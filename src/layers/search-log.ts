/**
 * Agent search tracking (md's item 4) and corpora on request (item 5).
 *
 * Every Atlas search is logged with its caller: the harness session that ran
 * it (from the environment Claude Code and Codex give their tools), the query,
 * the scope, what it could not see, and the passages it returned — as
 * identities and ordinals, never copied text. A corpus is a saved query +
 * scope whose results are snapshotted the same way, so it costs bytes per hit
 * and re-running it shows what changed.
 */
import type { Database } from "bun:sqlite";
import type { DB } from "../db/index.js";
import type { ListFilter } from "../data-access/session-list.js";
import { createSessionSearchService } from "../search/service.js";
import { openLayersDb } from "./db.js";

export interface Caller { harness: string; nativeId: string | null; agent: string | null }
/** [harness, nativeId, matched logical ordinals] */
export type PassageRef = [string, string, number[]];

export interface SearchRecord {
  surface: string;
  query: string;
  syntax: "literal" | "raw_fts5";
  scope: ListFilter;
  total: number;
  refs: PassageRef[];
  uncovered: Record<string, unknown>;
}

/** Who is searching: an agent session, md at a terminal, or unknown. */
export function callerFromEnv(env: NodeJS.ProcessEnv = process.env, interactive = Boolean(process.stdout.isTTY)): Caller {
  const agent = env.AI_AGENT ?? null;
  const explicit = env.ATLAS_CALLER?.match(/^([a-z0-9-]+):(.+)$/);
  if (explicit) return { harness: explicit[1]!, nativeId: explicit[2]!, agent };
  if (env.CODEX_THREAD_ID) return { harness: "codex", nativeId: env.CODEX_THREAD_ID, agent };
  if (env.CLAUDE_CODE_SESSION_ID) return { harness: "claude", nativeId: env.CLAUDE_CODE_SESSION_ID, agent };
  if (env.CLAUDECODE === "1") return { harness: "claude", nativeId: null, agent };
  return { harness: interactive ? "human" : "unknown", nativeId: null, agent };
}

/** What a search could not see. Cheap: one MAX over sessions plus the request itself. */
export function uncoveredScope(archive: DB, filter: ListFilter, total: number, returned: number, now = Date.now()): Record<string, unknown> {
  const newest = (archive.query(`SELECT MAX(ingested_at) AS at FROM sessions`).get() as { at: number | null }).at;
  const narrowed = Object.keys(filter).filter((k) => filter[k as keyof ListFilter] !== undefined);
  return {
    index_age_min: newest ? Math.round((now - newest) / 60_000) : null,
    ...(narrowed.length ? { filtered_by: narrowed } : {}),
    ...(total > returned ? { truncated: total - returned } : {}),
  };
}

/** Log a search. Never throws: tracking must not break the search itself. */
export function logSearch(dbPath: string, record: SearchRecord, caller = callerFromEnv(), now = Date.now()): number | null {
  if (process.env.ATLAS_SEARCH_LOG === "0") return null;
  try {
    const layers = openLayersDb(dbPath);
    try { return insertSearch(layers, record, caller, now); } finally { layers.close(); }
  } catch { return null; }
}

export function insertSearch(layers: Database, record: SearchRecord, caller: Caller, now: number): number {
  const result = layers.query(`INSERT INTO search_log(at,surface,caller_harness,caller_native_id,caller_agent,query,syntax,scope,total,returned,result_refs,uncovered)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(now, record.surface, caller.harness, caller.nativeId, caller.agent, record.query, record.syntax,
    JSON.stringify(record.scope), record.total, record.refs.length, JSON.stringify(record.refs), JSON.stringify(record.uncovered));
  return Number(result.lastInsertRowid);
}

export function refsFromHits(hits: { compatibility: { harness: string; nativeId: string }; snippets: { logicalOrdinal: number }[] }[]): PassageRef[] {
  return hits.map((hit) => [hit.compatibility.harness, hit.compatibility.nativeId, [...new Set(hit.snippets.map((s) => s.logicalOrdinal))]]);
}

/** Run a query to completion (up to `cap` sessions) and return passage refs. */
export function executeForRefs(archive: DB, query: string, syntax: "literal" | "raw_fts5", scope: ListFilter, cap = 2000): { total: number; refs: PassageRef[] } {
  const service = createSessionSearchService(archive);
  const refs: PassageRef[] = [];
  let cursor: string | null = null, total = 0;
  do {
    const result = service.searchList({ query, syntax, filter: scope, pageSize: 300, cursor });
    if (!result.ok) throw new Error(result.error.message);
    total = result.page.total;
    refs.push(...refsFromHits(result.page.hits));
    cursor = result.page.nextCursor;
  } while (cursor && refs.length < cap);
  return { total, refs: refs.slice(0, cap) };
}

// ---------------------------------------------------------------------------
// Corpora

export interface CorpusDiff { added: PassageRef[]; removed: PassageRef[]; changed: PassageRef[]; kept: number }

export function saveCorpus(layers: Database, input: { name: string; query: string; syntax: "literal" | "raw_fts5"; scope: ListFilter; origin: string; note?: string }, snapshot: { total: number; refs: PassageRef[] }, now = Date.now()): void {
  layers.transaction(() => {
    layers.query(`INSERT INTO corpora(name,query,syntax,scope,origin,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET query=excluded.query, syntax=excluded.syntax, scope=excluded.scope, origin=excluded.origin, note=COALESCE(excluded.note, corpora.note), updated_at=excluded.updated_at`)
      .run(input.name, input.query, input.syntax, JSON.stringify(input.scope), input.origin, input.note ?? null, now, now);
    layers.query(`INSERT OR REPLACE INTO corpus_snapshots(corpus,taken_at,total,refs) VALUES(?,?,?,?)`).run(input.name, now, snapshot.total, JSON.stringify(snapshot.refs));
  })();
}

export interface CorpusRow { name: string; query: string; syntax: "literal" | "raw_fts5"; scope: string; origin: string; note: string | null; created_at: number; updated_at: number }

export function readCorpus(layers: Database, name: string): { corpus: CorpusRow; snapshots: { taken_at: number; total: number; refs: PassageRef[] }[] } | null {
  const corpus = layers.query(`SELECT * FROM corpora WHERE name=?`).get(name) as CorpusRow | null;
  if (!corpus) return null;
  const snapshots = (layers.query(`SELECT taken_at,total,refs FROM corpus_snapshots WHERE corpus=? ORDER BY taken_at`).all(name) as { taken_at: number; total: number; refs: string }[])
    .map((row) => ({ taken_at: row.taken_at, total: row.total, refs: JSON.parse(row.refs) as PassageRef[] }));
  return { corpus, snapshots };
}

export function diffRefs(before: PassageRef[], after: PassageRef[]): CorpusDiff {
  const key = (ref: PassageRef) => `${ref[0]}\u001f${ref[1]}`;
  const old = new Map(before.map((ref) => [key(ref), ref]));
  const next = new Map(after.map((ref) => [key(ref), ref]));
  const diff: CorpusDiff = { added: [], removed: [], changed: [], kept: 0 };
  for (const [k, ref] of next) {
    const prior = old.get(k);
    if (!prior) diff.added.push(ref);
    else if (prior[2].join(",") !== ref[2].join(",")) diff.changed.push(ref);
    else diff.kept++;
  }
  for (const [k, ref] of old) if (!next.has(k)) diff.removed.push(ref);
  return diff;
}
