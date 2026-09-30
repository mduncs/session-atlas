import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../src/config.js";
import { openDb, type DB } from "../src/db/index.js";
import { ingest } from "../src/ingest.js";
import {
  getLogicalMessages,
  getLogicalMetrics,
  rebuildLogicalMetrics,
} from "../src/logical-metrics.js";
import { rebuildDatabase } from "../src/rebuild.js";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { kiloAdapter, resetKiloCache } from "../src/adapters/kilo.js";
import type { Adapter, IngestRecord, NormalizedMessage } from "../src/adapters/types.js";

const roots: string[] = [];
let db: DB | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name: string): { root: string; dbPath: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), `atlas-wave5-${name}-`));
  roots.push(root);
  const dbPath = join(root, "atlas.db");
  return {
    root,
    dbPath,
    config: {
      sources: { fixture: { roots: [root] } },
      providers: [],
      launchers: [],
      tunables: {
        tag_promotion_count: 3,
        export_budget_tokens: 20_000,
        fav_default_span: 6,
        summary_stale_pct: 25,
        redact_entropy_threshold: 4.8,
      },
      dbPath,
    },
  };
}

function message(
  ordinal: number,
  text: string,
  evidence: Partial<NormalizedMessage> = {},
): NormalizedMessage {
  const eventTs = evidence.eventTs ?? evidence.ts ?? null;
  return {
    ordinal,
    sourceOrdinal: evidence.sourceOrdinal ?? ordinal,
    role: "user",
    ts: evidence.ts ?? null,
    text,
    toolText: null,
    hasTool: false,
    recordKind: "real_user",
    dialogueSide: "user",
    prose: text,
    eventTs,
    toolActivities: [],
    sourceRecordId: null,
    sourceRecordUuid: null,
    sourceRecordTs: null,
    sourceIdentityKind: "none",
    ...evidence,
  };
}

function adapterFor(root: string, record: () => IngestRecord): Adapter {
  const sourcePath = join(root, "snapshot.jsonl");
  writeFileSync(sourcePath, "fixture\n");
  return {
    source: "fixture",
    discover: (roots) => [
      { root: roots[0]!, relPath: "snapshot.jsonl", fullPath: sourcePath, nativeId: "session-1" },
    ],
    parse: () => ({ record: record(), consumed: Buffer.byteLength(JSON.stringify(record())) }),
  };
}

function record(messages: NormalizedMessage[]): IngestRecord {
  const first = messages[0];
  const title = first?.prose ?? first?.text ?? null;
  const visible = messages.some((item) =>
    (item.recordKind === "real_user" || item.recordKind === "assistant_dialogue_prose")
      && Boolean(item.prose?.trim()),
  );
  return {
    nativeId: "session-1",
    cwd: "/fixture",
    project: "/fixture",
    title,
    startTs: messages[0]?.eventTs ?? messages[0]?.ts ?? null,
    endTs: messages.at(-1)?.eventTs ?? messages.at(-1)?.ts ?? null,
    models: [],
    messages,
    transcriptBytes: 100,
    origin: "unknown",
    continuitySupport: "unknown",
    continuityEvents: [],
    construction: {
      artifactKind: "dialogue_history",
      historyCompleteness: "complete",
      defaultSessionVisible: visible,
      sourceValidationStatus: "current",
      sourceObservedTs: null,
      project: {
        originalProjectKey: "/fixture",
        canonicalProjectKey: "/fixture",
        canonicalizationRuleVersion: "fixture-project-v1",
      },
      titleCandidates: title && first
        ? [{
            value: title,
            authority: "real_user_fallback",
            harnessSourceClass: "fixture-user",
            sourceRecordId: first.sourceRecordId ?? null,
            sourceReference: null,
            sourceOrdinal: first.sourceOrdinal ?? first.ordinal,
            eligibilityRuleVersion: "fixture-title-v1",
          }]
        : [],
      classificationRuleVersion: "fixture-class-v1",
      replayRuleVersion: "fixture-replay-v1",
    },
  };
}

function sessionId(db: DB): number {
  return Number((db.prepare(`SELECT id FROM sessions WHERE harness='fixture' AND native_id='session-1'`).get() as { id: number }).id);
}

test("Claude and Codex adapters carry only source record identity plus original timestamp", () => {
  const f = fixture("adapters");
  const claudeProject = join(f.root, "claude-project");
  mkdirSync(claudeProject, { recursive: true });
  const claudePath = join(claudeProject, "session.jsonl");
  const claudeUuid = "11111111-1111-4111-8111-111111111111";
  writeFileSync(
    claudePath,
    [
      JSON.stringify({
        type: "user",
        uuid: claudeUuid,
        timestamp: "2026-08-06T19:00:00.000Z",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-08-06T19:00:01.000Z",
        message: { role: "assistant", content: "world" },
      }),
    ].join("\n") + "\n",
  );
  const claudeSource = claudeAdapter.discover([f.root]).find((source) => source.fullPath === claudePath)!;
  const claudeMessages = claudeAdapter.parse(claudeSource).record.messages;
  expect(claudeMessages[0]).toMatchObject({
    sourceRecordId: claudeUuid,
    sourceRecordUuid: claudeUuid,
    sourceRecordTs: Date.parse("2026-08-06T19:00:00.000Z"),
    sourceIdentityKind: "uuid",
  });
  expect(claudeMessages[1]).toMatchObject({
    sourceRecordId: null,
    sourceRecordUuid: null,
    sourceRecordTs: Date.parse("2026-08-06T19:00:01.000Z"),
    sourceIdentityKind: "none",
  });

  const codexDir = join(f.root, "sessions", "2026", "08", "06");
  mkdirSync(codexDir, { recursive: true });
  const codexUuid = "22222222-2222-4222-8222-222222222222";
  const codexPath = join(codexDir, `rollout-2026-08-06-${codexUuid}.jsonl`);
  writeFileSync(
    codexPath,
    [
      JSON.stringify({ type: "session_meta", timestamp: "2026-08-06T19:00:00Z", payload: { id: codexUuid, cwd: "/fixture" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-06T19:00:02Z",
        payload: { type: "message", id: "item-1", role: "user", content: [{ text: "codex" }] },
      }),
    ].join("\n") + "\n",
  );
  const codexSource = codexAdapter.discover([f.root]).find((source) => source.fullPath === codexPath)!;
  expect(codexAdapter.parse(codexSource).record.messages[0]).toMatchObject({
    sourceRecordId: "item-1",
    sourceRecordUuid: null,
    sourceRecordTs: Date.parse("2026-08-06T19:00:02Z"),
    sourceIdentityKind: "record-id",
  });

  const kiloPath = join(f.root, "kilo.db");
  const kilo = new Database(kiloPath);
  kilo.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,model TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,time_created INTEGER,data TEXT);
  `);
  kilo.prepare(`INSERT INTO session VALUES ('kilo-session','/fixture','Kilo fixture','fixture',100,100,NULL)`).run();
  kilo.prepare(`INSERT INTO message VALUES ('kilo-message','kilo-session',101,?)`).run(JSON.stringify({ role: "assistant" }));
  kilo.prepare(`INSERT INTO part VALUES ('kilo-part','kilo-message',101,?)`).run(JSON.stringify({ type: "text", text: "kilo" }));
  kilo.close();
  try {
    const kiloSource = kiloAdapter.discover([kiloPath])[0]!;
    expect(kiloAdapter.parse(kiloSource).record.messages[0]).toMatchObject({
      sourceRecordId: "kilo-message",
      sourceRecordUuid: null,
      sourceRecordTs: 101,
      sourceIdentityKind: "message-id",
    });
  } finally {
    resetKiloCache();
  }
});

test("replay projection preserves raw rows, requires id+timestamp, and never keys by text", async () => {
  const f = fixture("projection");
  db = await openDb(f.dbPath);
  const messages = [
    message(0, "alpha", { ts: 100, sourceRecordId: "record-a", sourceRecordTs: 100, sourceIdentityKind: "record-id" }),
    message(1, "alpha", { ts: 100, sourceRecordId: "record-a", sourceRecordTs: 100, sourceIdentityKind: "record-id" }),
    message(2, "same text", { ts: 200, sourceRecordId: "record-b", sourceRecordTs: null, sourceIdentityKind: "record-id" }),
    message(3, "same text", { ts: 200, sourceRecordId: "record-c", sourceRecordTs: 200, sourceIdentityKind: "none" }),
    message(4, "later source row", {
      ts: 101,
      sourceRecordId: "record-a",
      sourceRecordTs: 101,
      sourceIdentityKind: "record-id",
      hasTool: true,
      toolText: "tool output",
      toolActivities: [{
        activityOrdinal: 0,
        activityKind: "result",
        toolName: null,
        toolText: "tool output",
        sourceActivityId: "tool-1",
      }],
    }),
    message(5, "contradictory", {
      ts: 300,
      sourceRecordId: "record-d",
      sourceRecordUuid: "00000000-0000-4000-8000-000000000000",
      sourceRecordTs: 300,
      sourceIdentityKind: "record-id",
    }),
  ];
  const adapter = adapterFor(f.root, () => record(messages));

  await ingest(db, f.config, { full: true, adapters: { fixture: adapter } });
  const sid = sessionId(db);
  const metrics = getLogicalMetrics(db, sid)!;
  expect(db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id=?`).get(sid)).toEqual({ n: 6 });
  expect(db.prepare(`SELECT text FROM messages WHERE session_id=? ORDER BY ordinal`).all(sid)).toEqual([
    { text: "alpha" },
    { text: "alpha" },
    { text: "same text" },
    { text: "same text" },
    { text: "later source row" },
    { text: "contradictory" },
  ]);
  expect(metrics).toMatchObject({
    logicalMsgCount: 5,
    logicalToolCallCount: 1,
    logicalReplayCount: 1,
    logicalIdentityCount: 2,
    logicalUnknownCount: 3,
    identityStatus: "partial",
  });
  expect(getLogicalMessages(db, sid).map((row) => [row.memberCount, row.replayCount])).toContainEqual([2, 1]);

  // Refresh replaces raw rows, then immediately rebuilds the projection rather
  // than retaining the old replay group or metrics.
  const refreshed = [
    message(0, "alpha refreshed", { ts: 100, sourceRecordId: "record-a", sourceRecordTs: 100, sourceIdentityKind: "record-id" }),
    message(1, "new unknown", { ts: 400 }),
  ];
  const refreshedAdapter = adapterFor(f.root, () => record(refreshed));
  await ingest(db, f.config, { full: true, adapters: { fixture: refreshedAdapter } });
  expect(getLogicalMetrics(db, sid)).toMatchObject({
    logicalMsgCount: 2,
    logicalReplayCount: 0,
    logicalIdentityCount: 1,
    logicalUnknownCount: 1,
    identityStatus: "partial",
  });
  expect(getLogicalMessages(db, sid)).toHaveLength(2);

  db.prepare(`DELETE FROM sessions WHERE id=?`).run(sid);
  expect(getLogicalMetrics(db, sid)).toBeNull();
  expect(getLogicalMessages(db, sid)).toEqual([]);
});

test("logical metrics are rebuilt for direct refresh and custom shadow rebuild", async () => {
  const f = fixture("rebuild");
  db = await openDb(f.dbPath);
  const result = db.prepare(
    `INSERT INTO sessions(harness,native_id,source_path,msg_count,ingested_at) VALUES ('fixture','old','fixture',1,1)`,
  ).run();
  const oldSid = Number(result.lastInsertRowid);
  db.prepare(
    `INSERT INTO messages(session_id,ordinal,role,text,ts,source_record_id,source_record_ts,source_identity_kind)
     VALUES (?,0,'user','old',100,'old-record',100,'record-id')`,
  ).run(oldSid);
  rebuildLogicalMetrics(db, oldSid);
  expect(getLogicalMetrics(db, oldSid)?.logicalMsgCount).toBe(1);
  db.close();
  db = undefined;

  await rebuildDatabase(
    f.config,
    {
      buildShadow: async (shadow) => {
        const inserted = shadow.prepare(
          `INSERT INTO sessions(harness,native_id,source_path,msg_count,ingested_at) VALUES ('fixture','rebuilt','fixture',2,2)`,
        ).run();
        const sid = Number(inserted.lastInsertRowid);
        const insert = shadow.prepare(
          `INSERT INTO messages(session_id,ordinal,role,text,ts,source_record_id,source_record_ts,source_identity_kind)
           VALUES (?,?,?,?,?,?,?,?)`,
        );
        insert.run(sid, 0, "user", "one", 100, "replay-record", 100, "record-id");
        insert.run(sid, 1, "user", "two", 100, "replay-record", 100, "record-id");
      },
    },
  );

  db = await openDb(f.dbPath);
  const rebuiltSid = Number((db.prepare(`SELECT id FROM sessions WHERE native_id='rebuilt'`).get() as { id: number }).id);
  expect(getLogicalMetrics(db, rebuiltSid)).toMatchObject({ logicalMsgCount: 1, logicalReplayCount: 1 });
  expect(getLogicalMessages(db, rebuiltSid)[0]).toMatchObject({ memberCount: 2, replayCount: 1 });
  expect(db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE native_id='old'`).get()).toEqual({ n: 0 });
});
