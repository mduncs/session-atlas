import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db/index.js";
import { ingest } from "../src/ingest.js";
import type { Adapter, IngestRecord } from "../src/adapters/types.js";
import type { Config } from "../src/config.js";
import { kiloAdapter } from "../src/adapters/kilo.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "atlas-wave0-ingest-"));
  dirs.push(dir);
  return dir;
}

function config(dbPath: string, sources: Config["sources"]): Config {
  return {
    sources,
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
  };
}

function record(nativeId: string, text: string): IngestRecord {
  return {
    nativeId,
    cwd: "/fixture",
    project: "/fixture",
    title: nativeId,
    startTs: 1,
    endTs: 2,
    models: ["fixture"],
    messages: [{
      ordinal: 0,
      sourceOrdinal: 0,
      role: "user",
      ts: 1,
      text,
      toolText: null,
      hasTool: false,
      recordKind: "real_user",
      dialogueSide: "user",
      prose: text,
      eventTs: 1,
      toolActivities: [],
      sourceRecordId: `${nativeId}-message-1`,
      sourceRecordUuid: null,
      sourceRecordTs: 1,
      sourceIdentityKind: "record-id",
    }],
    transcriptBytes: new TextEncoder().encode(text).byteLength,
    origin: "unknown",
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
        sourceRecordId: `${nativeId}-message-1`,
        sourceReference: null,
        sourceOrdinal: 0,
        eligibilityRuleVersion: "fixture-title-v1",
      }],
      classificationRuleVersion: "fixture-class-v1",
      replayRuleVersion: "fixture-replay-v1",
    },
  };
}

test("a malformed unit does not advance its state or block later units", async () => {
  const dir = temp();
  const root = join(dir, "source");
  writeFileSync(root, "fixture");
  const adapter: Adapter = {
    source: "fixture",
    discover: () => [
      { root, relPath: "bad", fullPath: root, nativeId: "bad" },
      { root, relPath: "good", fullPath: root, nativeId: "good" },
    ],
    parse(src) {
      if (src.nativeId === "bad") throw new Error("malformed fixture unit");
      return { record: record("good", "later unit survived"), consumed: 19 };
    },
  };
  const db = await openDb(join(dir, "atlas.db"));
  const progress: string[] = [];
  const result = await ingest(db, config(join(dir, "atlas.db"), { fixture: { roots: [root] } }), {
    adapters: { fixture: adapter },
    onSourceComplete: (summary) => progress.push(`${summary.source}:${summary.inserted}`),
  });

  expect(progress).toEqual(["fixture:1"]);
  expect(result[0]?.roots[0]?.reachable).toBe(true);
  expect(result[0]?.roots[0]?.unitErrors).toBe(1);
  expect(result[0]?.roots[0]?.error).toContain("bad: malformed fixture unit");
  expect((db.prepare(`SELECT native_id FROM sessions`).all() as { native_id: string }[]).map((r) => r.native_id)).toEqual(["good"]);
  expect((db.prepare(`SELECT rel_path FROM ingest_state`).all() as { rel_path: string }[]).map((r) => r.rel_path)).toEqual(["good"]);
  const run = db.prepare(`SELECT reachable,finished_at,error FROM ingest_runs`).get() as {
    reachable: number;
    finished_at: number | null;
    error: string | null;
  };
  expect(run.reachable).toBe(1);
  expect(run.finished_at).toBeNumber();
  expect(run.error).toContain("malformed fixture unit");
  db.close();
});

function createKilo(path: string): Database {
  const db = new Database(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE session(
      id TEXT PRIMARY KEY, directory TEXT, title TEXT, model TEXT,
      time_created INTEGER, time_updated INTEGER, parent_id TEXT
    );
    CREATE TABLE message(
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT
    );
    CREATE TABLE part(
      id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT
    );
  `);
  return db;
}

function insertKiloSession(db: Database, id: string, text: string, ts: number): void {
  db.prepare(
    `INSERT INTO session(id,directory,title,model,time_created,time_updated,parent_id)
     VALUES (?, '/fixture', ?, 'fixture-model', ?, ?, NULL)`,
  ).run(id, id, ts, ts);
  db.prepare(`INSERT INTO message(id,session_id,time_created,data) VALUES (?,?,?,?)`).run(
    `${id}-m1`, id, ts, JSON.stringify({ role: "user", model: { modelID: "fixture-model" } }),
  );
  db.prepare(`INSERT INTO part(id,message_id,time_created,data) VALUES (?,?,?,?)`).run(
    `${id}-p1`, `${id}-m1`, ts, JSON.stringify({ type: "text", text }),
  );
}

test("Kilo freshness observes active WAL rows while the main-file stat is unchanged", async () => {
  const dir = temp();
  const sourcePath = join(dir, "kilo.db");
  const writer = createKilo(sourcePath);
  insertKiloSession(writer, "s1", "first", 100);
  const atlasPath = join(dir, "atlas.db");
  const db = await openDb(atlasPath);
  const cfg = config(atlasPath, { kilo: { roots: [sourcePath] } });

  await ingest(db, cfg);
  const before = statSync(sourcePath);
  writer.transaction(() => {
    writer.prepare(`UPDATE session SET time_updated=200 WHERE id='s1'`).run();
    writer.prepare(`INSERT INTO message(id,session_id,time_created,data) VALUES ('s1-m2','s1',200,?)`).run(
      JSON.stringify({ role: "assistant", model: { modelID: "fixture-model" } }),
    );
    writer.prepare(`INSERT INTO part(id,message_id,time_created,data) VALUES ('s1-p2','s1-m2',200,?)`).run(
      JSON.stringify({ type: "text", text: "second WAL-visible turn" }),
    );
  })();
  const after = statSync(sourcePath);
  expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({ size: before.size, mtimeMs: before.mtimeMs });

  const second = await ingest(db, cfg);
  expect(second[0]?.replaced).toBe(1);
  const row = db.prepare(`SELECT msg_count,transcript_bytes FROM sessions WHERE native_id='s1'`).get() as {
    msg_count: number;
    transcript_bytes: number;
  };
  expect(row.msg_count).toBe(2);
  expect(row.transcript_bytes).toBeGreaterThan(0);
  db.close();
  writer.close();
});

test("Kilo cross-root dedupe compares the session transcript, not whole database size", async () => {
  const dir = temp();
  const livePath = join(dir, "live.db");
  const archivePath = join(dir, "archive.db");
  const live = createKilo(livePath);
  const archive = createKilo(archivePath);
  insertKiloSession(live, "target", "short", 100);
  insertKiloSession(live, "unrelated", "x".repeat(100_000), 100);
  insertKiloSession(archive, "target", "the target transcript is substantially longer", 100);
  const atlasPath = join(dir, "atlas.db");
  const db = await openDb(atlasPath);

  await ingest(db, config(atlasPath, { kilo: { roots: [livePath, archivePath] } }));
  const chosen = db.prepare(`SELECT source_path FROM sessions WHERE native_id='target'`).get() as {
    source_path: string;
  };
  expect(chosen.source_path).toBe(archivePath);
  db.close();
  live.close();
  archive.close();
});

test("a busy Kilo source is isolated and a later source still ingests", async () => {
  const dir = temp();
  const busyPath = join(dir, "busy-kilo.db");
  const busy = createKilo(busyPath);
  insertKiloSession(busy, "blocked", "locked", 100);
  busy.exec("PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");

  const root = join(dir, "later-source");
  writeFileSync(root, "fixture");
  const fixture: Adapter = {
    source: "fixture",
    discover: () => [{ root, relPath: "later", fullPath: root, nativeId: "later" }],
    parse: () => ({ record: record("later", "continued after busy Kilo"), consumed: 25 }),
  };
  const atlasPath = join(dir, "atlas.db");
  const db = await openDb(atlasPath);
  const results = await ingest(
    db,
    config(atlasPath, { kilo: { roots: [busyPath] }, fixture: { roots: [root] } }),
    { adapters: { kilo: kiloAdapter, fixture } },
  );

  const busyResult = results.find((r) => r.source === "kilo")?.roots[0];
  expect(busyResult?.reachable).toBe(true);
  expect(busyResult?.unitErrors).toBeGreaterThan(0);
  expect(busyResult?.error).toBeTruthy();
  expect(results.find((r) => r.source === "fixture")?.inserted).toBe(1);
  expect((db.prepare(`SELECT native_id FROM sessions`).get() as { native_id: string }).native_id).toBe("later");
  db.close();
  busy.exec("ROLLBACK;");
  busy.close();
}, 10_000);
