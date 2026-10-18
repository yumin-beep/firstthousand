import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeQloo, ScriptedLLM, ok } from "./fakes.js";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "ft-"));
const { createApp } = await import("../src/server.js");

function brief(evId) {
  return { text: JSON.stringify({ title: "T", one_liner: "O", sections: [{ id: "audience", title: "A", claims: [{ text: "Lorde fans.", names: ["Lorde"], evidence: [evId] }] }], limits: ["L"] }) };
}

async function readSse(res) {
  const text = await res.text();
  return text.split("\n\n").filter(Boolean).map((c) => ({ event: /^event: (.+)$/m.exec(c)?.[1], data: JSON.parse(/^data: (.+)$/m.exec(c)?.[1]) }));
}

test("POST /api/brief streams progress and a verified result, then serves the cache", async () => {
  const qloo = new FakeQloo({ qloo_describe: (a) => ok([a.entity]), "qloo_recommend:artist": ok(["Lorde"]) });
  // baseline runs first in parallel; order of LLM calls: baseline writer, follow-up, writer
  const llm = new ScriptedLLM([
    (req) => (req.system.includes("general knowledge") ? brief("") : { text: "DONE", calls: [] }),
    (req) => (req.system.includes("general knowledge") ? brief("") : req.jsonSchema ? brief("E3") : { text: "DONE", calls: [] }),
    (req) => (req.system.includes("general knowledge") ? brief("") : brief("E3")),
  ]);
  const server = createApp({ qloo, llm }).listen(0);
  const port = server.address().port;
  const body = JSON.stringify({ pitch: "A cozy farming game on an island.", comps: ["Stardew Valley"] });
  try {
    const events = await readSse(await fetch(`http://127.0.0.1:${port}/api/brief`, { method: "POST", body, headers: { "content-type": "application/json" } }));
    const result = events.find((e) => e.event === "result")?.data;
    assert.ok(events.some((e) => e.event === "progress" && e.data.type === "evidence"));
    assert.ok(result, JSON.stringify(events.filter((e) => e.event === "fail")));
    assert.equal(result.brief.sections[0].claims[0].verdict, "grounded");
    assert.ok(result.baseline.brief);
    const again = await readSse(await fetch(`http://127.0.0.1:${port}/api/brief`, { method: "POST", body, headers: { "content-type": "application/json" } }));
    assert.equal(again.find((e) => e.event === "result").data.cached, true);

    const bad = await fetch(`http://127.0.0.1:${port}/api/brief`, { method: "POST", body: "{}" });
    assert.equal(bad.status, 400);
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(await page.text(), /FirstThousand/);
    const escape = await fetch(`http://127.0.0.1:${port}/..%2f..%2fpackage.json`);
    assert.equal(escape.status, 404);
  } finally {
    server.close();
  }
});

test("without keys the server refuses live runs but still serves the page", async () => {
  const server = createApp({ qloo: null, llm: null });
  // createApp falls back to env keys; make sure none are set for this test
  assert.equal(process.env.QLOO_API_KEY, undefined);
  server.listen(0);
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/brief`, { method: "POST", body: JSON.stringify({ pitch: "A long enough pitch.", comps: ["X"] }) });
    assert.equal(r.status, 503);
    const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    assert.equal(h.qloo_configured, false);
  } finally {
    server.close();
  }
});
