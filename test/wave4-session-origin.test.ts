import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claudeAdapter } from "../src/adapters/claude.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { kiloAdapter, resetKiloCache } from "../src/adapters/kilo.js";
import type { Adapter, IngestRecord } from "../src/adapters/types.js";
import type { Config } from "../src/config.js";
import { openDb, runMigrations } from "../src/db/index.js";
import { MIGRATIONS, SCHEMA_VERSION_META_KEY } from "../src/db/schema.js";
import { ingest } from "../src/ingest.js";

const roots: string[] = [];

afterEach(() => {
  resetKiloCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `atlas-origin-${name}-`));
  roots.push(root);
  return root;
}

function source(path: string, nativeId: string, relPath = `${nativeId}.jsonl`) {
  return { root: join(path, ".."), relPath, fullPath: path, nativeId };
}

function writeJsonl(path: string, records: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

test("Codex origin uses session source metadata and captures spawned parent lineage", () => {
  const root = temp("codex");
  const cases = [
    { id: "human", source: "cli", origin: "human", detail: "codex:source:cli" },
    { id: "machine", source: "sdk", origin: "agent", detail: "codex:source:sdk" },
    { id: "unknown", source: "other", origin: "unknown", detail: null },
  ] as const;
  for (const item of cases) {
    const path = join(root, `${item.id}.jsonl`);
    writeJsonl(path, [{ type: "session_meta", payload: { id: item.id, source: item.source } }]);
    const parsed = codexAdapter.parse(source(path, item.id)).record;
    expect({ origin: parsed.origin, detail: parsed.originDetail ?? null }).toEqual({
      origin: item.origin,
      detail: item.detail,
    });
  }

  const path = join(root, "spawn.jsonl");
  writeJsonl(path, [{
    type: "session_meta",
    payload: {
      id: "spawn",
      source: { subagent: { thread_spawn: { parent_thread_id: "parent-thread" } } },
    },
  }]);
  const spawned = codexAdapter.parse(source(path, "spawn")).record;
  expect(spawned).toMatchObject({
    origin: "agent",
    originDetail: "codex:subagent.thread_spawn",
    parentNativeId: "parent-thread",
  });
});

test("Claude origin distinguishes direct CLI, sidechains/subagents, SDK, and mixed evidence", () => {
  const root = temp("claude");
  const directPath = join(root, "direct.jsonl");
  writeJsonl(directPath, [{
    type: "user",
    isSidechain: false,
    entrypoint: "cli",
    promptSource: "typed",
    message: { role: "user", content: "hello" },
  }]);
  expect(claudeAdapter.parse(source(directPath, "direct")).record).toMatchObject({
    origin: "human",
    originDetail: "claude:direct-cli",
  });

  const agentPath = join(root, "subagents", "agent-a.jsonl");
  writeJsonl(agentPath, [{
    type: "user",
    isSidechain: true,
    agentId: "agent-a",
    entrypoint: "cli",
    message: { role: "user", content: "delegated" },
  }]);
  const agent = claudeAdapter.parse(source(agentPath, "agent-a", "subagents/agent-a.jsonl")).record;
  expect(agent.origin).toBe("agent");
  expect(agent.originDetail).toContain("claude:subagents-path");
  expect(agent.originDetail).toContain("claude:isSidechain");

  const mixedPath = join(root, "mixed.jsonl");
  writeJsonl(mixedPath, [
    {
      type: "user",
      isSidechain: false,
      entrypoint: "cli",
      promptSource: "typed",
      message: { role: "user", content: "human start" },
    },
    {
      type: "assistant",
      isSidechain: false,
      entrypoint: "sdk-py",
      promptSource: "sdk",
      message: { role: "assistant", content: "machine continuation" },
    },
  ]);
  const mixed = claudeAdapter.parse(source(mixedPath, "mixed")).record;
  expect(mixed.origin).toBe("mixed");
  expect(mixed.originDetail).toBe(
    "agent:claude:entrypoint:sdk-py,claude:promptSource:sdk;human:claude:direct-cli",
  );
});

test("Kilo parent_id deterministically separates root sessions from child agents", () => {
  const root = temp("kilo");
  const path = join(root, "kilo.db");
  const sourceDb = new Database(path);
  sourceDb.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,model TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,time_created INTEGER,data TEXT);
    INSERT INTO session VALUES ('human','/fixture','human','m',1,2,NULL);
    INSERT INTO session VALUES ('agent','/fixture','agent','m',1,2,'human');
  `);
  sourceDb.close();

  expect(kiloAdapter.parse(source(path, "human", "human")).record).toMatchObject({
    origin: "human",
    originDetail: "kilo:root-session",
    parentNativeId: null,
  });
  expect(kiloAdapter.parse(source(path, "agent", "agent")).record).toMatchObject({
    origin: "agent",
    originDetail: "kilo:parent_id",
    parentNativeId: "human",
  });
});

test("schema migrations preserve v5 unknown origin defaults and advance through v6", () => {
  const root = temp("migration");
  const db = new Database(join(root, "atlas.db"));
  for (const migration of MIGRATIONS.filter((item) => item.version <= 4)) db.exec(migration.up);
  db.prepare(`INSERT INTO meta(key,value) VALUES (?,?)`).run(SCHEMA_VERSION_META_KEY, "4");
  db.prepare(
    `INSERT INTO sessions(harness,native_id,source_path,ingested_at) VALUES ('claude','old','old.jsonl',1)`,
  ).run();

  runMigrations(db);
  expect(Number((db.prepare(`SELECT value FROM meta WHERE key=?`).get(SCHEMA_VERSION_META_KEY) as { value: string }).value)).toBeGreaterThanOrEqual(6);
  expect(db.prepare(`SELECT origin,origin_detail FROM sessions`).get()).toEqual({
    origin: "unknown",
    origin_detail: null,
  });
  expect(() => db.prepare(
    `INSERT INTO sessions(harness,native_id,source_path,ingested_at,origin) VALUES ('x','bad','x',1,'robot')`,
  ).run()).toThrow();
  db.close();
});

test("ingest persists provenance on insert and refreshes it on replacement", async () => {
  const root = temp("ingest");
  const sourcePath = join(root, "source");
  writeFileSync(sourcePath, "fixture");
  let origin: IngestRecord["origin"] = "agent";
  const adapter: Adapter = {
    source: "fixture",
    discover: () => [{ root, relPath: "s1", fullPath: sourcePath, nativeId: "s1" }],
    parse: () => {
      const bytes = statSync(sourcePath).size;
      return {
        consumed: bytes,
        record: {
          nativeId: "s1",
          cwd: null,
          project: null,
          title: null,
          startTs: 1,
          endTs: 2,
          models: [],
          messages: [],
          transcriptBytes: bytes,
          origin,
          originDetail: `fixture:${origin}`,
          construction: {
            artifactKind: "metadata_shell",
            historyCompleteness: "complete",
            defaultSessionVisible: false,
            sourceValidationStatus: "current",
            sourceObservedTs: null,
            project: {
              originalProjectKey: null,
              canonicalProjectKey: null,
              canonicalizationRuleVersion: null,
            },
            titleCandidates: [],
            classificationRuleVersion: "fixture-class-v1",
            replayRuleVersion: "fixture-replay-v1",
          },
        },
      };
    },
  };
  const db = await openDb(join(root, "atlas.db"));
  const config: Config = {
    dbPath: join(root, "atlas.db"),
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
  };

  await ingest(db, config, { adapters: { fixture: adapter }, full: true });
  expect(db.prepare(`SELECT origin,origin_detail FROM sessions`).get()).toEqual({
    origin: "agent",
    origin_detail: "fixture:agent",
  });
  origin = "human";
  writeFileSync(sourcePath, "fixture-refresh");
  await ingest(db, config, { adapters: { fixture: adapter }, full: true });
  expect(db.prepare(`SELECT origin,origin_detail FROM sessions`).get()).toEqual({
    origin: "human",
    origin_detail: "fixture:human",
  });
  db.close();
});
