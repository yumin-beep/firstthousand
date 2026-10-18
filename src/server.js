// HTTP server: static UI, a streaming brief endpoint, saved examples, health.
// Keys come from the environment only: QLOO_API_KEY, GEMINI_API_KEY.
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QlooMcp } from "./qloo.js";
import { GeminiLLM } from "./llm/gemini.js";
import { runBrief, runBaseline, checkNamesExist, validateInput } from "./agent.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const EXAMPLES = path.join(ROOT, "examples");
const CACHE = path.join(process.env.DATA_DIR ?? path.join(ROOT, "data"), "cache");

const PORT = Number(process.env.PORT ?? 8080);
const PER_IP_PER_HOUR = Number(process.env.PER_IP_PER_HOUR ?? 6);
const DAILY_CAP = Number(process.env.DAILY_CAP ?? 120);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon" };

export function createApp({ qloo, llm } = {}) {
  qloo ??= process.env.QLOO_API_KEY ? new QlooMcp({ apiKey: process.env.QLOO_API_KEY }) : null;
  llm ??= process.env.GEMINI_API_KEY ? new GeminiLLM({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL }) : null;

  const hits = new Map(); // ip -> timestamps
  let day = new Date().toISOString().slice(0, 10);
  let dayCount = 0;

  function allow(ip) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      dayCount = 0;
    }
    if (dayCount >= DAILY_CAP) return "daily";
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= PER_IP_PER_HOUR) return "ip";
    recent.push(now);
    hits.set(ip, recent);
    dayCount++;
    return null;
  }

  async function readBody(req, limit = 8192) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw Object.assign(new Error("Request too large."), { code: "bad_input" });
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }

  async function serveStatic(req, res) {
    const url = new URL(req.url, "http://x");
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC) || !existsSync(file)) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "public, max-age=300" });
    res.end(await readFile(file));
  }

  async function listExamples() {
    if (!existsSync(EXAMPLES)) return [];
    const files = (await readdir(EXAMPLES)).filter((f) => f.endsWith(".json"));
    const out = [];
    for (const f of files) {
      const data = JSON.parse(await readFile(path.join(EXAMPLES, f), "utf8"));
      out.push({ id: f.replace(/\.json$/, ""), title: data.brief?.title, input: data.input, saved_at: data.saved_at });
    }
    return out;
  }

  async function handleBrief(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
    const { input, errors } = validateInput(body);
    if (errors.length) return json(res, 400, { error: errors.join(" ") });
    if (!qloo || !llm) return json(res, 503, { error: "This server has no API keys configured. Saved examples still work.", code: "not_configured" });

    const key = createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 24);
    const cacheFile = path.join(CACHE, `${key}.json`);

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    if (existsSync(cacheFile)) {
      send("result", { ...JSON.parse(await readFile(cacheFile, "utf8")), cached: true });
      return res.end();
    }
    const ip = (req.headers["x-forwarded-for"]?.split(",")[0] ?? req.socket.remoteAddress ?? "?").trim();
    const limited = allow(ip);
    if (limited) {
      send("fail", { code: "rate_limited", error: limited === "daily" ? "Today's live quota for this demo is used up. Try a saved example, or come back tomorrow." : "Too many briefs from this address in the last hour. Try a saved example meanwhile." });
      return res.end();
    }

    try {
      const baselineP = runBaseline(input, { llm }).catch((err) => ({ error: String(err.message ?? err) }));
      const result = await runBrief(input, { qloo, llm, onEvent: (e) => send("progress", e) });
      send("progress", { type: "stage", stage: "baseline" });
      const baseline = await baselineP;
      if (baseline.brief) baseline.exists = await checkNamesExist(baseline.brief, qloo).catch(() => null);
      const payload = { ...result, baseline, created_at: new Date().toISOString() };
      await mkdir(CACHE, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(payload));
      send("result", payload);
    } catch (err) {
      send("fail", { code: err.code ?? "failed", error: String(err.message ?? err) });
    }
    res.end();
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://x");
      if (req.method === "POST" && url.pathname === "/api/brief") return await handleBrief(req, res);
      if (req.method === "GET" && url.pathname === "/api/health") {
        return json(res, 200, { qloo_configured: Boolean(qloo), llm_configured: Boolean(llm), daily_cap: DAILY_CAP, used_today: dayCount });
      }
      if (req.method === "GET" && url.pathname === "/api/examples") return json(res, 200, await listExamples());
      if (req.method === "GET" && url.pathname.startsWith("/api/examples/")) {
        const id = url.pathname.split("/").pop().replace(/[^a-z0-9-]/gi, "");
        const file = path.join(EXAMPLES, `${id}.json`);
        if (!existsSync(file)) return json(res, 404, { error: "not found" });
        return json(res, 200, JSON.parse(await readFile(file, "utf8")));
      }
      if (req.method === "GET") return await serveStatic(req, res);
      json(res, 405, { error: "method not allowed" });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
      console.error(err);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(PORT, () => console.log(`FirstThousand on :${PORT}`));
}
