// Test doubles. Fixture data is synthetic and exists only for tests.
export class FakeQloo {
  constructor(table = {}) {
    this.table = table;
    this.calls = [];
    this.tools = [{ name: "qloo_describe", description: "d", inputSchema: { type: "object" } }];
  }
  async call(name, args) {
    this.calls.push({ name, args });
    const key = `${name}:${args.target_type ?? args.type ?? args.entity_type ?? ""}`;
    const hit = this.table[key] ?? this.table[name];
    if (typeof hit === "function") return hit(args);
    return hit ?? { status: "empty", results: [] };
  }
}

export class ScriptedLLM {
  constructor(steps) {
    this.steps = steps;
    this.seen = [];
  }
  async generate(req) {
    this.seen.push(req);
    const step = this.steps.shift();
    if (!step) throw new Error("ScriptedLLM ran out of steps");
    return typeof step === "function" ? step(req) : step;
  }
}

export const ok = (names, extra = {}) => ({
  status: "ok",
  summary: "fixture",
  results: names.map((n, i) => ({ entity_id: `id-${n}`, name: n, type: "urn:entity:x", affinity: 0.9 - i * 0.05 })),
  provenance: { source: "Qloo", endpoint: "/v2/insights", documentation: "", requests: [{ method: "GET", path: "/v2/insights", query: { fixture: true } }] },
  ...extra,
});
