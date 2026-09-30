/**
 * Schema + migrations. Source of truth for the core's data shape.
 *
 * Law 1: the index is a cache; favorites and chain links are user data.
 * Favorites therefore link by (harness, native_id) — never by the
 * surrogate session id, which may be re-created on rebuild.
 *
 * Law 10 offset discipline is enforced in the ingest layer, not here, but
 * ingest_state.offset is the column it advances.
 *
 * M0 ships schema v1: every table present (empty is fine, present is
 * mandatory — per BUILD.md, retrofitting FTS means a full re-ingest).
 */

import { V12_SEARCH_SCHEMA_SQL, V13_EFFICIENT_SEARCH_TRIGGER_SQL } from "../search/v12-fts.js";

export interface Migration {
  version: number;
  description: string;
  up: string;
}

export const SCHEMA_VERSION_META_KEY = "schema_version";

/**
 * SQLite checks foreign-key child rows during parent deletes. Every child key
 * therefore needs a non-partial index whose leading column is the FK column;
 * without these, replacing one session scans corpus-wide tables once per raw
 * record. Keep this in v13 because the compact sidecar publisher is the first
 * path that routinely reconstructs large legacy archives in place.
 */
export const V13_FOREIGN_KEY_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_continuity_projection_evidence
  ON continuity_projection(evidence_id);
CREATE INDEX IF NOT EXISTS idx_lineage_claims_resolved_parent
  ON lineage_claims(resolved_parent_session_id);
CREATE INDEX IF NOT EXISTS idx_logical_messages_representative_message
  ON logical_messages(representative_message_id);
CREATE INDEX IF NOT EXISTS idx_replay_election_evidence_representative_raw
  ON replay_election_evidence(representative_raw_record_id);
CREATE INDEX IF NOT EXISTS idx_replay_election_members_raw
  ON replay_election_members(raw_record_id);
CREATE INDEX IF NOT EXISTS idx_session_search_logical_record
  ON session_search_documents(logical_record_id);
CREATE INDEX IF NOT EXISTS idx_session_search_representative_raw
  ON session_search_documents(representative_raw_record_id);
CREATE INDEX IF NOT EXISTS idx_session_tags_tag
  ON session_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_source_schedule_last_group
  ON source_schedule_state(last_scheduled_group_id);
CREATE INDEX IF NOT EXISTS idx_summary_anchors_summary
  ON summary_anchors(summary_id);
CREATE INDEX IF NOT EXISTS idx_tag_candidates_session
  ON tag_candidates(session_id);
`;

const FTS_TRIGGERS = `
-- FTS5 external-content sync. Law: index USER + ASSISTANT text only;
-- tool/system output is stored and readable in messages but never indexed
-- (index bloat, QA r2.2/F10). WHEN clauses keep non-prose rows out of both
-- insert and delete, so a delete on a tool row is a clean no-op.
CREATE TRIGGER IF NOT EXISTS messages_fts_ai
  AFTER INSERT ON messages
  WHEN new.role IN ('user','assistant')
BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_ad
  AFTER DELETE ON messages
  WHEN old.role IN ('user','assistant')
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_fts_au
  AFTER UPDATE ON messages
  WHEN old.role IN ('user','assistant') OR new.role IN ('user','assistant')
BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "M0 skeleton: full table set incl. FTS5 + triggers, jobs, favorites",
    up: `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  harness         TEXT NOT NULL,
  native_id       TEXT NOT NULL,
  project         TEXT,
  cwd             TEXT,
  source_path     TEXT NOT NULL,
  source_root     TEXT,
  title           TEXT,
  start_ts        INTEGER,
  end_ts          INTEGER,
  last_activity   INTEGER,
  duration_ms     INTEGER,
  models          TEXT,            -- JSON array of model ids (consistency, Law 5)
  tok_user        INTEGER NOT NULL DEFAULT 0,
  tok_assistant   INTEGER NOT NULL DEFAULT 0,
  tok_tool        INTEGER NOT NULL DEFAULT 0,
  msg_count       INTEGER NOT NULL DEFAULT 0,
  engagement      REAL,            -- user / (user+assistant); tool excluded
  chain_id        INTEGER,
  orphaned        INTEGER NOT NULL DEFAULT 0,
  transcript_bytes INTEGER NOT NULL DEFAULT 0,
  ingested_at     INTEGER NOT NULL,
  UNIQUE (harness, native_id)       -- session identity = (harness, native_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_activity DESC, id);

CREATE TABLE IF NOT EXISTS chains (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_count    INTEGER NOT NULL DEFAULT 0,
  first_ts        INTEGER,
  last_ts         INTEGER,
  tok_total       INTEGER NOT NULL DEFAULT 0,
  head_session_id INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  role          TEXT NOT NULL,     -- 'user' | 'assistant' | 'tool' | 'system'
  ts            INTEGER,
  text          TEXT,              -- prose only (text blocks): FTS-indexed for user/assistant
  tool_text     TEXT,              -- tool output (tool_result content): stored, readable, never FTS-indexed
  has_tool      INTEGER NOT NULL DEFAULT 0,
  tok_estimate  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ordinal);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='id', tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS summaries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tier              INTEGER NOT NULL,   -- 1 = topic line, 2 = anchored
  topic_line        TEXT,
  body              TEXT,
  msg_count_covered INTEGER NOT NULL DEFAULT 0,
  model             TEXT,
  generated_at      INTEGER,
  UNIQUE (session_id, tier)
);

CREATE TABLE IF NOT EXISTS summary_anchors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  summary_id    INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
  ord           INTEGER NOT NULL,
  topic         TEXT NOT NULL,
  from_ordinal  INTEGER NOT NULL,
  to_ordinal    INTEGER NOT NULL,
  body          TEXT
);

CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  promoted_at INTEGER
);

CREATE TABLE IF NOT EXISTS session_tags (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, tag_id)
);

CREATE TABLE IF NOT EXISTS tag_candidates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE (name, session_id)
);

CREATE TABLE IF NOT EXISTS favorites (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  harness      TEXT NOT NULL,
  native_id    TEXT NOT NULL,
  from_ordinal INTEGER,
  to_ordinal   INTEGER,
  span_text    TEXT,
  topic        TEXT,
  status       TEXT NOT NULL DEFAULT 'ok',  -- 'ok' | 'pending'
  created_at   INTEGER NOT NULL,
  UNIQUE (harness, native_id, from_ordinal, to_ordinal, topic)
);

CREATE TABLE IF NOT EXISTS ingest_state (
  source      TEXT NOT NULL,
  root        TEXT NOT NULL,
  rel_path    TEXT NOT NULL,
  offset      INTEGER NOT NULL DEFAULT 0,
  mtime       INTEGER,
  size        INTEGER,
  ingested_at INTEGER,
  native_id   TEXT,
  PRIMARY KEY (source, root, rel_path)
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source         TEXT NOT NULL,
  root           TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  finished_at    INTEGER,
  reachable      INTEGER NOT NULL DEFAULT 0,
  sessions_seen  INTEGER NOT NULL DEFAULT 0,
  bytes_consumed INTEGER NOT NULL DEFAULT 0,
  error          TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  session_id  INTEGER,
  scope       TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  provider    TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);

${FTS_TRIGGERS}
`,
  },
  {
    version: 2,
    description: "M1: chain lineage edge (parent_native_id) for chain assembly",
    up: `
ALTER TABLE sessions ADD COLUMN parent_native_id TEXT;
`,
  },
  {
    version: 3,
    description: "M6: durable favorite identity, validation, and materialization metadata",
    up: `
-- SQLite treats NULLs as distinct in UNIQUE constraints.  Rebuild the table
-- so old whole-session duplicates collapse before installing the normalized
-- expression index used by every future writer.
ALTER TABLE favorites RENAME TO favorites_v2_legacy;

CREATE TABLE favorites (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  harness      TEXT NOT NULL,
  native_id    TEXT NOT NULL,
  from_ordinal INTEGER,
  to_ordinal   INTEGER,
  span_text    TEXT,
  span_hash    TEXT,
  topic        TEXT,
  scope        TEXT NOT NULL DEFAULT 'session',
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_error   TEXT,
  CHECK (status IN ('ok', 'pending')),
  CHECK (scope IN ('tail', 'span', 'session')),
  CHECK (
    (from_ordinal IS NULL AND to_ordinal IS NULL) OR
    (from_ordinal IS NOT NULL AND to_ordinal IS NOT NULL AND
     from_ordinal >= 0 AND to_ordinal >= from_ordinal)
  ),
  CHECK (status != 'ok' OR span_text IS NOT NULL),
  CHECK (span_hash IS NULL OR length(span_hash) = 64)
);

INSERT INTO favorites(
  harness, native_id, from_ordinal, to_ordinal, span_text, span_hash,
  topic, scope, status, created_at, updated_at, last_error
)
SELECT
  harness,
  native_id,
  from_ordinal,
  to_ordinal,
  MAX(span_text),
  NULL,
  NULLIF(topic, ''),
  CASE WHEN from_ordinal IS NULL THEN 'session' ELSE 'span' END,
  CASE WHEN MAX(span_text) IS NULL THEN 'pending' ELSE 'ok' END,
  MIN(created_at),
  MAX(created_at),
  CASE WHEN MAX(span_text) IS NULL THEN 'awaiting session ingest' ELSE NULL END
FROM favorites_v2_legacy
GROUP BY
  harness, native_id,
  COALESCE(from_ordinal, -1), COALESCE(to_ordinal, -1), COALESCE(topic, '');

DROP TABLE favorites_v2_legacy;

CREATE UNIQUE INDEX idx_favorites_stable_span
  ON favorites(
    harness,
    native_id,
    COALESCE(from_ordinal, -1),
    COALESCE(to_ordinal, -1),
    COALESCE(topic, '')
  );
CREATE INDEX idx_favorites_status ON favorites(status, updated_at);
CREATE INDEX idx_favorites_stable ON favorites(harness, native_id);
CREATE INDEX IF NOT EXISTS idx_sessions_stable_identity ON sessions(harness, native_id);
`,
  },
  {
    version: 4,
    description: "M5: cited tag synthesis cache with provider provenance",
    up: `
CREATE TABLE IF NOT EXISTS tag_syntheses (
  tag_id       INTEGER PRIMARY KEY REFERENCES tags(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  model        TEXT NOT NULL,
  provider     TEXT,
  citations    TEXT NOT NULL,
  session_ids  TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  CHECK (length(trim(body)) > 0),
  CHECK (json_valid(citations)),
  CHECK (json_valid(session_ids))
);
CREATE INDEX IF NOT EXISTS idx_tag_syntheses_generated
  ON tag_syntheses(generated_at DESC);

CREATE TABLE IF NOT EXISTS tag_merge_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  target_name  TEXT NOT NULL,
  source_names TEXT NOT NULL,
  snapshot     TEXT NOT NULL,
  model        TEXT NOT NULL,
  provider     TEXT,
  created_at   INTEGER NOT NULL,
  reverted_at  INTEGER,
  CHECK (json_valid(source_names)),
  CHECK (json_valid(snapshot))
);
CREATE INDEX IF NOT EXISTS idx_tag_merge_events_created
  ON tag_merge_events(created_at DESC);
`,
  },
  {
    version: 5,
    description: "Session provenance classification for human and agent-created runs",
    up: `
ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'unknown'
  CHECK (origin IN ('human', 'agent', 'mixed', 'unknown'));
ALTER TABLE sessions ADD COLUMN origin_detail TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_origin_last
  ON sessions(origin, last_activity DESC, id);
`,
  },
  {
    version: 6,
    description: "Auditable conservative human-session classification, separate from provenance",
    up: `
CREATE TABLE IF NOT EXISTS session_human_classifications (
  session_id       INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  decision         TEXT NOT NULL CHECK (decision IN ('human', 'agent')),
  confidence       REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  reason           TEXT NOT NULL,
  method           TEXT NOT NULL CHECK (method IN ('glm-human-promotion', 'conservative-default')),
  model            TEXT NOT NULL,
  runner           TEXT NOT NULL,
  origin_snapshot  TEXT NOT NULL CHECK (origin_snapshot IN ('human', 'agent', 'mixed', 'unknown')),
  input_hash       TEXT NOT NULL CHECK (length(input_hash) = 64),
  classified_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_human_classifications_decision
  ON session_human_classifications(decision, classified_at DESC, session_id);
`,
  },
  {
    version: 7,
    description: "Covering token-total index for cold list percentile normalization",
    up: `
CREATE INDEX IF NOT EXISTS idx_sessions_token_total
  ON sessions((tok_user + tok_assistant + tok_tool), id);
`,
  },
  {
    version: 8,
    description: "Replay-aware logical message identities and derived metrics",
    up: `
-- Raw transcript rows remain authoritative and retain their historical metrics.
-- These evidence columns let a rebuild derive a separate logical projection
-- without guessing from prose text.
ALTER TABLE messages ADD COLUMN source_record_id TEXT;
ALTER TABLE messages ADD COLUMN source_record_uuid TEXT;
ALTER TABLE messages ADD COLUMN source_record_ts INTEGER;
ALTER TABLE messages ADD COLUMN source_identity_kind TEXT NOT NULL DEFAULT 'none'
  CHECK (source_identity_kind IN ('uuid', 'record-id', 'message-id', 'none'));
CREATE INDEX IF NOT EXISTS idx_messages_source_identity
  ON messages(session_id, source_identity_kind, source_record_id, source_record_ts);

CREATE TABLE IF NOT EXISTS logical_messages (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id               INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  representative_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  logical_ordinal          INTEGER NOT NULL,
  logical_key              TEXT NOT NULL,
  identity_kind            TEXT NOT NULL CHECK (identity_kind IN ('uuid', 'record-id', 'message-id', 'none')),
  source_record_id         TEXT,
  source_record_uuid       TEXT,
  source_record_ts         INTEGER,
  member_count             INTEGER NOT NULL DEFAULT 1,
  replay_count             INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, logical_key),
  UNIQUE (session_id, logical_ordinal)
);
CREATE INDEX IF NOT EXISTS idx_logical_messages_session
  ON logical_messages(session_id, logical_ordinal);

CREATE TABLE IF NOT EXISTS logical_message_members (
  logical_message_id INTEGER NOT NULL REFERENCES logical_messages(id) ON DELETE CASCADE,
  message_id         INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  raw_ordinal        INTEGER NOT NULL,
  is_replay          INTEGER NOT NULL DEFAULT 0 CHECK (is_replay IN (0, 1)),
  PRIMARY KEY (logical_message_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_logical_members_message
  ON logical_message_members(message_id);

CREATE TABLE IF NOT EXISTS logical_metrics (
  session_id             INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  logical_tok_user       INTEGER NOT NULL DEFAULT 0,
  logical_tok_assistant  INTEGER NOT NULL DEFAULT 0,
  logical_tok_tool       INTEGER NOT NULL DEFAULT 0,
  logical_tool_call_count INTEGER NOT NULL DEFAULT 0,
  logical_msg_count      INTEGER NOT NULL DEFAULT 0,
  logical_replay_count   INTEGER NOT NULL DEFAULT 0,
  logical_identity_count INTEGER NOT NULL DEFAULT 0,
  logical_unknown_count  INTEGER NOT NULL DEFAULT 0,
  identity_status        TEXT NOT NULL CHECK (identity_status IN ('complete', 'partial')),
  computed_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logical_metrics_status
  ON logical_metrics(identity_status, computed_at DESC);

-- Existing archives have no source identity evidence until their next full
-- source ingest. Seed a conservative, non-deduplicated projection so opening
-- a v7 archive never makes logical metrics disappear. The next rebuild replaces
-- these raw-only rows with evidence-backed rows where adapters can provide it.
INSERT INTO logical_messages(
  session_id, representative_message_id, logical_ordinal, logical_key,
  identity_kind, source_record_id, source_record_uuid, source_record_ts,
  member_count, replay_count
)
SELECT session_id, id, ordinal, 'raw:' || id, 'none',
       source_record_id, source_record_uuid, source_record_ts, 1, 0
FROM messages;
INSERT INTO logical_message_members(logical_message_id, message_id, raw_ordinal, is_replay)
SELECT lm.id, lm.representative_message_id, m.ordinal, 0
FROM logical_messages lm JOIN messages m ON m.id = lm.representative_message_id;
INSERT INTO logical_metrics(
  session_id, logical_tok_user, logical_tok_assistant, logical_tok_tool,
  logical_tool_call_count, logical_msg_count, logical_replay_count, logical_identity_count,
  logical_unknown_count, identity_status, computed_at
)
SELECT s.id, s.tok_user, s.tok_assistant, s.tok_tool, 0, s.msg_count, 0, 0,
       s.msg_count, 'partial', CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sessions s;
`,
  },
  {
    version: 9,
    description: "Explicit continuity evidence with rebuildable reset/archive projection state",
    up: `
-- Continuity evidence is derived only from explicit source records. It is kept
-- separately from the projection so an explicit reset can clear Atlas state
-- without destroying evidence needed for a later rebuild.
CREATE TABLE IF NOT EXISTS continuity_state (
  session_id       INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  support          TEXT NOT NULL DEFAULT 'unknown'
                   CHECK (support IN ('supported', 'unknown', 'unsupported')),
  archived         INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  reset_generation INTEGER NOT NULL DEFAULT 0,
  reset_at         INTEGER,
  archived_at      INTEGER,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS continuity_evidence (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_key           TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('compaction', 'checkpoint')),
  source_ordinal      INTEGER NOT NULL,
  source_record_id    TEXT,
  source_record_uuid  TEXT,
  source_record_ts    INTEGER,
  source_identity_kind TEXT NOT NULL DEFAULT 'none'
                       CHECK (source_identity_kind IN ('uuid', 'record-id', 'message-id', 'none')),
  detail              TEXT,
  recorded_at         INTEGER NOT NULL,
  UNIQUE (session_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_continuity_evidence_session
  ON continuity_evidence(session_id, source_ordinal, source_record_ts, id);

-- The projection is intentionally disposable. Reset removes only these rows;
-- continuity_evidence, messages, and source files remain untouched.
CREATE TABLE IF NOT EXISTS continuity_projection (
  session_id       INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  evidence_id      INTEGER NOT NULL REFERENCES continuity_evidence(id) ON DELETE CASCADE,
  generation       INTEGER NOT NULL,
  PRIMARY KEY (session_id, evidence_id)
);
CREATE INDEX IF NOT EXISTS idx_continuity_projection_session
  ON continuity_projection(session_id, generation, evidence_id);

INSERT INTO continuity_state(session_id, support, updated_at)
SELECT id, 'unknown', CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM sessions
WHERE NOT EXISTS (SELECT 1 FROM continuity_state c WHERE c.session_id = sessions.id);
`,
  },
  {
    version: 10,
    description: "Repair pre-release logical metrics shape and persist semantic transcript election bytes",
    // Column additions are conditional in applyMigration because some dirty
    // v8 archives already contain one of these pre-release columns.
    up: ``,
  },
  {
    version: 11,
    description: "Contract construction, reconciliation, lineage, and durable job state",
    up: `
-- SessionConstructionState and ProjectKey. Legacy rows fail closed until a
-- source-backed Phase 3 reconciliation publishes a valid generation.
ALTER TABLE sessions ADD COLUMN original_project_key TEXT;
ALTER TABLE sessions ADD COLUMN canonical_project_key TEXT;
ALTER TABLE sessions ADD COLUMN project_key_rule_version TEXT;
ALTER TABLE sessions ADD COLUMN artifact_kind TEXT NOT NULL DEFAULT 'metadata_shell'
  CHECK (artifact_kind IN ('dialogue_history','current_context_projection','metadata_shell'));
ALTER TABLE sessions ADD COLUMN history_completeness TEXT NOT NULL DEFAULT 'unknown'
  CHECK (history_completeness IN ('complete','current_context_only','unknown'));
ALTER TABLE sessions ADD COLUMN construction_generation TEXT NOT NULL DEFAULT 'legacy-v11';
ALTER TABLE sessions ADD COLUMN construction_status TEXT NOT NULL DEFAULT 'invalid'
  CHECK (construction_status IN ('valid','invalid'));
ALTER TABLE sessions ADD COLUMN construction_invalid_reason TEXT;
ALTER TABLE sessions ADD COLUMN default_session_visible INTEGER NOT NULL DEFAULT 0
  CHECK (default_session_visible IN (0,1));
ALTER TABLE sessions ADD COLUMN source_validation_status TEXT NOT NULL DEFAULT 'legacy_unverified'
  CHECK (source_validation_status IN ('current','snapshot_only','legacy_unverified'));
ALTER TABLE sessions ADD COLUMN source_observed_ts INTEGER;
UPDATE sessions SET
  original_project_key=project,
  construction_generation='legacy-v11:' || id,
  construction_invalid_reason='requires_source_reconciliation';
CREATE INDEX idx_sessions_construction_visibility
  ON sessions(construction_status,default_session_visible,last_activity DESC,id);
CREATE INDEX idx_sessions_project_key
  ON sessions(canonical_project_key,last_activity DESC,id);

-- Existing messages remain lossless compatibility storage and are explicitly
-- unclassified. These columns are the v11 RawProvenanceRecord seam; Phase 3
-- replaces the invalid legacy generation atomically from source evidence.
ALTER TABLE messages ADD COLUMN source_ordinal INTEGER;
ALTER TABLE messages ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'unclassified'
  CHECK (record_kind IN (
    'real_user','assistant_dialogue_prose','tool','control_context','telemetry',
    'developer_system','automatic_utility','unclassified'
  ));
ALTER TABLE messages ADD COLUMN dialogue_side TEXT
  CHECK (dialogue_side IS NULL OR dialogue_side IN ('user','assistant'));
ALTER TABLE messages ADD COLUMN prose TEXT;
ALTER TABLE messages ADD COLUMN event_ts INTEGER;
ALTER TABLE messages ADD COLUMN construction_generation TEXT;
UPDATE messages SET
  source_ordinal=ordinal,
  prose=text,
  event_ts=NULL,
  construction_generation=(SELECT construction_generation FROM sessions WHERE sessions.id=messages.session_id);
CREATE INDEX idx_messages_construction
  ON messages(session_id,construction_generation,ordinal);
CREATE INDEX idx_messages_contract_dialogue
  ON messages(session_id,record_kind,ordinal);

CREATE TABLE tool_activities (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_record_id         INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  activity_ordinal      INTEGER NOT NULL,
  activity_kind         TEXT NOT NULL CHECK (activity_kind IN ('call','result','command','attachment','other')),
  tool_name             TEXT,
  tool_text             TEXT,
  source_activity_id    TEXT,
  construction_generation TEXT NOT NULL,
  UNIQUE (raw_record_id,activity_ordinal)
);
CREATE INDEX idx_tool_activities_record
  ON tool_activities(raw_record_id,activity_ordinal);

ALTER TABLE logical_messages ADD COLUMN record_kind TEXT NOT NULL DEFAULT 'unclassified'
  CHECK (record_kind IN (
    'real_user','assistant_dialogue_prose','tool','control_context','telemetry',
    'developer_system','automatic_utility','unclassified'
  ));
ALTER TABLE logical_messages ADD COLUMN dialogue_side TEXT
  CHECK (dialogue_side IS NULL OR dialogue_side IN ('user','assistant'));
ALTER TABLE logical_messages ADD COLUMN identity_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (identity_status IN ('proved','unknown'));
ALTER TABLE logical_messages ADD COLUMN construction_generation TEXT;
ALTER TABLE logical_message_members ADD COLUMN construction_generation TEXT;
UPDATE logical_messages SET
  construction_generation=(SELECT construction_generation FROM sessions WHERE sessions.id=logical_messages.session_id);
UPDATE logical_message_members SET
  construction_generation=(
    SELECT logical_messages.construction_generation
    FROM logical_messages WHERE logical_messages.id=logical_message_members.logical_message_id
  );
CREATE INDEX idx_logical_messages_generation
  ON logical_messages(session_id,construction_generation,logical_ordinal);

CREATE TABLE replay_election_evidence (
  logical_record_id       INTEGER PRIMARY KEY REFERENCES logical_messages(id) ON DELETE CASCADE,
  evidence_rule_version   TEXT NOT NULL,
  source_identity_kind    TEXT NOT NULL CHECK (source_identity_kind IN ('uuid','record-id','message-id','none')),
  source_record_id        TEXT,
  source_record_uuid      TEXT,
  source_record_ts        INTEGER,
  representative_raw_record_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  construction_generation TEXT NOT NULL
);
CREATE TABLE replay_election_members (
  logical_record_id INTEGER NOT NULL REFERENCES replay_election_evidence(logical_record_id) ON DELETE CASCADE,
  raw_record_id     INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  member_ordinal    INTEGER NOT NULL,
  is_representative INTEGER NOT NULL CHECK (is_representative IN (0,1)),
  PRIMARY KEY (logical_record_id,raw_record_id),
  UNIQUE (logical_record_id,member_ordinal)
);

CREATE TABLE construction_metrics (
  session_id                         INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  construction_generation            TEXT NOT NULL,
  raw_provenance_row_count            INTEGER NOT NULL DEFAULT 0 CHECK (raw_provenance_row_count >= 0),
  logical_record_count                INTEGER NOT NULL DEFAULT 0 CHECK (logical_record_count >= 0),
  raw_tool_activity_count             INTEGER NOT NULL DEFAULT 0 CHECK (raw_tool_activity_count >= 0),
  logical_tool_activity_count         INTEGER NOT NULL DEFAULT 0 CHECK (logical_tool_activity_count >= 0),
  raw_prose_bearing_record_count      INTEGER NOT NULL DEFAULT 0 CHECK (raw_prose_bearing_record_count >= 0),
  logical_prose_bearing_record_count  INTEGER NOT NULL DEFAULT 0 CHECK (logical_prose_bearing_record_count >= 0),
  dialogue_turn_count                 INTEGER NOT NULL DEFAULT 0 CHECK (dialogue_turn_count >= 0),
  user_dialogue_turn_count            INTEGER NOT NULL DEFAULT 0 CHECK (user_dialogue_turn_count >= 0),
  assistant_dialogue_turn_count       INTEGER NOT NULL DEFAULT 0 CHECK (assistant_dialogue_turn_count >= 0),
  logical_replay_count                INTEGER NOT NULL DEFAULT 0 CHECK (logical_replay_count >= 0),
  unknown_identity_raw_row_count      INTEGER NOT NULL DEFAULT 0 CHECK (unknown_identity_raw_row_count >= 0),
  computed_at                         INTEGER NOT NULL,
  CHECK (logical_replay_count = raw_provenance_row_count - logical_record_count),
  CHECK (dialogue_turn_count = user_dialogue_turn_count + assistant_dialogue_turn_count),
  CHECK (dialogue_turn_count <= logical_prose_bearing_record_count),
  CHECK (logical_prose_bearing_record_count <= logical_record_count),
  CHECK (logical_record_count <= raw_provenance_row_count),
  CHECK (raw_prose_bearing_record_count <= raw_provenance_row_count),
  CHECK (raw_prose_bearing_record_count >= logical_prose_bearing_record_count),
  CHECK (raw_tool_activity_count >= logical_tool_activity_count)
);
INSERT INTO construction_metrics(session_id,construction_generation,computed_at)
SELECT id,construction_generation,CAST(strftime('%s','now') AS INTEGER)*1000 FROM sessions;

CREATE TABLE atlas_title_overrides (
  harness       TEXT NOT NULL,
  native_id     TEXT NOT NULL,
  value         TEXT NOT NULL CHECK (length(trim(value)) > 0),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (harness,native_id)
);
CREATE TABLE title_evidence (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id                 INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  construction_generation    TEXT NOT NULL,
  authority                  TEXT NOT NULL CHECK (authority IN ('atlas_user_override','source_explicit','real_user_fallback')),
  harness_source_class       TEXT,
  value                      TEXT NOT NULL,
  source_record_id           TEXT,
  source_reference           TEXT,
  source_ordinal             INTEGER,
  eligibility_rule_version   TEXT NOT NULL,
  selected                   INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0,1))
);
CREATE UNIQUE INDEX idx_title_evidence_selected
  ON title_evidence(session_id) WHERE selected=1;
CREATE INDEX idx_title_evidence_generation
  ON title_evidence(session_id,construction_generation,id);

CREATE TABLE lineage_claims (
  session_id                 INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  parent_harness             TEXT NOT NULL,
  parent_native_id           TEXT NOT NULL,
  resolution_status          TEXT NOT NULL CHECK (resolution_status IN ('resolved','unresolved','invalid')),
  resolution_reason          TEXT,
  resolved_parent_session_id INTEGER REFERENCES sessions(id) ON DELETE SET NULL,
  construction_generation    TEXT NOT NULL,
  CHECK ((resolution_status='resolved') = (resolved_parent_session_id IS NOT NULL))
);
CREATE INDEX idx_lineage_parent
  ON lineage_claims(parent_harness,parent_native_id,resolution_status);

-- Reconciliation evidence keeps reachability, completeness, hook latency, and
-- candidate election distinct. Targeted hooks never populate denominators.
CREATE TABLE reconciliation_groups (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  config_digest         TEXT NOT NULL,
  trigger_kind          TEXT NOT NULL CHECK (trigger_kind IN ('scheduled','manual','rebuild')),
  started_at            INTEGER NOT NULL,
  finished_at           INTEGER,
  status                TEXT NOT NULL CHECK (status IN ('running','complete','incomplete','failed')),
  enabled_source_count  INTEGER NOT NULL DEFAULT 0,
  complete_source_count INTEGER NOT NULL DEFAULT 0,
  error                 TEXT
);
CREATE TABLE reconciliation_sources (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id                   INTEGER NOT NULL REFERENCES reconciliation_groups(id) ON DELETE CASCADE,
  source                     TEXT NOT NULL,
  resolution_mode            TEXT NOT NULL CHECK (resolution_mode IN ('builtin','extend','replace','disabled')),
  disabled_reason            TEXT,
  resolved_roots_json        TEXT NOT NULL CHECK (json_valid(resolved_roots_json)),
  status                     TEXT NOT NULL CHECK (status IN ('running','complete','incomplete','disabled','failed')),
  physical_unit_count        INTEGER NOT NULL DEFAULT 0,
  canonical_candidate_count  INTEGER NOT NULL DEFAULT 0,
  admissible_identity_count  INTEGER,
  archived_identity_count    INTEGER,
  duplicate_candidate_count  INTEGER NOT NULL DEFAULT 0,
  rejected_unit_count        INTEGER NOT NULL DEFAULT 0,
  error_unit_count           INTEGER NOT NULL DEFAULT 0,
  snapshot_only_count        INTEGER NOT NULL DEFAULT 0,
  unresolved_lineage_count   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (group_id,source)
);
CREATE TABLE reconciliation_roots (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_source_id   INTEGER NOT NULL REFERENCES reconciliation_sources(id) ON DELETE CASCADE,
  root_ordinal               INTEGER NOT NULL,
  root                       TEXT NOT NULL,
  reachability               TEXT NOT NULL CHECK (reachability IN ('reachable','unreachable','error')),
  started_at                 INTEGER,
  finished_at                INTEGER,
  start_change_token         TEXT,
  end_change_token           TEXT,
  changed_during_walk        INTEGER CHECK (changed_during_walk IS NULL OR changed_during_walk IN (0,1)),
  physical_unit_count        INTEGER NOT NULL DEFAULT 0,
  canonical_candidate_count  INTEGER NOT NULL DEFAULT 0,
  error                      TEXT,
  UNIQUE (reconciliation_source_id,root_ordinal)
);
CREATE TABLE reconciliation_rejections (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_root_id  INTEGER NOT NULL REFERENCES reconciliation_roots(id) ON DELETE CASCADE,
  stable_unit_key          TEXT NOT NULL,
  reason_code              TEXT NOT NULL CHECK (reason_code IN (
    'no_session_envelope','auxiliary_workflow','auxiliary_agent_artifact',
    'malformed_complete_record','unsupported_unit_shape','identity_mismatch'
  )),
  detail                   TEXT,
  UNIQUE (reconciliation_root_id,stable_unit_key,reason_code)
);
CREATE TABLE session_candidate_evidence (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_source_id INTEGER NOT NULL REFERENCES reconciliation_sources(id) ON DELETE CASCADE,
  harness                  TEXT NOT NULL,
  native_id                TEXT NOT NULL,
  root_ordinal             INTEGER NOT NULL,
  rel_path                 TEXT NOT NULL,
  semantic_bytes           INTEGER NOT NULL CHECK (semantic_bytes >= 0),
  candidate_kind           TEXT NOT NULL DEFAULT 'unknown',
  semantic_byte_tie        INTEGER NOT NULL DEFAULT 0 CHECK (semantic_byte_tie IN (0,1)),
  elected                  INTEGER NOT NULL CHECK (elected IN (0,1)),
  election_rule_version    TEXT NOT NULL,
  UNIQUE (reconciliation_source_id,root_ordinal,rel_path)
);
CREATE UNIQUE INDEX idx_session_candidate_winner
  ON session_candidate_evidence(reconciliation_source_id,harness,native_id) WHERE elected=1;
CREATE TABLE targeted_ingest_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  harness       TEXT,
  native_id     TEXT,
  trigger_kind  TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('running','complete','failed')),
  error         TEXT
);
CREATE TABLE source_schedule_state (
  source                 TEXT PRIMARY KEY,
  config_digest          TEXT NOT NULL,
  expected_interval_ms   INTEGER NOT NULL CHECK (expected_interval_ms > 0),
  degraded_after_ms      INTEGER NOT NULL CHECK (degraded_after_ms >= 2 * expected_interval_ms),
  stale_after_ms         INTEGER NOT NULL CHECK (stale_after_ms > degraded_after_ms),
  schedule_kind          TEXT,
  schedule_path          TEXT,
  target_config_path     TEXT NOT NULL,
  target_db_path         TEXT NOT NULL,
  last_scheduled_group_id INTEGER REFERENCES reconciliation_groups(id) ON DELETE SET NULL,
  updated_at             INTEGER NOT NULL
);

ALTER TABLE ingest_state ADD COLUMN construction_generation TEXT;
ALTER TABLE ingest_state ADD COLUMN elected_semantic_bytes INTEGER;
ALTER TABLE continuity_state ADD COLUMN construction_generation TEXT;
ALTER TABLE continuity_evidence ADD COLUMN construction_generation TEXT;
ALTER TABLE continuity_projection ADD COLUMN construction_generation TEXT;
ALTER TABLE chains ADD COLUMN stable_key TEXT;
ALTER TABLE chains ADD COLUMN harness TEXT;
ALTER TABLE chains ADD COLUMN head_native_id TEXT;
CREATE UNIQUE INDEX idx_chains_stable_key ON chains(stable_key) WHERE stable_key IS NOT NULL;
ALTER TABLE summaries ADD COLUMN coverage_basis TEXT NOT NULL DEFAULT 'legacy_msg_count_v1';
ALTER TABLE summaries ADD COLUMN needs_revalidation INTEGER NOT NULL DEFAULT 0
  CHECK (needs_revalidation IN (0,1));

-- Canonical durable work and ordered attempt history. Legacy pending/running
-- rows become blocked until Phase 3 proves provider authorization; this
-- preserves every row while guaranteeing migration causes zero provider calls.
CREATE TABLE job_work (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                TEXT NOT NULL,
  target_harness      TEXT NOT NULL DEFAULT '',
  target_native_id    TEXT NOT NULL DEFAULT '',
  legacy_target_ref   TEXT NOT NULL DEFAULT '',
  normalized_scope    TEXT NOT NULL DEFAULT '',
  input_version       TEXT NOT NULL,
  current_status      TEXT NOT NULL CHECK (current_status IN ('pending','running','blocked','done','failed','superseded')),
  attempt_count       INTEGER NOT NULL DEFAULT 0,
  current_error       TEXT,
  blocked_reason      TEXT,
  provider            TEXT,
  owner_token         TEXT,
  claimed_at          INTEGER,
  heartbeat_at        INTEGER,
  lease_expires_at    INTEGER,
  next_attempt_at     INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (kind,target_harness,target_native_id,legacy_target_ref,normalized_scope,input_version),
  CHECK ((target_harness='') = (target_native_id=''))
);
CREATE INDEX idx_job_work_status ON job_work(current_status,next_attempt_at,created_at);
CREATE TABLE job_attempts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id           INTEGER NOT NULL REFERENCES job_work(id) ON DELETE CASCADE,
  attempt_ordinal   INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending','running','blocked','done','failed','superseded')),
  legacy_status     TEXT,
  provider          TEXT,
  error             TEXT,
  input_revision    TEXT NOT NULL,
  owner_token       TEXT,
  claimed_at        INTEGER,
  heartbeat_at      INTEGER,
  lease_expires_at  INTEGER,
  started_at        INTEGER,
  finished_at       INTEGER,
  created_at        INTEGER NOT NULL,
  UNIQUE (work_id,attempt_ordinal),
  UNIQUE (work_id,id)
);

WITH legacy AS (
  SELECT j.*,
         COALESCE(s.harness,'') AS target_harness,
         COALESCE(s.native_id,'') AS target_native_id,
         CASE WHEN s.id IS NULL AND j.session_id IS NOT NULL THEN CAST(j.session_id AS TEXT) ELSE '' END AS legacy_target_ref,
         COALESCE(NULLIF(trim(j.scope),''),'') AS normalized_scope
  FROM jobs j LEFT JOIN sessions s ON s.id=j.session_id
), grouped AS (
  SELECT kind,target_harness,target_native_id,legacy_target_ref,normalized_scope,
         COUNT(*) AS attempt_count,MIN(created_at) AS created_at,MAX(updated_at) AS updated_at,
         CASE
           WHEN SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END)>0 THEN 'blocked'
           WHEN SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END)>0 THEN 'failed'
           WHEN SUM(CASE WHEN status='done' THEN 1 ELSE 0 END)=COUNT(*) THEN 'done'
           ELSE 'blocked'
         END AS current_status
  FROM legacy
  GROUP BY kind,target_harness,target_native_id,legacy_target_ref,normalized_scope
)
INSERT INTO job_work(
  kind,target_harness,target_native_id,legacy_target_ref,normalized_scope,input_version,
  current_status,attempt_count,current_error,blocked_reason,provider,created_at,updated_at
)
SELECT g.kind,g.target_harness,g.target_native_id,g.legacy_target_ref,g.normalized_scope,'legacy-v1',
       g.current_status,g.attempt_count,
       (SELECT l.last_error FROM legacy l WHERE l.kind=g.kind AND l.target_harness=g.target_harness
         AND l.target_native_id=g.target_native_id AND l.legacy_target_ref=g.legacy_target_ref
         AND l.normalized_scope=g.normalized_scope ORDER BY l.updated_at DESC,l.id DESC LIMIT 1),
       CASE WHEN g.current_status='blocked' THEN 'legacy_provider_authorization_required' ELSE NULL END,
       (SELECT l.provider FROM legacy l WHERE l.kind=g.kind AND l.target_harness=g.target_harness
         AND l.target_native_id=g.target_native_id AND l.legacy_target_ref=g.legacy_target_ref
         AND l.normalized_scope=g.normalized_scope ORDER BY l.updated_at DESC,l.id DESC LIMIT 1),
       g.created_at,g.updated_at
FROM grouped g;

WITH legacy AS (
  SELECT j.*,
         COALESCE(s.harness,'') AS target_harness,
         COALESCE(s.native_id,'') AS target_native_id,
         CASE WHEN s.id IS NULL AND j.session_id IS NOT NULL THEN CAST(j.session_id AS TEXT) ELSE '' END AS legacy_target_ref,
         COALESCE(NULLIF(trim(j.scope),''),'') AS normalized_scope
  FROM jobs j LEFT JOIN sessions s ON s.id=j.session_id
), ranked AS (
  SELECT legacy.*,
         ROW_NUMBER() OVER (
           PARTITION BY kind,target_harness,target_native_id,legacy_target_ref,normalized_scope
           ORDER BY created_at,id
         ) AS attempt_ordinal
  FROM legacy
)
INSERT INTO job_attempts(
  work_id,attempt_ordinal,status,legacy_status,provider,error,input_revision,
  started_at,finished_at,created_at
)
SELECT w.id,r.attempt_ordinal,
       CASE
         WHEN r.status='done' THEN 'done'
         WHEN r.status='failed' THEN 'failed'
         WHEN r.status IN ('pending','running') THEN 'blocked'
         ELSE 'blocked'
       END,
       r.status,r.provider,r.last_error,'legacy-v1',r.created_at,
       CASE WHEN r.status IN ('done','failed') THEN r.updated_at ELSE NULL END,
       r.created_at
FROM ranked r JOIN job_work w
  ON w.kind=r.kind AND w.target_harness=r.target_harness
 AND w.target_native_id=r.target_native_id AND w.legacy_target_ref=r.legacy_target_ref
 AND w.normalized_scope=r.normalized_scope AND w.input_version='legacy-v1';
`,
  },
  {
    version: 12,
    description: "Current-generation logical dialogue and selected-title FTS",
    up: V12_SEARCH_SCHEMA_SQL,
  },
  {
    version: 13,
    description: "Compact ingest evidence for omitted control and tool payloads",
    up: `
ALTER TABLE messages ADD COLUMN content_digest TEXT
  CHECK (content_digest IS NULL OR (length(content_digest)=64 AND content_digest NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE messages ADD COLUMN content_bytes INTEGER CHECK (content_bytes IS NULL OR content_bytes >= 0);
ALTER TABLE messages ADD COLUMN content_token_estimate INTEGER CHECK (content_token_estimate IS NULL OR content_token_estimate >= 0);
ALTER TABLE messages ADD COLUMN source_prose_present INTEGER NOT NULL DEFAULT 0
  CHECK (source_prose_present IN (0,1));
UPDATE messages SET source_prose_present=CASE WHEN prose IS NOT NULL AND length(trim(prose))>0 THEN 1 ELSE 0 END;

ALTER TABLE tool_activities ADD COLUMN payload_digest TEXT
  CHECK (payload_digest IS NULL OR (length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE tool_activities ADD COLUMN payload_bytes INTEGER CHECK (payload_bytes IS NULL OR payload_bytes >= 0);
ALTER TABLE tool_activities ADD COLUMN payload_token_estimate INTEGER CHECK (payload_token_estimate IS NULL OR payload_token_estimate >= 0);
${V13_EFFICIENT_SEARCH_TRIGGER_SQL}
${V13_FOREIGN_KEY_INDEX_SQL}
`,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
