#!/usr/bin/env bun
/** Read-only full-corpus cold-list and 4k-scroll proxy gate. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import React from "react";
import { render } from "ink";
import { Database } from "bun:sqlite";
import { readDashboardAnalytics, readDashboardRowStates } from "../src/tui/analytics.js";
import { FlatDashboard } from "../src/tui/flat-dashboard.js";
import { projectionSession, sessionKey, type SessionRow } from "../src/tui/domain.js";
import type { InteractionZone } from "../src/tui/interaction.js";
import type { DashboardListActions } from "../src/tui/list-view.js";
import { fetchPage } from "../src/tui/queries.js";
import { attachLayers } from "../src/layers/db.js";
import { execUnderProduction } from "../src/production-exec.js";
import { appendRows, initialState, logicalListViewport, moveFocus } from "../src/tui/store.js";

// Measure the React build `atlas` runs. Static imports already linked React,
// so an unset NODE_ENV re-executes this gate under production, forwarding
// signals and the child's exit status.
if (process.env.NODE_ENV === undefined) process.exit(await execUnderProduction());

export const COLD_DASHBOARD_BUDGET_MS = 500;
export const SCROLL_P99_BUDGET_MS = 8;

const dbPath = required("--db");
const outputDir = resolve(required("--output-dir"));
mkdirSync(outputDir, { recursive: true });
const startedAt = new Date().toISOString();
const started = performance.now();
const processRecord = { pid: process.pid, command: process.argv, startedAt, kill: `kill ${process.pid}`, scope: "read-only SQLite performance gate" };
writeJson("process.json", processRecord);

let db: Database | null = null;
let mounted: ReturnType<typeof render> | null = null;
class DiscardTerminal extends Writable {
  columns = 100;
  rows = 24;
  isTTY = true;
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void { callback(); }
}
const stdout = new DiscardTerminal();
const stderr = new DiscardTerminal();
let lastCoreRenderMs = Number.NaN;
let lastZoneCount = 0;
let stopping = false;
const PERF_ACTIONS: DashboardListActions = {
  onOpenSession: () => {},
  onPeekSession: () => {},
  onToggleFavorite: () => {},
  onToggleChain: () => {},
  onFilter: () => {},
  onRemoveFilter: () => {},
  onSearch: () => {},
  onApplyLive: () => {},
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    writeJson("done.json", { ok: false, aborted: true, pid: process.pid, signal });
    mounted?.unmount();
    db?.close();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}
try {
  db = new Database(dbPath, { readonly: true });
  attachLayers(db, dbPath, { create: false });
  const coldStart = performance.now();
  const fetchStarted = performance.now();
  const first = fetchPage(db, {}, null, 300);
  const coldFetchMs = performance.now() - fetchStarted;
  if (first.error) throw new Error(first.error.message);
  const analyticsStarted = performance.now();
  const coldAnalytics = readDashboardAnalytics(db, {});
  const coldAnalyticsMs = performance.now() - analyticsStarted;
  let state = appendRows(initialState(18), first.rows, !first.hasMore);
  const mountStarted = performance.now();
  mounted = render(frameElement(state, coldAnalytics), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: process.stdin,
    debug: true,
    interactive: false,
    exitOnCtrlC: false,
    patchConsole: false,
    onRender: ({ renderTime }) => { lastCoreRenderMs = renderTime; },
  });
  const coldMountMs = performance.now() - mountStarted;
  const coldCoreMs = performance.now() - coldStart;

  const rows = [...first.rows];
  let cursor = first.rows.at(-1) ?? null;
  while (cursor && rows.length < coldAnalytics.corpusSessionCount) {
    const page = fetchPage(db, {}, { last_activity: cursor.last_activity, id: cursor.id }, 300);
    if (page.error) throw new Error(page.error.message);
    rows.push(...page.rows);
    cursor = page.rows.at(-1) ?? null;
    if (!page.hasMore) break;
  }
  state = appendRows(initialState(18), rows, true);

  for (let index = 0; index < 10; index++) {
    state = moveFocus(state, 1);
    mounted.rerender(frameElement(state, coldAnalytics));
  }

  const cpuFrameTimes: number[] = [];
  const coreFrameTimes: number[] = [];
  const wallFrameTimes: number[] = [];
  const frames = Math.min(4_000, Math.max(0, rows.length - 11));
  for (let index = 0; index < frames; index++) {
    const cpuStart = process.cpuUsage();
    const frameStart = performance.now();
    state = moveFocus(state, 1);
    mounted.rerender(frameElement(state, coldAnalytics));
    wallFrameTimes.push(performance.now() - frameStart);
    const cpu = process.cpuUsage(cpuStart);
    cpuFrameTimes.push((cpu.user + cpu.system) / 1_000);
    if (!Number.isFinite(lastCoreRenderMs)) throw new Error("Ink did not publish render metrics");
    coreFrameTimes.push(lastCoreRenderMs);
    if ((index + 1) % 250 === 0 || index + 1 === frames) {
      const progress = { pid: process.pid, phase: "scroll", frames: index + 1, total: frames, elapsedMs: performance.now() - started, at: new Date().toISOString() };
      writeJson("progress.json", progress);
      process.stderr.write(`[perf-gate] ${progress.frames}/${progress.total} · ${Math.round(progress.elapsedMs)}ms\n`);
    }
  }

  const orderedCpu = [...cpuFrameTimes].sort((a, b) => a - b);
  const orderedCore = [...coreFrameTimes].sort((a, b) => a - b);
  const orderedWall = [...wallFrameTimes].sort((a, b) => a - b);
  const coreP99Ms = percentile(orderedCore, .99);
  const wallP99Ms = percentile(orderedWall, .99);
  const result = {
    ok: coldCoreMs <= COLD_DASHBOARD_BUDGET_MS
      && coreP99Ms <= SCROLL_P99_BUDGET_MS
      && wallP99Ms <= SCROLL_P99_BUDGET_MS,
    startedAt,
    finishedAt: new Date().toISOString(),
    database: resolve(dbPath),
    sessions: rows.length,
    budget: {
      coldDashboardMs: COLD_DASHBOARD_BUDGET_MS,
      scrollP99Ms: SCROLL_P99_BUDGET_MS,
    },
    coldCoreMs,
    coldBreakdown: {
      fetchMs: coldFetchMs,
      analyticsMs: coldAnalyticsMs,
      mountMs: coldMountMs,
    },
    scroll: {
      frames,
      interactionZones: lastZoneCount,
      metric: "Ink onRender core frame time",
      meanMs: coreFrameTimes.reduce((sum, value) => sum + value, 0) / Math.max(1, frames),
      p95Ms: percentile(orderedCore, .95),
      p99Ms: coreP99Ms,
      maxMs: orderedCore.at(-1) ?? 0,
      over8Ms: coreFrameTimes.filter((value) => value > SCROLL_P99_BUDGET_MS).length,
      over16Ms: coreFrameTimes.filter((value) => value > 16.67).length,
      over33Ms: coreFrameTimes.filter((value) => value > 33).length,
      dispatchWall: {
        metric: "end-to-end rerender dispatch wall time",
        meanMs: wallFrameTimes.reduce((sum, value) => sum + value, 0) / Math.max(1, frames),
        p95Ms: percentile(orderedWall, .95),
        p99Ms: wallP99Ms,
        maxMs: orderedWall.at(-1) ?? 0,
        over8Ms: wallFrameTimes.filter((value) => value > SCROLL_P99_BUDGET_MS).length,
        over16Ms: wallFrameTimes.filter((value) => value > 16.67).length,
        over33Ms: wallFrameTimes.filter((value) => value > 33).length,
      },
      cpuDiagnostic: {
        metric: "process CPU per dispatch; multi-thread total, diagnostic only",
        meanMs: cpuFrameTimes.reduce((sum, value) => sum + value, 0) / Math.max(1, frames),
        p95Ms: percentile(orderedCpu, .95),
        p99Ms: percentile(orderedCpu, .99),
        maxMs: orderedCpu.at(-1) ?? 0,
        over33Ms: cpuFrameTimes.filter((value) => value > 33).length,
      },
    },
  };
  writeJson("result.json", result);
  writeJson("done.json", { ok: result.ok, pid: process.pid, result: resolve(outputDir, "result.json") });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  const diagnostic = error instanceof Error ? error.stack ?? error.message : String(error);
  writeJson("done.json", { ok: false, pid: process.pid, error: diagnostic });
  process.stderr.write(`[perf-gate] failed · ${diagnostic}\n`);
  process.exitCode = 1;
} finally {
  mounted?.unmount();
  stdout.destroy();
  stderr.destroy();
  db?.close();
}

function frameElement(state: ReturnType<typeof initialState>, analytics: ReturnType<typeof readDashboardAnalytics>): React.JSX.Element {
  if (!db) throw new Error("performance database is not open");
  const viewport = logicalListViewport(state);
  const represented = [...new Map(viewport.rows.filter((row) => row.kind !== "cluster").map((row) => {
    const session = projectionSession(row); return [sessionKey(session), session] as const;
  })).values()] as SessionRow[];
  const rowStates = readDashboardRowStates(db, represented);
  const focus = state.list.focusKey;
  return <FlatDashboard width={100} height={24} projections={viewport.rows} analytics={analytics}
    activeProvider={null} focusKey={focus} selectedKeys={state.list.selected} rowStates={rowStates}
    actions={PERF_ACTIONS} onInteractionZones={recordZones} />;
}

function recordZones(zones: readonly InteractionZone[]): void { lastZoneCount = zones.length; }

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  return values[Math.min(values.length - 1, Math.floor(values.length * ratio))]!;
}

function required(flag: string): string {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${flag}`);
  return value;
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(resolve(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
