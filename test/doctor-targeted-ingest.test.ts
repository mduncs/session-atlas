import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TUNABLES, HARNESS_IDS, type Config } from "../src/config.js";
import { openDb, type DB } from "../src/db/index.js";
import { collectDoctorReport, TARGETED_INGEST_STALE_AFTER_MS } from "../src/commands/doctor.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("doctor keeps a fresh targeted run in progress and does not degrade it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-doctor-targeted-"));
  directories.push(directory);
  const root = join(directory, "claude-root");
  mkdirSync(root);
  const config: Config = {
    sources: Object.fromEntries(HARNESS_IDS.map((source) => [source, { mode: "disabled", roots: [], disabledReason: "fixture" }])) as Config["sources"],
    providers: [], launchers: [], tunables: { ...DEFAULT_TUNABLES }, dbPath: join(directory, "atlas.db"),
  };
  config.sources.claude = { mode: "replace", roots: [root], disabledReason: null };
  const db = await openDb(config.dbPath);
  try {
    const now = 1_000_000;
    db.prepare(`INSERT INTO targeted_ingest_runs(source,harness,native_id,trigger_kind,started_at,status) VALUES ('claude','claude','fresh','hook',?, 'running')`).run(now - 1_000);
    const report = collectDoctorReport(db, config, now);
    expect(report.lines).toContain("  [--] claude  targeted ingestion · running · 1s ago · in progress");
    expect(report.lines.some((line) => line.includes("unfinished beyond recovery threshold"))).toBe(false);
  } finally { db.close(); }
});

test("doctor marks an old unfinished targeted run as a recovery candidate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "atlas-doctor-targeted-"));
  directories.push(directory);
  const root = join(directory, "claude-root");
  mkdirSync(root);
  const config: Config = {
    sources: Object.fromEntries(HARNESS_IDS.map((source) => [source, { mode: "disabled", roots: [], disabledReason: "fixture" }])) as Config["sources"],
    providers: [], launchers: [], tunables: { ...DEFAULT_TUNABLES }, dbPath: join(directory, "atlas.db"),
  };
  config.sources.claude = { mode: "replace", roots: [root], disabledReason: null };
  const db = await openDb(config.dbPath);
  try {
    const now = 1_000_000;
    db.prepare(`INSERT INTO targeted_ingest_runs(source,harness,native_id,trigger_kind,started_at,status) VALUES ('claude','claude','old','hook',?, 'running')`).run(now - TARGETED_INGEST_STALE_AFTER_MS - 1);
    const report = collectDoctorReport(db, config, now);
    expect(report.lines).toContain("  [DEGRADED] claude  targeted ingestion · running · 10m ago · unfinished beyond recovery threshold · recovery candidate only; ingestion not claimed");
    expect((db.prepare(`SELECT status,finished_at,error FROM targeted_ingest_runs`).get() as Record<string, unknown>)).toEqual({ status: "running", finished_at: null, error: null });
  } finally { db.close(); }
});
