/** Read-mostly seam between Ink and the published library.
 *
 * This module deliberately does not bootstrap, migrate, or generate anything
 * while opening a reader. Writes acquire a separate lazy LibraryStore handle
 * and are reachable only through the explicit action methods below.
 */
import { readActiveLibrary } from "../library/active-library.js";
import { LibraryStore } from "../library/store.js";
import { keyToken } from "../library/passages.js";
import { permissionFingerprint, validateProfile } from "../library/librarians/profile.js";
import type { Favorite, Interpretation, LibrarySession, SessionKey, SourceObservation } from "../library/contracts.js";
import { openReadOnlyDb, type DB } from "../db/index.js";
import type { Tier2ViewState } from "../tier2.js";

export interface InkSummaryView extends Tier2ViewState {
  sessionKey: SessionKey;
  session?: LibrarySession;
  provenance?: string;
  coverage?: Interpretation["coverage"];
  source?: SourceObservation;
  stale?: boolean;
}
export type ProcessingStatus = "unconfigured" | "idle" | "awaiting-authorization" | "paused" | "queued" | "running" | "failed";
export interface InkProcessingView { status: ProcessingStatus; detail?: string; command: string }
export interface InkLibraryBridgeOptions { libraryPath?: string; legacyPath?: string; env?: NodeJS.ProcessEnv }

function legacySummary(db: DB, key: SessionKey): InkSummaryView | null {
  if (key.variant) return null; // legacy rows have no variant identity; never guess.
  const session = db.prepare("SELECT * FROM sessions WHERE harness=? AND native_id=? LIMIT 1").get(key.harness, key.nativeId) as Record<string, unknown> | null;
  if (!session) return null;
  const id = Number(session.id);
  const hasSummaries = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='summaries'").get());
  const row = hasSummaries ? db.prepare("SELECT * FROM summaries WHERE session_id=? ORDER BY tier DESC, rowid DESC LIMIT 1").get(id) as Record<string, unknown> | null : null;
  const body = row && [row.body, row.overview, row.summary, row.topic_line].find(v => typeof v === "string" && v.trim()) as string | undefined;
  if (!body) return { sessionKey: key, sessionId: id, status: "unavailable", reason: "no cached summary" };
  return { sessionKey: key, sessionId: id, status: "degraded", result: { body: body.trim(), anchors: [] }, provider: "legacy-cache", model: String(row?.model ?? "legacy-unknown"), provenance: "legacy-coverage-unverified", reason: "historical cache; source coverage and anchors are unverified" };
}

export class InkLibraryBridge {
  readonly store: LibraryStore | null;
  private readonly legacy: DB | null;
  private writable: LibraryStore | null = null;
  private constructor(store: LibraryStore | null, legacy: DB | null) { this.store = store; this.legacy = legacy; }

  static open(options: InkLibraryBridgeOptions = {}): InkLibraryBridge {
    const active = options.libraryPath ? null : readActiveLibrary(options.env);
    const kind = active?.kind;
    const path = options.libraryPath ?? (kind === "library" ? active!.database : undefined);
    const legacyPath = options.legacyPath ?? (kind === "legacy" ? active!.database : undefined);
    if (path) return new InkLibraryBridge(new LibraryStore(path, { readOnly: true }), legacyPath ? openReadOnlyDb(legacyPath) : null);
    return new InkLibraryBridge(null, legacyPath ? openReadOnlyDb(legacyPath) : null);
  }

  close(): void { this.store?.close(); this.legacy?.close(); this.writable?.close(); this.writable = null; }
  getSessionView(key: SessionKey): InkSummaryView {
    if (this.store) {
      const session = this.store.session(key);
      if (!session && this.legacy) {
        const historical = legacySummary(this.legacy, key);
        if (historical) return historical;
      }
      if (!session) return { sessionKey: key, sessionId: 0, status: "unavailable", reason: "session unavailable" };
      const summary = session.summary;
      // The summary view does not need the potentially large observation payload.
      const source = undefined;
      if (!summary && this.legacy) {
        const historical = legacySummary(this.legacy, key);
        if (historical?.result) return { ...historical, session: { ...session, summary: null }, source };
      }
      if (!summary) return { sessionKey: key, sessionId: 0, session, source, status: "unavailable", reason: "no cached summary; configure via atlas library provider FILE.json" };
      const stale = summary.revision !== session.revision;
      return { sessionKey: key, sessionId: 0, session, source, stale, status: summary.provenance === "validated" && !stale ? "ready" : "degraded", result: { body: summary.overview, anchors: [] }, provider: "library-cache", model: summary.model, provenance: summary.provenance, coverage: summary.coverage, reason: stale ? "summary is stale for the current source revision" : summary.provenance === "validated" ? undefined : "historical or unverified summary; claims remain bounded by recorded coverage" };
    }
    if (this.legacy) { const result = legacySummary(this.legacy, key); if (result) return result; }
    return { sessionKey: key, sessionId: 0, status: "unavailable", reason: "session unavailable" };
  }

  processingStatus(): InkProcessingView {
    const command = "atlas library provider FILE.json";
    if (!this.store) return { status: "unconfigured", detail: "Library processing is unavailable for a legacy-only pointer", command };
    const profile = this.store.getState<Record<string, unknown>>("provider-profile");
    if (!profile) return { status: "unconfigured", detail: "No provider profile saved", command };
    const validated = validateProfile(profile);
    const ledger = this.store.getState<{ permission?: string; paused?: boolean; jobs?: Record<string, { status?: string; error?: string }> }>(`librarians:${String(profile.id)}`);
    if (ledger?.permission !== permissionFingerprint(validated)) return { status: "awaiting-authorization", detail: "Profile saved; processing not authorized", command: "atlas library process --authorize FINGERPRINT --limit N" };
    if (ledger?.paused) return { status: "paused", command };
    const jobs = Object.values(ledger?.jobs ?? {});
    if (jobs.some(j => j.status === "running")) return { status: "running", command };
    if (jobs.some(j => ["failed", "unknown", "incomplete"].includes(String(j.status)))) return { status: "failed", detail: jobs.find(j => j.error)?.error, command };
    return { status: jobs.some(j => j.status === "ready") ? "queued" : "idle", command: "atlas library process --limit N" };
  }

  enqueueSummary(_key: SessionKey): { queued: false; reason: string; command: string } {
    const status = this.processingStatus();
    if (status.status === "unconfigured") return { queued: false, reason: "No provider configured; no job created", command: status.command };
    return { queued: false, reason: "Summary processing requires an explicit reviewed run; selected-session enqueue is not exposed by the coordinator", command: "atlas library process --authorize FINGERPRINT --limit N" };
  }

  private writableStore(): LibraryStore { if (!this.store) throw new Error("favorites require an active new library"); return this.writable ??= new LibraryStore(this.store.path); }
  saveFavorite(input: { sessionKey: SessionKey; refs?: string[]; note?: string; idempotencyKey?: string }): Favorite { return this.writableStore().saveFavorite(input); }
  toggleFavorite(key: SessionKey): { active: boolean; favorite?: Favorite; undoId?: string } {
    if (!this.store?.session(key)) throw new Error("session is not present in the active library; no favorite changed");
    const store = this.writableStore(); const token = keyToken(key); const matches = store.favorites().filter(f => keyToken(f.sessionKey) === token);
    if (matches.length > 1) throw new Error("multiple favorites match this stable session key; choose an exact favorite");
    const current = matches[0];
    if (current) return { active: false, undoId: store.removeFavorite(current.id) };
    const favorite = store.saveFavorite({ sessionKey: key });
    const event = store.journal().filter(e => e.kind === "favorite" && e.target === favorite.id && e.after !== null).at(-1);
    return { active: true, favorite, undoId: event?.id };
  }
  undoFavorite(id: string): void { this.writableStore().undo(id); }
}

export function openInkLibraryBridge(options: InkLibraryBridgeOptions = {}): InkLibraryBridge { return InkLibraryBridge.open(options); }
