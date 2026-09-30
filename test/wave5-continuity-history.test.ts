import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/config.js";
import { openDb, runMigrations, type DB } from "../src/db/index.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "../src/db/schema.js";
import { ingest } from "../src/ingest.js";
import {
  archiveContinuityState,
  getContinuityHistory,
  getContinuityState,
  listContinuityHistory,
  rebuildContinuityHistory,
  resetContinuityState,
  restoreContinuityState,
} from "../src/continuity-history.js";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { kiloAdapter, resetKiloCache } from "../src/adapters/kilo.js";
import type {
  Adapter,
  ContinuityEventEvidence,
  IngestRecord,
  NormalizedMessage,
} from "../src/adapters/types.js";

const tempRoots: string[] = [];
let atlas: DB | undefined;

const tunables = {
  tag_promotion_count: 3,
  export_budget_tokens: 20_000,
  fav_default_span: 6,
  summary_stale_pct: 25,
  redact_entropy_threshold: 4.8,
};

function fixture(name: string): { root: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), `atlas-wave5-continuity-${name}-`));
  tempRoots.push(root);
  return { root, dbPath: join(root, "atlas.db") };
}

function config(dbPath: string, sources: Config["sources"]): Config {
  return { sources, providers: [], launchers: [], tunables, dbPath };
}

function message(text: string, ordinal = 0): NormalizedMessage {
  const eventTs = 100 + ordinal;
  return {
    ordinal,
    sourceOrdinal: ordinal,
    role: "user",
    ts: eventTs,
    text,
    toolText: null,
    hasTool: false,
    recordKind: "real_user",
    dialogueSide: "user",
    prose: text,
    eventTs,
    toolActivities: [],
    sourceRecordId: `fixture-message-${ordinal}`,
    sourceRecordUuid: null,
    sourceRecordTs: eventTs,
    sourceIdentityKind: "record-id",
  };
}

function fixtureRecord(
  events: ContinuityEventEvidence[],
  text = "raw before",
): IngestRecord {
  return {
    nativeId: "fixture-session",
    cwd: "/fixture",
    project: "/fixture",
    title: "fixture",
    startTs: 100,
    endTs: 100,
    models: [],
    messages: [message(text)],
    transcriptBytes: 100,
    origin: "unknown",
    continuityEvents: events,
    continuitySupport: "supported",
    construction: {
      artifactKind: "dialogue_history",
      historyCompleteness: "complete",
      defaultSessionVisible: true,
      sourceValidationStatus: "current",
      sourceObservedTs: null,
      project: {
        originalProjectKey: "/fixture",
        canonicalProjectKey: "/fixture",
        canonicalizationRuleVersion: "fixture-project-v1",
      },
      titleCandidates: [{
        value: text,
        authority: "real_user_fallback",
        harnessSourceClass: "fixture-user",
        sourceRecordId: "fixture-message-0",
        sourceReference: null,
        sourceOrdinal: 0,
        eligibilityRuleVersion: "fixture-title-v1",
      }],
      classificationRuleVersion: "fixture-class-v1",
      replayRuleVersion: "fixture-replay-v1",
    },
  };
}

function fixtureAdapter(root: string, current: { record: IngestRecord; fail?: boolean }): Adapter {
  const sourcePath = join(root, "fixture-source.jsonl");
  writeFileSync(sourcePath, "fixture source history\n");
  return {
    source: "fixture",
    continuitySupport: "supported",
    discover: (roots) => [{
      root: roots[0]!,
      relPath: "fixture-source.jsonl",
      fullPath: sourcePath,
      nativeId: current.record.nativeId,
    }],
    parse: () => {
      if (current.fail) throw new Error("fixture parse failure");
      return { record: current.record, consumed: current.record.transcriptBytes };
    },
  };
}

function sessionId(db: DB, harness: string, nativeId: string): number {
  const row = db.prepare(`SELECT id FROM sessions WHERE harness=? AND native_id=?`).get(harness, nativeId) as { id: number };
  return Number(row.id);
}

function count(db: DB, table: string, session: number): number {
  // Table names are constants at each call site; keeping the argument avoids
  // hiding the cascade assertions behind several nearly-identical statements.
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id=?`).get(session) as { n: number }).n);
}

function writeClaudeFixture(root: string): string {
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const path = join(project, "claude-session.jsonl");
  const uuid = "11111111-1111-4111-8111-111111111111";
  const lines = [
    {
      type: "user",
      uuid: "user-1",
      timestamp: "2026-08-06T19:00:00.000Z",
      message: { role: "user", content: "ordinary prose says compact_boundary and checkpoint" },
    },
    {
      type: "system",
      subtype: "other",
      timestamp: "2026-08-06T19:00:01.000Z",
      message: { role: "system", content: "compact_boundary in a text field is not evidence" },
    },
    {
      type: "system",
      subtype: "compact_boundary",
      uuid,
      timestamp: "2026-08-06T19:00:02.000Z",
      compactMetadata: { trigger: "fixture", keep: ["structured", "only"] },
    },
    {
      type: "system",
      subtype: "checkpoint",
      timestamp: "2026-08-06T19:00:03.000Z",
      message: { role: "system", content: "not an established Claude seam" },
    },
  ];
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

function writeCodexFixture(root: string): string {
  const day = join(root, "sessions", "2026", "08", "06");
  mkdirSync(day, { recursive: true });
  const nativeId = "22222222-2222-4222-8222-222222222222";
  const path = join(day, `rollout-2026-08-06-${nativeId}.jsonl`);
  const lines = [
    { type: "session_meta", timestamp: "2026-08-06T19:00:00.000Z", payload: { id: nativeId, cwd: "/fixture" } },
    {
      type: "response_item",
      timestamp: "2026-08-06T19:00:01.000Z",
      payload: { type: "message", id: "item-1", role: "user", content: [{ text: "context_compacted checkpoint" }] },
    },
  ];
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

function writeKiloFixture(path: string): void {
  const source = new Database(path);
  source.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,model TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,time_created INTEGER,data TEXT);
  `);
  source.prepare(`INSERT INTO session VALUES ('kilo-session','/fixture','Kilo fixture','fixture',100,100,NULL)`).run();
  source.prepare(`INSERT INTO message VALUES ('kilo-message','kilo-session',101,?)`).run(JSON.stringify({ role: "user" }));
  source.prepare(`INSERT INTO part VALUES ('kilo-part','kilo-message',101,?)`).run(JSON.stringify({ type: "text", text: "kilo" }));
  source.close();
}

/** Build exactly a v8 image, then let openDb apply only migration 9. */
function createV8Database(path: string): number {
  const old = new Database(path);
  old.exec("PRAGMA foreign_keys=ON;");
  let sid = 0;
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 8)) {
    old.exec(migration.up);
    old.prepare(
      `INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run("schema_version", String(migration.version));
    if (migration.version === 1) {
      const inserted = old.prepare(
        `INSERT INTO sessions(harness,native_id,source_path,msg_count,ingested_at)
         VALUES ('fixture','old-v8','/fixture/source',1,100)`,
      ).run() as { lastInsertRowid: number | bigint };
      sid = Number(inserted.lastInsertRowid);
      old.prepare(
        `INSERT INTO messages(session_id,ordinal,role,text,tok_estimate)
         VALUES (?,0,'user','retained v8 raw row',1)`,
      ).run(sid);
    }
  }
  expect(Number((old.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string }).value)).toBe(8);
  old.close();
  return sid;
}

afterEach(() => {
  atlas?.close();
  atlas = undefined;
  resetKiloCache();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("source capability boundaries accept only Claude system/compact_boundary", async () => {
  const f = fixture("capabilities");
  const claudePath = writeClaudeFixture(f.root);
  const codexPath = writeCodexFixture(f.root);
  const kiloPath = join(f.root, "kilo.db");
  writeKiloFixture(kiloPath);

  const claudeSource = claudeAdapter.discover([f.root]).find((source) => source.fullPath === claudePath)!;
  const claudeRecord = claudeAdapter.parse(claudeSource).record;
  expect(claudeRecord.continuitySupport).toBe("supported");
  expect(claudeRecord.continuityEvents).toHaveLength(1);
  expect(claudeRecord.continuityEvents?.[0]).toMatchObject({
    kind: "compaction",
    sourceRecordUuid: "11111111-1111-4111-8111-111111111111",
    detail: JSON.stringify({ trigger: "fixture", keep: ["structured", "only"] }),
  });

  const codexSource = codexAdapter.discover([f.root]).find((source) => source.fullPath === codexPath)!;
  const codexRecord = codexAdapter.parse(codexSource).record;
  expect(codexRecord.continuitySupport).toBe("unknown");
  expect(codexRecord.continuityEvents).toEqual([]);
  expect(kiloAdapter.continuitySupport).toBe("unsupported");
  const kiloSource = kiloAdapter.discover([kiloPath])[0]!;
  expect(kiloAdapter.parse(kiloSource).record).toMatchObject({ continuitySupport: "unsupported", continuityEvents: [] });
  resetKiloCache();

  atlas = await openDb(f.dbPath);
  await ingest(atlas, config(f.dbPath, {
    claude: { roots: [f.root] },
    codex: { roots: [f.root] },
    kilo: { roots: [kiloPath] },
  }));

  const claudeSession = sessionId(atlas, "claude", "claude-session");
  expect(getContinuityHistory(atlas, claudeSession)?.events).toHaveLength(1);
  expect(getContinuityState(atlas, claudeSession)?.support).toBe("supported");
  const codexSession = sessionId(atlas, "codex", "22222222-2222-4222-8222-222222222222");
  expect(getContinuityHistory(atlas, codexSession)).toMatchObject({ state: { support: "unknown" }, events: [] });
  const kiloSession = sessionId(atlas, "kilo", "kilo-session");
  expect(getContinuityHistory(atlas, kiloSession)).toMatchObject({ state: { support: "unsupported" }, events: [] });
});

test("continuity evidence has stable ordering, deduplication, and transactional refresh", async () => {
  const f = fixture("refresh");
  const events: ContinuityEventEvidence[] = [
    { kind: "checkpoint", sourceOrdinal: 20, sourceRecordId: "z", sourceRecordTs: 300, detail: "z" },
    { kind: "compaction", sourceOrdinal: 10, sourceRecordId: "a", sourceRecordTs: 100, detail: "a" },
    { kind: "compaction", sourceOrdinal: 10, sourceRecordId: "a", sourceRecordTs: 100, detail: "a" },
    { kind: "checkpoint", sourceOrdinal: 5, sourceRecordId: "null-ts", sourceRecordTs: null, detail: "null" },
  ];
  const current = { record: fixtureRecord(events) };
  const adapter = fixtureAdapter(f.root, current);
  atlas = await openDb(f.dbPath);
  const cfg = config(f.dbPath, { fixture: { roots: [f.root] } });
  await ingest(atlas, cfg, { adapters: { fixture: adapter }, full: true });
  const sid = sessionId(atlas, "fixture", "fixture-session");
  expect(listContinuityHistory(atlas, sid).map((event) => event.sourceOrdinal)).toEqual([5, 10, 20]);
  expect(listContinuityHistory(atlas, sid).map((event) => event.eventKey)).toHaveLength(3);
  expect(count(atlas, "continuity_evidence", sid)).toBe(3);

  current.record = fixtureRecord([
    { kind: "compaction", sourceOrdinal: 7, sourceRecordId: "new", sourceRecordTs: 700, detail: "new" },
  ], "raw after");
  await ingest(atlas, cfg, { adapters: { fixture: adapter }, full: true });
  expect((atlas.prepare(`SELECT text FROM messages WHERE session_id=? ORDER BY ordinal`).get(sid) as { text: string }).text).toBe("raw after");
  expect(listContinuityHistory(atlas, sid).map((event) => event.sourceRecordId)).toEqual(["new"]);

  // Force a failure after messages have been deleted and reinserted. The
  // reconcile transaction must roll the complete refresh back.
  atlas.exec(`
    CREATE TRIGGER continuity_fixture_abort
    BEFORE INSERT ON continuity_evidence
    BEGIN SELECT RAISE(ABORT, 'fixture continuity write failure'); END;
  `);
  current.record = fixtureRecord([
    { kind: "checkpoint", sourceOrdinal: 8, sourceRecordId: "never-committed", sourceRecordTs: 800 },
  ], "must roll back");
  const failed = await ingest(atlas, cfg, { adapters: { fixture: adapter }, full: true });
  expect(failed[0]?.roots[0]?.error).toContain("fixture continuity write failure");
  expect((atlas.prepare(`SELECT text FROM messages WHERE session_id=? ORDER BY ordinal`).get(sid) as { text: string }).text).toBe("raw after");
  expect(listContinuityHistory(atlas, sid).map((event) => event.sourceRecordId)).toEqual(["new"]);
  atlas.exec(`DROP TRIGGER continuity_fixture_abort`);
});

test("reset persists through ingest, explicit rebuild restores projection, archive only changes status, and cascade removes state", async () => {
  const f = fixture("lifecycle");
  const sourcePath = join(f.root, "fixture-source.jsonl");
  const current = {
    record: fixtureRecord([
      { kind: "compaction", sourceOrdinal: 2, sourceRecordId: "compaction", sourceRecordTs: 200 },
      { kind: "checkpoint", sourceOrdinal: 4, sourceRecordId: "checkpoint", sourceRecordTs: 400 },
    ]),
  };
  const adapter = fixtureAdapter(f.root, current);
  const sourceHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
  atlas = await openDb(f.dbPath);
  const cfg = config(f.dbPath, { fixture: { roots: [f.root] } });
  await ingest(atlas, cfg, { adapters: { fixture: adapter }, full: true });
  const sid = sessionId(atlas, "fixture", "fixture-session");
  const rawBefore = atlas.prepare(`SELECT COUNT(*) AS n, MIN(text) AS text FROM messages WHERE session_id=?`).get(sid) as { n: number; text: string };
  const evidenceBefore = atlas.prepare(`SELECT event_key FROM continuity_evidence WHERE session_id=? ORDER BY source_ordinal`).all(sid);

  const reset = resetContinuityState(atlas, sid);
  expect(reset.status).toBe("reset");
  expect(getContinuityHistory(atlas, sid)?.events).toEqual([]);
  expect(count(atlas, "continuity_evidence", sid)).toBe(2);
  expect((atlas.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id=?`).get(sid) as { n: number }).n).toBe(rawBefore.n);

  // A source refresh updates authoritative raw/evidence rows but does not
  // silently resurrect a projection that the user explicitly reset.
  await ingest(atlas, cfg, { adapters: { fixture: adapter }, full: true });
  expect(getContinuityState(atlas, sid)?.status).toBe("reset");
  expect(getContinuityHistory(atlas, sid)?.events).toEqual([]);
  expect(count(atlas, "continuity_evidence", sid)).toBe(2);

  const rebuilt = rebuildContinuityHistory(atlas, sid);
  expect(rebuilt.state.status).toBe("active");
  expect(rebuilt.events.map((event) => event.sourceRecordId)).toEqual(["compaction", "checkpoint"]);
  expect(getContinuityState(atlas, sid)?.resetAt).toBeNull();

  const rawRowsBeforeArchive = atlas.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id=?`).get(sid) as { n: number };
  const evidenceRowsBeforeArchive = atlas.prepare(`SELECT event_key FROM continuity_evidence WHERE session_id=? ORDER BY id`).all(sid);
  expect(archiveContinuityState(atlas, sid)).toMatchObject({ status: "archived", archived: true });
  expect(getContinuityHistory(atlas, sid)).toMatchObject({ state: { status: "archived", archived: true }, events: rebuilt.events });
  expect(listContinuityHistory(atlas, sid)).toHaveLength(2);
  expect(restoreContinuityState(atlas, sid)).toMatchObject({ status: "active", archived: false });
  expect(getContinuityHistory(atlas, sid)?.events).toEqual(rebuilt.events);
  expect(atlas.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id=?`).get(sid)).toEqual(rawRowsBeforeArchive);
  expect(atlas.prepare(`SELECT event_key FROM continuity_evidence WHERE session_id=? ORDER BY id`).all(sid)).toEqual(evidenceRowsBeforeArchive);
  expect(createHash("sha256").update(readFileSync(sourcePath)).digest("hex")).toBe(sourceHash);
  expect(atlas.prepare(`SELECT event_key FROM continuity_evidence WHERE session_id=? ORDER BY source_ordinal`).all(sid)).toEqual(evidenceBefore);

  atlas.prepare(`DELETE FROM sessions WHERE id=?`).run(sid);
  expect(atlas.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id=?`).get(sid)).toEqual({ n: 0 });
  expect(atlas.prepare(`SELECT COUNT(*) AS n FROM continuity_state WHERE session_id=?`).get(sid)).toEqual({ n: 0 });
  expect(atlas.prepare(`SELECT COUNT(*) AS n FROM continuity_evidence WHERE session_id=?`).get(sid)).toEqual({ n: 0 });
  expect(atlas.prepare(`SELECT COUNT(*) AS n FROM continuity_projection WHERE session_id=?`).get(sid)).toEqual({ n: 0 });
  expect(readFileSync(sourcePath, "utf8")).toBe("fixture source history\n");
});

test("migration v8 through current creates continuity state and keeps existing rows", async () => {
  const f = fixture("migration");
  const sid = createV8Database(f.dbPath);
  const migrationOwner = new Database(f.dbPath);
  runMigrations(migrationOwner);
  migrationOwner.close();
  atlas = await openDb(f.dbPath);
  expect((atlas.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as { value: string }).value).toBe(String(LATEST_SCHEMA_VERSION));
  expect(atlas.prepare(`SELECT session_id,support,archived,reset_generation FROM continuity_state`).get()).toEqual({
    session_id: sid,
    support: "unknown",
    archived: 0,
    reset_generation: 0,
  });
  expect((atlas.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id=?`).get(sid) as { n: number }).n).toBe(1);
  expect((atlas.prepare(`SELECT COUNT(*) AS n FROM logical_messages WHERE session_id=?`).get(sid) as { n: number }).n).toBe(1);
  expect(atlas.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('continuity_evidence','continuity_projection') ORDER BY name`).all()).toEqual([
    { name: "continuity_evidence" },
    { name: "continuity_projection" },
  ]);
});
