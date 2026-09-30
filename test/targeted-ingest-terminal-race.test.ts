import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_TUNABLES, HARNESS_IDS, type Config } from "../src/config.js";
import { runMigrations } from "../src/db/index.js";
import { ingestOne } from "../src/ingest.js";
import { repairStaleTargetedRuns } from "../src/targeted-repair.js";

const NOW = 10_000_000;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("confirmed targeted repair bumps last_write only when it repairs rows", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    db.prepare("INSERT INTO meta(key,value) VALUES ('last_write',?)").run("1000");
    db.prepare(
      `INSERT INTO targeted_ingest_runs(source,harness,native_id,trigger_kind,started_at,status)
       VALUES ('claude','claude','stale','hook',?,'running')`,
    ).run(NOW - 60 * 60_000);

    const preview = repairStaleTargetedRuns(db, {
      ageMs: 30 * 60_000, ageLabel: "30m", nowMs: NOW, confirmed: false,
    });
    expect(preview.repaired).toBe(0);
    expect(lastWrite(db)).toBe(1000);

    const repaired = repairStaleTargetedRuns(db, {
      ageMs: 30 * 60_000, ageLabel: "30m", nowMs: NOW, confirmed: true,
    });
    expect(repaired.repaired).toBe(1);
    expect(lastWrite(db)).not.toBe(1000);

    const revision = lastWrite(db);
    const noOp = repairStaleTargetedRuns(db, {
      ageMs: 30 * 60_000, ageLabel: "30m", nowMs: NOW, confirmed: true,
    });
    expect(noOp.repaired).toBe(0);
    expect(lastWrite(db)).toBe(revision);
  } finally {
    db.close();
  }
});

test("ingestOne cannot overwrite synthetic stale recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-targeted-race-"));
  dirs.push(dir);
  const root = join(dir, "source");
  mkdirSync(root);
  const dbPath = join(dir, "atlas.db");
  const db = new Database(dbPath);
  try {
    runMigrations(db);
    db.exec(`
      CREATE TRIGGER recover_targeted_run AFTER INSERT ON targeted_ingest_runs
      BEGIN
        UPDATE targeted_ingest_runs
           SET status='failed', finished_at=999, error='synthetic recovery'
         WHERE id=NEW.id;
      END;
    `);
    const config = fixtureConfig(dbPath, root);

    const result = await ingestOne(db, config, "claude", "missing-session");

    expect(result).toEqual({ found: false, sessionId: null });
    expect(db.prepare(
      `SELECT status,finished_at,error FROM targeted_ingest_runs ORDER BY id DESC LIMIT 1`,
    ).get()).toEqual({ status: "failed", finished_at: 999, error: "synthetic recovery" });
  } finally {
    db.close();
  }
});

function lastWrite(db: Database): number {
  return Number((db.prepare("SELECT value FROM meta WHERE key='last_write'").get() as { value: string }).value);
}

function fixtureConfig(dbPath: string, root: string): Config {
  const sources = Object.fromEntries(HARNESS_IDS.map((source) => [source, {
    mode: source === "claude" ? "replace" : "disabled",
    roots: source === "claude" ? [root] : [],
    disabledReason: source === "claude" ? null : "fixture owns no source",
  }])) as Config["sources"];
  return { dbPath, sources, providers: [], launchers: [], tunables: DEFAULT_TUNABLES };
}
