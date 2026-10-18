// The launch-brief agent.
// 1. Core research: a fixed set of Qloo calls every brief needs (run in parallel).
// 2. Follow-up: the model reads the evidence and may make a few more Qloo calls of its choosing.
// 3. Writing: the model writes the brief as JSON; every claim must cite evidence ids.
// 4. Verification: code checks each claim's named items against the cited evidence.
import { EvidenceStore } from "./evidence.js";
import { verifyBrief } from "./verify.js";

export const CROSS_DOMAINS = [
  { type: "artist", label: "music artists" },
  { type: "movie", label: "films" },
  { type: "podcast", label: "podcasts" },
  { type: "brand", label: "brands" },
  { type: "tv_show", label: "TV shows" },
];

export const SECTION_IDS = ["audience", "store_page", "trailer_music", "channels", "regions", "direction", "first_steps"];

const claimSchema = {
  type: "object",
  properties: {
    text: { type: "string", description: "One sentence, plain English." },
    names: { type: "array", items: { type: "string" }, description: "Every specific named entity the sentence mentions, spelled as in the evidence." },
    evidence: { type: "array", items: { type: "string" }, description: "Evidence ids (E1, E2, ...) that contain those names. Empty for interpretation." },
  },
  required: ["text", "names", "evidence"],
};

export const BRIEF_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    one_liner: { type: "string" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", enum: SECTION_IDS },
          title: { type: "string" },
          claims: { type: "array", items: claimSchema },
        },
        required: ["id", "title", "claims"],
      },
    },
    limits: { type: "array", items: { type: "string" } },
  },
  required: ["title", "one_liner", "sections", "limits"],
};

export function validateInput(input) {
  const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const list = (a) =>
    (Array.isArray(a) ? a : String(a ?? "").split(/[,\n]/))
      .map((s) => clean(s, 80))
      .filter(Boolean)
      .slice(0, 3);
  const out = {
    pitch: clean(input.pitch, 400),
    comps: list(input.comps),
    alt_label: clean(input.alt_label, 60),
    alt_comps: list(input.alt_comps),
    market: clean(input.market, 60) || "United States",
  };
  const errors = [];
  if (out.pitch.length < 10) errors.push("Describe the game in at least one sentence.");
  if (out.comps.length < 1) errors.push("Name at least one comparable game.");
  if (out.alt_comps.length && !out.alt_label) out.alt_label = "Alternative direction";
  return { input: out, errors };
}

function corePlan(input) {
  const calls = [];
  for (const g of input.comps) calls.push({ tool: "qloo_describe", args: { entity: g, type: "videogame" } });
  calls.push({ tool: "qloo_entity_tags", args: { entities: input.comps, entity_type: "videogame", limit: 12 } });
  for (const d of CROSS_DOMAINS) {
    calls.push({ tool: "qloo_recommend", args: { target_type: d.type, signals: input.comps, limit: 8, explain: true } });
  }
  calls.push({ tool: "qloo_recommend", args: { target_type: "videogame", signals: input.comps, limit: 8, explain: true } });
  calls.push({ tool: "qloo_where_popular", args: { entity: input.comps[0], entity_type: "videogame", within: input.market, limit: 8 } });
  if (input.alt_comps.length) {
    calls.push({ tool: "qloo_compare_audiences", args: { group_a: input.comps, group_b: input.alt_comps, limit: 10 } });
  }
  return calls;
}

const RESEARCH_SYSTEM = `You are the research step of a launch-planning agent for indie game developers.
You have Qloo taste-graph tools. Core research has already run; its evidence is below.
Make at most a few follow-up calls only where they would sharpen the brief, for example:
- a comparable game did not resolve: retry qloo_describe with a corrected title
- a cross-domain list is empty or generic: try qloo_recommend with signal_tags from the entity tags
- regions look thin: qloo_where_popular for another comparable game
Do not repeat a call that already succeeded. When nothing more is needed, reply with the word DONE.`;

const WRITER_SYSTEM = `You write a launch brief for an indie game team from Qloo evidence.
Rules:
- Every sentence that names a specific artist, film, podcast, brand, show, game, tag or place must list those names in "names" and cite the evidence ids that contain them in "evidence".
- Use only names that appear in the evidence. Do not add names from your own knowledge.
- Sentences with no specific names are interpretation: leave "names" and "evidence" empty.
- Qloo results are aggregate taste affinities, not predictions about individuals or sales. Say so in "limits".
- Sections: audience (who they are, by taste), store_page (tag and hook ideas), trailer_music (sound direction), channels (podcasts, shows, brands to reach them), regions (where the audience is), direction (only if a comparison was run), first_steps (three concrete next actions).
- 2 to 4 claims per section. Plain, short sentences. No hype.`;

const BASELINE_SYSTEM = `You write a launch brief for an indie game team from your own general knowledge only.
For every sentence that names a specific artist, film, podcast, brand, show, game, tag or place, list those names in "names". Leave "evidence" empty.
Sections: audience, store_page, trailer_music, channels, regions, direction (only if an alternative direction is given), first_steps. 2 to 4 claims per section.`;

function describeInput(input) {
  const lines = [`Game pitch: ${input.pitch}`, `Comparable games: ${input.comps.join("; ")}`, `Main market: ${input.market}`];
  if (input.alt_comps.length) lines.push(`Alternative direction "${input.alt_label}" comparable games: ${input.alt_comps.join("; ")}`);
  return lines.join("\n");
}

function evidenceDigest(store) {
  return store.items.map((e) => ({ tool: e.tool, args: e.args, ...store.forModel(e) }));
}

export async function runBrief(rawInput, { qloo, llm, maxFollowups = 4, onEvent = () => {} }) {
  const { input, errors } = validateInput(rawInput);
  if (errors.length) throw Object.assign(new Error(errors.join(" ")), { code: "bad_input" });
  const store = new EvidenceStore();

  // 1. core research
  const plan = corePlan(input);
  onEvent({ type: "stage", stage: "research", total: plan.length });
  const envelopes = await Promise.all(
    plan.map(async (c) => {
      let envelope;
      try {
        envelope = await qloo.call(c.tool, c.args);
      } catch (err) {
        envelope = { status: "error", error: { code: "call_failed", recovery: String(err.message ?? err) } };
      }
      onEvent({ type: "call_done", tool: c.tool, status: envelope?.status });
      return envelope;
    })
  );
  // add in plan order so evidence ids do not depend on which call finished first
  plan.forEach((c, i) => onEvent({ type: "evidence", item: store.add({ tool: c.tool, args: c.args, envelope: envelopes[i] }) }));

  const usable = store.items.filter((e) => e.status === "ok" || e.status === "partial");
  if (usable.length === 0) {
    const first = store.items.find((e) => e.error);
    throw Object.assign(new Error(first?.error?.recovery || "Qloo returned no usable results."), { code: "qloo_unavailable", evidence: store.items });
  }

  // 2. follow-ups chosen by the model
  onEvent({ type: "stage", stage: "followup" });
  const messages = [
    { role: "user", text: `${describeInput(input)}\n\nEvidence so far:\n${JSON.stringify(evidenceDigest(store))}` },
  ];
  for (let i = 0; i < maxFollowups; i++) {
    const res = await llm.generate({ system: RESEARCH_SYSTEM, messages, tools: qloo.tools });
    if (!res.calls.length) break;
    messages.push({ role: "model", text: res.text, calls: res.calls });
    const results = [];
    for (const c of res.calls.slice(0, 2)) {
      let envelope;
      try {
        envelope = await qloo.call(c.name, c.args);
      } catch (err) {
        envelope = { status: "error", error: { code: "call_failed", recovery: String(err.message ?? err) } };
      }
      const item = store.add({ tool: c.name, args: c.args, envelope });
      item.followup = true;
      onEvent({ type: "evidence", item });
      results.push({ name: c.name, response: store.forModel(item) });
    }
    messages.push({ role: "tool", results });
  }

  // 3. writing
  onEvent({ type: "stage", stage: "writing" });
  const res = await llm.generate({
    system: WRITER_SYSTEM,
    messages: [{ role: "user", text: `${describeInput(input)}\n\nEvidence:\n${JSON.stringify(evidenceDigest(store))}` }],
    jsonSchema: BRIEF_SCHEMA,
    temperature: 0.3,
  });
  const brief = parseJson(res.text);

  // 4. verification
  const verified = verifyBrief(brief, store);
  onEvent({ type: "stage", stage: "done" });
  return { input, brief: verified, evidence: store.items };
}

export async function runBaseline(rawInput, { llm }) {
  const { input, errors } = validateInput(rawInput);
  if (errors.length) throw Object.assign(new Error(errors.join(" ")), { code: "bad_input" });
  const res = await llm.generate({
    system: BASELINE_SYSTEM,
    messages: [{ role: "user", text: describeInput(input) }],
    jsonSchema: BRIEF_SCHEMA,
    temperature: 0.3,
  });
  return { input, brief: verifyBrief(parseJson(res.text), null) };
}

// For the LLM-only brief: look its named items up in Qloo (capped) so the comparison shows
// which names Qloo can confirm exist at all. This is a lookup, not a grounding check.
export async function checkNamesExist(brief, qloo, cap = 8) {
  const names = [...new Set(brief.sections.flatMap((s) => s.claims.flatMap((c) => c.names ?? [])))].slice(0, cap);
  const found = {};
  await Promise.all(
    names.map(async (n) => {
      try {
        const env = await qloo.call("qloo_describe", { entity: n });
        found[n] = env.status === "ok" || env.status === "partial";
      } catch {
        found[n] = null;
      }
    })
  );
  return { checked: names.length, found: Object.values(found).filter((v) => v === true).length, by_name: found };
}

function parseJson(text) {
  const t = String(text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(t);
  } catch {
    throw Object.assign(new Error("The writer returned malformed JSON."), { code: "writer_failed" });
  }
}
