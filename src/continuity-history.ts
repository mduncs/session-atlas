/**
 * Source-backed continuity history and disposable Atlas projection state.
 *
 * The source transcript remains authoritative. Adapters may contribute an
 * event only when a durable source record explicitly identifies compaction or
 * checkpointing; prose that merely says "compacted" is never parsed as an
 * event. `continuity_evidence` is retained across reset, while
 * `continuity_projection` is intentionally disposable and rebuildable.
 */
import type { DB } from "./db/index.js";
import type {
  ContinuityEventEvidence,
  ContinuityEventKind,
  ContinuitySupport,
  RecordIdentityKind,
} from "./adapters/types.js";

export type ContinuityStateStatus = "active" | "reset" | "archived";

export interface ContinuityHistoryEvent {
  id: number;
  sessionId: number;
  eventKey: string;
  kind: ContinuityEventKind;
  sourceOrdinal: number;
  sourceRecordId: string | null;
  sourceRecordUuid: string | null;
  sourceRecordTs: number | null;
  sourceIdentityKind: RecordIdentityKind;
  detail: string | null;
}

export interface ContinuityState {
  sessionId: number;
  support: ContinuitySupport;
  status: ContinuityStateStatus;
  archived: boolean;
  resetGeneration: number;
  resetAt: number | null;
  archivedAt: number | null;
  updatedAt: number;
}

export interface ContinuityHistory {
  state: ContinuityState;
  events: ContinuityHistoryEvent[];
}

interface StateRow {
  session_id: number;
  support: string;
  archived: number;
  reset_generation: number;
  reset_at: number | null;
  archived_at: number | null;
  updated_at: number;
}

/**
 * Replace one session's explicit evidence and refresh its projection unless a
 * reset is active. This is called by ingest inside its existing transaction.
 */
export function syncContinuityEvidence(
  db: DB,
  sessionId: number,
  events: readonly ContinuityEventEvidence[] = [],
  support: ContinuitySupport = "unknown",
  constructionGeneration?: string,
): void {
  const apply = () => {
    const state = ensureState(db, sessionId, support);
    // Evidence is a fresh derivation of the current winning source unit. It is
    // not raw source history, so replacing it is safe and deterministic.
    db.prepare(`DELETE FROM continuity_evidence WHERE session_id=?`).run(sessionId);
    const insert = db.prepare(
      `INSERT INTO continuity_evidence(
         session_id, event_key, kind, source_ordinal, source_record_id,
         source_record_uuid, source_record_ts, source_identity_kind, detail, recorded_at,
         construction_generation
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const seen = new Set<string>();
    for (const event of events) {
      const normalized = normalizeEvidence(event);
      const eventKey = continuityEventKey(normalized);
      if (seen.has(eventKey)) continue;
      seen.add(eventKey);
      insert.run(
        sessionId,
        eventKey,
        normalized.kind,
        normalized.sourceOrdinal,
        normalized.sourceRecordId,
        normalized.sourceRecordUuid,
        normalized.sourceRecordTs,
        normalized.sourceIdentityKind,
        normalized.detail,
        Date.now(),
        constructionGeneration ?? currentGeneration(db, sessionId),
      );
    }
    db.prepare(
      `UPDATE continuity_state SET support=?, updated_at=?, construction_generation=? WHERE session_id=?`,
    ).run(events.length > 0 ? "supported" : support, Date.now(), constructionGeneration ?? currentGeneration(db, sessionId), sessionId);
    if (state.reset_at === null) rebuildProjectionInTransaction(db, sessionId);
  };
  if (db.inTransaction) apply();
  else db.transaction(apply)();
}

/** Rebuild the disposable projection from retained explicit evidence. */
export function rebuildContinuityHistory(db: DB, sessionId: number): ContinuityHistory {
  const apply = () => {
    ensureState(db, sessionId, "unknown");
    rebuildProjectionInTransaction(db, sessionId);
    db.prepare(
      `UPDATE continuity_state SET reset_at=NULL, updated_at=? WHERE session_id=?`,
    ).run(Date.now(), sessionId);
    // Read after clearing reset_at so the returned state and projection describe
    // the same generation. This is an explicit user rebuild, not an ingest
    // refresh, so it deliberately clears the reset marker.
    return readHistory(db, sessionId);
  };
  return db.inTransaction ? apply() : db.transaction(apply)();
}

/** Rebuild every existing session's continuity projection. */
export function rebuildAllContinuityHistory(db: DB): ContinuityHistory[] {
  const ids = (db.prepare(`SELECT id FROM sessions ORDER BY id`).all() as Array<{ id: number }>).map(
    (row) => Number(row.id),
  );
  return ids.map((id) => rebuildContinuityHistory(db, id));
}

/**
 * Explicitly reset only Atlas-derived continuity projection state. Source
 * evidence, raw messages, and source files are untouched. A later rebuild
 * restores the projection from continuity_evidence.
 */
export function resetContinuityState(db: DB, sessionId: number): ContinuityState {
  const apply = () => {
    const state = ensureState(db, sessionId, "unknown");
    const now = Date.now();
    db.prepare(`DELETE FROM continuity_projection WHERE session_id=?`).run(sessionId);
    db.prepare(
      `UPDATE continuity_state
       SET reset_generation=reset_generation+1, reset_at=?, updated_at=?
       WHERE session_id=?`,
    ).run(now, now, sessionId);
    return readState(db, sessionId)!;
  };
  return db.inTransaction ? apply() : db.transaction(apply)();
}

/** Mark continuity state archived without deleting evidence or raw content. */
export function archiveContinuityState(db: DB, sessionId: number): ContinuityState {
  return setArchiveFlag(db, sessionId, true);
}

/** Recover an archived continuity state without rebuilding or deleting data. */
export function restoreContinuityState(db: DB, sessionId: number): ContinuityState {
  return setArchiveFlag(db, sessionId, false);
}

/** Alias for callers that use the shorter recovery verb. */
export const unarchiveContinuityState = restoreContinuityState;
export const archiveSessionContinuity = archiveContinuityState;
export const restoreSessionContinuity = restoreContinuityState;

/** Read state, including explicit unsupported/unknown capability reporting. */
export function getContinuityState(db: DB, sessionId: number): ContinuityState | null {
  return readState(db, sessionId);
}

/** Deterministic per-session history query with capability/status metadata. */
export function getContinuityHistory(db: DB, sessionId: number): ContinuityHistory | null {
  if (!readState(db, sessionId)) return null;
  return readHistory(db, sessionId);
}

export const queryContinuityHistory = getContinuityHistory;

/** Exact row count `syncContinuityEvidence` will publish after normalization. */
export function countContinuityEvidence(events: readonly ContinuityEventEvidence[] = []): number {
  return new Set(events.map((event) => continuityEventKey(normalizeEvidence(event)))).size;
}

/** Array form for list-oriented consumers. */
export function listContinuityHistory(db: DB, sessionId: number): ContinuityHistoryEvent[] {
  return getContinuityHistory(db, sessionId)?.events ?? [];
}

export const listContinuityEvents = listContinuityHistory;

function setArchiveFlag(db: DB, sessionId: number, archived: boolean): ContinuityState {
  const apply = () => {
    ensureState(db, sessionId, "unknown");
    const now = Date.now();
    db.prepare(
      `UPDATE continuity_state
       SET archived=?, archived_at=?, updated_at=? WHERE session_id=?`,
    ).run(archived ? 1 : 0, archived ? now : null, now, sessionId);
    return readState(db, sessionId)!;
  };
  return db.inTransaction ? apply() : db.transaction(apply)();
}

function ensureState(db: DB, sessionId: number, support: ContinuitySupport): StateRow {
  const session = db.prepare(`SELECT id FROM sessions WHERE id=?`).get(sessionId) as { id: number } | null;
  if (!session) throw new Error(`continuity session not found: ${sessionId}`);
  db.prepare(
    `INSERT INTO continuity_state(session_id, support, updated_at, construction_generation)
     VALUES (?,?,?,?) ON CONFLICT(session_id) DO NOTHING`,
  ).run(sessionId, support, Date.now(), currentGeneration(db, sessionId));
  return db.prepare(`SELECT * FROM continuity_state WHERE session_id=?`).get(sessionId) as StateRow;
}

function readState(db: DB, sessionId: number): ContinuityState | null {
  const row = db.prepare(`SELECT * FROM continuity_state WHERE session_id=?`).get(sessionId) as StateRow | null;
  if (!row) return null;
  const support = normalizeSupport(row.support);
  return {
    sessionId: Number(row.session_id),
    support,
    status: row.archived !== 0 ? "archived" : row.reset_at === null ? "active" : "reset",
    archived: row.archived !== 0,
    resetGeneration: Number(row.reset_generation),
    resetAt: nullableNumber(row.reset_at),
    archivedAt: nullableNumber(row.archived_at),
    updatedAt: Number(row.updated_at),
  };
}

function readHistory(db: DB, sessionId: number): ContinuityHistory {
  const state = readState(db, sessionId);
  if (!state) throw new Error(`continuity session not found: ${sessionId}`);
  const rows = db.prepare(
    `SELECT e.id, e.session_id, e.event_key, e.kind, e.source_ordinal,
            e.source_record_id, e.source_record_uuid, e.source_record_ts,
            e.source_identity_kind, e.detail
     FROM continuity_projection p
     JOIN continuity_evidence e ON e.id=p.evidence_id
     WHERE p.session_id=? AND p.generation=?
     ORDER BY e.source_ordinal ASC,
              (e.source_record_ts IS NULL) ASC,
              e.source_record_ts ASC,
              e.event_key ASC, e.id ASC`,
  ).all(sessionId, state.resetGeneration) as Record<string, unknown>[];
  return {
    state,
    events: rows.map((row) => ({
      id: Number(row.id),
      sessionId: Number(row.session_id),
      eventKey: String(row.event_key),
      kind: String(row.kind) as ContinuityEventKind,
      sourceOrdinal: Number(row.source_ordinal),
      sourceRecordId: nullableString(row.source_record_id),
      sourceRecordUuid: nullableString(row.source_record_uuid),
      sourceRecordTs: nullableNumber(row.source_record_ts),
      sourceIdentityKind: normalizeIdentity(row.source_identity_kind),
      detail: nullableString(row.detail),
    })),
  };
}

function rebuildProjectionInTransaction(db: DB, sessionId: number): void {
  const state = db.prepare(`SELECT reset_generation FROM continuity_state WHERE session_id=?`).get(sessionId) as
    | { reset_generation: number }
    | null;
  if (!state) throw new Error(`continuity session not found: ${sessionId}`);
  db.prepare(`DELETE FROM continuity_projection WHERE session_id=?`).run(sessionId);
  db.prepare(
    `INSERT INTO continuity_projection(session_id, evidence_id, generation, construction_generation)
     SELECT session_id, id, ?, construction_generation FROM continuity_evidence WHERE session_id=?
     ORDER BY source_ordinal, (source_record_ts IS NULL), source_record_ts, event_key, id`,
  ).run(Number(state.reset_generation), sessionId);
}

function currentGeneration(db: DB, sessionId: number): string | null {
  const row = db.prepare(`SELECT construction_generation FROM sessions WHERE id=?`).get(sessionId) as
    | { construction_generation: string } | null;
  return row?.construction_generation ?? null;
}

function normalizeEvidence(event: ContinuityEventEvidence): Required<ContinuityEventEvidence> {
  const sourceOrdinal = Number.isSafeInteger(event.sourceOrdinal) && event.sourceOrdinal >= 0
    ? event.sourceOrdinal
    : 0;
  const kind = event.kind === "checkpoint" ? "checkpoint" : "compaction";
  const sourceRecordId = clean(event.sourceRecordId);
  const sourceRecordUuid = clean(event.sourceRecordUuid);
  const sourceRecordTs = Number.isSafeInteger(event.sourceRecordTs) ? Number(event.sourceRecordTs) : null;
  const sourceIdentityKind = normalizeIdentity(event.sourceIdentityKind);
  return {
    kind,
    sourceOrdinal,
    sourceRecordId,
    sourceRecordUuid,
    sourceRecordTs,
    sourceIdentityKind,
    detail: clean(event.detail),
  };
}

function continuityEventKey(event: Required<ContinuityEventEvidence>): string {
  // Offset/ordinal is source evidence, not a guessed identity. Include all
  // stable fields to avoid collapsing two explicit events at one offset.
  return JSON.stringify([
    event.kind,
    event.sourceOrdinal,
    event.sourceRecordId,
    event.sourceRecordUuid,
    event.sourceRecordTs,
    event.detail,
  ]);
}

function normalizeSupport(value: unknown): ContinuitySupport {
  return value === "supported" || value === "unsupported" ? value : "unknown";
}

function normalizeIdentity(value: unknown): RecordIdentityKind {
  return value === "uuid" || value === "record-id" || value === "message-id" ? value : "none";
}

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
