import type { Claim, Origin, PassageRef } from "../contracts";
export interface ValidOutput { status: "ok" | "overflow"; claims: Claim[]; overview: string; episodes: { title: string; claimIds: string[] }[]; origin?: { label: Origin; refs: PassageRef[]; reason: string }; childDisposition: Record<string, string[]> }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object"); return value as Record<string, unknown>; }
function fields(value: Record<string, unknown>, allowed: string[]): void { if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error("Unknown output field"); }
function text(value: unknown, max = 8000): string { if (typeof value !== "string" || !value.length || value.length > max) throw new Error("Invalid bounded text"); return value; }
function strings(value: unknown, max = 1024): string[] { if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== "string")) throw new Error("Invalid string array"); return value; }
export function validateOutput(raw: string, refs: Map<string, PassageRef | PassageRef[]>, children: Map<string, Claim>, prefix: string): ValidOutput {
  const value = object(JSON.parse(raw)); fields(value, ["status", "claims", "overview", "episodes", "origin", "childDisposition"]);
  if (value.status === "overflow") return { status: "overflow", claims: [], overview: "", episodes: [], childDisposition: {} };
  if (value.status !== "ok" || !Array.isArray(value.claims) || value.claims.length > 256) throw new Error("Invalid status/claims");
  const ids = new Map<string, string>();
  for (const rawClaim of value.claims) { const c = object(rawClaim); const id = text(c.id, 128); if (ids.has(id)) throw new Error("Duplicate claim id"); ids.set(id, `${prefix}:${id}`); }
  const claims = value.claims.map(rawClaim => {
    const c = object(rawClaim); fields(c, ["id", "text", "kind", "refs", "supersedes"]);
    if (!["question", "proposal", "decision", "reversal", "outcome", "open_issue", "topic"].includes(c.kind as string)) throw new Error("Invalid claim kind");
    const cited = strings(c.refs); if (!cited.length || cited.some(ref => !refs.has(ref))) throw new Error("Invented or empty evidence reference");
    const supersedes = strings(c.supersedes);
    if (supersedes.some(id => !ids.has(id) && !children.has(id))) throw new Error("Invented supersession target");
    return { id: ids.get(c.id as string)!, text: text(c.text), kind: c.kind as Claim["kind"], refs: [...new Set(cited.flatMap(ref => refs.get(ref)!))], supersedes: supersedes.map(id => ids.get(id) ?? children.get(id)!.id) };
  });
  const episodes = value.episodes === undefined ? [] : (Array.isArray(value.episodes) ? value.episodes : (() => { throw new Error("Invalid episodes"); })()).map(rawEpisode => {
    const e = object(rawEpisode); fields(e, ["title", "claimIds"]); const claimIds = strings(e.claimIds); if (!claimIds.length || claimIds.some(id => !ids.has(id))) throw new Error("Episode cites invented claim");
    return { title: text(e.title, 500), claimIds: claimIds.map(id => ids.get(id)!) };
  });
  const disposition: Record<string, string[]> = {};
  if (children.size) {
    const d = object(value.childDisposition); if (Object.keys(d).length !== children.size) throw new Error("Reduction dropped a child");
    for (const [alias, child] of children) {
      const targets = strings(d[alias]); if (!targets.length || targets.some(id => !ids.has(id))) throw new Error("Reduction dropped child disposition");
      const outputs = claims.filter(c => targets.some(id => ids.get(id) === c.id));
      if (child.refs.some(ref => !outputs.some(c => c.refs.includes(ref)))) throw new Error("Reduction discarded child evidence");
      if (child.kind === "reversal" && !outputs.some(c => c.kind === "reversal")) throw new Error("Reduction discarded reversal");
      disposition[child.id] = targets.map(id => ids.get(id)!);
    }
  }
  let origin: ValidOutput["origin"];
  if (value.origin !== undefined) {
    const o = object(value.origin); fields(o, ["label", "refs", "reason"]);
    if (!["human_started", "worker", "mixed", "unknown"].includes(o.label as string)) throw new Error("Invalid origin");
    const r = strings(o.refs); if (r.some(ref => !refs.has(ref))) throw new Error("Invented origin reference");
    origin = { label: o.label as Origin, refs: [...new Set(r.flatMap(ref => refs.get(ref)!))], reason: text(o.reason, 2000) };
  }
  return { status: "ok", claims, overview: value.overview === undefined ? "" : text(value.overview), episodes, childDisposition: disposition, origin };
}
