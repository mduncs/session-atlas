import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { Config } from "../src/config.js";
import { openDb, runMigrations, type DB } from "../src/db/index.js";
import { MIGRATIONS, SCHEMA_VERSION_META_KEY } from "../src/db/schema.js";
import { createFavorite, retryPendingFavorites } from "../src/favorites.js";
import { rebuildDatabase } from "../src/rebuild.js";
import { rebuildLogicalMetrics } from "../src/logical-metrics.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name: string): { root: string; dbPath: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), `atlas-${name}-`));
  roots.push(root);
  const dbPath = join(root, "atlas.db");
  return {
    root,
    dbPath,
    config: {
      sources: {},
      providers: [],
      launchers: [],
      tunables: {
        tag_promotion_count: 3,
        export_budget_tokens: 20_000,
        fav_default_span: 2,
        summary_stale_pct: 25,
        redact_entropy_threshold: 4.8,
      },
      dbPath,
    },
  };
}

function createOldDb(path: string, version: 1 | 2): Database {
  const db = new Database(path);
  db.exec(MIGRATIONS[0]!.up);
  if (version === 2) db.exec(MIGRATIONS[1]!.up);
  db.prepare(`INSERT INTO meta(key,value) VALUES (?,?)`).run(SCHEMA_VERSION_META_KEY, String(version));
  return db;
}

function insertSession(db: DB, harness: string, nativeId: string, texts = ["first", "second", "third"]): number {
  const now = Date.now();
  const generation = `fixture-generation-${harness}-${nativeId}`;
  const userCount = texts.filter((_, ordinal) => ordinal % 2 === 0).length;
  const assistantCount = texts.length - userCount;
  const result = db.prepare(
    `INSERT INTO sessions(
       harness,native_id,source_path,source_root,title,start_ts,end_ts,last_activity,duration_ms,models,
       tok_user,tok_assistant,tok_tool,msg_count,transcript_bytes,default_session_visible,ingested_at,
       artifact_kind,history_completeness,construction_generation,construction_status,construction_invalid_reason,
       source_validation_status,source_observed_ts
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    harness,
    nativeId,
    `/fixture/${nativeId}`,
    "/fixture",
    texts[0] ?? null,
    now,
    now + Math.max(0, texts.length - 1),
    now + Math.max(0, texts.length - 1),
    Math.max(0, texts.length - 1),
    '["fixture"]',
    userCount,
    assistantCount,
    0,
    texts.length,
    texts.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0),
    1,
    now,
    "dialogue_history",
    "complete",
    generation,
    "valid",
    null,
    "current",
    now,
  );
  const id = Number(result.lastInsertRowid);
  texts.forEach((text, ordinal) => {
    const role = ordinal % 2 ? "assistant" : "user";
    const recordKind = role === "user" ? "real_user" : "assistant_dialogue_prose";
    const eventTs = now + ordinal;
    db.prepare(
      `INSERT INTO messages(
         session_id,ordinal,role,ts,text,tool_text,has_tool,tok_estimate,source_ordinal,record_kind,
         dialogue_side,prose,event_ts,source_record_id,source_record_ts,source_identity_kind,construction_generation
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      ordinal,
      role,
      eventTs,
      text,
      null,
      0,
      1,
      ordinal,
      recordKind,
      role,
      text,
      eventTs,
      `fixture-${harness}-${nativeId}-${ordinal}`,
      eventTs,
      "record-id",
      generation,
    );
  });
  rebuildLogicalMetrics(db, id, generation, "fixture-replay-v1");
  return id;
}

test("Wave 0 persistence — v1/v2 upgrades collapse NULL duplicates and enforce favorite checks", () => {
  for (const version of [1, 2] as const) {
    const { root, dbPath } = fixture(`upgrade-v${version}`);
    const db = createOldDb(dbPath, version);
    const created = Date.now();
    db.prepare(
      `INSERT INTO favorites(harness,native_id,from_ordinal,to_ordinal,span_text,topic,status,created_at)
       VALUES ('claude','same',NULL,NULL,NULL,NULL,'ok',?)`,
    ).run(created);
    db.prepare(
      `INSERT INTO favorites(harness,native_id,from_ordinal,to_ordinal,span_text,topic,status,created_at)
       VALUES ('claude','same',NULL,NULL,NULL,NULL,'ok',?)`,
    ).run(created + 1);

    runMigrations(db);
    expect((db.prepare(`SELECT value FROM meta WHERE key=?`).get(SCHEMA_VERSION_META_KEY) as { value: string }).value).toBe(
      String(MIGRATIONS.at(-1)!.version),
    );
    const rows = db.prepare(`SELECT status,scope,span_text FROM favorites`).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "pending", scope: "session", span_text: null });
    expect(() =>
      db.prepare(
        `INSERT INTO favorites(harness,native_id,from_ordinal,to_ordinal,status,scope,created_at,updated_at)
         VALUES ('x','bad',4,2,'pending','span',1,1)`,
      ).run(),
    ).toThrow();
    expect(() =>
      db.prepare(
        `INSERT INTO favorites(harness,native_id,status,scope,created_at,updated_at)
         VALUES ('x','bad-status','broken','session',1,1)`,
      ).run(),
    ).toThrow();
    db.close();
    expect(() => writeFileSync(join(root, "still-writable"), "ok")).not.toThrow();
  }
});

test("Wave 0 persistence — favorite race parks pending, targeted seam runs, and retry materializes exact tail", async () => {
  const { dbPath } = fixture("favorite-race");
  const db = await openDb(dbPath);
  let targeted = 0;
  const pending = await createFavorite(
    db,
    { harness: "codex", nativeId: "late-session", topic: "thread" },
    {
      defaultSpan: 2,
      targetedIngest: async () => {
        targeted++;
        throw new Error("source still being created");
      },
    },
  );
  expect(targeted).toBe(1);
  expect(pending).toMatchObject({ status: "pending", scope: "tail", spanText: null });

  insertSession(db, "codex", "late-session");
  expect(retryPendingFavorites(db, { harness: "codex", nativeId: "late-session", defaultSpan: 2 })).toEqual({
    materialized: 1,
    pending: 0,
  });
  const row = db.prepare(`SELECT * FROM favorites`).get() as Record<string, unknown>;
  expect(row.status).toBe("ok");
  expect(row.from_ordinal).toBe(1);
  expect(row.to_ordinal).toBe(2);
  expect(String(row.span_text)).toContain("second");
  expect(String(row.span_text)).toContain("third");
  expect(String(row.span_text)).not.toContain("first");
  expect(String(row.span_hash)).toHaveLength(64);
  db.close();
});

async function seedRebuild(path: string): Promise<void> {
  const db = await openDb(path);
  const keepId = insertSession(db, "claude", "keep", ["keep user", "keep assistant"]);
  const pruneId = insertSession(db, "claude", "prune", ["pruned but favorited"]);
  const keepSummary = db.prepare(
    `INSERT INTO summaries(session_id,tier,topic_line,body,msg_count_covered,model,generated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(keepId, 2, "kept topic", "kept body", 2, "fixture-model", 123);
  db.prepare(
    `INSERT INTO summary_anchors(summary_id,ord,topic,from_ordinal,to_ordinal,body)
     VALUES (?,?,?,?,?,?)`,
  ).run(Number(keepSummary.lastInsertRowid), 0, "anchor", 0, 1, "anchor body");
  db.prepare(
    `INSERT INTO summaries(session_id,tier,topic_line,msg_count_covered) VALUES (?,?,?,?)`,
  ).run(pruneId, 1, "pruned summary", 1);
  const tag = db.prepare(`INSERT INTO tags(name,promoted_at) VALUES ('astronomy',44)`).run();
  db.prepare(`INSERT INTO session_tags(session_id,tag_id) VALUES (?,?)`).run(keepId, Number(tag.lastInsertRowid));
  db.prepare(`INSERT INTO tag_candidates(name,session_id) VALUES ('variable stars',?)`).run(keepId);
  await createFavorite(db, { harness: "claude", nativeId: "prune", wholeSession: true });
  db.close();
}

async function buildOnlyKeep(db: DB): Promise<void> {
  // The shadow must admit every SessionKey referenced by durable state. Rebuild
  // is preservation-first; a missing retained target refuses the swap.
  insertSession(db, "claude", "keep", ["rebuilt user", "rebuilt assistant"]);
  insertSession(db, "claude", "prune", ["rebuilt favorited session"]);
}

test("Wave 0 persistence — normal shadow rebuild remaps cache, preserves every durable target, and validates FTS", async () => {
  const { dbPath, config } = fixture("normal-rebuild");
  await seedRebuild(dbPath);
  const report = await rebuildDatabase(config, { buildShadow: async (db) => buildOnlyKeep(db) });
  expect(report).toMatchObject({ hard: false, sessions: 2, messages: 3, favorites: 1, summariesRestored: 2 });
  expect(report.prunedCacheEntries).toBe(0);

  const db = await openDb(dbPath);
  expect(db.prepare(`SELECT topic_line FROM summaries ORDER BY id`).all()).toEqual([
    { topic_line: "kept topic" },
    { topic_line: "pruned summary" },
  ]);
  expect((db.prepare(`SELECT COUNT(*) n FROM summary_anchors`).get() as { n: number }).n).toBe(1);
  expect((db.prepare(`SELECT COUNT(*) n FROM session_tags`).get() as { n: number }).n).toBe(1);
  const favorite = db.prepare(`SELECT status,span_text,span_hash FROM favorites`).get() as Record<string, unknown>;
  expect(favorite.status).toBe("ok");
  expect(String(favorite.span_text)).toContain("pruned but favorited");
  expect(String(favorite.span_hash)).toHaveLength(64);
  expect((db.prepare(`SELECT COUNT(*) n FROM session_search_documents`).get() as { n: number }).n).toBe(3);
  db.close();
});

test("Wave 0 persistence — hard rebuild preserves all durable state and validates the rebuilt cache", async () => {
  const { dbPath, config } = fixture("hard-rebuild");
  await seedRebuild(dbPath);
  const report = await rebuildDatabase(config, { hard: true, buildShadow: async (db) => buildOnlyKeep(db) });
  expect(report).toMatchObject({ hard: true, favorites: 1, summariesRestored: 2, tagsRestored: 1 });
  const db = await openDb(dbPath);
  expect((db.prepare(`SELECT COUNT(*) n FROM summaries`).get() as { n: number }).n).toBe(2);
  expect((db.prepare(`SELECT COUNT(*) n FROM tags`).get() as { n: number }).n).toBe(1);
  expect((db.prepare(`SELECT COUNT(*) n FROM favorites`).get() as { n: number }).n).toBe(1);
  db.close();
});

test("Wave 0 persistence — a WAL-consistent copied fixture preserves committed favorite data", async () => {
  const source = fixture("wal-source");
  const target = fixture("wal-copy");
  const writer = await openDb(source.dbPath);
  writer.exec("PRAGMA wal_autocheckpoint=0;");
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const reader = new Database(source.dbPath);
  reader.exec("BEGIN;");
  reader.prepare(`SELECT COUNT(*) FROM meta`).get(); // pin the pre-write WAL snapshot

  const sessionId = insertSession(writer, "claude", "wal-only", ["committed in wal"]);
  writer.prepare(
    `INSERT INTO favorites(
       harness,native_id,span_text,span_hash,topic,scope,status,created_at,updated_at
     ) VALUES ('claude','wal-only','committed in wal',?,NULL,'session','ok',1,1)`,
  ).run(createHash("sha256").update("committed in wal").digest("hex"));
  expect(sessionId).toBeGreaterThan(0);
  expect(existsSync(`${source.dbPath}-wal`)).toBe(true);
  copyFileSync(source.dbPath, target.dbPath);
  copyFileSync(`${source.dbPath}-wal`, `${target.dbPath}-wal`);
  writer.close();
  reader.exec("ROLLBACK;");
  reader.close();

  const report = await rebuildDatabase(target.config, { buildShadow: async (db) => buildOnlyKeep(db) });
  expect(report.favorites).toBe(1);
  const rebuilt = await openDb(target.dbPath);
  expect((rebuilt.prepare(`SELECT span_text FROM favorites`).get() as { span_text: string }).span_text).toBe(
    "committed in wal",
  );
  rebuilt.close();
});

test("Wave 0 persistence — maintenance/concurrent refusal and forced pre-swap failure leave original usable", async () => {
  const locked = fixture("maintenance-lock");
  await seedRebuild(locked.dbPath);
  writeFileSync(`${locked.dbPath}.maintenance.lock`, "owned elsewhere\n");
  await expect(openDb(locked.dbPath)).rejects.toThrow("database is under maintenance");
  await expect(rebuildDatabase(locked.config, { buildShadow: async (db) => buildOnlyKeep(db) })).rejects.toThrow(
    "maintenance lock exists",
  );
  rmSync(`${locked.dbPath}.maintenance.lock`);

  const idle = await openDb(locked.dbPath);
  await expect(rebuildDatabase(locked.config, { buildShadow: async (db) => buildOnlyKeep(db) })).rejects.toThrow(
    "open Atlas database handle",
  );
  idle.close();

  const concurrent = fixture("active-writer");
  await seedRebuild(concurrent.dbPath);
  const writer = await openDb(concurrent.dbPath);
  writer.exec("BEGIN IMMEDIATE;");
  await expect(rebuildDatabase(concurrent.config, { buildShadow: async (db) => buildOnlyKeep(db) })).rejects.toThrow(
    /open Atlas database handle|WAL checkpoint is busy|active writer/,
  );
  writer.exec("ROLLBACK;");
  writer.close();

  const failure = fixture("forced-failure");
  await seedRebuild(failure.dbPath);
  await expect(
    rebuildDatabase(failure.config, {
      buildShadow: async (db) => buildOnlyKeep(db),
      onStage: (stage) => {
        if (stage === "before-swap") throw new Error("forced before swap");
      },
    }),
  ).rejects.toThrow("forced before swap");
  const db = await openDb(failure.dbPath);
  expect((db.prepare(`SELECT COUNT(*) n FROM sessions`).get() as { n: number }).n).toBe(2);
  expect((db.prepare(`SELECT COUNT(*) n FROM favorites`).get() as { n: number }).n).toBe(1);
  expect((db.prepare(`PRAGMA integrity_check`).get() as { integrity_check: string }).integrity_check).toBe("ok");
  db.close();

  const corrupt = fixture("corrupt-favorite-hash");
  await seedRebuild(corrupt.dbPath);
  const corruptDb = await openDb(corrupt.dbPath);
  corruptDb.prepare(`UPDATE favorites SET span_hash=?`).run("f".repeat(64));
  corruptDb.close();
  await expect(rebuildDatabase(corrupt.config, { buildShadow: async (shadow) => buildOnlyKeep(shadow) })).rejects.toThrow(
    "materialized span hash validation",
  );
  const unchanged = await openDb(corrupt.dbPath);
  expect((unchanged.prepare(`SELECT COUNT(*) n FROM sessions`).get() as { n: number }).n).toBe(2);
  unchanged.close();
});
