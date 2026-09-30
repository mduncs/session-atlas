import { createHash } from "node:crypto";
import type { DB } from "./db/index.js";
import { bumpLastWrite } from "./db/index.js";

export interface StableSessionRef {
  harness: string;
  nativeId: string;
}

export interface FavoriteRequest extends StableSessionRef {
  fromOrdinal?: number;
  toOrdinal?: number;
  topic?: string;
  /** A deliberate whole-session favorite; ordinary live favorites use the tail. */
  wholeSession?: boolean;
}

export interface FavoriteRecord {
  id: number;
  harness: string;
  nativeId: string;
  fromOrdinal: number | null;
  toOrdinal: number | null;
  spanText: string | null;
  spanHash: string | null;
  topic: string | null;
  scope: "tail" | "span" | "session";
  status: "ok" | "pending";
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
}

export interface FavoriteServiceOptions {
  defaultSpan?: number;
  /** The ingest layer injects its one canonical targeted-ingest operation here. */
  targetedIngest?: (target: StableSessionRef) => Promise<unknown>;
}

export interface MaterializedSpan {
  fromOrdinal: number | null;
  toOrdinal: number | null;
  text: string;
  hash: string;
}

export interface WholeSessionFavoriteToggleResult {
  active: boolean;
  action: "added" | "removed";
  favorite: FavoriteRecord | null;
}

/**
 * Whole-session favorites are durable identity markers. Copying a multi-MB
 * transcript on the interactive `f` path makes a metadata toggle scale with
 * session size; consumers that need payload text materialize it lazily.
 */
export const WHOLE_SESSION_FAVORITE_MARKER = "[Session Atlas whole-session favorite; transcript materializes when exported.]";

/**
 * Create or refresh a favorite.  The only async work is the optional targeted
 * ingest seam; all favorite state changes themselves happen transactionally.
 */
export async function createFavorite(
  db: DB,
  request: FavoriteRequest,
  options: FavoriteServiceOptions = {},
): Promise<FavoriteRecord> {
  validateRequest(request);
  const topic = normalizeTopic(request.topic);
  let ingestError: string | null = null;

  if (!findSession(db, request) && options.targetedIngest) {
    try {
      await options.targetedIngest({ harness: request.harness, nativeId: request.nativeId });
    } catch (error) {
      ingestError = error instanceof Error ? error.message : String(error);
    }
  }

  const now = Date.now();
  const tx = db.transaction(() => {
    const span = request.wholeSession
      ? materializeWholeSessionMarker(db, request)
      : materializeSpan(db, request, options.defaultSpan ?? 6);
    if (span) {
      return upsertFavorite(db, request, topic, span, now, null);
    }
    return upsertFavorite(
      db,
      request,
      topic,
      null,
      now,
      ingestError ?? "awaiting session ingest",
    );
  });
  const result = tx();
  bumpLastWrite(db);
  return result;
}

/** Retry pending rows after regular or targeted ingest. Safe to run repeatedly. */
export function retryPendingFavorites(
  db: DB,
  options: Pick<FavoriteServiceOptions, "defaultSpan"> & Partial<StableSessionRef> = {},
): { materialized: number; pending: number } {
  const clauses = ["status = 'pending'"];
  const args: string[] = [];
  if (options.harness) {
    clauses.push("harness = ?");
    args.push(options.harness);
  }
  if (options.nativeId) {
    clauses.push("native_id = ?");
    args.push(options.nativeId);
  }
  const pending = db
    .prepare(`SELECT * FROM favorites WHERE ${clauses.join(" AND ")} ORDER BY id`)
    .all(...args) as FavoriteRow[];
  let materialized = 0;

  const tx = db.transaction(() => {
    for (const row of pending) {
      const request: FavoriteRequest = {
        harness: row.harness,
        nativeId: row.native_id,
        fromOrdinal: row.from_ordinal ?? undefined,
        toOrdinal: row.to_ordinal ?? undefined,
        topic: row.topic ?? undefined,
        wholeSession: row.scope === "session",
      };
      const span = request.wholeSession
        ? materializeWholeSessionMarker(db, request)
        : materializeSpan(db, request, options.defaultSpan ?? 6);
      if (!span) continue;
      db.prepare(
        `UPDATE favorites
         SET from_ordinal=?, to_ordinal=?, span_text=?, span_hash=?, status='ok',
             updated_at=?, last_error=NULL
         WHERE id=?`,
      ).run(span.fromOrdinal, span.toOrdinal, span.text, span.hash, Date.now(), row.id);
      materialized++;
    }
  });
  tx();
  if (materialized > 0) bumpLastWrite(db);
  return { materialized, pending: pending.length - materialized };
}

export function getFavorite(db: DB, id: number): FavoriteRecord | null {
  const row = db.prepare(`SELECT * FROM favorites WHERE id=?`).get(id) as FavoriteRow | null;
  return row ? mapRow(row) : null;
}

export function listFavorites(db: DB): FavoriteRecord[] {
  return (db.prepare(`SELECT * FROM favorites ORDER BY created_at DESC, id DESC`).all() as FavoriteRow[]).map(mapRow);
}

export function removeFavorite(db: DB, id: number): boolean {
  const changed = db.prepare(`DELETE FROM favorites WHERE id=?`).run(id).changes > 0;
  if (changed) bumpLastWrite(db);
  return changed;
}

export function removeFavoritesForSession(db: DB, target: StableSessionRef): number {
  const changed = db
    .prepare(`DELETE FROM favorites WHERE harness=? AND native_id=?`)
    .run(target.harness, target.nativeId).changes;
  if (changed > 0) bumpLastWrite(db);
  return changed;
}

/**
 * Toggle the canonical whole-session favorite without touching tail/span rows.
 * This synchronous service is suitable for a TUI key binding: it resolves and
 * materializes the row in one transaction and reports the resulting state.
 */
export function toggleWholeSessionFavorite(
  db: DB,
  target: StableSessionRef,
): WholeSessionFavoriteToggleResult {
  if (!target.harness.trim() || !target.nativeId.trim()) {
    throw new Error("favorite requires a stable harness and native session id");
  }

  const tx = db.transaction((): WholeSessionFavoriteToggleResult => {
    const existing = db.prepare(
      `SELECT * FROM favorites
       WHERE harness=? AND native_id=? AND scope='session'
         AND from_ordinal IS NULL AND to_ordinal IS NULL AND topic IS NULL
       ORDER BY id LIMIT 1`,
    ).get(target.harness, target.nativeId) as FavoriteRow | null;
    if (existing) {
      db.prepare(`DELETE FROM favorites WHERE id=?`).run(existing.id);
      return { active: false, action: "removed", favorite: null };
    }

    // A not-yet-ingested tail favorite also starts with NULL bounds and can
    // occupy the normalized unique key. Once the session exists, materialize
    // that tail in place first; it remains a distinct favorite and frees the
    // canonical NULL/NULL key for the session row.
    const pendingTail = db.prepare(
      `SELECT * FROM favorites
       WHERE harness=? AND native_id=? AND scope='tail' AND status='pending'
         AND from_ordinal IS NULL AND to_ordinal IS NULL AND topic IS NULL
       ORDER BY id LIMIT 1`,
    ).get(target.harness, target.nativeId) as FavoriteRow | null;
    if (pendingTail) {
      const tail = materializeSpan(db, target);
      if (!tail) throw new Error("cannot favorite a session that is not indexed or has no messages");
      db.prepare(
        `UPDATE favorites SET from_ordinal=?,to_ordinal=?,span_text=?,span_hash=?,
          status='ok',updated_at=?,last_error=NULL WHERE id=?`,
      ).run(tail.fromOrdinal, tail.toOrdinal, tail.text, tail.hash, Date.now(), pendingTail.id);
    }

    const request: FavoriteRequest = { ...target, wholeSession: true };
    const span = materializeWholeSessionMarker(db, request);
    if (!span) throw new Error("cannot favorite a session that is not indexed or has no messages");
    const favorite = upsertFavorite(db, request, null, span, Date.now(), null);
    return { active: true, action: "added", favorite };
  });
  const result = tx();
  bumpLastWrite(db);
  return result;
}

/** Resolve either the current surrogate id or a native id to stable identity. */
export function resolveSessionRef(
  db: DB,
  identifier: string,
  harness?: string,
): StableSessionRef | null {
  if (/^[1-9]\d*$/.test(identifier)) {
    const byId = db.prepare(`SELECT harness,native_id FROM sessions WHERE id=?`).get(Number(identifier)) as
      | { harness: string; native_id: string }
      | null;
    if (byId && (!harness || byId.harness === harness)) {
      return { harness: byId.harness, nativeId: byId.native_id };
    }
  }
  const rows = db
    .prepare(
      `SELECT harness,native_id FROM sessions
       WHERE native_id=? AND (? IS NULL OR harness=?) ORDER BY harness LIMIT 2`,
    )
    .all(identifier, harness ?? null, harness ?? null) as Array<{ harness: string; native_id: string }>;
  if (rows.length === 1) return { harness: rows[0]!.harness, nativeId: rows[0]!.native_id };
  if (rows.length > 1) throw new Error(`session id '${identifier}' exists in more than one harness; pass --harness`);
  return harness ? { harness, nativeId: identifier } : null;
}

function validateRequest(request: FavoriteRequest): void {
  if (!request.harness.trim() || !request.nativeId.trim()) {
    throw new Error("favorite requires a stable harness and native session id");
  }
  const oneBound = request.fromOrdinal === undefined !== (request.toOrdinal === undefined);
  if (oneBound) throw new Error("favorite spans require both --from and --to");
  if (request.fromOrdinal !== undefined) {
    if (!Number.isInteger(request.fromOrdinal) || !Number.isInteger(request.toOrdinal)) {
      throw new Error("favorite ordinals must be integers");
    }
    if (request.fromOrdinal < 0 || request.toOrdinal! < request.fromOrdinal) {
      throw new Error("favorite ordinal range is invalid");
    }
  }
}

function normalizeTopic(topic: string | undefined): string | null {
  const value = topic?.trim();
  return value ? value : null;
}

function findSession(db: DB, target: StableSessionRef): { id: number } | null {
  return db
    .prepare(`SELECT id FROM sessions WHERE harness=? AND native_id=?`)
    .get(target.harness, target.nativeId) as { id: number } | null;
}

export function materializeSpan(db: DB, request: FavoriteRequest, defaultSpan: number = 6): MaterializedSpan | null {
  const session = findSession(db, request);
  if (!session) return null;

  type MessageRow = { ordinal: number; role: string; text: string | null; tool_text: string | null };
  let rows: MessageRow[];
  if (request.fromOrdinal !== undefined && request.toOrdinal !== undefined) {
    rows = db
      .prepare(
        `SELECT ordinal, role, text, tool_text FROM messages
         WHERE session_id=? AND ordinal BETWEEN ? AND ? ORDER BY ordinal`,
      )
      .all(session.id, request.fromOrdinal, request.toOrdinal) as MessageRow[];
  } else if (request.wholeSession) {
    rows = db
      .prepare(`SELECT ordinal, role, text, tool_text FROM messages WHERE session_id=? ORDER BY ordinal`)
      .all(session.id) as MessageRow[];
  } else {
    const limit = Math.max(1, Math.floor(defaultSpan));
    rows = (db
      .prepare(
        `SELECT ordinal, role, text, tool_text FROM messages
         WHERE session_id=? ORDER BY ordinal DESC LIMIT ?`,
      )
      .all(session.id, limit) as MessageRow[]).reverse();
  }
  if (rows.length === 0) return null;

  // Text/tool payloads are copied without rewriting or truncation.  The small
  // ordinal/role envelope makes a detached favorite intelligible after pruning.
  // Records whose payload the archive compacted away (tool calls, control
  // events) fold into one line per run instead of a column of empty envelopes.
  const blocks: string[] = [];
  let empty: MessageRow[] = [];
  const flushEmpty = () => {
    if (empty.length === 0) return;
    const first = empty[0]!.ordinal;
    const last = empty[empty.length - 1]!.ordinal;
    const roles = [...new Set(empty.map((row) => row.role))].join("/");
    blocks.push(`[${first === last ? first : `${first}-${last}`}] ${roles} x${empty.length} (payload not archived)`);
    empty = [];
  };
  for (const row of rows) {
    const payload = [row.text, row.tool_text].filter((value): value is string => value !== null && value !== "").join("\n");
    if (payload === "") { empty.push(row); continue; }
    flushEmpty();
    blocks.push(`[${row.ordinal}] ${row.role}:\n${payload}`);
  }
  flushEmpty();
  const text = blocks.join("\n\n");
  return {
    fromOrdinal: request.wholeSession ? null : rows[0]!.ordinal,
    toOrdinal: request.wholeSession ? null : rows[rows.length - 1]!.ordinal,
    text,
    hash: createHash("sha256").update(text).digest("hex"),
  };
}

function materializeWholeSessionMarker(db: DB, request: FavoriteRequest): MaterializedSpan | null {
  const session = findSession(db, request);
  if (!session) return null;
  const message = db.prepare(`SELECT 1 AS present FROM messages WHERE session_id=? LIMIT 1`).get(session.id) as
    | { present: number }
    | null;
  if (!message) return null;
  return {
    fromOrdinal: null,
    toOrdinal: null,
    text: WHOLE_SESSION_FAVORITE_MARKER,
    hash: createHash("sha256").update(WHOLE_SESSION_FAVORITE_MARKER).digest("hex"),
  };
}

function upsertFavorite(
  db: DB,
  request: FavoriteRequest,
  topic: string | null,
  span: MaterializedSpan | null,
  now: number,
  error: string | null,
): FavoriteRecord {
  const from = span?.fromOrdinal ?? request.fromOrdinal ?? null;
  const to = span?.toOrdinal ?? request.toOrdinal ?? null;
  const existing = db
    .prepare(
      `SELECT * FROM favorites
       WHERE harness=? AND native_id=?
         AND COALESCE(from_ordinal,-1)=COALESCE(?,-1)
         AND COALESCE(to_ordinal,-1)=COALESCE(?,-1)
         AND COALESCE(topic,'')=COALESCE(?,'')`,
    )
    .get(request.harness, request.nativeId, from, to, topic) as FavoriteRow | null;

  if (existing) {
    db.prepare(
      `UPDATE favorites SET span_text=?, span_hash=?, status=?, updated_at=?, last_error=? WHERE id=?`,
    ).run(span?.text ?? existing.span_text, span?.hash ?? existing.span_hash, span ? "ok" : "pending", now, error, existing.id);
    return getFavorite(db, existing.id)!;
  }

  const result = db.prepare(
    `INSERT INTO favorites(
       harness,native_id,from_ordinal,to_ordinal,span_text,span_hash,topic,scope,
       status,created_at,updated_at,last_error
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    request.harness,
    request.nativeId,
    from,
    to,
    span?.text ?? null,
    span?.hash ?? null,
    topic,
    request.wholeSession ? "session" : request.fromOrdinal !== undefined ? "span" : "tail",
    span ? "ok" : "pending",
    now,
    now,
    error,
  );
  return getFavorite(db, Number(result.lastInsertRowid))!;
}

interface FavoriteRow {
  id: number;
  harness: string;
  native_id: string;
  from_ordinal: number | null;
  to_ordinal: number | null;
  span_text: string | null;
  span_hash: string | null;
  topic: string | null;
  scope: "tail" | "span" | "session";
  status: "ok" | "pending";
  created_at: number;
  updated_at: number;
  last_error: string | null;
}

function mapRow(row: FavoriteRow): FavoriteRecord {
  return {
    id: row.id,
    harness: row.harness,
    nativeId: row.native_id,
    fromOrdinal: row.from_ordinal,
    toOrdinal: row.to_ordinal,
    spanText: row.span_text,
    spanHash: row.span_hash,
    topic: row.topic,
    scope: row.scope,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  };
}
