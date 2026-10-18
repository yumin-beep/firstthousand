const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const TOOL_LABEL = {
  qloo_describe: "resolve",
  qloo_entity_tags: "taste tags",
  qloo_recommend: "recommend",
  qloo_where_popular: "where popular",
  qloo_compare_audiences: "compare audiences",
  qloo_audience_demographics: "demographics",
  qloo_find_tags: "find tags",
  qloo_rank: "rank",
};
const VERDICT_LABEL = { grounded: "grounded", partial: "partial", ungrounded: "not in evidence", interpretation: "interpretation" };

let current = null; // { result, evidenceById }

function argSummary(tool, a = {}) {
  if (tool === "qloo_recommend") return `${a.target_type} ← ${(a.signals ?? a.signal_tags ?? []).join(", ")}`;
  if (tool === "qloo_describe") return `${a.entity}${a.type ? ` (${a.type})` : ""}`;
  if (tool === "qloo_where_popular") return `${a.entity} within ${a.within}`;
  if (tool === "qloo_compare_audiences") return `${(a.group_a ?? []).join(", ")} vs ${(a.group_b ?? []).join(", ")}`;
  if (tool === "qloo_entity_tags") return (a.entities ?? []).join(", ");
  return JSON.stringify(a);
}

function show(id, on = true) {
  $(id).hidden = !on;
}

function setStage(stage) {
  const order = ["research", "followup", "writing", "baseline", "done"];
  const idx = order.indexOf(stage);
  $$("#stages li").forEach((li) => {
    const i = order.indexOf(li.dataset.stage);
    li.className = i < idx ? "done" : i === idx ? "active" : "";
  });
}

function addCall(item) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="st-${esc(item.status)}">${esc(item.status)}</span> ${esc(item.id)} ${esc(TOOL_LABEL[item.tool] ?? item.tool)}: ${esc(argSummary(item.tool, item.args))}${item.followup ? " (follow-up)" : ""}`;
  $("#calls").append(li);
  $("#calls").scrollTop = $("#calls").scrollHeight;
}

function fail(msg) {
  $("#error").textContent = msg;
  show("#error");
  show("#progress", false);
}

function readForm() {
  const f = $("#brief-form");
  const vals = (n) => $$(`[name="${n}"]`, f).map((i) => i.value.trim()).filter(Boolean);
  return {
    pitch: f.pitch.value.trim(),
    comps: vals("comp"),
    market: f.market.value,
    alt_label: f.alt_label.value.trim(),
    alt_comps: vals("alt_comp"),
  };
}

async function submit(e) {
  e.preventDefault();
  const body = readForm();
  show("#error", false);
  show("#result", false);
  $("#calls").innerHTML = "";
  setStage("research");
  show("#progress");
  $("#go").disabled = true;
  try {
    const res = await fetch("/api/brief", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok || !res.headers.get("content-type")?.includes("event-stream")) {
      const j = await res.json().catch(() => ({}));
      return fail(j.error ?? `Request failed (${res.status}).`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = JSON.parse(/^data: (.+)$/m.exec(chunk)?.[1] ?? "null");
        if (ev === "progress") {
          if (data.type === "stage") setStage(data.stage);
          if (data.type === "evidence") addCall(data.item);
        } else if (ev === "result") {
          render(data, data.cached ? "Saved from an earlier identical request" : "Live run");
        } else if (ev === "fail") {
          fail(data.error);
        }
      }
    }
  } catch (err) {
    fail("The connection dropped before the brief finished. Please try again.");
  } finally {
    $("#go").disabled = false;
  }
}

function claimHtml(c, { withEvidence, exists }) {
  const evs = withEvidence ? (c.evidence ?? []).map((id) => `<button class="ev" data-ev="${esc(id)}" title="Open evidence ${esc(id)}">${esc(id)}</button>`).join("") : "";
  let extra = "";
  if (withEvidence && c.missing?.length) extra = `<span class="missing">Not found in cited evidence: ${c.missing.map(esc).join(", ")}</span>`;
  if (withEvidence && c.bad_evidence_ids?.length) extra += `<span class="missing">Cites evidence that does not exist: ${c.bad_evidence_ids.map(esc).join(", ")}</span>`;
  if (!withEvidence && exists && c.names?.length) {
    const parts = c.names.map((n) => (n in exists.by_name ? `<span class="${exists.by_name[n] ? "found" : "notfound"}">${esc(n)}${exists.by_name[n] ? " ✓" : " ✗"}</span>` : esc(n)));
    extra = `<span class="missing" style="color:var(--muted)">Qloo lookup: ${parts.join(", ")}</span>`;
  }
  const verdict = withEvidence || c.verdict === "interpretation" ? c.verdict : "ungrounded";
  const label = withEvidence ? VERDICT_LABEL[verdict] : verdict === "interpretation" ? "interpretation" : "no source";
  return `<div class="claim"><p>${esc(c.text)}${extra}</p><span class="meta"><span class="pill ${esc(verdict)}">${esc(label)}</span>${evs}</span></div>`;
}

function sectionsHtml(brief, opts) {
  return (brief.sections ?? [])
    .filter((s) => s.claims?.length)
    .map((s) => `<div class="section"><h3>${esc(s.title)}</h3>${s.claims.map((c) => claimHtml(c, opts)).join("")}</div>`)
    .join("");
}

function statsHtml(st) {
  return `<div class="stats">
    <div class="stat"><b>${st.grounded}</b><span>grounded claims</span></div>
    <div class="stat"><b>${st.partial}</b><span>partly grounded</span></div>
    <div class="stat"><b>${st.ungrounded}</b><span>not in evidence</span></div>
    <div class="stat"><b>${st.interpretation}</b><span>interpretation</span></div></div>`;
}

function render(result, origin) {
  const evidenceById = Object.fromEntries((result.evidence ?? []).map((e) => [e.id, e]));
  current = { result, evidenceById };
  const b = result.brief;
  $("#result-kicker").textContent = `${origin}${result.created_at || result.saved_at ? ` · ${new Date(result.saved_at ?? result.created_at).toLocaleString()}` : ""}`;
  $("#brief-title").textContent = b.title;
  $("#brief-oneliner").textContent = b.one_liner;
  $("#ev-count").textContent = `(${result.evidence?.length ?? 0})`;

  $("#tab-grounded").innerHTML =
    statsHtml(b.stats) +
    `<p class="note">${b.stats.unverified_items} of ${b.stats.named_items} named items could not be found in the evidence their claim cites.</p>` +
    sectionsHtml(b, { withEvidence: true }) +
    `<div class="section limits"><h3>Limits</h3><ul>${(b.limits ?? []).map((l) => `<li>${esc(l)}</li>`).join("")}</ul></div>`;

  const base = result.baseline;
  if (base?.brief) {
    const ex = base.exists;
    $("#tab-baseline").innerHTML =
      `<p class="note">Same model, same input, no Qloo. Nothing here cites a source.${ex ? ` We looked up ${ex.checked} of its named items in Qloo: ${ex.found} were found, ${ex.checked - ex.found} were not.` : ""}</p>` +
      sectionsHtml(base.brief, { withEvidence: false, exists: ex });
  } else {
    $("#tab-baseline").innerHTML = `<p class="note">The LLM-only comparison did not finish for this run.</p>`;
  }

  $("#tab-evidence").innerHTML = (result.evidence ?? []).map(evidenceHtml).join("");
  show("#progress", false);
  show("#result");
  selectTab("grounded");
  $("#result").scrollIntoView({ behavior: "smooth", block: "start" });
}

function evidenceHtml(e) {
  const reqs = (e.requests ?? []).map((r) => `<div class="req">${esc(r.method)} ${esc(r.path)}?${esc(new URLSearchParams(flatten(r.query)).toString())}</div>`).join("");
  return `<div class="evitem" id="ev-${esc(e.id)}"><header><b>${esc(e.id)} · ${esc(TOOL_LABEL[e.tool] ?? e.tool)}${e.followup ? " (follow-up)" : ""}</b><span class="pill ${e.status === "ok" ? "grounded" : e.status === "error" ? "ungrounded" : "partial"}">${esc(e.status)}</span></header>
    <code>${esc(argSummary(e.tool, e.args))}</code>
    ${e.summary ? `<p class="note" style="margin:6px 0 0">${esc(e.summary)}</p>` : ""}
    ${e.names?.length ? `<ol class="evnames">${e.names.slice(0, 12).map((n) => `<li>${esc(n.name)}${n.affinity != null ? ` <span class="req">affinity ${Number(n.affinity).toFixed(2)}</span>` : ""}</li>`).join("")}</ol>` : ""}
    ${e.error ? `<p class="missing">${esc(e.error.code)}: ${esc(e.error.recovery)}</p>` : ""}
    ${reqs}</div>`;
}

function flatten(q) {
  const out = {};
  for (const [k, v] of Object.entries(q ?? {})) out[k] = Array.isArray(v) ? v.join(",") : typeof v === "object" ? JSON.stringify(v) : String(v);
  return out;
}

function selectTab(name) {
  $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  ["grounded", "baseline", "evidence"].forEach((t) => show(`#tab-${t}`, t === name));
}

document.addEventListener("click", (e) => {
  const tab = e.target.closest(".tabs button");
  if (tab) return selectTab(tab.dataset.tab);
  const ev = e.target.closest("[data-ev]");
  if (ev && current) {
    const item = current.evidenceById[ev.dataset.ev];
    $("#ev-body").innerHTML = item ? `<h2 id="ev-title">Evidence ${esc(item.id)}</h2>${evidenceHtml(item)}` : `<p>Evidence ${esc(ev.dataset.ev)} does not exist in this run.</p>`;
    $("#ev-dialog").showModal();
  }
  const ex = e.target.closest("[data-example]");
  if (ex) loadExample(ex.dataset.example);
});

async function loadExample(id) {
  show("#error", false);
  const r = await fetch(`/api/examples/${encodeURIComponent(id)}`);
  if (!r.ok) return fail("That saved run could not be loaded.");
  const data = await r.json();
  const f = $("#brief-form");
  f.pitch.value = data.input.pitch;
  $$('[name="comp"]', f).forEach((el, i) => (el.value = data.input.comps[i] ?? ""));
  render(data, "Saved run (real Qloo calls, stored)");
}

async function init() {
  $("#brief-form").addEventListener("submit", submit);
  try {
    const ex = await (await fetch("/api/examples")).json();
    if (ex.length) {
      $("#example-list").innerHTML = ex.map((x) => `<button class="chip" data-example="${esc(x.id)}">${esc(x.title ?? x.id)}</button>`).join("");
      show("#examples");
    }
    const h = await (await fetch("/api/health")).json();
    if (!h.qloo_configured || !h.llm_configured) $("#quota-hint").textContent = "Live runs are off on this server. Saved runs still work.";
  } catch {}
}
init();
