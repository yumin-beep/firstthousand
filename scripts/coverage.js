// Live check before tuning: which comparable games Qloo resolves, and what the
// recommend / where_popular results look like. Needs QLOO_API_KEY; no model key.
// Writes a JSON report (no key, no personal data) to the path in argv[2] or stdout.
import { writeFileSync } from "node:fs";
import { QlooMcp } from "../src/qloo.js";

const GAMES = [
  "Stardew Valley", "Hades", "Celeste", "Hollow Knight", "Vampire Survivors", "Unpacking",
  // Korean-made titles, to see whether the graph covers them
  "Dave the Diver", "Skul: The Hero Slayer", "Sanabi", "Lies of P",
];

const brief = (env) => ({
  status: env.status,
  summary: env.summary,
  warnings: env.warnings,
  error: env.error && { code: env.error.code, recovery: env.error.recovery },
  requests: env.provenance?.requests,
});

const qloo = new QlooMcp({ apiKey: process.env.QLOO_API_KEY });
const report = { checked_at: new Date().toISOString(), base_url: qloo.baseUrl, games: [], samples: {} };
try {
  report.readiness = await qloo.readiness();
  for (const g of GAMES) {
    const env = await qloo.call("qloo_describe", { entity: g, type: "videogame" });
    const top = env.results?.[0] ?? env.results?.entities?.[0];
    report.games.push({ query: g, ...brief(env), top: top && { name: top.name, type: top.type, entity_id: top.entity_id, popularity: top.popularity } });
  }
  const signals = ["Stardew Valley", "Unpacking"];
  report.samples.recommend_artist = await qloo.call("qloo_recommend", { target_type: "artist", signals, limit: 5, explain: true });
  report.samples.recommend_videogame = await qloo.call("qloo_recommend", { target_type: "videogame", signals, limit: 5, explain: true });
  report.samples.where_popular = await qloo.call("qloo_where_popular", { entity: "Stardew Valley", entity_type: "videogame", within: "United States", limit: 5 });
  report.samples.entity_tags = await qloo.call("qloo_entity_tags", { entities: signals });
} catch (err) {
  report.fatal = String(err?.message ?? err);
} finally {
  await qloo.close();
}
report.resolved = report.games.filter((g) => g.status === "ok" && g.top).length;
const out = JSON.stringify(report, null, 2);
if (process.argv[2]) writeFileSync(process.argv[2], out);
else console.log(out);
console.error(`resolved ${report.resolved}/${GAMES.length}${report.fatal ? `; fatal: ${report.fatal}` : ""}`);
