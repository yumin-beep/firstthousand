// Every Qloo call becomes an evidence item with a short id (E1, E2, ...).
// The brief may only cite these ids, and the verifier checks names against them.

export function normalizeName(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/^the /, "")
    .trim();
}

// Walk an arbitrary result payload and pull out anything that looks like a named Qloo item.
export function collectItems(node, out = [], depth = 0) {
  if (depth > 6 || node == null) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectItems(n, out, depth + 1);
    return out;
  }
  if (typeof node === "object") {
    if (typeof node.name === "string" && node.name.trim()) {
      out.push({
        name: node.name,
        id: node.entity_id ?? node.entityId ?? node.id ?? node.tagId ?? null,
        type: node.type ?? node.subtype ?? null,
        affinity: typeof node.affinity === "number" ? node.affinity : null,
      });
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "provenance" || k === "execution") continue;
      if (v && typeof v === "object") collectItems(v, out, depth + 1);
    }
  }
  return out;
}

export class EvidenceStore {
  constructor() {
    this.items = [];
  }

  add({ tool, args, envelope }) {
    const id = `E${this.items.length + 1}`;
    const named = collectItems({ results: envelope?.results, interpretation: envelope?.interpretation });
    const seen = new Set();
    const unique = named.filter((n) => {
      const key = normalizeName(n.name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const item = {
      id,
      tool,
      args,
      status: envelope?.status ?? "error",
      summary: envelope?.summary ?? "",
      warnings: envelope?.warnings ?? [],
      error: envelope?.error ?? null,
      names: unique.slice(0, 40),
      requests: (envelope?.provenance?.requests ?? []).map((r) => ({ method: r.method, path: r.path, query: r.query })),
    };
    this.items.push(item);
    return item;
  }

  get(id) {
    return this.items.find((e) => e.id === id);
  }

  // Compact view handed back to the model after each call.
  forModel(item) {
    return {
      evidence_id: item.id,
      status: item.status,
      summary: item.summary,
      warnings: item.warnings.slice(0, 3),
      error: item.error ? { code: item.error.code, recovery: item.error.recovery } : undefined,
      results: item.names.slice(0, 15).map((n) => ({ name: n.name, type: n.type, affinity: n.affinity })),
    };
  }
}
