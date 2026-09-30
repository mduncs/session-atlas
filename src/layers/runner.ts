/**
 * Durable model-job runner for interpretation layers.
 *
 * A job is a kind (paragraphs, episodes, …), a model, and a ledger of items.
 * The runner claims a batch of pending items, makes one call, applies the
 * answer, and records tokens and cost per item. Everything that interrupts a
 * call — a usage limit, a crash, SIGTERM, a timeout — leaves items pending, so
 * the next run resumes exactly where this one stopped. Before every call the
 * usage gate is consulted; at the threshold the runner sleeps until the
 * window resets rather than exiting, so an overnight run finishes on its own.
 */
import type { Database } from "bun:sqlite";
import type { DB } from "../db/index.js";
import type { ModelCaller, ModelUsage } from "./model-call.js";
import { DEFAULT_USAGE_THRESHOLD, gateDecision, readGate, writeGate } from "./usage-gate.js";

export interface BuiltBatch { prompt: string; keys: string[]; skipped: string[] }
export interface Applied { applied: string[]; rejected: { key: string; error: string }[] }

export interface LayerTask {
  kind: string;
  system: string;
  /** Items per call. */
  batch: number;
  /** Extended thinking; off unless the task needs judgment (the rubric). */
  thinking?: boolean;
  /** Candidate item keys for a scope, excluding items already done in the layers. */
  plan(archive: DB, layers: Database, scope: { sinceMs: number | null }): string[];
  /** Prompt for up to `batch` keys; keys whose source vanished are skipped. */
  build(archive: DB, layers: Database, keys: string[]): BuiltBatch;
  apply(layers: Database, archive: DB, keys: string[], answer: unknown, model: string, now: number): Applied;
}

export interface RunnerOptions {
  archive: DB;
  layers: Database;
  call: ModelCaller;
  tasks: Record<string, LayerTask>;
  threshold?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Stop after this many calls (tests, dry pilots). */
  maxCalls?: number;
}

export interface RunReport { calls: number; applied: number; rejected: number; pauses: number; stoppedBy: "done" | "signal" | "max-calls" }

const MAX_ATTEMPTS = 3;
const ERROR_PAUSE_MS = 30 * 60_000;
const MAX_SLEEP_SLICE_MS = 60_000;

export function createJob(layers: Database, input: { id: string; kind: string; model: string; scope: string; keys: string[] }, now = Date.now()): number {
  let added = 0;
  layers.transaction(() => {
    layers.query(`INSERT OR IGNORE INTO layer_jobs(id,kind,model,scope,status,created_at,updated_at) VALUES(?,?,?,?, 'active',?,?)`)
      .run(input.id, input.kind, input.model, input.scope, now, now);
    const insert = layers.query(`INSERT OR IGNORE INTO layer_job_items(job_id,item_key,status,updated_at) VALUES(?,?,'pending',?)`);
    for (const key of input.keys) added += insert.run(input.id, key, now).changes;
  })();
  return added;
}

export const realSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, Math.max(0, ms));
  function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});

export async function runJobs(options: RunnerOptions): Promise<RunReport> {
  const { archive, layers, call, tasks } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const log = options.log ?? (() => {});
  const threshold = options.threshold ?? DEFAULT_USAGE_THRESHOLD;
  const report: RunReport = { calls: 0, applied: 0, rejected: 0, pauses: 0, stoppedBy: "done" };
  // Anything left running belongs to a previous process that did not finish it.
  layers.query(`UPDATE layer_job_items SET status='pending', updated_at=? WHERE status='running'`).run(now());
  let consecutiveErrors = 0;

  while (true) {
    if (options.signal?.aborted) { report.stoppedBy = "signal"; break; }
    if (options.maxCalls !== undefined && report.calls >= options.maxCalls) { report.stoppedBy = "max-calls"; break; }
    const job = layers.query(`SELECT id,kind,model,paused_until FROM layer_jobs WHERE status='active' ORDER BY created_at, id LIMIT 1`)
      .get() as { id: string; kind: string; model: string; paused_until: number | null } | null;
    if (!job) break;
    const task = tasks[job.kind];
    if (!task) {
      layers.query(`UPDATE layer_jobs SET status='cancelled', pause_reason=?, updated_at=? WHERE id=?`).run(`unknown kind ${job.kind}`, now(), job.id);
      continue;
    }

    // Gate first: a persisted snapshot means a restart waits instead of probing.
    const gate = gateDecision(readGate(layers), threshold, now());
    const errorPause = job.paused_until !== null && job.paused_until > now() ? job.paused_until : null;
    if (!gate.ok || errorPause) {
      const untilMs = Math.max(gate.ok ? 0 : gate.untilMs, errorPause ?? 0);
      const reason = gate.ok ? "paused after repeated errors" : `usage ${gate.reason} ≥ ${Math.round(threshold * 100)}%`;
      layers.query(`UPDATE layer_jobs SET paused_until=?, pause_reason=?, updated_at=? WHERE id=?`).run(untilMs, reason, now(), job.id);
      log(`paused · ${reason} · until ${new Date(untilMs).toLocaleString()}`);
      report.pauses++;
      while (now() < untilMs && !options.signal?.aborted) await sleep(Math.min(MAX_SLEEP_SLICE_MS, untilMs - now()), options.signal);
      continue;
    }

    const pending = (layers.query(`SELECT item_key FROM layer_job_items WHERE job_id=? AND status='pending' ORDER BY item_key LIMIT ?`)
      .all(job.id, task.batch) as { item_key: string }[]).map((row) => row.item_key);
    if (!pending.length) {
      layers.query(`UPDATE layer_jobs SET status='done', paused_until=NULL, pause_reason=NULL, updated_at=? WHERE id=?`).run(now(), job.id);
      log(`done · ${job.id}`);
      continue;
    }

    let built: BuiltBatch;
    try { built = task.build(archive, layers, pending); }
    catch (error) { built = { prompt: "", keys: [], skipped: [] }; markFailed(layers, job.id, pending, `build: ${message(error)}`, now()); continue; }
    if (built.skipped.length) markFailed(layers, job.id, built.skipped, "source no longer present", now());
    if (!built.keys.length) continue;

    setStatus(layers, job.id, built.keys, "running", now(), true);
    const result = await call({ model: job.model, system: task.system, prompt: built.prompt, thinking: task.thinking ?? false, signal: options.signal });
    report.calls++;
    if (result.snapshot) writeGate(layers, result.snapshot);
    if (result.limited || options.signal?.aborted) {
      // Not the items' fault: they go back untouched and do not spend an attempt.
      layers.query(`UPDATE layer_job_items SET status='pending', attempts=attempts-1, updated_at=? WHERE job_id=? AND status='running'`).run(now(), job.id);
      if (result.limited && !result.snapshot) {
        const gateNow = readGate(layers);
        writeGate(layers, { status: "rejected", overage: false, windows: gateNow?.windows ?? {}, seenAtMs: now() });
      }
      log(`call returned to pending · ${result.limited ? "usage limit" : "stopping"}`);
      continue;
    }
    if (!result.ok) {
      consecutiveErrors++;
      retryOrFail(layers, job.id, built.keys, result.error ?? "error", now());
      log(`call error ${consecutiveErrors} · ${result.error}`);
      if (consecutiveErrors >= 3) {
        // Three in a row is the environment (auth, CLI, outage), not these items: refund and pause.
        const refund = layers.query(`UPDATE layer_job_items SET status='pending', attempts=MAX(0, attempts-1), updated_at=? WHERE job_id=? AND item_key=?`);
        layers.transaction(() => { for (const key of built.keys) refund.run(now(), job.id, key); })();
        layers.query(`UPDATE layer_jobs SET paused_until=?, pause_reason=?, updated_at=? WHERE id=?`)
          .run(now() + ERROR_PAUSE_MS, `repeated errors: ${String(result.error).slice(0, 200)}`, now(), job.id);
        consecutiveErrors = 0;
      }
      continue;
    }
    consecutiveErrors = 0;

    const answer = parseJsonAnswer(result.text);
    if (answer === undefined) { retryOrFail(layers, job.id, built.keys, "answer was not JSON", now()); report.rejected += built.keys.length; continue; }
    const share = splitUsage(result.usage, built.keys.length);
    let applied: Applied;
    try { applied = task.apply(layers, archive, built.keys, answer, job.model, now()); }
    catch (error) { applied = { applied: [], rejected: built.keys.map((key) => ({ key, error: `apply: ${message(error)}` })) }; }
    const done = layers.query(`UPDATE layer_job_items SET status='done', error=NULL, input_tokens=input_tokens+?, output_tokens=output_tokens+?,
      cache_read_tokens=cache_read_tokens+?, cache_write_tokens=cache_write_tokens+?, cost_usd=cost_usd+?, updated_at=? WHERE job_id=? AND item_key=?`);
    const charge = layers.query(`UPDATE layer_job_items SET input_tokens=input_tokens+?, output_tokens=output_tokens+?,
      cache_read_tokens=cache_read_tokens+?, cache_write_tokens=cache_write_tokens+?, cost_usd=cost_usd+?, updated_at=? WHERE job_id=? AND item_key=?`);
    layers.transaction(() => {
      for (const key of applied.applied) done.run(share.inputTokens, share.outputTokens, share.cacheReadTokens, share.cacheWriteTokens, share.costUsd, now(), job.id, key);
      for (const { key } of applied.rejected) charge.run(share.inputTokens, share.outputTokens, share.cacheReadTokens, share.cacheWriteTokens, share.costUsd, now(), job.id, key);
    })();
    for (const { key, error } of applied.rejected) retryOrFail(layers, job.id, [key], error, now());
    report.applied += applied.applied.length;
    report.rejected += applied.rejected.length;
    const usage = result.snapshot ? Object.entries(result.snapshot.windows).map(([name, w]) => `${name} ${Math.round(w.utilization * 100)}%`).join(" ") : "usage ?";
    log(`${job.id} · ${applied.applied.length} applied · ${applied.rejected.length} rejected · $${result.usage.costUsd.toFixed(4)} · ${usage}`);
  }
  // Leave nothing claimed on the way out.
  layers.query(`UPDATE layer_job_items SET status='pending', updated_at=? WHERE status='running'`).run(now());
  return report;
}

export function parseJsonAnswer(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  for (const candidate of [fenced, text, sliceBetween(text, "{", "}"), sliceBetween(text, "[", "]")]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate.trim()); } catch { /* next */ }
  }
  return undefined;
}

function sliceBetween(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open), end = text.lastIndexOf(close);
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

function splitUsage(usage: ModelUsage, n: number): ModelUsage {
  const d = Math.max(1, n);
  return { inputTokens: Math.round(usage.inputTokens / d), outputTokens: Math.round(usage.outputTokens / d), cacheReadTokens: Math.round(usage.cacheReadTokens / d), cacheWriteTokens: Math.round(usage.cacheWriteTokens / d), costUsd: usage.costUsd / d };
}

function setStatus(layers: Database, jobId: string, keys: string[], status: string, now: number, attempt = false): void {
  const query = layers.query(`UPDATE layer_job_items SET status=?, attempts=attempts+?, updated_at=? WHERE job_id=? AND item_key=?`);
  layers.transaction(() => { for (const key of keys) query.run(status, attempt ? 1 : 0, now, jobId, key); })();
}

function retryOrFail(layers: Database, jobId: string, keys: string[], error: string, now: number): void {
  const query = layers.query(`UPDATE layer_job_items SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'pending' END, error=?, updated_at=? WHERE job_id=? AND item_key=?`);
  layers.transaction(() => { for (const key of keys) query.run(MAX_ATTEMPTS, error.slice(0, 500), now, jobId, key); })();
}

function markFailed(layers: Database, jobId: string, keys: string[], error: string, now: number): void {
  const query = layers.query(`UPDATE layer_job_items SET status='failed', error=?, updated_at=? WHERE job_id=? AND item_key=?`);
  layers.transaction(() => { for (const key of keys) query.run(error, now, jobId, key); })();
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
