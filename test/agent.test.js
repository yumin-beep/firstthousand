import { test } from "node:test";
import assert from "node:assert/strict";
import { runBrief, runBaseline, validateInput, checkNamesExist } from "../src/agent.js";
import { verifyClaim } from "../src/verify.js";
import { EvidenceStore, collectItems, normalizeName } from "../src/evidence.js";
import { FakeQloo, ScriptedLLM, ok } from "./fakes.js";

const input = { pitch: "A cozy farming game set on a floating island.", comps: ["Stardew Valley", "A Short Hike"], market: "United States" };

function briefJson(sections) {
  return { text: JSON.stringify({ title: "T", one_liner: "O", sections, limits: ["Aggregate affinities only."] }) };
}

test("validateInput trims, caps lists and reports missing fields", () => {
  const { input: v, errors } = validateInput({ pitch: "  short  ", comps: "a, b, c, d" });
  assert.equal(v.comps.length, 3);
  assert.equal(v.market, "United States");
  assert.equal(errors.length, 1);
  assert.equal(validateInput({ pitch: "A long enough pitch here", comps: [] }).errors.length, 1);
});

test("collectItems finds named items at any depth and skips provenance", () => {
  const items = collectItems({ results: { entities: [{ name: "A", entity_id: "1" }, { nested: [{ name: "B" }] }] }, provenance: { name: "X" } });
  assert.deepEqual(items.map((i) => i.name), ["A", "B"]);
  assert.equal(normalizeName("The Légend & Co."), "legend and co");
});

test("verifier: grounded, partial, ungrounded, interpretation, bad ids", () => {
  const store = new EvidenceStore();
  store.add({ tool: "qloo_recommend", args: {}, envelope: ok(["Lorde", "Bon Iver"]) });
  assert.equal(verifyClaim({ text: "x", names: ["Lorde"], evidence: ["E1"] }, store).verdict, "grounded");
  assert.equal(verifyClaim({ text: "x", names: ["Lorde", "Adele"], evidence: ["E1"] }, store).verdict, "partial");
  assert.equal(verifyClaim({ text: "x", names: ["Adele"], evidence: ["E1"] }, store).verdict, "ungrounded");
  assert.equal(verifyClaim({ text: "x", names: ["Lorde"], evidence: [] }, store).verdict, "ungrounded");
  assert.equal(verifyClaim({ text: "x", names: [], evidence: [] }, store).verdict, "interpretation");
  assert.deepEqual(verifyClaim({ text: "x", names: ["Lorde"], evidence: ["E1", "E9"] }, store).bad_evidence_ids, ["E9"]);
});

test("runBrief: core plan, follow-up call, verified brief with stable evidence ids", async () => {
  const qloo = new FakeQloo({
    "qloo_describe:videogame": (a) => ok([a.entity]),
    qloo_entity_tags: ok(["Cozy", "Farming"]),
    "qloo_recommend:artist": ok(["Lorde", "Bon Iver"]),
    "qloo_recommend:movie": ok(["My Neighbor Totoro"]),
    "qloo_recommend:podcast": { status: "empty", results: [] },
    "qloo_recommend:brand": ok(["Muji"]),
    "qloo_recommend:tv_show": ok(["Bluey"]),
    "qloo_recommend:videogame": ok(["Animal Crossing"]),
    qloo_where_popular: ok(["Portland", "Seattle"]),
    "qloo_describe:": ok(["Spiritfarer"]),
  });
  const llm = new ScriptedLLM([
    { text: "", calls: [{ name: "qloo_describe", args: { entity: "Spiritfarer" } }] },
    { text: "DONE", calls: [] },
    (req) => {
      assert.ok(req.jsonSchema, "writer uses JSON schema");
      return briefJson([
        { id: "audience", title: "Audience", claims: [
          { text: "They also like Lorde.", names: ["Lorde"], evidence: ["E4"] },
          { text: "They like Taylor Swift.", names: ["Taylor Swift"], evidence: ["E4"] },
          { text: "Calm, low-stress play matters.", names: [], evidence: [] },
        ] },
      ]);
    },
  ]);
  const events = [];
  const out = await runBrief(input, { qloo, llm, onEvent: (e) => events.push(e) });
  // 2 describes + tags + 5 cross-domain + videogame + where_popular = 10 core calls, plus 1 follow-up
  assert.equal(out.evidence.length, 11);
  assert.equal(out.evidence[3].tool, "qloo_recommend");
  assert.equal(out.evidence[3].args.target_type, "artist");
  assert.equal(out.evidence[3].id, "E4");
  assert.ok(out.evidence[10].followup);
  const claims = out.brief.sections[0].claims;
  assert.deepEqual(claims.map((c) => c.verdict), ["grounded", "ungrounded", "interpretation"]);
  assert.equal(out.brief.stats.unverified_items, 1);
  assert.ok(events.some((e) => e.type === "stage" && e.stage === "writing"));
});

test("runBrief adds compare_audiences only when an alternative direction is given", async () => {
  const qloo = new FakeQloo({ qloo_describe: (a) => ok([a.entity]), qloo_compare_audiences: ok(["Hollow Knight"]) });
  const llm = new ScriptedLLM([{ text: "DONE", calls: [] }, briefJson([])]);
  await runBrief({ ...input, alt_comps: ["Hollow Knight"] }, { qloo, llm });
  assert.ok(qloo.calls.some((c) => c.name === "qloo_compare_audiences"));
});

test("runBrief fails clearly when every Qloo call errors", async () => {
  const qloo = new FakeQloo({});
  qloo.call = async () => ({ status: "error", error: { code: "auth", recovery: "Check QLOO_API_KEY." } });
  await assert.rejects(runBrief(input, { qloo, llm: new ScriptedLLM([]) }), /QLOO_API_KEY/);
});

test("baseline brief has no evidence, so named claims are ungrounded; existence lookup is capped", async () => {
  const llm = new ScriptedLLM([briefJson([{ id: "channels", title: "C", claims: [{ text: "Pitch to Cozy Pod.", names: ["Cozy Pod", "Muji"], evidence: [] }] }])]);
  const { brief } = await runBaseline(input, { llm });
  assert.equal(brief.stats.ungrounded, 1);
  const qloo = new FakeQloo({ qloo_describe: (a) => (a.entity === "Muji" ? ok(["Muji"]) : { status: "empty", results: [] }) });
  const ex = await checkNamesExist(brief, qloo, 8);
  assert.deepEqual(ex, { checked: 2, found: 1, by_name: { "Cozy Pod": false, Muji: true } });
});
