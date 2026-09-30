#!/usr/bin/env bun
/**
 * Safe Wave 3 clone smoke for Session Atlas.
 *
 * This runner never opens the source database writable, never copies only the
 * SQLite main file, never launches the interactive TUI, and never invokes a
 * provider or launcher. All Atlas mutations are confined to an explicitly
 * named absolute work directory.
 */
import { chmod, lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import React from "react";
import { renderToString } from "ink";
import { DEFAULT_DB_PATH, HARNESS_IDS, loadConfig, type Config } from "../src/config.js";
import { openDb, type DB } from "../src/db/index.js";
import { createFavorite } from "../src/favorites.js";
import { writeExport } from "../src/export.js";
import { rebuildDatabase } from "../src/rebuild.js";
import { rebuildLogicalMetrics } from "../src/logical-metrics.js";
import { validateV12SearchIndex } from "../src/search/v12-fts.js";
import { readDashboardAnalytics, readDashboardRowStates } from "../src/tui/analytics.js";
import { App, TuiRuntime } from "../src/tui/app.js";
import { UltraDenseDashboard } from "../src/tui/dashboard.js";
import { projectListRows, sessionKey, type SessionRow } from "../src/tui/domain.js";
import { fetchPage } from "../src/tui/queries.js";
import { appendRows, closeExcursion, initialState, openSession } from "../src/tui/store.js";

const WIDTHS = [160, 120, 100, 80, 60, 50] as const;
const FRAME_HEIGHT = 24;
const PROGRESS_INTERVAL_MS = 30_000;
const PROJECT_ROOT = resolve(import.meta.dir, "..");

export interface CloneSmokeOptions {
  sourceDb: string;
  configPath: string;
  workDir: string;
  noSources: boolean;
  fixtureMode: boolean;
  allowCloneRebuild: boolean;
}

export interface FileFingerprint {
  path: string;
  exists: boolean;
  kind: "file" | "directory" | "other" | "missing";
  size: number | null;
  mtimeMs: number | null;
  mode: number | null;
  inode: number | null;
}

export interface CloneSmokeResult {
  ok: true;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  sourceDb: string;
  cloneDb: string;
  cloneConfig: string;
  counts: { sessions: number; messages: number; proseMessages: number; ftsRows: number };
  checks: {
    integrity: string;
    foreignKeyViolations: number;
    schemaVersion: string;
    dashboardMs: number;
    pageQueryMs: number;
    contextRestored: boolean;
    cli: Record<"help" | "doctor" | "search", { code: number; elapsedMs: number }>;
    frames: Array<{ width: number; lines: number; maxWidth: number; appBytes: number; dashboardBytes: number }>;
    fixtureActions: null | { favorite: boolean; export: boolean; normalRebuild: boolean; hardRebuild: boolean };
    cloneRebuild: null | { sessions: number; messages: number; favorites: number };
  };
  fingerprints: { before: FileFingerprint[]; after: FileFingerprint[]; unchanged: true };
  artifacts: { result: string; done: string; process: string; progress: string };
}

export function parseCloneSmokeArgs(argv: string[]): CloneSmokeOptions {
  const sourceDb = requiredValue(argv, "--source-db");
  const configPath = requiredValue(argv, "--config");
  const workDir = requiredValue(argv, "--work-dir");
  const known = new Set([
    "--source-db", "--config", "--work-dir", "--no-sources", "--fixture-mode", "--allow-clone-rebuild",
  ]);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!known.has(arg)) throw new Error(`clone smoke: unknown argument ${arg}`);
    if (["--source-db", "--config", "--work-dir"].includes(arg)) index++;
  }
  return {
    sourceDb,
    configPath,
    workDir,
    noSources: argv.includes("--no-sources"),
    fixtureMode: argv.includes("--fixture-mode"),
    allowCloneRebuild: argv.includes("--allow-clone-rebuild"),
  };
}

function requiredValue(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index < 0 ? undefined : argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`clone smoke: explicit ${flag} is required`);
  return value;
}

/** Validate all caller-selected paths before opening SQLite. */
export function assertSafeClonePaths(options: Pick<CloneSmokeOptions, "sourceDb" | "configPath" | "workDir">, cloneDb?: string): void {
  const paths = [
    ["sourceDb", options.sourceDb],
    ["configPath", options.configPath],
    ["workDir", options.workDir],
  ] as const;
  for (const [name, value] of paths) {
    if (!value || !isAbsolute(value)) throw new Error(`clone smoke: ${name} must be an explicit absolute path`);
  }
  const source = resolve(options.sourceDb);
  const output = resolve(cloneDb ?? join(options.workDir, "atlas-clone.db"));
  if (output === source) throw new Error("clone smoke: output database must not equal the source database");
  if (output === resolve(DEFAULT_DB_PATH)) throw new Error("clone smoke: output database must not equal Session Atlas DEFAULT_DB_PATH");
  if (resolve(options.workDir) === resolve("/") || resolve(options.workDir) === resolve(process.env.HOME ?? "/nonexistent")) {
    throw new Error("clone smoke: work directory is too broad");
  }
}

/**
 * sqlite3_serialize reads the connection's consistent database view, including
 * committed pages still resident in WAL. The source connection is readonly
 * and query_only; it is closed before the destination file is created.
 */
export async function createWalConsistentSnapshot(sourceDb: string, cloneDb: string): Promise<number> {
  if (!isAbsolute(sourceDb) || !isAbsolute(cloneDb)) throw new Error("snapshot paths must be absolute");
  if (resolve(sourceDb) === resolve(cloneDb)) throw new Error("snapshot destination must differ from source");
  if (existsSync(cloneDb)) throw new Error(`clone smoke: refusing to overwrite ${cloneDb}`);
  const source = new Database(sourceDb, { readonly: true, strict: true });
  let image: Uint8Array;
  try {
    source.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000;");
    image = source.serialize();
  } finally {
    source.close();
  }
  await writeFile(cloneDb, image, { flag: "wx", mode: 0o600 });
  return image.byteLength;
}

export function renderIsolatedConfig(config: Config, cloneDb: string, noSources = false): string {
  const lines = [
    "# Generated by scripts/clone-smoke.tsx. Providers and launchers are intentionally disabled.",
    `dbPath = ${tomlString(cloneDb)}`,
    "",
  ];
  if (noSources) {
    // Omission means builtin discovery under the v11 catalog contract. A
    // disposable no-source clone must therefore disable all seven entries
    // explicitly, with a visible reason, rather than accidentally walking the
    // operator's real source roots.
    for (const name of HARNESS_IDS) {
      lines.push(
        `[sources.${tomlKey(name)}]`,
        `mode = "disabled"`,
        `reason = "clone smoke --no-sources fixture"`,
        "",
      );
    }
  } else {
    // Config is already resolved by loadConfig, but render every catalog entry
    // explicitly so a cloned file cannot reactivate a builtin by omission.
    for (const name of HARNESS_IDS) {
      const source = config.sources[name];
      const roots = source?.roots ?? [];
      if (!source || source.mode === "disabled") {
        lines.push(
          `[sources.${tomlKey(name)}]`,
          `mode = "disabled"`,
          `reason = ${tomlString(source?.disabledReason ?? "clone smoke config omitted source")}`,
          "",
        );
        continue;
      }
      for (const root of roots) {
        if (!isAbsolute(root)) throw new Error(`clone smoke: configured source root must be absolute: ${root}`);
      }
      lines.push(
        `[sources.${tomlKey(name)}]`,
        `mode = "replace"`,
        `roots = [${roots.map(tomlString).join(", ")}]`,
        "",
      );
    }
  }
  lines.push(
    "[tunables]",
    `tag_promotion_count = ${config.tunables.tag_promotion_count}`,
    `export_budget_tokens = ${config.tunables.export_budget_tokens}`,
    `fav_default_span = ${config.tunables.fav_default_span}`,
    `summary_stale_pct = ${config.tunables.summary_stale_pct}`,
    `redact_entropy_threshold = ${config.tunables.redact_entropy_threshold}`,
    "",
  );
  return lines.join("\n");
}

function tomlString(value: string): string { return JSON.stringify(value); }
function tomlKey(value: string): string { return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value); }

export async function fingerprintPaths(paths: readonly string[]): Promise<FileFingerprint[]> {
  const unique = [...new Set(paths.map((path) => resolve(path)))].sort();
  return Promise.all(unique.map(async (path): Promise<FileFingerprint> => {
    try {
      const info = await lstat(path);
      return {
        path,
        exists: true,
        kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
        size: info.size,
        mtimeMs: info.mtimeMs,
        mode: info.mode,
        inode: info.ino,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { path, exists: false, kind: "missing", size: null, mtimeMs: null, mode: null, inode: null };
    }
  }));
}

export function assertFingerprintsUnchanged(before: readonly FileFingerprint[], after: readonly FileFingerprint[]): void {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    const beforeByPath = new Map(before.map((item) => [item.path, item]));
    const changed = after.filter((item) => JSON.stringify(item) !== JSON.stringify(beforeByPath.get(item.path))).map((item) => item.path);
    throw new Error(`clone smoke: source fingerprint changed during run: ${changed.join(", ") || "path set changed"}`);
  }
}

export async function runCloneSmoke(options: CloneSmokeOptions): Promise<CloneSmokeResult> {
  assertSafeClonePaths(options);
  if (options.allowCloneRebuild && options.noSources) {
    throw new Error("clone smoke: --allow-clone-rebuild requires configured clone sources; --no-sources would rebuild an empty archive");
  }
  await stat(options.sourceDb);
  await stat(options.configPath);
  await mkdir(options.workDir, { recursive: true, mode: 0o700 });
  const canonicalWork = await realpath(options.workDir);
  const cloneDb = join(canonicalWork, "atlas-clone.db");
  const cloneConfig = join(canonicalWork, "clone-config.toml");
  assertSafeClonePaths(options, cloneDb);
  for (const output of [cloneDb, cloneConfig, join(canonicalWork, "result.json"), join(canonicalWork, "done.json")]) {
    if (existsSync(output)) throw new Error(`clone smoke: refusing non-empty/reused output target ${output}`);
  }

  const artifacts = {
    result: join(canonicalWork, "result.json"),
    done: join(canonicalWork, "done.json"),
    process: join(canonicalWork, "process.json"),
    progress: join(canonicalWork, "progress.json"),
  };
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let phase = "starting";
  let tick = 0;
  const progress = async (next: string) => {
    phase = next;
    const payload = { pid: process.pid, phase, tick: ++tick, at: new Date().toISOString(), elapsedMs: performance.now() - started };
    await writeFile(artifacts.progress, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
    process.stderr.write(`[clone-smoke] ${payload.at} · ${phase} · ${Math.round(payload.elapsedMs)}ms\n`);
  };
  await writeFile(artifacts.process, JSON.stringify({
    pid: process.pid,
    startedAt,
    command: process.argv,
    kill: `kill ${process.pid}`,
    scope: "read-only source snapshot; all writes confined to workDir",
  }, null, 2) + "\n", { mode: 0o600 });
  const timer = setInterval(() => { void progress(`running: ${phase}`); }, PROGRESS_INTERVAL_MS);

  try {
    await progress("load config and fingerprint sources");
    const sourceConfig = await loadConfig(options.configPath);
    const fingerprintTargets = [
      options.sourceDb,
      `${options.sourceDb}-wal`,
      // SQLite readers may legitimately update the shared-memory coordination
      // file. It contains no durable archive data, so byte identity there is
      // neither expected nor evidence of a source write.
      options.configPath,
      // --no-sources intentionally disables the resolved catalog; do not
      // fingerprint operator roots that this fixture must never inspect.
      ...(options.noSources ? [] : Object.values(sourceConfig.sources).flatMap((source) => source?.roots ?? [])),
    ];
    const before = await fingerprintPaths(fingerprintTargets);

    await progress("serialize WAL-consistent readonly snapshot");
    await createWalConsistentSnapshot(options.sourceDb, cloneDb);
    await writeFile(cloneConfig, renderIsolatedConfig(sourceConfig, cloneDb, options.noSources), { flag: "wx", mode: 0o600 });
    await chmod(cloneConfig, 0o600);
    const cloneRuntimeConfig = await loadConfig(cloneConfig);

    await progress("validate clone database and production surfaces");
    const validation = await validateClone(cloneDb, cloneRuntimeConfig);

    await progress("exercise noninteractive CLI routes");
    const cli = {
      help: await runCli(["--config", cloneConfig, "help"], /Usage:/),
      doctor: await runCli(["--config", cloneConfig, "doctor"], /atlas doctor/),
      search: await runCli(["--config", cloneConfig, "search", `atlasclonesmokenomatch${Date.now()}`], /no hits/),
    };

    let fixtureActions: CloneSmokeResult["checks"]["fixtureActions"] = null;
    if (options.fixtureMode) {
      await progress("exercise favorite/export/rebuild on isolated tiny fixture");
      fixtureActions = await runFixtureActions(canonicalWork);
    }

    let cloneRebuild: CloneSmokeResult["checks"]["cloneRebuild"] = null;
    if (options.allowCloneRebuild) {
      await progress("explicitly authorized normal rebuild of guarded clone");
      assertSafeClonePaths(options, cloneRuntimeConfig.dbPath);
      cloneRebuild = await rebuildDatabase(cloneRuntimeConfig, { hard: false });
    }

    await progress("verify source fingerprints remained unchanged");
    const after = await fingerprintPaths(fingerprintTargets);
    assertFingerprintsUnchanged(before, after);
    const result: CloneSmokeResult = {
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      sourceDb: resolve(options.sourceDb),
      cloneDb,
      cloneConfig,
      counts: validation.counts,
      checks: { ...validation.checks, cli, fixtureActions, cloneRebuild },
      fingerprints: { before, after, unchanged: true },
      artifacts,
    };
    await writeFile(artifacts.result, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    await writeFile(artifacts.done, JSON.stringify({ ok: true, pid: process.pid, at: result.finishedAt, result: artifacts.result }, null, 2) + "\n", { mode: 0o600 });
    return result;
  } catch (error) {
    const failure = { ok: false, pid: process.pid, at: new Date().toISOString(), phase, error: messageOf(error) };
    await writeFile(artifacts.result, JSON.stringify(failure, null, 2) + "\n", { mode: 0o600 }).catch(() => undefined);
    await writeFile(artifacts.done, JSON.stringify(failure, null, 2) + "\n", { mode: 0o600 }).catch(() => undefined);
    throw error;
  } finally {
    clearInterval(timer);
  }
}

async function validateClone(cloneDb: string, config: Config): Promise<{
  counts: CloneSmokeResult["counts"];
  checks: Omit<CloneSmokeResult["checks"], "cli" | "fixtureActions" | "cloneRebuild">;
}> {
  const db = await openDb(cloneDb);
  try {
    const integrityRows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const integrity = integrityRows.length === 1 ? integrityRows[0]!.integrity_check : JSON.stringify(integrityRows);
    if (integrity !== "ok") throw new Error(`clone integrity_check failed: ${integrity}`);
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length > 0) throw new Error(`clone has ${foreignKeys.length} foreign-key violations`);
    const schemaVersion = String((db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | null)?.value ?? "0");
    const sessions = scalar(db, "SELECT COUNT(*) n FROM sessions");
    const messages = scalar(db, "SELECT COUNT(*) n FROM messages");
    const proseMessages = scalar(db, "SELECT COUNT(*) n FROM messages WHERE role IN ('user','assistant')");
    const searchValidation = validateV12SearchIndex(db);
    const ftsRows = searchValidation.ftsRows;

    const pageStarted = performance.now();
    const page = fetchPage(db, {}, null, 80);
    const pageQueryMs = performance.now() - pageStarted;
    if (page.error) throw new Error(`dashboard page query failed: ${page.error.message}`);
    const dashboardStarted = performance.now();
    const analytics = readDashboardAnalytics(db, {});
    const rowStates = readDashboardRowStates(db, page.rows);
    const dashboardMs = performance.now() - dashboardStarted;
    const projections = projectListRows(page.rows, new Set());
    const runtime = new TuiRuntime(db, config);
    const frames: CloneSmokeResult["checks"]["frames"] = [];
    try {
      for (const width of WIDTHS) {
        const dashboard = renderToString(
          <UltraDenseDashboard width={width} height={FRAME_HEIGHT} projections={projections} analytics={analytics}
            activeProvider={config.providers[0]?.name ?? null}
            rowStates={rowStates} focusKey={page.rows[0] ? sessionKey(page.rows[0]) : null} />,
          { columns: width, rows: FRAME_HEIGHT },
        );
        const app = renderToString(<App db={db} config={config} runtime={runtime} fixedWidth={width} fixedHeight={FRAME_HEIGHT} visibleRows={17} />,
          { columns: width, rows: FRAME_HEIGHT });
        const dashboardShape = assertFiniteFrame(dashboard, width, FRAME_HEIGHT, "dashboard");
        const appShape = assertFiniteFrame(app, width, FRAME_HEIGHT, "app");
        if (!app.includes("ATLAS")) throw new Error(`production shell at ${width} columns did not render ATLAS`);
        frames.push({ width, lines: Math.max(dashboardShape.lines, appShape.lines), maxWidth: Math.max(dashboardShape.maxWidth, appShape.maxWidth), appBytes: Buffer.byteLength(app), dashboardBytes: Buffer.byteLength(dashboard) });
      }
    } finally {
      await runtime.close();
    }
    const contextRestored = verifyContextRestoration(page.rows);
    if (!contextRestored) throw new Error("list context restoration helper changed operator context");
    return {
      counts: { sessions, messages, proseMessages, ftsRows },
      checks: { integrity, foreignKeyViolations: foreignKeys.length, schemaVersion, dashboardMs, pageQueryMs, contextRestored, frames },
    };
  } finally {
    db.close();
  }
}

function assertFiniteFrame(frame: string, width: number, height: number, label: string): { lines: number; maxWidth: number } {
  const lines = frame.length === 0 ? [] : frame.split("\n");
  const maxWidth = Math.max(0, ...lines.map((line) => Bun.stringWidth(line)));
  if (lines.length > height || maxWidth > width) throw new Error(`${label} frame ${width}x${height} overflowed as ${maxWidth}x${lines.length}`);
  return { lines: lines.length, maxWidth };
}

function verifyContextRestoration(rows: readonly SessionRow[]): boolean {
  if (rows.length === 0) return true;
  let state = appendRows(initialState(12), [...rows], true);
  const focus = Math.min(2, rows.length - 1);
  state = {
    ...state,
    filter: { source: rows[focus]!.harness, query: "restoration-probe" },
    list: {
      ...state.list,
      focus,
      focusKey: sessionKey(rows[focus]!),
      scrollTop: Math.min(1, focus),
      selected: state.list.selected.clone(),
      expandedChains: new Set(rows.flatMap((row) => row.chain_id === null ? [] : [row.chain_id])),
    },
  };
  state.list.selected.add(sessionKey(rows[focus]!));
  const before = contextDigest(state);
  const restored = closeExcursion(openSession(state, rows[focus]!.id));
  return before === contextDigest(restored);
}

function contextDigest(state: ReturnType<typeof initialState>): string {
  return JSON.stringify({
    filter: state.filter,
    rows: state.list.rows,
    fetchedAll: state.list.fetchedAll,
    focus: state.list.focus,
    focusKey: state.list.focusKey,
    scrollTop: state.list.scrollTop,
    expandedChains: [...state.list.expandedChains].sort((a, b) => a - b),
    selected: [...state.list.selected].sort(),
  });
}

async function runCli(args: string[], expected: RegExp): Promise<{ code: number; elapsedMs: number }> {
  const started = performance.now();
  const child = Bun.spawn([process.execPath, join(PROJECT_ROOT, "src", "cli.ts"), ...args], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const combined = `${stdout}\n${stderr}`;
  if (code !== 0) throw new Error(`CLI ${args.at(-1)} exited ${code}: ${combined.trim()}`);
  if (!expected.test(combined)) throw new Error(`CLI ${args.at(-1)} omitted expected output ${expected}`);
  return { code, elapsedMs: performance.now() - started };
}

async function runFixtureActions(workDir: string): Promise<NonNullable<CloneSmokeResult["checks"]["fixtureActions"]>> {
  const dbPath = join(workDir, "fixture-actions.db");
  if (existsSync(dbPath)) throw new Error(`fixture actions refuse existing ${dbPath}`);
  const config: Config = {
    sources: {}, providers: [], launchers: [], dbPath,
    tunables: { tag_promotion_count: 3, export_budget_tokens: 20_000, fav_default_span: 2, summary_stale_pct: 25, redact_entropy_threshold: 4.8 },
  };
  let db = await openDb(dbPath);
  const seeded = seedFixture(db);
  await createFavorite(db, { harness: "clone-smoke", nativeId: "fixture-1", fromOrdinal: 0, toOrdinal: 1, topic: "clone smoke" });
  const favorite = scalar(db, "SELECT COUNT(*) n FROM favorites") === 1;
  const written = await writeExport(db, config, { kind: "session", id: seeded }, { outputDir: join(workDir, "fixture-exports") });
  const exported = existsSync(written.path);
  db.close();

  const buildShadow = async (shadow: DB) => { seedFixture(shadow, false); };
  await rebuildDatabase(config, { hard: false, buildShadow });
  db = await openDb(dbPath);
  const normal = scalar(db, "SELECT COUNT(*) n FROM favorites") === 1 && scalar(db, "SELECT COUNT(*) n FROM summaries") === 1;
  db.close();
  await rebuildDatabase(config, { hard: true, buildShadow });
  db = await openDb(dbPath);
  // HARD changes reconstruction strength, not preservation authorization.
  const hard = scalar(db, "SELECT COUNT(*) n FROM favorites") === 1 && scalar(db, "SELECT COUNT(*) n FROM summaries") === 1;
  db.close();
  if (!favorite || !exported || !normal || !hard) throw new Error("fixture mutation/rebuild checks failed");
  return { favorite, export: exported, normalRebuild: normal, hardRebuild: hard };
}

function seedFixture(db: DB, includeSummary = true): number {
  const existing = db.prepare("SELECT id FROM sessions WHERE harness='clone-smoke' AND native_id='fixture-1'").get() as { id: number } | null;
  if (existing) return existing.id;
  const now = Date.now();
  const generation = "clone-smoke-fixture-v11";
  const result = db.prepare(`INSERT INTO sessions(
    harness,native_id,source_path,source_root,title,start_ts,end_ts,last_activity,duration_ms,models,
    tok_user,tok_assistant,tok_tool,msg_count,engagement,orphaned,transcript_bytes,ingested_at,
    artifact_kind,history_completeness,construction_generation,construction_status,default_session_visible,
    source_validation_status,source_observed_ts
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "clone-smoke", "fixture-1", "/readonly/fixture", "/readonly", "clone smoke fixture", now, now + 1_000, now + 1_000,
    1_000, '["fixture"]', 4, 5, 0, 2, 0.5, 0, 48, now,
    "dialogue_history", "complete", generation, "valid", 1, "current", now,
  );
  const id = Number(result.lastInsertRowid);
  const messages = [
    { ordinal: 0, role: "user", kind: "real_user", side: "user", text: "fixture user evidence", ts: now },
    { ordinal: 1, role: "assistant", kind: "assistant_dialogue_prose", side: "assistant", text: "fixture assistant evidence", ts: now + 1_000 },
  ] as const;
  for (const message of messages) {
    db.prepare(`INSERT INTO messages(
      session_id,ordinal,role,ts,text,tool_text,has_tool,tok_estimate,source_ordinal,record_kind,
      dialogue_side,prose,event_ts,source_record_id,source_record_ts,source_identity_kind,construction_generation
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      message.ordinal,
      message.role,
      message.ts,
      message.text,
      null,
      0,
      message.ordinal === 0 ? 4 : 5,
      message.ordinal,
      message.kind,
      message.side,
      message.text,
      message.ts,
      `clone-smoke-record-${message.ordinal}`,
      message.ts,
      "record-id",
      generation,
    );
  }
  rebuildLogicalMetrics(db, id, generation, "clone-smoke-replay-v1");
  if (includeSummary) {
    db.prepare(`INSERT INTO summaries(session_id,tier,topic_line,body,msg_count_covered,model,generated_at)
      VALUES (?,1,'clone smoke fixture','fixture summary',2,'fixture',?)`).run(id, now);
  }
  return id;
}

function scalar(db: DB, sql: string): number { return Number((db.prepare(sql).get() as { n: number }).n); }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function usage(): string {
  return `Usage: bun scripts/clone-smoke.tsx --source-db /absolute/source.db --config /absolute/config.toml --work-dir /absolute/new-output-dir [--no-sources] [--fixture-mode] [--allow-clone-rebuild]\n`;
}

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(usage());
    process.exit(0);
  }
  try {
    const options = parseCloneSmokeArgs(process.argv.slice(2));
    const result = await runCloneSmoke(options);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n${usage()}`);
    process.exitCode = 1;
  }
}
