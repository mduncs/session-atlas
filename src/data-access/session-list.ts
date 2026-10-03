/**
 * Shared session-list data access — mechanically extracted from the TUI. Keyset pagination (NO OFFSET
 * anywhere — SPEC §5 perf mechanics), percentile saturation at query time
 * (SPEC trap #7: exact percent-rank over the filtered corpus, fed by a small
 * covering index and cached per refresh; no materialized percentile column
 * to keep coherent).
 */
import type { DB } from "../db/index.js";
import { getLastWrite } from "../db/index.js";
import type { SessionOrigin } from "../adapters/types.js";
import { effectiveSessionOriginSql } from "../human-classifier.js";
import { creatorJoinSql } from "../layers/creator-sql.js";
import { compileFtsQuery } from "../fts-query.js";
import { createSessionSearchService } from "../search/service.js";
import {
  applyFilterTerm,
  compileSessionFilter,
  listFilterKey,
  normalizeListFilter,
  removeFilterTerm,
  type ChainFilter,
  type DateFilter,
  type FilterTerm,
  type ListFilter,
  type SessionStateFilter,
} from "../search/compiler.js";
import { sessionKey, type SessionKey, type SessionRow } from "../tui/domain.js";
export type { SessionRow } from "../tui/domain.js";
export {
  applyFilterTerm,
  listFilterKey,
  removeFilterTerm,
  type ChainFilter,
  type DateFilter,
  type FilterTerm,
  type ListFilter,
  type SessionStateFilter,
} from "../search/compiler.js";

export interface Page {
  rows: SessionRow[];
  hasMore: boolean;
  /** Truthful filtered total; present for semantic search pages. */
  total?: number;
  /** Designed render-safe failure, most commonly malformed FTS5 syntax. */
  error?: ListQueryError;
}

export interface ListQueryError {
  kind: "invalid-search" | "query-failed";
  message: string;
  query: string | null;
  recoverable: true;
}

export interface SessionKeysResult {
  keys: SessionKey[];
  error?: ListQueryError;
}

const PAGE_SIZE = 300;
const searchCursorCaches = new WeakMap<object, Map<string, string>>();

export interface CompiledListFilter {
  joins: string[];
  joinParams: Array<string | number>;
  predicates: string[];
  predicateParams: Array<string | number>;
}

/** Compile narrowing atoms through the same v12 query and filter compilers. */
export function compileListFilter(filter: ListFilter, alias = "s"): CompiledListFilter {
  const normalized = normalizeListFilter(filter);
  const compiled = compileSessionFilter(normalized, alias, { semantic: false });
  const joins: string[] = [];
  const joinParams: Array<string | number> = [];
  if (filter.query) {
    const query = compileFtsQuery(filter.query, "literal");
    joins.push(`JOIN (
      SELECT d.session_id AS sid
      FROM session_search_fts
      JOIN session_search_documents d ON d.id=session_search_fts.rowid
      WHERE session_search_fts MATCH ?
      GROUP BY d.session_id
    ) f ON f.sid=${alias}.id`);
    joinParams.push(query.match);
  }
  return {
    joins,
    joinParams,
    predicates: compiled.predicates,
    predicateParams: compiled.params,
  };
}

// ---- per-refresh percentile cache (trap #7) ----
interface PercentileCache {
  token: number;
  byFilter: Map<string, Map<number, number>>;
}

// A process can open isolated/test databases with the same revision token.
// Cache by connection identity first so one archive can never lend another
// archive a same-id percentile map.
const pctCaches = new WeakMap<object, PercentileCache>();
const MAX_PERCENTILE_FILTERS = 4;

interface PercentileInput {
  id: number;
  total: number;
}

/** Exact SQLite percent_rank semantics, including tied token totals. */
export function buildPercentileMap(input: readonly PercentileInput[]): Map<number, number> {
  if (input.length === 0) return new Map();
  const sorted = [...input].sort((left, right) => left.total - right.total || left.id - right.id);
  const denominator = Math.max(1, sorted.length - 1);
  const map = new Map<number, number>();
  let groupStart = 0;
  while (groupStart < sorted.length) {
    let groupEnd = groupStart + 1;
    while (groupEnd < sorted.length && sorted[groupEnd]!.total === sorted[groupStart]!.total) groupEnd++;
    const percentile = sorted.length === 1 ? 0 : groupStart / denominator;
    for (let index = groupStart; index < groupEnd; index++) map.set(sorted[index]!.id, percentile);
    groupStart = groupEnd;
  }
  return map;
}

/** Build/refresh the session→size-percentile map. The ordered token-total
 * projection is index-only for the default archive lens; exact tie handling
 * happens in JS once per revision/filter and is reused across page fetches. */
/** Browse-list titles for a page of search hits: summary topic line, else the display title. */
function listTitles(db: DB, ids: readonly number[]): Map<number, string> {
  if (ids.length === 0) return new Map();
  const rows = db.prepare(
    `SELECT s.id AS id, COALESCE(sm.topic_line, s.title) AS title FROM sessions s
     LEFT JOIN summaries sm ON sm.session_id = s.id AND sm.tier = 1
     WHERE s.id IN (${ids.map(() => "?").join(",")})`,
  ).all(...ids) as Array<{ id: number; title: string | null }>;
  const titles = new Map<number, string>();
  for (const row of rows) if (row.title !== null) titles.set(row.id, row.title);
  return titles;
}

function pctMap(db: DB, filter: ListFilter): Map<number, number> {
  const token = getLastWrite(db);
  const filterKey = listFilterKey(filter);
  let cache = pctCaches.get(db as object);
  if (!cache || cache.token !== token) {
    cache = { token, byFilter: new Map() };
    pctCaches.set(db as object, cache);
  }
  const cached = cache.byFilter.get(filterKey);
  if (cached) {
    cache.byFilter.delete(filterKey);
    cache.byFilter.set(filterKey, cached);
    return cached;
  }

  const compiled = filter.query && !hasV12SearchTables(db)
    ? compileLegacyListFilter(filter)
    : compileListFilter(filter);
  const clause = compiled.predicates.length ? `AND ${compiled.predicates.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT s.id, s.tok_user+s.tok_assistant+s.tok_tool AS total
       FROM sessions s ${compiled.joins.join("\n")} WHERE 1=1 ${clause}
       ORDER BY total, s.id`,
    )
    .all(...compiled.joinParams, ...compiled.predicateParams) as PercentileInput[];
  const map = buildPercentileMap(rows);
  cache.byFilter.set(filterKey, map);
  while (cache.byFilter.size > MAX_PERCENTILE_FILTERS) {
    const oldest = cache.byFilter.keys().next().value;
    if (oldest === undefined) break;
    cache.byFilter.delete(oldest);
  }
  return map;
}

function hasV12SearchTables(db: DB): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_search_fts'`).get();
}

/** Pre-v12 compatibility only; new semantic search has no raw-role fallback. */
function compileLegacyListFilter(filter: ListFilter, alias = "s"): CompiledListFilter {
  if (/^"[^"\n]*$/u.test(filter.query!)) throw new Error("unterminated FTS5 string");
  const compiled = compileSessionFilter(normalizeListFilter({ ...filter, query: null }), alias, { semantic: false });
  const query = compileFtsQuery(filter.query!, "literal");
  // Legacy unicode61 does not preserve punctuation tokenchars, so strip the
  // v12 prose column scope but retain safe literal-default syntax.
  const legacyMatch = query.match.replace(/^prose\s*:\s*\((.*)\)$/u, "$1");
  return {
    joins: [`JOIN (
      SELECT DISTINCT m.session_id AS sid FROM messages_fts
      JOIN messages m ON m.id=messages_fts.rowid WHERE messages_fts MATCH ?
    ) f ON f.sid=${alias}.id`],
    joinParams: [legacyMatch],
    predicates: compiled.predicates,
    predicateParams: compiled.params,
  };
}

export function fetchPage(
  db: DB,
  filter: ListFilter,
  cursor?: { last_activity: number | null; id: number } | null,
  pageSize: number = PAGE_SIZE,
): Page {
  try {
    return fetchPageUnsafe(db, filter, cursor, pageSize);
  } catch (error) {
    return { rows: [], hasMore: false, error: designedListQueryError(error, filter) };
  }
}

function fetchPageUnsafe(
  db: DB,
  filter: ListFilter,
  cursor: { last_activity: number | null; id: number } | null | undefined,
  pageSize: number,
): Page {
  if (filter.query && hasV12SearchTables(db)) return fetchSemanticSearchPage(db, filter, cursor, pageSize);
  const compiled = filter.query && !hasV12SearchTables(db)
    ? compileLegacyListFilter(filter)
    : compileListFilter(filter);
  const clause = compiled.predicates.length ? `AND ${compiled.predicates.join(" AND ")}` : "";

  // Keyset cursor for (last_activity DESC, id DESC). COALESCE so NULL activity
  // sorts deterministically (DESC puts -1 last, matching COALESCE here).
  let cursorClause = "";
  const cursorParams: Array<string | number | null> = [];
  if (cursor) {
    const curLa = cursor.last_activity ?? -1;
    cursorClause = `AND (COALESCE(s.last_activity,-1) < ? OR (COALESCE(s.last_activity,-1) = ? AND s.id < ?))`;
    cursorParams.push(curLa, curLa, cursor.id);
  }

  const sql = `
    SELECT s.id, s.harness, s.native_id, COALESCE(sm.topic_line, s.title) AS title,
           s.cwd, s.project, s.last_activity, s.duration_ms,
           s.tok_user, s.tok_assistant, s.tok_tool,
           (s.tok_user+s.tok_assistant+s.tok_tool) AS tok_total,
           s.msg_count, s.models, s.chain_id, s.engagement, s.orphaned,
           s.origin, s.origin_detail,
           ${effectiveSessionOriginSql("s")} AS effective_origin,
           hc.decision AS classification_decision,
           hc.confidence AS classification_confidence,
           hc.reason AS classification_reason,
           hc.method AS classification_method,
           EXISTS (SELECT 1 FROM favorites fav
                   WHERE fav.harness=s.harness AND fav.native_id=s.native_id) AS favorite
    FROM sessions s
    LEFT JOIN summaries sm ON sm.session_id = s.id AND sm.tier = 1
    ${creatorJoinSql("s")}
    ${compiled.joins.join("\n")}
    WHERE 1=1 ${clause} ${cursorClause}
    ORDER BY s.last_activity DESC, s.id DESC
    LIMIT ?`;
  const args = [...compiled.joinParams, ...compiled.predicateParams, ...cursorParams, pageSize + 1];
  const all = db.prepare(sql).all(...args) as Record<string, unknown>[];

  const hasMore = all.length > pageSize;
  const slice = hasMore ? all.slice(0, pageSize) : all;
  if (slice.length === 0) return { rows: [], hasMore: false };

  // Attach percentile from the per-refresh cache. No firstUser join needed:
  // the ingest-time `s.title` column already holds the first-user fallback
  // (set in every adapter), so COALESCE(summary, ingest-title) covers it.
  const pct = pctMap(db, filter);

  const rows = slice.map((r) => {
    const id = Number(r.id);
    return {
      id,
      harness: String(r.harness),
      native_id: String(r.native_id),
      title: (r.title as string | null) ?? null,
      firstUser: null,
      cwd: (r.cwd as string | null) ?? null,
      project: (r.project as string | null) ?? null,
      last_activity: r.last_activity === null ? null : Number(r.last_activity),
      duration_ms: r.duration_ms === null ? null : Number(r.duration_ms),
      tok_user: Number(r.tok_user),
      tok_assistant: Number(r.tok_assistant),
      tok_tool: Number(r.tok_tool),
      tok_total: Number(r.tok_total),
      msg_count: Number(r.msg_count),
      models: (r.models as string | null) ?? null,
      chain_id: r.chain_id === null ? null : Number(r.chain_id),
      favorite: Number(r.favorite),
      sizePct: pct.get(id) ?? 0,
      engagement: r.engagement === null ? null : Number(r.engagement),
      orphaned: Number(r.orphaned),
      origin: String(r.origin) as SessionOrigin,
      origin_detail: (r.origin_detail as string | null) ?? null,
      effective_origin: String(r.effective_origin) as "human" | "agent",
      classification_confidence: r.classification_confidence === null ? null : Number(r.classification_confidence),
      classification_reason: (r.classification_reason as string | null) ?? null,
      classification_method: (r.classification_method as string | null) ?? null,
    } satisfies SessionRow;
  });
  return { rows, hasMore };
}

function fetchSemanticSearchPage(
  db: DB,
  filter: ListFilter,
  cursor: { last_activity: number | null; id: number } | null | undefined,
  pageSize: number,
): Page {
  const filterKey = listFilterKey(filter);
  let cache = searchCursorCaches.get(db as object);
  if (!cache) {
    cache = new Map();
    searchCursorCaches.set(db as object, cache);
  }
  const opaqueCursor = cursor ? cache.get(`${filterKey}\n${cursor.id}`) : null;
  if (cursor && !opaqueCursor) {
    return {
      rows: [],
      hasMore: false,
      error: {
        kind: "query-failed",
        message: "Search cursor expired; refresh the result set",
        query: filter.query ?? null,
        recoverable: true,
      },
    };
  }
  const result = createSessionSearchService(db).searchList({
    query: filter.query!,
    syntax: "literal",
    filter,
    pageSize,
    cursor: opaqueCursor ?? null,
  });
  if (!result.ok) {
    return {
      rows: [],
      hasMore: false,
      error: {
        kind: result.error.code === "invalid_query" ? "invalid-search" : "query-failed",
        message: result.error.message,
        query: filter.query ?? null,
        recoverable: true,
      },
    };
  }
  const pct = pctMap(db, filter);
  const titles = listTitles(db, result.page.hits.map((hit) => hit.compatibility.id));
  const rows: SessionRow[] = result.page.hits.map((hit) => {
    const value = hit.compatibility;
    return {
      id: value.id,
      harness: value.harness,
      native_id: value.nativeId,
      // Same title the browse list shows; the evidence title can differ.
      title: titles.get(value.id) ?? value.title,
      firstUser: null,
      cwd: value.cwd,
      project: value.project,
      last_activity: value.lastActivity,
      duration_ms: value.durationMs,
      tok_user: value.tokUser,
      tok_assistant: value.tokAssistant,
      tok_tool: value.tokTool,
      tok_total: value.tokUser + value.tokAssistant + value.tokTool,
      // Compatibility field only: it carries the canonical dialogue-turn
      // metric, never legacy sessions.msg_count.
      msg_count: value.dialogueTurnCount,
      models: value.modelsJson,
      chain_id: value.chainId,
      favorite: value.favorite ? 1 : 0,
      sizePct: pct.get(value.id) ?? 0,
      engagement: value.engagement,
      orphaned: value.orphaned,
      origin: value.origin as SessionOrigin,
      origin_detail: value.originDetail,
      effective_origin: value.effectiveOrigin,
      classification_confidence: value.classificationConfidence,
      classification_reason: value.classificationReason,
      classification_method: value.classificationMethod,
    };
  });
  const last = rows.at(-1);
  if (last && result.page.nextCursor) cache.set(`${filterKey}\n${last.id}`, result.page.nextCursor);
  return { rows, hasMore: result.page.nextCursor !== null, total: result.page.total };
}

/**
 * Deliberate whole-filter materialization for the `*` command. Normal list
 * rendering remains keyset-paginated; this query runs only after an explicit
 * select-all gesture and returns stable identities rather than row offsets.
 */
export function fetchAllSessionKeysResult(db: DB, filter: ListFilter): SessionKeysResult {
  try {
    return { keys: fetchAllSessionKeysUnsafe(db, filter) };
  } catch (error) {
    return { keys: [], error: designedListQueryError(error, filter) };
  }
}

/** Compatibility adapter; render paths should prefer `fetchAllSessionKeysResult`. */
export function fetchAllSessionKeys(db: DB, filter: ListFilter): SessionKey[] {
  return fetchAllSessionKeysResult(db, filter).keys;
}

function fetchAllSessionKeysUnsafe(db: DB, filter: ListFilter): SessionKey[] {
  const compiled = filter.query && !hasV12SearchTables(db)
    ? compileLegacyListFilter(filter)
    : compileListFilter(filter);
  const clause = compiled.predicates.length ? `AND ${compiled.predicates.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT DISTINCT s.harness,s.native_id
     FROM sessions s ${compiled.joins.join("\n")}
     WHERE 1=1 ${clause}
     ORDER BY s.last_activity DESC,s.id DESC`,
  ).all(...compiled.joinParams, ...compiled.predicateParams) as Array<{ harness: string; native_id: string }>;
  return rows.map(sessionKey);
}

function designedListQueryError(error: unknown, filter: ListFilter): ListQueryError {
  const detail = error instanceof Error ? error.message : String(error);
  const invalidSearch = !!filter.query && /fts5|unterminated|syntax error|malformed match/i.test(detail);
  if (invalidSearch) {
    return {
      kind: "invalid-search",
      message: `Invalid search syntax: ${filter.query}`,
      query: filter.query ?? null,
      recoverable: true,
    };
  }
  return {
    kind: "query-failed",
    message: `Could not load sessions: ${detail}`,
    query: null,
    recoverable: true,
  };
}

/** Status-line ingest freshness per source (SPEC §5). */
export function sourceFreshness(db: DB): { source: string; ageMs: number | null; reachable: boolean }[] {
  const rows = db
    .prepare(
      `SELECT r.source, MAX(r.finished_at) AS t, MAX(r.reachable) AS reachable
       FROM ingest_runs r GROUP BY r.source`,
    )
    .all() as unknown as { source: string; t: number | null; reachable: number }[];
  return rows.map((r) => ({
    source: r.source,
    ageMs: r.t ? Date.now() - r.t : null,
    reachable: !!r.reachable,
  }));
}

export function pendingJobCount(db: DB): number {
  return (db.prepare(`SELECT COUNT(*) n FROM job_work WHERE current_status='pending'`).get() as { n: number }).n;
}
