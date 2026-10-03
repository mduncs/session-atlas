import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { HARNESS_IDS, loadConfig, sourcePlanDigest } from "../src/config.js";
import { collectDoctorReport } from "../src/commands/doctor.js";
import { favoriteIdentifier } from "../src/commands/fav.js";
import { rebuildWarning, runRebuild } from "../src/commands/rebuild.js";
import { openDb } from "../src/db/index.js";
import { ingest } from "../src/ingest.js";

const roots: string[] = [];
afterEach(() => {
  delete process.env.ATLAS_TEST_KEY;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name: string): { root: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), `atlas-wave1-${name}-`));
  roots.push(root);
  const sources = {} as Config["sources"];
  for (const source of HARNESS_IDS) {
    sources[source] = {
      mode: "disabled",
      roots: [],
      disabledReason: "wave 1 fixture owns only Claude",
    };
  }
  sources.claude = { mode: "replace", roots: [root], disabledReason: null };
  return {
    root,
    config: {
      sources,
      providers: [{ name: "fixture", base: "https://invalid.test", kind: "anthropic", model: "fixture", key_env: "ATLAS_TEST_KEY" }],
      launchers: [],
      tunables: {
        tag_promotion_count: 3,
        export_budget_tokens: 20_000,
        fav_default_span: 2,
        summary_stale_pct: 25,
        redact_entropy_threshold: 4.8,
      },
      dbPath: join(root, "atlas.db"),
    },
  };
}

function claudeLine(
  type: "user" | "assistant",
  role: "user" | "assistant",
  text: string,
  ordinal: number,
): string {
  const timestamp = new Date(1_700_000_000_000 + ordinal * 1000).toISOString();
  return JSON.stringify({
    type,
    message: { role, ...(role === "assistant" ? { model: "fixture-model" } : {}), content: text },
    timestamp,
    cwd: "/fixture/project",
    sessionId: "s1",
    uuid: `00000000-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`,
  });
}

test("Wave 1 operations — missing config is bootstrapped once with standard sources and private permissions", async () => {
  const { root } = fixture("bootstrap");
  const configPath = join(root, "xdg-config", "session-atlas", "config.toml");
  const config = await loadConfig(configPath);
  expect(existsSync(configPath)).toBe(true);
  const text = readFileSync(configPath, "utf8");
  expect(text).toContain("[sources.claude]");
  expect(text).toContain("[sources.codex]");
  expect(text).toContain("[sources.kilo]");
  expect(config.tunables.export_budget_tokens).toBe(20_000);
  const again = await loadConfig(configPath);
  expect(again.dbPath).toBe(config.dbPath);
});

test("Wave 1 operations — a fresh process honors empty XDG config/data homes", () => {
  const { root } = fixture("fresh-xdg");
  const configHome = join(root, "config-home");
  const dataHome = join(root, "data-home");
  const script = `
    const mod = await import("./src/config.ts");
    const config = await mod.loadConfig();
    process.stdout.write(JSON.stringify({ configPath: mod.DEFAULT_CONFIG_PATH, dbPath: config.dbPath }));
  `;
  const child = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  const paths = JSON.parse(child.stdout.toString()) as { configPath: string; dbPath: string };
  expect(paths.configPath).toBe(join(configHome, "session-atlas", "config.toml"));
  expect(paths.dbPath).toBe(join(dataHome, "session-atlas", "atlas.db"));
  expect(existsSync(paths.configPath)).toBe(true);
});

test("Wave 1 operations — doctor covers roots, jobs, provider, maintenance, and favorites under one second", async () => {
  const { root, config } = fixture("doctor");
  process.env.ATLAS_TEST_KEY = "fixture-only";
  const configPath = join(root, "fixture-config.toml");
  const schedulePath = join(root, "fixture-schedule.plist");
  writeFileSync(configPath, "fixture config\n", { mode: 0o600 });
  writeFileSync(join(root, "s1.jsonl"), [
    claudeLine("user", "user", "doctor fixture request", 0),
    claudeLine("assistant", "assistant", "doctor fixture response", 1),
  ].join("\n") + "\n");
  // The schedule artifact exists before the walk so creating it cannot make
  // the source root newer than its just-completed reconciliation.
  writeFileSync(schedulePath, `${configPath}\n${config.dbPath}\n`, { mode: 0o600 });
  const db = await openDb(config.dbPath);
  const summaries = await ingest(db, config, { configPath, trigger: "scheduled" });
  expect(summaries.find((summary) => summary.source === "claude")).toMatchObject({ uniqueIdentities: 1 });
  db.prepare(`UPDATE source_schedule_state SET schedule_kind='launchd',schedule_path=? WHERE source='claude'`).run(schedulePath);
  const finished = (db.prepare(`SELECT finished_at FROM reconciliation_groups ORDER BY id DESC LIMIT 1`).get() as { finished_at: number }).finished_at;
  const report = collectDoctorReport(db, config, finished + 1000, configPath);
  expect(report.ok).toBe(true);
  expect(report.elapsedMs).toBeLessThan(1000);
  expect(report.lines.join("\n")).toContain("provider fixture");
  expect(report.lines.join("\n")).toContain("healthy resolved plan");

  const work = db.prepare(
    `INSERT INTO job_work(kind,target_harness,target_native_id,input_version,current_status,attempt_count,current_error,created_at,updated_at)
     VALUES ('tier1','claude','s1','fixture-v11','failed',1,'boom',1,1)`,
  ).run() as { lastInsertRowid: number | bigint };
  const workId = Number(work.lastInsertRowid);
  db.prepare(
    `INSERT INTO job_attempts(work_id,attempt_ordinal,status,error,input_revision,finished_at,created_at)
     VALUES (?,?,?, ?,?,?,?)`,
  ).run(workId, 1, "failed", "boom", "fixture-generation", 1, 1);
  await favoriteIdentifier(db, config, "missing", { harness: "claude" });
  const degraded = collectDoctorReport(db, config, Date.now(), configPath);
  expect(degraded.ok).toBe(false);
  expect(db.prepare(`SELECT kind,current_status,current_error FROM job_work WHERE id=?`).get(workId)).toEqual({
    kind: "tier1", current_status: "failed", current_error: "boom",
  });
  expect(db.prepare(`SELECT status,error,input_revision FROM job_attempts WHERE work_id=?`).get(workId)).toEqual({
    status: "failed", error: "boom", input_revision: "fixture-generation",
  });
  expect(degraded.lines.join("\n")).toContain("job #");
  expect(degraded.lines.join("\n")).toContain("favorites pending");
  expect(root).toContain("atlas-wave1-doctor");
  db.close();
});

test("Wave 1 operations — doctor isolates full-walk and scheduled cadence health by source", async () => {
  const { root, config } = fixture("doctor-source-health");
  const codexRoot = join(root, "codex-root");
  mkdirSync(codexRoot);
  config.sources.codex = { mode: "replace", roots: [codexRoot], disabledReason: null };
  const configPath = join(root, "fixture-config.toml");
  const schedulePath = join(root, "fixture-schedule.plist");
  writeFileSync(configPath, "fixture config\n", { mode: 0o600 });
  writeFileSync(schedulePath, `${configPath}\n${config.dbPath}\n`, { mode: 0o600 });
  const db = await openDb(config.dbPath);
  const now = Date.now();
  const digest = sourcePlanDigest(config);
  const groupId = Number((db.prepare(
    `INSERT INTO reconciliation_groups(
       config_digest,trigger_kind,started_at,finished_at,status,enabled_source_count,complete_source_count
     ) VALUES (?,'scheduled',?,?,'incomplete',2,1)`,
  ).run(digest, now - 2000, now - 1000) as { lastInsertRowid: number | bigint }).lastInsertRowid);
  const insertSource = db.prepare(
    `INSERT INTO reconciliation_sources(
       group_id,source,resolution_mode,resolved_roots_json,status,admissible_identity_count,archived_identity_count
     ) VALUES (?,?,'replace',?,?,?,?)`,
  );
  const claudeSourceId = Number((insertSource.run(groupId, "claude", JSON.stringify([root]), "complete", 0, 0) as { lastInsertRowid: number | bigint }).lastInsertRowid);
  const codexSourceId = Number((insertSource.run(groupId, "codex", JSON.stringify([codexRoot]), "incomplete", null, null) as { lastInsertRowid: number | bigint }).lastInsertRowid);
  const insertRoot = db.prepare(
    `INSERT INTO reconciliation_roots(
       reconciliation_source_id,root_ordinal,root,reachability,started_at,finished_at,
       physical_unit_count,canonical_candidate_count
     ) VALUES (?,0,?,'reachable',?,?,0,0)`,
  );
  insertRoot.run(claudeSourceId, root, now - 2000, now - 1000);
  insertRoot.run(codexSourceId, codexRoot, now - 2000, now - 1000);
  const insertSchedule = db.prepare(
    `INSERT INTO source_schedule_state(
       source,config_digest,expected_interval_ms,degraded_after_ms,stale_after_ms,schedule_kind,schedule_path,
       target_config_path,target_db_path,last_scheduled_group_id,updated_at
     ) VALUES (?,?,300000,900000,3600000,'launchd',?,?,?,?,?)`,
  );
  for (const source of ["claude", "codex"]) {
    insertSchedule.run(source, digest, schedulePath, configPath, config.dbPath, groupId, now - 1000);
  }

  const runningGroupId = Number((db.prepare(
    `INSERT INTO reconciliation_groups(
       config_digest,trigger_kind,started_at,status,enabled_source_count,complete_source_count
     ) VALUES (?,'scheduled',?,'running',2,0)`,
  ).run(digest, now - 500) as { lastInsertRowid: number | bigint }).lastInsertRowid);
  insertSource.run(runningGroupId, "claude", JSON.stringify([root]), "complete", 0, 0);
  insertSource.run(runningGroupId, "codex", JSON.stringify([codexRoot]), "running", null, null);

  const report = collectDoctorReport(db, config, now, configPath);
  const line = (source: string, axis: string) => report.lines.find((item) => item.includes(source) && item.includes(axis));
  expect(line("claude", "full reconciliation")).toContain("[ok]");
  expect(line("codex", "full reconciliation")).toContain("[DOWN]");
  expect(line("claude", "schedule")).toContain("[ok]");
  expect(line("claude", "schedule")).toContain("source complete");
  expect(line("codex", "schedule")).toContain("[DOWN]");
  expect(line("codex", "schedule")).toContain("source incomplete");
  db.close();
});

test("Wave 1 operations — doctor treats retained invalid orphans as history and only valid orphans as actionable", async () => {
  const { config } = fixture("doctor-retained-invalid");
  config.sources.claude = { mode: "disabled", roots: [], disabledReason: "retained-history fixture" };
  const db = await openDb(config.dbPath);
  db.prepare(
    `INSERT INTO sessions(harness,native_id,source_path,orphaned,ingested_at)
     VALUES ('claude','legacy-invalid','/fixture/legacy-invalid',1,1)`,
  ).run();

  const retainedOnly = collectDoctorReport(db, config);
  expect(retainedOnly.status).toBe("healthy");
  expect(retainedOnly.orphaned).toBe(0);
  expect(retainedOnly.retainedInvalidOrphaned).toBe(1);
  expect(retainedOnly.lines.join("\n")).toContain("[--] retained invalid/orphaned history · 1");

  db.prepare(
    `INSERT INTO sessions(
       harness,native_id,source_path,orphaned,ingested_at,construction_generation,construction_status
     ) VALUES ('claude','valid-orphan','/fixture/valid-orphan',1,1,'fixture-valid','valid')`,
  ).run();
  const actionable = collectDoctorReport(db, config);
  expect(actionable.status).toBe("degraded");
  expect(actionable.orphaned).toBe(1);
  expect(actionable.retainedInvalidOrphaned).toBe(1);
  db.close();
});

test("Wave 1 operations — rebuild service requires confirmation and hard warning names only discardable cache", async () => {
  const { config } = fixture("rebuild-confirm");
  await expect(runRebuild(config)).rejects.toThrow("confirmation required");
  expect(rebuildWarning(false)).toContain("preserving favorites, summaries, anchors, and tags");
  const warning = rebuildWarning(true);
  expect(warning).toContain("Favorites remain verbatim");
  expect(warning).toContain("preserves summaries");
  expect(warning).toContain("canonical jobs/attempts exactly by SessionKey");
  expect(warning).toContain("Missing stable targets block the swap");
});

test("Wave 1 operations — doctor judges a walk left incomplete by live-root churn on its last complete pass", async () => {
  const { root, config } = fixture("doctor-churn");
  const configPath = join(root, "fixture-config.toml");
  const schedulePath = join(root, "fixture-schedule.plist");
  writeFileSync(configPath, "fixture config\n", { mode: 0o600 });
  writeFileSync(schedulePath, `${configPath}\n${config.dbPath}\n`, { mode: 0o600 });
  const db = await openDb(config.dbPath);
  const now = Date.now();
  const digest = sourcePlanDigest(config);
  const insertGroup = db.prepare(
    `INSERT INTO reconciliation_groups(config_digest,trigger_kind,started_at,finished_at,status,enabled_source_count,complete_source_count)
     VALUES (?,'scheduled',?,?,?,1,?)`,
  );
  const insertSource = db.prepare(
    `INSERT INTO reconciliation_sources(group_id,source,resolution_mode,resolved_roots_json,status,admissible_identity_count,archived_identity_count)
     VALUES (?,'claude','replace',?,?,?,?)`,
  );
  const insertRoot = db.prepare(
    `INSERT INTO reconciliation_roots(reconciliation_source_id,root_ordinal,root,reachability,started_at,finished_at,changed_during_walk,physical_unit_count,canonical_candidate_count)
     VALUES (?,0,?,'reachable',?,?,?,1,1)`,
  );
  const id = (result: unknown) => Number((result as { lastInsertRowid: number | bigint }).lastInsertRowid);
  const completeGroup = id(insertGroup.run(digest, now - 3000, now - 2000, "complete", 1));
  insertRoot.run(id(insertSource.run(completeGroup, JSON.stringify([root]), "complete", 1, 1)), root, now - 3000, now - 2000, 0);
  const churnGroup = id(insertGroup.run(digest, now - 1500, now - 1000, "incomplete", 0));
  const churnSource = id(insertSource.run(churnGroup, JSON.stringify([root]), "incomplete", null, null));
  insertRoot.run(churnSource, root, now - 1500, now - 1000, 1);
  db.prepare(
    `INSERT INTO source_schedule_state(source,config_digest,expected_interval_ms,degraded_after_ms,stale_after_ms,schedule_kind,schedule_path,
       target_config_path,target_db_path,last_scheduled_group_id,updated_at)
     VALUES ('claude',?,1800000,5400000,21600000,'launchd',?,?,?,?,?)`,
  ).run(digest, schedulePath, configPath, config.dbPath, churnGroup, now - 1000);
  const line = (report: ReturnType<typeof collectDoctorReport>, axis: string) => report.lines.find((item) => item.includes("claude") && item.includes(axis)) ?? "";
  const completedAt = (ms: number) => db.prepare(`UPDATE reconciliation_groups SET finished_at=? WHERE id=?`).run(ms, completeGroup);

  const fresh = collectDoctorReport(db, config, now, configPath);
  expect(line(fresh, "full reconciliation")).toContain("[ok]");
  expect(line(fresh, "full reconciliation")).toContain("roots changed during walk · last complete 2s ago · denominator 1");
  expect(line(fresh, "schedule")).toContain("[ok]");
  expect(line(fresh, "schedule")).toContain("source incomplete (roots changed during walk)");
  expect(fresh.status).toBe("healthy");

  completedAt(now - 2 * 60 * 60_000);
  const aging = collectDoctorReport(db, config, now, configPath);
  expect(line(aging, "full reconciliation")).toContain("[DEGRADED]");
  expect(line(aging, "schedule")).toContain("[ok]");
  expect(aging.status).toBe("degraded");

  completedAt(now - 7 * 60 * 60_000);
  expect(line(collectDoctorReport(db, config, now, configPath), "full reconciliation")).toContain("[DOWN]");

  // Anything beyond churn (unit errors, an unclean root) keeps the incomplete pass DOWN.
  completedAt(now - 2000);
  db.prepare(`UPDATE reconciliation_sources SET error_unit_count=1 WHERE id=?`).run(churnSource);
  const errored = collectDoctorReport(db, config, now, configPath);
  expect(line(errored, "full reconciliation")).toContain("[DOWN]");
  expect(line(errored, "schedule")).toContain("[DOWN]");
  db.prepare(`UPDATE reconciliation_sources SET error_unit_count=0 WHERE id=?`).run(churnSource);
  db.prepare(`UPDATE reconciliation_roots SET changed_during_walk=0 WHERE reconciliation_source_id=?`).run(churnSource);
  expect(line(collectDoctorReport(db, config, now, configPath), "full reconciliation")).toContain("[DOWN]");
  db.close();
});
