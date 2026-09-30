import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DB_PATH } from "../src/config.js";
import { runMigrations } from "../src/db/index.js";
import { rebuildLogicalMetrics } from "../src/logical-metrics.js";
import {
  assertSafeClonePaths,
  createWalConsistentSnapshot,
  parseCloneSmokeArgs,
  renderIsolatedConfig,
  runCloneSmoke,
} from "../scripts/clone-smoke.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "atlas-clone-smoke-"));
  roots.push(path);
  return path;
}

test("clone smoke requires every explicit absolute path and refuses protected destinations", () => {
  expect(() => parseCloneSmokeArgs([])).toThrow("explicit --source-db is required");
  expect(() => parseCloneSmokeArgs(["--source-db", "/a", "--config", "/b"])).toThrow("explicit --work-dir is required");
  expect(() => assertSafeClonePaths({ sourceDb: "relative.db", configPath: "/config", workDir: "/tmp/out" })).toThrow("sourceDb must be an explicit absolute path");
  expect(() => assertSafeClonePaths({ sourceDb: "/tmp/source.db", configPath: "/config", workDir: "relative" })).toThrow("workDir must be an explicit absolute path");
  expect(() => assertSafeClonePaths(
    { sourceDb: "/tmp/source.db", configPath: "/config", workDir: "/tmp/out" },
    "/tmp/source.db",
  )).toThrow("must not equal the source");
  expect(() => assertSafeClonePaths(
    { sourceDb: "/tmp/source.db", configPath: "/config", workDir: "/tmp/out" },
    DEFAULT_DB_PATH,
  )).toThrow("must not equal Session Atlas DEFAULT_DB_PATH");
});

test("readonly sqlite serialization includes committed pages present only in WAL", async () => {
  const dir = root();
  const sourcePath = join(dir, "source.db");
  const clonePath = join(dir, "clone.db");
  const writer = new Database(sourcePath);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence(value TEXT NOT NULL);");
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  writer.prepare("INSERT INTO evidence(value) VALUES (?)").run("committed only after checkpoint");
  expect((writer.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as { log: number }).log).toBeGreaterThan(0);

  const bytes = await createWalConsistentSnapshot(sourcePath, clonePath);
  expect(bytes).toBeGreaterThan(0);
  // The serialized database retains WAL journal mode. The disposable clone is
  // deliberately writable so SQLite can create its own fresh -shm/-wal files;
  // only the source connection is constrained readonly.
  const clone = new Database(clonePath, { strict: true });
  expect((clone.prepare("SELECT value FROM evidence").get() as { value: string }).value).toBe("committed only after checkpoint");
  clone.close();
  writer.close();
});

test("isolated config pins clone DB, preserves only explicit roots, and disables active integrations", () => {
  const rendered = renderIsolatedConfig({
    dbPath: "/live/atlas.db",
    sources: { claude: { roots: ["/readonly/claude"] }, codex: { roots: ["/readonly/codex"] } },
    providers: [{ name: "paid", base: "https://provider", kind: "openai", model: "model", key_env: "SECRET" }],
    launchers: [{ name: "external", cmd: "external {payload}" }],
    tunables: { tag_promotion_count: 3, export_budget_tokens: 1234, fav_default_span: 6, summary_stale_pct: 25, redact_entropy_threshold: 4.8 },
  }, "/clone/atlas.db");
  expect(rendered).toContain('dbPath = "/clone/atlas.db"');
  expect(rendered).toContain('/readonly/claude');
  expect(rendered).toContain('/readonly/codex');
  expect(rendered).not.toContain("https://provider");
  expect(rendered).not.toContain("SECRET");
  expect(rendered).not.toContain("external {payload}");
  expect(renderIsolatedConfig({
    dbPath: "/live/atlas.db", sources: { claude: { roots: ["/readonly/claude"] } }, providers: [], launchers: [],
    tunables: { tag_promotion_count: 3, export_budget_tokens: 1234, fav_default_span: 6, summary_stale_pct: 25, redact_entropy_threshold: 4.8 },
  }, "/clone/atlas.db", true)).toContain('[sources.claude]\nmode = "disabled"\nreason = "clone smoke --no-sources fixture"');
  expect(renderIsolatedConfig({
    dbPath: "/live/atlas.db", sources: { claude: { roots: ["/readonly/claude"] } }, providers: [], launchers: [],
    tunables: { tag_promotion_count: 3, export_budget_tokens: 1234, fav_default_span: 6, summary_stale_pct: 25, redact_entropy_threshold: 4.8 },
  }, "/clone/atlas.db", true)).toContain('[sources.kilo]\nmode = "disabled"');
});

test("end-to-end tiny WAL clone emits evidence and confines destructive checks to its fixture", async () => {
  const dir = root();
  const sourcePath = join(dir, "source-atlas.db");
  const configPath = join(dir, "source-config.toml");
  const workDir = join(dir, "smoke-output");
  const writer = new Database(sourcePath);
  writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA foreign_keys=ON;");
  runMigrations(writer);
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const now = Date.now();
  const generation = "wal-fixture-v11";
  const inserted = writer.prepare(`INSERT INTO sessions(
    harness,native_id,source_path,title,start_ts,end_ts,last_activity,duration_ms,models,
    tok_user,tok_assistant,tok_tool,msg_count,engagement,orphaned,transcript_bytes,ingested_at,
    artifact_kind,history_completeness,construction_generation,construction_status,default_session_visible,
    source_validation_status,source_observed_ts
  ) VALUES ('fixture','wal-session','/fixture','WAL smoke',?,?,?,?, '["fixture"]',4,5,0,2,0.5,0,36,?,
    'dialogue_history','complete',?,'invalid',0,'current',?)`).run(now, now + 1_000, now + 1_000, 1_000, now, generation, now);
  const id = Number(inserted.lastInsertRowid);
  writer.prepare(`INSERT INTO messages(
    session_id,ordinal,role,ts,text,prose,event_ts,source_ordinal,record_kind,dialogue_side,
    source_record_id,source_record_ts,source_identity_kind,construction_generation,tok_estimate
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, 0, "user", now, "WAL fixture user", "WAL fixture user", now, 0, "real_user", "user",
    "wal-fixture-user", now, "record-id", generation, 4,
  );
  writer.prepare(`INSERT INTO messages(
    session_id,ordinal,role,ts,text,prose,event_ts,source_ordinal,record_kind,dialogue_side,
    source_record_id,source_record_ts,source_identity_kind,construction_generation,tok_estimate
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, 1, "assistant", now + 1_000, "WAL fixture assistant", "WAL fixture assistant", now + 1_000, 1,
    "assistant_dialogue_prose", "assistant", "wal-fixture-assistant", now + 1_000, "record-id", generation, 5,
  );
  rebuildLogicalMetrics(writer, id, generation, "wal-fixture-replay-v1");
  writer.prepare(`UPDATE sessions SET construction_status='valid',construction_invalid_reason=NULL,default_session_visible=1 WHERE id=?`).run(id);
  writeFileSync(configPath, `dbPath = ${JSON.stringify(sourcePath)}\n[tunables]\ntag_promotion_count = 3\nexport_budget_tokens = 20000\nfav_default_span = 6\nsummary_stale_pct = 25\nredact_entropy_threshold = 4.8\n`);

  try {
    const result = await runCloneSmoke({
      sourceDb: sourcePath,
      configPath,
      workDir,
      noSources: true,
      fixtureMode: true,
      allowCloneRebuild: false,
    });
    expect(result.ok).toBe(true);
    expect(result.counts).toEqual({ sessions: 1, messages: 2, proseMessages: 2, ftsRows: 2 });
    expect(result.checks.frames.map((frame) => frame.width)).toEqual([160, 120, 100, 80, 60, 50]);
    expect(result.checks.contextRestored).toBe(true);
    expect(result.checks.fixtureActions).toEqual({ favorite: true, export: true, normalRebuild: true, hardRebuild: true });
    expect(result.fingerprints.unchanged).toBe(true);
    expect(existsSync(result.artifacts.result)).toBe(true);
    expect(existsSync(result.artifacts.done)).toBe(true);
  } finally {
    writer.close();
  }
});
