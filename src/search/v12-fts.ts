import type { DB } from "../db/index.js";

/**
 * Phase 4's lane-owned schema-v12 fragment. Prime integrates this as migration
 * v12 only after Phase 3 has published clean v11 construction generations.
 * This module deliberately does not register a migration or auto-run on read.
 *
 * v11 construction assumptions:
 * - `sessions` carries the current generation/status/visibility and stable key;
 * - `logical_messages` elects exactly one representative `messages` row;
 * - both logical and raw rows carry matching RecordKind/generation evidence;
 * - `title_evidence.selected=1` is the effective title for that generation.
 */

const UNICODE_WHITESPACE = `char(9)||char(10)||char(11)||char(12)||char(13)||char(32)||char(133)||char(160)||char(5760)||char(8192)||char(8193)||char(8194)||char(8195)||char(8196)||char(8197)||char(8198)||char(8199)||char(8200)||char(8201)||char(8202)||char(8232)||char(8233)||char(8239)||char(8287)||char(12288)`;

const REFRESH_COLUMNS = `
  session_id,logical_record_id,representative_raw_record_id,logical_ordinal,
  side,scope,prose,title,construction_generation`;

function refreshSession(reference: string): string {
  return `
  DELETE FROM session_search_documents WHERE session_id=${reference};
  INSERT INTO session_search_documents(${REFRESH_COLUMNS})
  SELECT ${REFRESH_COLUMNS} FROM v12_search_eligible_documents WHERE session_id=${reference};`;
}

/** Complete tokenizer/table/view/trigger/backfill fragment reserved for v12. */
export const V12_SEARCH_SCHEMA_SQL = `
-- Retire the role-based legacy index. v12 has no role/raw compatibility path.
DROP TRIGGER IF EXISTS messages_fts_ai;
DROP TRIGGER IF EXISTS messages_fts_ad;
DROP TRIGGER IF EXISTS messages_fts_au;
DROP TABLE IF EXISTS messages_fts;

CREATE TABLE session_search_documents (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id                   INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  logical_record_id            INTEGER REFERENCES logical_messages(id) ON DELETE CASCADE,
  representative_raw_record_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  logical_ordinal              INTEGER,
  side                         TEXT CHECK (side IS NULL OR side IN ('user','assistant')),
  scope                        TEXT NOT NULL CHECK (scope IN ('dialogue','title')),
  prose                        TEXT,
  title                        TEXT,
  construction_generation      TEXT NOT NULL,
  CHECK (
    (scope='dialogue' AND logical_record_id IS NOT NULL AND representative_raw_record_id IS NOT NULL
      AND logical_ordinal IS NOT NULL AND side IS NOT NULL AND prose IS NOT NULL AND title IS NULL)
    OR
    (scope='title' AND logical_record_id IS NULL AND representative_raw_record_id IS NULL
      AND logical_ordinal IS NULL AND side IS NULL AND prose IS NULL AND title IS NOT NULL)
  )
);
CREATE UNIQUE INDEX idx_session_search_dialogue_logical
  ON session_search_documents(logical_record_id) WHERE scope='dialogue';
CREATE UNIQUE INDEX idx_session_search_title_session
  ON session_search_documents(session_id) WHERE scope='title';
CREATE INDEX idx_session_search_session_scope
  ON session_search_documents(session_id,scope,logical_ordinal,id);

-- '_+./-' keeps the exact code/path atoms in Census Q01/Q02/Q04/Q06-Q10.
-- Porter still supplies ordinary word stemming; unicode61 supplies case-folding.
CREATE VIRTUAL TABLE session_search_fts USING fts5(
  prose,
  title,
  content='session_search_documents',
  content_rowid='id',
  tokenize = "porter unicode61 tokenchars '_+./-'"
);

CREATE TRIGGER session_search_documents_ai AFTER INSERT ON session_search_documents BEGIN
  INSERT INTO session_search_fts(rowid,prose,title) VALUES (new.id,new.prose,new.title);
END;
CREATE TRIGGER session_search_documents_ad AFTER DELETE ON session_search_documents BEGIN
  INSERT INTO session_search_fts(session_search_fts,rowid,prose,title)
  VALUES ('delete',old.id,old.prose,old.title);
END;
CREATE TRIGGER session_search_documents_au AFTER UPDATE ON session_search_documents BEGIN
  INSERT INTO session_search_fts(session_search_fts,rowid,prose,title)
  VALUES ('delete',old.id,old.prose,old.title);
  INSERT INTO session_search_fts(rowid,prose,title) VALUES (new.id,new.prose,new.title);
END;

-- This view is the single physical eligibility law. Dialogue rows are current
-- valid logical representatives with matching semantic class/side/generation
-- and Unicode-nonblank source-backed prose. Replay members never enter it.
-- Title rows are isolated in a separate indexed column and require explicit
-- title: scope; metadata-only title rows therefore cannot become message hits.
CREATE VIEW v12_search_eligible_documents AS
SELECT
  s.id AS session_id,
  lm.id AS logical_record_id,
  m.id AS representative_raw_record_id,
  lm.logical_ordinal,
  lm.dialogue_side AS side,
  'dialogue' AS scope,
  m.prose,
  NULL AS title,
  s.construction_generation
FROM sessions s
JOIN construction_metrics cm
  ON cm.session_id=s.id
 AND cm.construction_generation=s.construction_generation
JOIN logical_messages lm
  ON lm.session_id=s.id
 AND lm.construction_generation=s.construction_generation
JOIN messages m
  ON m.id=lm.representative_message_id
 AND m.session_id=s.id
 AND m.construction_generation=s.construction_generation
WHERE s.construction_status='valid'
  AND lm.record_kind IN ('real_user','assistant_dialogue_prose')
  AND m.record_kind=lm.record_kind
  AND ((lm.record_kind='real_user' AND lm.dialogue_side='user' AND m.dialogue_side='user')
    OR (lm.record_kind='assistant_dialogue_prose' AND lm.dialogue_side='assistant' AND m.dialogue_side='assistant'))
  AND length(trim(m.prose,${UNICODE_WHITESPACE}))>0
UNION ALL
SELECT
  s.id,
  NULL,
  NULL,
  NULL,
  NULL,
  'title',
  NULL,
  te.value,
  s.construction_generation
FROM sessions s
JOIN title_evidence te
  ON te.session_id=s.id
 AND te.construction_generation=s.construction_generation
 AND te.selected=1
WHERE s.construction_status='valid'
  AND length(trim(te.value,${UNICODE_WHITESPACE}))>0;

-- Rebuild one session's derived documents whenever eligibility evidence can
-- change. Construction publication is transactional, so intermediate trigger
-- work is never visible and the final state is exact at commit.
CREATE TRIGGER session_search_sessions_ai AFTER INSERT ON sessions BEGIN
  ${refreshSession("new.id")}
END;
CREATE TRIGGER session_search_sessions_au AFTER UPDATE ON sessions BEGIN
  ${refreshSession("old.id")}
  ${refreshSession("new.id")}
END;
CREATE TRIGGER session_search_messages_ai AFTER INSERT ON messages BEGIN
  ${refreshSession("new.session_id")}
END;
CREATE TRIGGER session_search_messages_ad AFTER DELETE ON messages BEGIN
  ${refreshSession("old.session_id")}
END;
CREATE TRIGGER session_search_messages_au AFTER UPDATE ON messages BEGIN
  ${refreshSession("old.session_id")}
  ${refreshSession("new.session_id")}
END;
CREATE TRIGGER session_search_logical_ai AFTER INSERT ON logical_messages BEGIN
  ${refreshSession("new.session_id")}
END;
CREATE TRIGGER session_search_logical_ad AFTER DELETE ON logical_messages BEGIN
  ${refreshSession("old.session_id")}
END;
CREATE TRIGGER session_search_logical_au AFTER UPDATE ON logical_messages BEGIN
  ${refreshSession("old.session_id")}
  ${refreshSession("new.session_id")}
END;
CREATE TRIGGER session_search_title_ai AFTER INSERT ON title_evidence BEGIN
  ${refreshSession("new.session_id")}
END;
CREATE TRIGGER session_search_title_ad AFTER DELETE ON title_evidence BEGIN
  ${refreshSession("old.session_id")}
END;
CREATE TRIGGER session_search_title_au AFTER UPDATE ON title_evidence BEGIN
  ${refreshSession("old.session_id")}
  ${refreshSession("new.session_id")}
END;

-- Backfill only after the complete eligibility law and sync triggers exist.
INSERT INTO session_search_documents(${REFRESH_COLUMNS})
SELECT ${REFRESH_COLUMNS} FROM v12_search_eligible_documents;
`;

/**
 * v13 keeps the same eligibility law but suppresses refresh work while an
 * ingest transaction is publishing an explicitly invalid generation. The
 * final invalid→valid session update performs the one required refresh.
 */
export const V13_EFFICIENT_SEARCH_TRIGGER_SQL = `
DROP TRIGGER IF EXISTS session_search_sessions_ai;
DROP TRIGGER IF EXISTS session_search_sessions_au;
DROP TRIGGER IF EXISTS session_search_messages_ai;
DROP TRIGGER IF EXISTS session_search_messages_ad;
DROP TRIGGER IF EXISTS session_search_messages_au;
DROP TRIGGER IF EXISTS session_search_logical_ai;
DROP TRIGGER IF EXISTS session_search_logical_ad;
DROP TRIGGER IF EXISTS session_search_logical_au;
DROP TRIGGER IF EXISTS session_search_title_ai;
DROP TRIGGER IF EXISTS session_search_title_ad;
DROP TRIGGER IF EXISTS session_search_title_au;

CREATE TRIGGER session_search_sessions_ai AFTER INSERT ON sessions
WHEN new.construction_status='valid' BEGIN
  ${refreshSession("new.id")}
END;
CREATE TRIGGER session_search_sessions_au
AFTER UPDATE OF construction_status,construction_generation ON sessions BEGIN
  ${refreshSession("new.id")}
END;
CREATE TRIGGER session_search_messages_ai AFTER INSERT ON messages
WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.id=new.session_id AND s.construction_status='valid') BEGIN
  ${refreshSession("new.session_id")}
END;
CREATE TRIGGER session_search_messages_ad AFTER DELETE ON messages
WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.id=old.session_id AND s.construction_status='valid') BEGIN
  ${refreshSession("old.session_id")}
END;
CREATE TRIGGER session_search_messages_au AFTER UPDATE ON messages
WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.id=new.session_id AND s.construction_status='valid') BEGIN
  ${refreshSession("new.session_id")}
END;
CREATE TRIGGER session_search_logical_ai AFTER INSERT ON logical_messages
WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.id=new.session_id AND s.construction_status='valid') BEGIN
  ${refreshSession("new.session_id")}
END;
CREATE TRIGGER session_search_logical_ad AFTER DELETE ON logical_messages
WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.id=old.session_id AND s.construction_status='valid') BEGIN
  ${refreshSession("old.session_id")}
END;
CREATE TRIGGER session_search_logical_au AFTER UPDATE ON logical_messages
WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.id=new.session_id AND s.construction_status='valid') BEGIN
  ${refreshSession("new.session_id")}
END;
CREATE TRIGGER session_search_title_ai AFTER INSERT ON title_evidence
WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.id=new.session_id AND s.construction_status='valid') BEGIN
  ${refreshSession("new.session_id")}
END;
CREATE TRIGGER session_search_title_ad AFTER DELETE ON title_evidence
WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.id=old.session_id AND s.construction_status='valid') BEGIN
  ${refreshSession("old.session_id")}
END;
CREATE TRIGGER session_search_title_au AFTER UPDATE ON title_evidence
WHEN EXISTS (SELECT 1 FROM sessions s WHERE s.id=new.session_id AND s.construction_status='valid') BEGIN
  ${refreshSession("new.session_id")}
END;
`;

export interface V12SearchValidation {
  expectedDocuments: number;
  actualDocuments: number;
  ftsRows: number;
  missingDocuments: number;
  extraDocuments: number;
  duplicateDialogue: number;
  duplicateTitle: number;
}

/** Read-only mismatch query run after FTS5's own external-content integrity check. */
export const V12_SEARCH_VALIDATION_SQL = `
SELECT
  (SELECT count(*) FROM v12_search_eligible_documents) AS expected_documents,
  (SELECT count(*) FROM session_search_documents) AS actual_documents,
  (SELECT count(*) FROM session_search_fts) AS fts_rows,
  (SELECT count(*) FROM v12_search_eligible_documents e
    WHERE NOT EXISTS (
      SELECT 1 FROM session_search_documents d
      WHERE d.session_id=e.session_id AND d.scope=e.scope
        AND d.logical_record_id IS e.logical_record_id
        AND d.representative_raw_record_id IS e.representative_raw_record_id
        AND d.logical_ordinal IS e.logical_ordinal AND d.side IS e.side
        AND d.prose IS e.prose AND d.title IS e.title
        AND d.construction_generation=e.construction_generation
    )) AS missing_documents,
  (SELECT count(*) FROM session_search_documents d
    WHERE NOT EXISTS (
      SELECT 1 FROM v12_search_eligible_documents e
      WHERE d.session_id=e.session_id AND d.scope=e.scope
        AND d.logical_record_id IS e.logical_record_id
        AND d.representative_raw_record_id IS e.representative_raw_record_id
        AND d.logical_ordinal IS e.logical_ordinal AND d.side IS e.side
        AND d.prose IS e.prose AND d.title IS e.title
        AND d.construction_generation=e.construction_generation
    )) AS extra_documents,
  (SELECT count(*) FROM (
    SELECT logical_record_id FROM session_search_documents WHERE scope='dialogue'
    GROUP BY logical_record_id HAVING count(*)<>1
  )) AS duplicate_dialogue,
  (SELECT count(*) FROM (
    SELECT session_id FROM session_search_documents WHERE scope='title'
    GROUP BY session_id HAVING count(*)<>1
  )) AS duplicate_title;
`;

/** Test/integration helper. Call only inside an explicit isolated migration. */
export function applyV12SearchFragment(db: DB): V12SearchValidation {
  const exists = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_search_documents'`,
  ).get();
  if (!exists) db.exec(V12_SEARCH_SCHEMA_SQL);
  return validateV12SearchIndex(db);
}

export function validateV12SearchIndex(db: DB, options: { ftsIntegrityCheck?: boolean } = {}): V12SearchValidation {
  // rank=1 makes FTS5 compare the external-content rows, not only its index.
  // Read-only post-swap validation sets this false after the writable shadow
  // already ran the command in rebuildIndexes.
  if (options.ftsIntegrityCheck !== false) {
    db.prepare(`INSERT INTO session_search_fts(session_search_fts,rank) VALUES('integrity-check',1)`).run();
  }
  const row = db.prepare(V12_SEARCH_VALIDATION_SQL).get() as Record<string, number>;
  const result: V12SearchValidation = {
    expectedDocuments: Number(row.expected_documents),
    actualDocuments: Number(row.actual_documents),
    ftsRows: Number(row.fts_rows),
    missingDocuments: Number(row.missing_documents),
    extraDocuments: Number(row.extra_documents),
    duplicateDialogue: Number(row.duplicate_dialogue),
    duplicateTitle: Number(row.duplicate_title),
  };
  const values = Object.values(result);
  if (
    result.expectedDocuments !== result.actualDocuments
    || result.actualDocuments !== result.ftsRows
    || values.slice(3).some((value) => value !== 0)
  ) {
    throw new Error(`v12 search validation failed: ${JSON.stringify(result)}`);
  }
  return result;
}
