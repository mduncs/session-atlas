/**
 * Interpretation layers: a derived sidecar database beside the archive.
 *
 * The archive (`atlas.db`) is the corpus. Everything interpreted from it —
 * who started a session, its shape and episodes, paragraph breaks, emergent
 * tags, the agent search log, saved corpora, and md's corrections — lives in
 * `<name>.layers.db` next to it. Layers are rebuildable, never gate archive
 * schema versions, and never rewrite transcript text. Corrections are the only
 * rows here that are not recomputable, so rebuild passes never touch them.
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { DB } from "../db/index.js";

export const LAYERS_SCHEMA_VERSION = 4;

export const LAYERS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS layer_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Who started each session. Keyed by harness identity so rebuilds that renumber
-- archive rows keep their layer.
CREATE TABLE IF NOT EXISTS session_creator (
  harness TEXT NOT NULL,
  native_id TEXT NOT NULL,
  session_id INTEGER NOT NULL,
  started_by TEXT NOT NULL CHECK (started_by IN ('human','agent','unknown')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence TEXT NOT NULL,
  first_human_ordinal INTEGER,
  human_turns INTEGER NOT NULL,
  agent_turns INTEGER NOT NULL,
  harness_turns INTEGER NOT NULL,
  rule_version INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (harness, native_id)
);
CREATE INDEX IF NOT EXISTS idx_session_creator_started ON session_creator(started_by, session_id);

-- Session shape (tiny/worker/conversation/wanderer/marathon) and, for tiny and
-- worker sessions, their provider-free topic.
CREATE TABLE IF NOT EXISTS session_shape (
  harness TEXT NOT NULL,
  native_id TEXT NOT NULL,
  session_id INTEGER NOT NULL,
  shape TEXT NOT NULL CHECK (shape IN ('tiny','worker','conversation','wanderer','marathon')),
  topic TEXT,
  human_turns INTEGER NOT NULL,
  tool_calls INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  compactions INTEGER NOT NULL,
  episodes INTEGER NOT NULL,
  rule_version INTEGER NOT NULL,
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (harness, native_id)
);
CREATE INDEX IF NOT EXISTS idx_session_shape_shape ON session_shape(shape);

-- Episodes of long sessions, anchored to message ordinals. Boundaries are
-- provider-free; label is written later by a model (or md) and survives
-- recomputation while its span is unchanged.
CREATE TABLE IF NOT EXISTS session_episodes (
  harness TEXT NOT NULL,
  native_id TEXT NOT NULL,
  episode INTEGER NOT NULL,
  start_ordinal INTEGER NOT NULL,
  end_ordinal INTEGER NOT NULL,
  start_ts INTEGER,
  end_ts INTEGER,
  human_turns INTEGER NOT NULL,
  boundary TEXT NOT NULL,
  keywords TEXT NOT NULL,
  label TEXT,
  label_source TEXT,
  label_model TEXT,
  labeled_at INTEGER,
  PRIMARY KEY (harness, native_id, episode)
);

-- Display-only paragraph breaks for long unbroken messages. breaks is a JSON
-- array of UTF-16 offsets into the exact stored text where a blank line is
-- shown; the text itself is never rewritten. text_sha256 guards staleness:
-- readers ignore a row whose hash no longer matches the message text.
CREATE TABLE IF NOT EXISTS message_paragraphs (
  harness TEXT NOT NULL,
  native_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text_sha256 TEXT NOT NULL,
  breaks TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (harness, native_id, ordinal)
);

-- md's one-key corrections. Never recomputed; always win over session_creator.
CREATE TABLE IF NOT EXISTS creator_corrections (
  harness TEXT NOT NULL,
  native_id TEXT NOT NULL,
  started_by TEXT NOT NULL CHECK (started_by IN ('human','agent')),
  previous TEXT,
  corrected_at INTEGER NOT NULL,
  PRIMARY KEY (harness, native_id)
);

-- Model verdicts for the creator residue (sessions evidence left unknown).
-- Consulted after md's correction and after a non-unknown evidence verdict.
CREATE TABLE IF NOT EXISTS creator_model (
  harness TEXT NOT NULL,
  native_id TEXT NOT NULL,
  started_by TEXT NOT NULL CHECK (started_by IN ('human','agent','unknown')),
  reason TEXT NOT NULL,
  model TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  PRIMARY KEY (harness, native_id)
);

-- Emergent tags, anchored to episodes (episode -1 = whole session). source is
-- 'model' or 'md'; md's overlays always win and are never recomputed.
CREATE TABLE IF NOT EXISTS episode_tags (
  harness TEXT NOT NULL,
  native_id TEXT NOT NULL,
  episode INTEGER NOT NULL,
  tag TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('model','md')),
  model TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (harness, native_id, episode, tag)
);
CREATE INDEX IF NOT EXISTS idx_episode_tags_tag ON episode_tags(tag);

-- Tag consolidation log: every merge/split/demotion the rubric checker (or md)
-- made, so a broad tag can always be traced back to the detail it absorbed.
CREATE TABLE IF NOT EXISTS tag_merges (
  from_tag TEXT NOT NULL,
  to_tag TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('merge','nest','demote','split','keep')),
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_tag, to_tag, action)
);

-- Durable model jobs. Items are the resumable unit: a call cut off by a usage
-- limit, a crash, or SIGTERM returns its items to pending, never to failed.
CREATE TABLE IF NOT EXISTS layer_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','done','cancelled')),
  paused_until INTEGER,
  pause_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS layer_job_items (
  job_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_layer_job_items_status ON layer_job_items(job_id, status);

-- Every search run through Atlas, and who ran it. caller_* comes from the
-- calling harness's environment (CLAUDE_CODE_SESSION_ID, CODEX_THREAD_ID), so
-- an agent's searches link back to the session that made them. result_refs
-- are identities and ordinals only: [[harness, native_id, [ordinals]], ...].
-- uncovered records what the search could not see (filters, index age, cap).
CREATE TABLE IF NOT EXISTS search_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  surface TEXT NOT NULL,
  caller_harness TEXT NOT NULL,
  caller_native_id TEXT,
  caller_agent TEXT,
  query TEXT NOT NULL,
  syntax TEXT NOT NULL,
  scope TEXT NOT NULL,
  total INTEGER NOT NULL,
  returned INTEGER NOT NULL,
  result_refs TEXT NOT NULL,
  uncovered TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_log_caller ON search_log(caller_harness, caller_native_id, at);
CREATE INDEX IF NOT EXISTS idx_search_log_at ON search_log(at);

-- Corpora: a saved query + scope whose results are snapshotted as passage
-- references (never copied text), so re-running shows what changed.
CREATE TABLE IF NOT EXISTS corpora (
  name TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  syntax TEXT NOT NULL,
  scope TEXT NOT NULL,
  origin TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS corpus_snapshots (
  corpus TEXT NOT NULL REFERENCES corpora(name) ON DELETE CASCADE,
  taken_at INTEGER NOT NULL,
  total INTEGER NOT NULL,
  refs TEXT NOT NULL,
  PRIMARY KEY (corpus, taken_at)
);
`;

/** `/x/atlas.db` → `/x/atlas.layers.db`. */
export function layersPathFor(dbPath: string): string {
  const name = basename(dbPath).replace(/\.(db|sqlite3?)$/i, "");
  return join(dirname(dbPath), `${name}.layers.db`);
}

/** Open (creating if needed) the layers DB for a derivation pass. */
export function openLayersDb(dbPath: string): Database {
  const path = layersPathFor(dbPath);
  const db = new Database(path);
  // Layers quote md's words (paragraphs, labels, search queries): same privacy as the archive.
  try { chmodSync(path, 0o600); } catch { /* not owner: leave as found */ }
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
  // v4: tag_merges gains 'nest' (a subtopic keeps its identity under a parent tag).
  const merges = db.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='tag_merges'`).get() as { sql: string } | null;
  const upgradeMerges = merges !== null && !merges.sql.includes("'nest'");
  if (upgradeMerges) db.exec("ALTER TABLE tag_merges RENAME TO tag_merges_v3");
  db.exec(LAYERS_SCHEMA_SQL);
  if (upgradeMerges) db.exec("INSERT OR IGNORE INTO tag_merges SELECT * FROM tag_merges_v3; DROP TABLE tag_merges_v3;");
  db.query("INSERT OR REPLACE INTO layer_meta(key,value) VALUES('schema_version',?)").run(String(LAYERS_SCHEMA_VERSION));
  return db;
}

/**
 * Attach layers to an archive handle as schema `layers`, so queries can always
 * reference `layers.*`. When no layers file can exist beside the archive, an
 * empty scratch layer is attached instead: same tables, no rows, and every
 * consumer falls back to archive provenance.
 */
/** `create: false` never writes: an existing sidecar attaches through the (read-only) archive handle. */
export function attachLayers(db: DB, dbPath: string | null, options: { create?: boolean } = {}): "file" | "empty" {
  if (isAttached(db)) return "file";
  if (dbPath === ":memory:") {
    // An in-memory archive (tests, scratch) gets private in-memory layers.
    db.exec("ATTACH DATABASE ':memory:' AS layers");
    db.exec(LAYERS_SCHEMA_SQL.replace(/CREATE (TABLE|INDEX) IF NOT EXISTS /g, "CREATE $1 IF NOT EXISTS layers."));
    return "empty";
  }
  // Schema creation goes through a separate writable handle: a read-only
  // archive handle cannot create tables in anything it attaches.
  if (dbPath) {
    if (options.create !== false) try { openLayersDb(dbPath).close(); } catch { /* read-only volume: use the empty layer */ }
    const path = layersPathFor(dbPath);
    if (existsSync(path)) {
      db.query("ATTACH DATABASE ? AS layers").run(path);
      return "file";
    }
  }
  const empty = join(tmpdir(), `atlas-empty-layers-${LAYERS_SCHEMA_VERSION}-${process.pid}.layers.db`);
  if (!existsSync(empty)) openLayersDb(empty.replace(/\.layers\.db$/, ".db")).close();
  db.query("ATTACH DATABASE ? AS layers").run(empty);
  return "empty";
}

function isAttached(db: DB): boolean {
  return (db.query("PRAGMA database_list").all() as { name: string }[]).some((row) => row.name === "layers");
}
