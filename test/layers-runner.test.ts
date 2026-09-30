import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openLayersDb } from "../src/layers/db.js";
import { parseStream, type ModelCaller, type ModelResult } from "../src/layers/model-call.js";
import { createJob, runJobs, type LayerTask } from "../src/layers/runner.js";
import { candidateUnits, normalizeTag, paragraphize } from "../src/layers/tasks.js";
import { gateDecision, parseRateLimitEvent, readGate, type UsageSnapshot } from "../src/layers/usage-gate.js";
import type { DB } from "../src/db/index.js";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 28, 22, 0);
const snap = (fiveHour: number, resetsAtMs: number, extra: Partial<UsageSnapshot> = {}): UsageSnapshot =>
  ({ status: "allowed", overage: false, windows: { five_hour: { utilization: fiveHour, resetsAtMs }, seven_day: { utilization: 0.2, resetsAtMs: T0 + 90 * HOUR } }, seenAtMs: T0, ...extra });

describe("usage gate", () => {
  test("closes at 95% until the window resets, never before", () => {
    expect(gateDecision(snap(0.94, T0 + HOUR), 0.95, T0)).toEqual({ ok: true });
    const closed = gateDecision(snap(0.95, T0 + HOUR), 0.95, T0);
    expect(closed.ok).toBe(false);
    if (!closed.ok) { expect(closed.untilMs).toBeGreaterThan(T0 + HOUR); expect(closed.reason).toContain("five_hour 95%"); }
    expect(gateDecision(snap(0.99, T0 - 1), 0.95, T0)).toEqual({ ok: true });
  });

  test("the seven-day window and overage close it too", () => {
    const weekly: UsageSnapshot = { ...snap(0.1, T0 + HOUR), windows: { five_hour: { utilization: 0.1, resetsAtMs: T0 + HOUR }, seven_day: { utilization: 0.97, resetsAtMs: T0 + 50 * HOUR } } };
    const decision = gateDecision(weekly, 0.95, T0);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.untilMs).toBeGreaterThan(T0 + 50 * HOUR);
    expect(gateDecision(snap(0.1, T0 + HOUR, { overage: true }), 0.95, T0).ok).toBe(false);
  });

  test("reads the rate_limit_event Claude Code emits", () => {
    const parsed = parseRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1790649000, rateLimitType: "five_hour", utilization: 0.95, isUsingOverage: false,
      unifiedWindows: { five_hour: { utilization: 0.95, resetsAt: 1790649000 }, seven_day: { utilization: 0.21, resetsAt: 1790960400 } } } }, T0);
    expect(parsed?.windows.five_hour).toEqual({ utilization: 0.95, resetsAtMs: 1790649000_000 });
    expect(parsed?.windows.seven_day?.utilization).toBe(0.21);
  });

  test("a stream with a limit error is limited, not failed", () => {
    const limited = parseStream(`{"type":"result","is_error":true,"result":"Claude AI usage limit reached|1790649000"}\n`, "", 1);
    expect(limited).toMatchObject({ ok: false, limited: true });
    const fine = parseStream(`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.4,"resetsAt":1790649000}}}}\n{"type":"result","is_error":false,"result":"{}","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":7,"cache_read_input_tokens":100,"cache_creation_input_tokens":0}}\n`, "", 0);
    expect(fine).toMatchObject({ ok: true, limited: false, text: "{}", usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 100, costUsd: 0.01 } });
    expect(fine.snapshot?.windows.five_hour?.utilization).toBe(0.4);
  });
});

/** A task that needs no archive: each item's answer is echoed back as done. */
const echoTask: LayerTask = {
  kind: "echo", system: "echo", batch: 2,
  plan: () => [],
  build: (_a, _l, keys) => ({ prompt: keys.join(","), keys, skipped: [] }),
  apply: (layers, _a, keys) => { for (const key of keys) layers.query(`INSERT OR REPLACE INTO layer_meta(key,value) VALUES(?, 'x')`).run(`echo:${key}`); return { applied: keys, rejected: [] }; },
};

function harness(results: (clock: { now: number }) => ModelResult[]) {
  const dir = mkdtempSync(join(tmpdir(), "atlas-runner-"));
  const layers = openLayersDb(join(dir, "atlas.db"));
  const clock = { now: T0 };
  const queue = results(clock);
  const calls: string[] = [];
  const call: ModelCaller = async ({ prompt }) => { calls.push(prompt); return queue.shift() ?? ok(snap(0.5, clock.now + HOUR)); };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); clock.now += ms; };
  return { dir, layers, clock, calls, sleeps, call, sleep, cleanup: () => { layers.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const ok = (snapshot: UsageSnapshot | null): ModelResult => ({ ok: true, text: "{}", usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002 }, snapshot, limited: false, error: null });
const itemStatus = (layers: Database) => layers.query(`SELECT item_key, status, attempts FROM layer_job_items ORDER BY item_key`).all();

describe("durable runner", () => {
  test("stops calling at 95%, sleeps until reset, then finishes the job", async () => {
    const h = harness((clock) => [ok(snap(0.96, T0 + 2 * HOUR))]);
    try {
      createJob(h.layers, { id: "j", kind: "echo", model: "m", scope: "30d", keys: ["a", "b", "c", "d"] }, T0);
      const report = await runJobs({ archive: {} as DB, layers: h.layers, call: h.call, tasks: { echo: echoTask }, now: () => h.clock.now, sleep: h.sleep });
      expect(report).toMatchObject({ calls: 2, applied: 4, pauses: 1, stoppedBy: "done" });
      expect(h.clock.now).toBeGreaterThan(T0 + 2 * HOUR);
      expect(itemStatus(h.layers)).toEqual(["a", "b", "c", "d"].map((k) => ({ item_key: k, status: "done", attempts: 1 })));
      expect(readGate(h.layers)?.windows.five_hour?.utilization).toBe(0.5);
    } finally { h.cleanup(); }
  });

  test("a call refused by the limit returns its items to pending without spending an attempt", async () => {
    const h = harness((clock) => [{ ok: false, text: "", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, snapshot: { ...snap(1, clock.now + HOUR), status: "rejected" }, limited: true, error: "usage limit reached" }]);
    try {
      createJob(h.layers, { id: "j", kind: "echo", model: "m", scope: "30d", keys: ["a", "b"] }, T0);
      const report = await runJobs({ archive: {} as DB, layers: h.layers, call: h.call, tasks: { echo: echoTask }, now: () => h.clock.now, sleep: h.sleep });
      expect(report).toMatchObject({ calls: 2, applied: 2, pauses: 1 });
      expect(itemStatus(h.layers)).toEqual([{ item_key: "a", status: "done", attempts: 1 }, { item_key: "b", status: "done", attempts: 1 }]);
    } finally { h.cleanup(); }
  });

  test("a persisted closed gate makes a restarted runner wait instead of probing", async () => {
    const h = harness(() => []);
    try {
      createJob(h.layers, { id: "j", kind: "echo", model: "m", scope: "30d", keys: ["a"] }, T0);
      h.layers.query(`INSERT OR REPLACE INTO layer_meta(key,value) VALUES('usage_gate',?)`).run(JSON.stringify(snap(0.97, T0 + 3 * HOUR)));
      await runJobs({ archive: {} as DB, layers: h.layers, call: h.call, tasks: { echo: echoTask }, now: () => h.clock.now, sleep: h.sleep, maxCalls: 1 });
      expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3 * HOUR);
      expect(h.calls).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  test("abort mid-sleep exits cleanly with work still pending, and a rerun resumes it", async () => {
    const h = harness((clock) => [ok(snap(0.99, T0 + HOUR))]);
    try {
      createJob(h.layers, { id: "j", kind: "echo", model: "m", scope: "30d", keys: ["a", "b", "c"] }, T0);
      const controller = new AbortController();
      const sleep = async (ms: number) => { h.clock.now += ms; controller.abort(); };
      const first = await runJobs({ archive: {} as DB, layers: h.layers, call: h.call, tasks: { echo: echoTask }, now: () => h.clock.now, sleep, signal: controller.signal });
      expect(first.stoppedBy).toBe("signal");
      expect(itemStatus(h.layers)).toEqual([{ item_key: "a", status: "done", attempts: 1 }, { item_key: "b", status: "done", attempts: 1 }, { item_key: "c", status: "pending", attempts: 0 }]);
      h.clock.now = T0 + 2 * HOUR;
      const second = await runJobs({ archive: {} as DB, layers: h.layers, call: h.call, tasks: { echo: echoTask }, now: () => h.clock.now, sleep: h.sleep });
      expect(second).toMatchObject({ applied: 1, stoppedBy: "done" });
    } finally { h.cleanup(); }
  });

  test("repeated call errors pause the job instead of burning every item", async () => {
    const fail: ModelResult = { ok: false, text: "", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, snapshot: null, limited: false, error: "bad flag" };
    const h = harness(() => [fail, fail, fail]);
    try {
      createJob(h.layers, { id: "j", kind: "echo", model: "m", scope: "30d", keys: ["a", "b", "c", "d", "e", "f", "g", "h"] }, T0);
      const report = await runJobs({ archive: {} as DB, layers: h.layers, call: h.call, tasks: { echo: echoTask }, now: () => h.clock.now, sleep: h.sleep });
      expect(report.pauses).toBe(1);
      expect(report.applied).toBe(8);
      expect(h.layers.query(`SELECT COUNT(*) AS n FROM layer_job_items WHERE status='failed'`).get()).toEqual({ n: 0 });
    } finally { h.cleanup(); }
  });
});

describe("paragraph candidates", () => {
  test("breaks only ever add blank lines; words are untouched", () => {
    const text = "hi so i was thinking about the nav, its broken everywhere and i cant tell where i am. also the detail view is a wall of text i hate it. btw can we run the pilot tonight? and what does it cost";
    const units = candidateUnits(text);
    expect(units.map((unit) => unit.text).join("")).toBe(text);
    const shown = paragraphize(text, [units[1]!.start, units[3]!.start]);
    expect(shown.replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
    expect(shown.split("\n\n")).toHaveLength(3);
  });

  test("inline numbered items are candidates", () => {
    const text = "1 i was wrong about it 2 yes I like it 3 yes i like it, needs a rubric 4 yes i like i like 5 i think this is cheap right";
    expect(candidateUnits(text).map((unit) => unit.text.trim().slice(0, 1))).toEqual(["1", "2", "3", "4", "5"]);
  });

  test("run-on text without punctuation still gets candidates", () => {
    const text = Array.from({ length: 90 }, (_, i) => (i % 15 === 14 ? "so then" : "word")).join(" ");
    expect(candidateUnits(text).length).toBeGreaterThan(1);
  });
});

describe("tag hygiene", () => {
  test("model names, build numbers and date suffixes never become tags", () => {
    expect(normalizeTag("opus-5-5")).toBeNull();
    expect(normalizeTag("v100")).toBeNull();
    expect(normalizeTag("k3")).toBeNull();
    expect(normalizeTag("claude-sonnet-4-6")).toBeNull();
    expect(normalizeTag("gpt-6-astra")).toBeNull();
    expect(normalizeTag("glm-probe")).toBe("glm-probe");
    expect(normalizeTag("parity-exploration-202609")).toBe("parity-exploration");
    expect(normalizeTag("Apple Maps 3D")).toBe("apple-maps-3d");
    expect(normalizeTag("image-gen-6")).toBe("image-gen-6");
    expect(normalizeTag("codex")).toBe("codex");
    expect(normalizeTag("design")).toBeNull();
  });

  test("a v3 tag_merges table upgrades in place to allow nest, keeping its rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-merges-"));
    try {
      const path = join(dir, "atlas.layers.db");
      const old = new Database(path);
      old.exec(`CREATE TABLE tag_merges (from_tag TEXT NOT NULL, to_tag TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('merge','demote','split','keep')),
        reason TEXT NOT NULL, source TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (from_tag, to_tag, action));
        INSERT INTO tag_merges VALUES ('tmux-setup','tmux','merge','x','rubric',NULL,1);`);
      old.close();
      const layers = openLayersDb(join(dir, "atlas.db"));
      layers.query(`INSERT INTO tag_merges VALUES ('tmux-scrolling','tmux','nest','subtopic','rubric',NULL,2)`).run();
      expect(layers.query(`SELECT from_tag, action FROM tag_merges ORDER BY created_at`).all()).toEqual([{ from_tag: "tmux-setup", action: "merge" }, { from_tag: "tmux-scrolling", action: "nest" }]);
      layers.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
