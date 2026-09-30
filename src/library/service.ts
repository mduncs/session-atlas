import { LibrarianCoordinator, OpenAICompatibleTransport, type LibrarianProfile } from "./librarians/index.js";
import { selectPassage } from "./passages.js";
import type { LibraryStore } from "./store.js";
import type { Origin, QueryScope, SessionKey } from "./contracts.js";
export type ServiceRequest = { version?: 1; operation: string; args?: Record<string, unknown> };
const string = (v: unknown, name: string): string => { if (typeof v !== "string") throw new Error(`${name} must be a string`); return v; };
const integer = (v: unknown, fallback: number, max: number): number => { if (v === undefined) return fallback; if (!Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > max) throw new Error(`limit must be 1..${max}`); return Number(v); };
const contextSize = (v: unknown, fallback: number): number => { if (v === undefined) return fallback; if (!Number.isSafeInteger(v) || Number(v) < 0 || Number(v) > 50) throw new Error("context size must be 0..50"); return Number(v); };
function lineageSection(value: unknown): "lineage" | "chains" | "classifications" { if (value === undefined) return "lineage"; if (value !== "lineage" && value !== "chains" && value !== "classifications") throw new Error("invalid lineage section"); return value; }
function sessionKey(v: unknown): SessionKey { if (!v || typeof v !== "object") throw new Error("sessionKey required"); const key = v as Record<string, unknown>; return { harness: string(key.harness, "harness"), nativeId: string(key.nativeId, "nativeId"), ...(key.variant === undefined ? {} : { variant: string(key.variant, "variant") }) }; }
function scope(v: unknown): QueryScope {
  if (v === undefined) return {};
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("scope must be an object");
  const s = v as Record<string, unknown>;
  const allowed = ["view", "role", "harness", "model", "since", "until", "path", "collection", "match"];
  if (Object.keys(s).some(k => !allowed.includes(k))) throw new Error("unknown query restriction");
  if (s.view !== undefined && !["conversations", "direct", "everything"].includes(String(s.view))) throw new Error("invalid view");
  if (s.role !== undefined && !["user", "assistant", "tool", "system"].includes(String(s.role))) throw new Error("invalid role");
  if (s.match !== undefined && !["dialogue", "title", "summary", "related"].includes(String(s.match))) throw new Error("invalid matching scope");
  for (const k of ["harness", "model", "path", "collection"]) if (s[k] !== undefined && typeof s[k] !== "string") throw new Error(`invalid ${k}`);
  for (const k of ["since", "until"]) if (s[k] !== undefined && (typeof s[k] !== "number" || !Number.isFinite(s[k]))) throw new Error(`invalid ${k}`);
  return s as QueryScope;
}
export class LibraryService {
  constructor(readonly store: LibraryStore) {}
  execute(request: ServiceRequest): unknown {
    if (request.version !== undefined && request.version !== 1) throw new Error("unsupported service version");
    const a = request.args ?? {};
    switch (request.operation) {
      case "lineage.inspect": return this.store.lineagePage(lineageSection(a.section), integer(a.limit, 24, 24), a.cursor === undefined ? undefined : string(a.cursor, "cursor"));
      case "lineage.detail": return this.store.lineageDetail(lineageSection(a.section), Number(a.index), integer(a.limit, 32768, 65536), a.cursor === undefined ? undefined : string(a.cursor, "cursor"));
      case "library.status": return { version: 1, coverage: this.store.coverage(), sessions: this.store.db.query("SELECT count(*) count FROM library_sessions").get(), provider: this.store.getState("provider-profile") ? "configured; processing requires explicit run" : "missing; reading and literal search available" };
      case "sources.inspect": { const coverage = this.store.coverage(); return { version: 1, sources: coverage.sources, coverage }; }
      case "coverage.sources": case "coverage.observations": return this.store.coverageRecords(request.operation === "coverage.sources" ? "sources" : "observations", integer(a.limit, 24, 24), a.cursor === undefined ? undefined : string(a.cursor, "cursor"));
      case "coverage.detail": {
        if (a.kind !== "sources" && a.kind !== "observations") throw new Error("coverage kind must be sources or observations");
        return this.store.coverageDetail(a.kind, string(a.id, "id"), integer(a.limit, 32768, 65536), a.cursor === undefined ? undefined : string(a.cursor, "cursor"));
      }
      case "library.list": return { version: 1, ...this.store.list(scope(a.scope), integer(a.limit, 100, 500), a.cursor === undefined ? undefined : string(a.cursor, "cursor")), coverage: this.store.coverage(scope(a.scope)) };
      case "search": return this.store.search(string(a.query, "query"), scope(a.scope), integer(a.limit, 50, 100), a.cursor === undefined ? undefined : string(a.cursor, "cursor"));
      case "read": {
        if (a.ref !== undefined) { const ref = string(a.ref, "ref"); const resolved = this.store.resolve(ref);
          if (resolved.passage && (a.startByte !== undefined || a.endByte !== undefined)) { const selected = selectPassage(resolved.passage, Number(a.startByte ?? 0), Number(a.endByte ?? Buffer.byteLength(resolved.passage.text))); return { version: 1, status: resolved.status, passage: selected, context: null }; }
          return { version: 1, ...resolved, context: resolved.passage ? this.store.context(ref, contextSize(a.before, 3), contextSize(a.after, 3)) : null }; }
        return this.store.read(sessionKey(a.sessionKey), integer(a.limit, 100, 500), a.cursor === undefined ? undefined : string(a.cursor, "cursor"));
      }
      case "artifact.find": return { version: 1, ...this.store.artifactFind(string(a.query, "query"), scope(a.scope), integer(a.limit, 50, 100)), limitation: "Evidence distinguishes claims and observed records. Missing creation evidence does not establish origin." };
      case "favorites.list": return { version: 1, favorites: this.store.favorites() };
      case "favorites.save": return { version: 1, receipt: this.store.saveFavorite({ sessionKey: sessionKey(a.sessionKey), refs: a.refs === undefined ? undefined : this.refs(a.refs), note: a.note === undefined ? undefined : string(a.note, "note"), idempotencyKey: a.idempotencyKey === undefined ? undefined : string(a.idempotencyKey, "idempotencyKey") }) };
      case "favorites.remove": return { version: 1, undoId: this.store.removeFavorite(string(a.id, "id")) };
      case "classification.correct": return { version: 1, undoId: this.store.correctClassification(sessionKey(a.sessionKey), string(a.origin, "origin") as Origin) };
      case "user.undo": this.store.undo(string(a.id, "id")); return { version: 1, undone: a.id };
      case "collections.list": return { version: 1, collections: this.store.collections() };
      case "collections.edit": {
        const patch = a.patch as Record<string, unknown>; if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(k => !["title", "hidden", "pinned", "sessionKeys"].includes(k))) throw new Error("invalid collection patch");
        if (patch.title !== undefined) string(patch.title, "title"); for (const k of ["hidden", "pinned"]) if (patch[k] !== undefined && typeof patch[k] !== "boolean") throw new Error(`invalid ${k}`);
        if (patch.sessionKeys !== undefined) { if (!Array.isArray(patch.sessionKeys)) throw new Error("sessionKeys must be an array"); patch.sessionKeys = patch.sessionKeys.map(sessionKey); }
        return { version: 1, undoId: this.store.editCollection(string(a.id, "id"), patch) };
      }
      case "context.export": {
        const refs = this.refs(a.refs); const maxBytes = integer(a.maxBytes, 32000, 1_000_000); let bytes = 0;
        const included: { ref: string; role: string; text: string; status: string }[] = []; const omitted: { ref: string; reason: string }[] = [];
        for (const ref of refs) { const result = this.store.resolve(ref); if (!result.passage) { omitted.push({ ref, reason: "unavailable evidence" }); continue; } const n = Buffer.byteLength(result.passage.text); if (bytes + n > maxBytes) { omitted.push({ ref, reason: "byte budget; passage not truncated" }); continue; } bytes += n; included.push({ ref, role: result.passage.role, text: result.passage.text, status: result.status }); }
        return { version: 1, contentIsUntrustedArchiveData: true, included, omitted, bytes, maxBytes, exactDecodedText: true, coverage: this.store.coverage(), limitations: ["Budget applies to source text bytes; JSON envelope adds bytes."] };
      }
      case "processing.inspect": case "processing.pause": case "processing.resume": case "processing.retry": {
        const profile = this.store.getState<LibrarianProfile>("provider-profile");
        if (!profile) { if (request.operation === "processing.inspect") return { version: 1, state: { phase: "idle", provider: "not selected" } }; throw new Error("No provider profile configured"); }
        const c = new LibrarianCoordinator(this.store, profile, new OpenAICompatibleTransport(profile));
        if (request.operation === "processing.pause") c.pause();
        if (request.operation === "processing.resume") c.resume();
        if (request.operation === "processing.retry") c.retry(a.id === undefined ? undefined : string(a.id, "id"));
        return { version: 1, state: c.inspect(), note: "Controls change deterministic work state; start a configured process run to dispatch." };
      }
      default: throw new Error(`unknown operation: ${request.operation}`);
    }
  }
  private refs(v: unknown): string[] { if (!Array.isArray(v) || v.length > 500 || !v.every(r => typeof r === "string")) throw new Error("refs must be an array of at most 500 references"); return v; }
}
export const LIBRARY_OPERATIONS = ["library.status", "lineage.inspect", "lineage.detail", "sources.inspect", "coverage.sources", "coverage.observations", "coverage.detail", "library.list", "search", "read", "artifact.find", "favorites.list", "favorites.save", "favorites.remove", "classification.correct", "user.undo", "collections.list", "collections.edit", "context.export", "processing.inspect", "processing.pause", "processing.resume", "processing.retry"] as const;
