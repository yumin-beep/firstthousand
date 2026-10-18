// Checks each claim of a brief against the evidence it cites.
//   grounded      every named item appears in a cited evidence result
//   partial       some named items appear, some do not
//   ungrounded    names nothing that the cited evidence contains (or cites nothing)
//   interpretation the claim names no items; it is the writer's reading, shown as such
import { normalizeName } from "./evidence.js";

function nameInEvidence(name, evidenceItems) {
  const key = normalizeName(name);
  if (!key) return false;
  return evidenceItems.some((e) =>
    e.names.some((n) => {
      const k = normalizeName(n.name);
      return k === key || (key.length > 4 && (k.includes(key) || key.includes(k)) && Math.min(k.length, key.length) / Math.max(k.length, key.length) > 0.6);
    }) || (e.args && JSON.stringify(e.args).toLowerCase().includes(String(name).toLowerCase()))
  );
}

export function verifyClaim(claim, store) {
  const names = (claim.names ?? []).filter((n) => typeof n === "string" && n.trim());
  const cited = (claim.evidence ?? []).map((id) => store?.get(id)).filter(Boolean);
  const badIds = (claim.evidence ?? []).filter((id) => !store?.get(id));
  if (names.length === 0) {
    return { ...claim, verdict: "interpretation", missing: [], bad_evidence_ids: badIds };
  }
  if (cited.length === 0) {
    return { ...claim, verdict: "ungrounded", missing: names, bad_evidence_ids: badIds };
  }
  const missing = names.filter((n) => !nameInEvidence(n, cited));
  const verdict = missing.length === 0 ? "grounded" : missing.length < names.length ? "partial" : "ungrounded";
  return { ...claim, verdict, missing, bad_evidence_ids: badIds };
}

export function verifyBrief(brief, store) {
  const sections = (brief.sections ?? []).map((s) => ({
    ...s,
    claims: (s.claims ?? []).map((c) => verifyClaim(c, store)),
  }));
  const all = sections.flatMap((s) => s.claims);
  const named = all.filter((c) => c.verdict !== "interpretation");
  const stats = {
    claims: all.length,
    named_claims: named.length,
    grounded: named.filter((c) => c.verdict === "grounded").length,
    partial: named.filter((c) => c.verdict === "partial").length,
    ungrounded: named.filter((c) => c.verdict === "ungrounded").length,
    interpretation: all.length - named.length,
    named_items: named.reduce((n, c) => n + (c.names?.length ?? 0), 0),
    unverified_items: named.reduce((n, c) => n + (c.missing?.length ?? 0), 0),
  };
  return { ...brief, sections, stats };
}
