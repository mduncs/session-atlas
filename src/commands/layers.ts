import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import { openLayersDb, layersPathFor } from "../layers/db.js";
import { computeCreators } from "../layers/creator.js";
import { computeShapes, formatShapes } from "../layers/shape.js";
import { claudeHeadless } from "../layers/model-call.js";
import { createJob, runJobs } from "../layers/runner.js";
import { LAYER_TASKS, TASK_MODEL } from "../layers/tasks.js";
import { DEFAULT_USAGE_THRESHOLD, gateDecision, readGate } from "../layers/usage-gate.js";
import { withReadOnlyCtx, hasFlag, flagValue } from "./ctx.js";

const USAGE = `usage:
  atlas layers creator|shape|all            recompute provider-free layers
  atlas layers plan <kind|pilot> [--since 30d|all] [--dry]
                                            queue model work (kinds: ${Object.keys(LAYER_TASKS).join(", ")})
  atlas layers run [--threshold 0.95] [--max-calls N]
                                            work queued jobs; pauses at the usage threshold and resumes after reset
  atlas layers status                       jobs, progress, tokens, cost, usage gate
  atlas layers estimate                     full-corpus cost projected from finished pilot items`;

/** The pilot order: cheap residue first, then text layers, then tags, then the checker. */
const PILOT = ["creator", "paragraphs", "episodes", "tiny-tags", "tag-rubric"];

export async function layersCmd(argv: string[]): Promise<number> {
  try {
    const verb = argv[0];
    if (verb === "creator" || verb === "shape" || verb === "all") return await recompute(argv, verb);
    if (verb === "plan") return await plan(argv);
    if (verb === "run") return await run(argv);
    if (verb === "status") return await status(argv);
    if (verb === "estimate") return await estimate(argv);
    throw new Error(USAGE);
  } catch (error) {
    process.stderr.write(`atlas layers: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

async function recompute(argv: string[], verb: "creator" | "shape" | "all"): Promise<number> {
  return withReadOnlyCtx(argv, ({ db, dbPath }) => {
    const layers = openLayersDb(dbPath);
    try {
      if (verb !== "shape") {
        const report = computeCreators(db, layers);
        process.stdout.write(`atlas layers creator · ${layersPathFor(dbPath)} · ${report.sessions} sessions · ${report.human} human / ${report.agent} agent / ${report.unknown} unknown · ${report.templatedOpeners} templated openers · ${report.ms} ms\n`);
        if (hasFlag(argv, "--json")) process.stdout.write(JSON.stringify(report) + "\n");
      }
      if (verb !== "creator") {
        const report = computeShapes(db, layers);
        process.stdout.write(`atlas layers shape · ${report.sessions} sessions · ${formatShapes(report.shapes)} · ${report.episodes} episodes · ${report.ms} ms\n`);
        if (hasFlag(argv, "--json")) process.stdout.write(JSON.stringify(report) + "\n");
      }
      return 0;
    } finally { layers.close(); }
  });
}

function parseSince(value: string | undefined, now: number): number | null {
  if (!value || value === "all") return value === "all" ? null : now - 30 * 86_400_000;
  const match = value.match(/^(\d+)([dh])$/);
  if (!match) throw new Error(`--since takes Nd, Nh, or all (got ${value})`);
  return now - Number(match[1]) * (match[2] === "d" ? 86_400_000 : 3_600_000);
}

async function plan(argv: string[]): Promise<number> {
  const target = argv[1];
  const kinds = target === "pilot" ? PILOT : target && LAYER_TASKS[target] ? [target] : null;
  if (!kinds) throw new Error(USAGE);
  const now = Date.now();
  const sinceArg = flagValue(argv, "--since") ?? "30d";
  const sinceMs = parseSince(sinceArg, now);
  return withReadOnlyCtx(argv, ({ db, dbPath }) => {
    const layers = openLayersDb(dbPath);
    try {
      for (const [i, kind] of kinds.entries()) {
        const task = LAYER_TASKS[kind]!;
        const keys = task.plan(db, layers, { sinceMs });
        const id = `${kind}-${sinceArg}-${new Date(now).toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
        const calls = Math.ceil(keys.length / task.batch);
        if (hasFlag(argv, "--dry")) { process.stdout.write(`atlas layers plan · ${kind} · ${keys.length} items · ~${calls} calls · ${TASK_MODEL[kind]} (dry)\n`); continue; }
        // The rubric reads the tags the earlier jobs write, so it always queues its single item.
        const queued = kind === "tag-rubric" ? [`vocabulary\u001f${now}`] : keys;
        if (!queued.length) { process.stdout.write(`atlas layers plan · ${kind} · nothing to do\n`); continue; }
        const added = createJob(layers, { id, kind, model: TASK_MODEL[kind]!, scope: sinceArg, keys: queued }, now + i);
        process.stdout.write(`atlas layers plan · ${kind} · job ${id} · ${added} items · ~${Math.ceil(added / task.batch)} calls · ${TASK_MODEL[kind]}\n`);
      }
      return 0;
    } finally { layers.close(); }
  });
}

/** One runner at a time per layers file; a stale lock (dead pid) is taken over. */
function takeLock(layersPath: string): (() => void) | null {
  const path = join(dirname(layersPath), "atlas.layers.runner.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { if (readFileSync(path, "utf8") === String(process.pid)) rmSync(path); } catch { /* gone */ } };
    } catch {
      let pid = 0;
      try { pid = Number(readFileSync(path, "utf8")); } catch { /* raced */ }
      if (pid && isAlive(pid)) return null;
      try { rmSync(path); } catch { /* raced */ }
    }
  }
  return null;
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function run(argv: string[]): Promise<number> {
  const threshold = Number(flagValue(argv, "--threshold") ?? DEFAULT_USAGE_THRESHOLD);
  if (!(threshold > 0 && threshold <= 1)) throw new Error("--threshold must be in (0, 1]");
  const maxCallsArg = flagValue(argv, "--max-calls");
  return withReadOnlyCtx(argv, async ({ db, dbPath }) => {
    const layersPath = layersPathFor(dbPath);
    const release = takeLock(layersPath);
    if (!release) { process.stdout.write("atlas layers run · another runner holds the lock; nothing to do\n"); return 0; }
    const layers = openLayersDb(dbPath);
    const controller = new AbortController();
    const stop = (signal: string) => { log(`${signal} · stopping after returning in-flight items to pending`); controller.abort(); };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));
    try {
      const report = await runJobs({
        archive: db, layers, call: claudeHeadless, tasks: LAYER_TASKS, threshold,
        signal: controller.signal, log, maxCalls: maxCallsArg ? Number(maxCallsArg) : undefined,
      });
      log(`exit · ${report.stoppedBy} · ${report.calls} calls · ${report.applied} applied · ${report.rejected} rejected · ${report.pauses} pauses`);
      return 0;
    } finally {
      layers.close();
      release();
    }
  });
}

function log(line: string): void {
  process.stdout.write(`${new Date().toISOString()} atlas layers run · ${line}\n`);
}

interface JobRow { id: string; kind: string; model: string; status: string; paused_until: number | null; pause_reason: string | null; items: number; done: number; pending: number; failed: number; input: number; output: number; cache_read: number; cache_write: number; cost: number }

function jobRows(layers: Database): JobRow[] {
  return layers.query(`SELECT j.id, j.kind, j.model, j.status, j.paused_until, j.pause_reason, COUNT(i.item_key) AS items,
      SUM(i.status='done') AS done, SUM(i.status IN ('pending','running')) AS pending, SUM(i.status='failed') AS failed,
      SUM(i.input_tokens) AS input, SUM(i.output_tokens) AS output, SUM(i.cache_read_tokens) AS cache_read, SUM(i.cache_write_tokens) AS cache_write, SUM(i.cost_usd) AS cost
    FROM layer_jobs j LEFT JOIN layer_job_items i ON i.job_id=j.id GROUP BY j.id ORDER BY j.created_at`).all() as JobRow[];
}

async function status(argv: string[]): Promise<number> {
  return withReadOnlyCtx(argv, ({ dbPath }) => {
    const layers = openLayersDb(dbPath);
    try {
      const gate = readGate(layers);
      const decision = gateDecision(gate);
      const windows = gate ? Object.entries(gate.windows).map(([name, w]) => `${name} ${Math.round(w.utilization * 100)}% (resets ${new Date(w.resetsAtMs).toLocaleString()})`).join(" · ") : "no call made yet";
      process.stdout.write(`usage gate · ${decision.ok ? "open" : `closed until ${new Date(decision.untilMs).toLocaleString()}`} · ${windows}\n`);
      for (const job of jobRows(layers)) {
        const paused = job.status === "active" && job.paused_until && job.paused_until > Date.now() ? ` · paused: ${job.pause_reason}` : "";
        process.stdout.write(`${job.id} · ${job.status}${paused} · ${job.done ?? 0}/${job.items} done · ${job.pending ?? 0} pending · ${job.failed ?? 0} failed · in ${job.input ?? 0} / out ${job.output ?? 0} / cache r ${job.cache_read ?? 0} w ${job.cache_write ?? 0} · $${(job.cost ?? 0).toFixed(4)}\n`);
      }
      return 0;
    } finally { layers.close(); }
  });
}

/** Project the full corpus from measured per-item cost. Planning is read-only. */
async function estimate(argv: string[]): Promise<number> {
  return withReadOnlyCtx(argv, ({ db, dbPath }) => {
    const layers = openLayersDb(dbPath);
    try {
      // The latest 30 items per kind: rates change when prompts or call settings do (e.g. thinking off).
      const measured = layers.query(`SELECT kind, COUNT(*) AS n, AVG(cost_usd) AS cost, AVG(input_tokens+cache_read_tokens+cache_write_tokens) AS input, AVG(output_tokens) AS output
        FROM (SELECT j.kind, i.*, ROW_NUMBER() OVER (PARTITION BY j.kind ORDER BY i.updated_at DESC) AS recent
              FROM layer_job_items i JOIN layer_jobs j ON j.id=i.job_id WHERE i.status='done') WHERE recent <= 30 GROUP BY kind`).all() as { kind: string; n: number; cost: number; input: number; output: number }[];
      let total = 0;
      for (const kind of PILOT) {
        const m = measured.find((row) => row.kind === kind);
        const remaining = kind === "tag-rubric" ? 1 : LAYER_TASKS[kind]!.plan(db, layers, { sinceMs: null }).length;
        const cost = m ? m.cost * remaining : NaN;
        if (Number.isFinite(cost)) total += cost;
        process.stdout.write(`${kind} · ${remaining} items left in full corpus · ${m ? `latest ${m.n}: $${m.cost.toFixed(5)}/item, ${Math.round(m.input)} in / ${Math.round(m.output)} out tokens` : "not measured yet"} · ${Number.isFinite(cost) ? `≈ $${cost.toFixed(2)}` : "?"}\n`);
      }
      process.stdout.write(`total ≈ $${total.toFixed(2)} API-equivalent (subscription runs spend usage windows, not dollars)\n`);
      return 0;
    } finally { layers.close(); }
  });
}
