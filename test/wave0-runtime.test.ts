import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tuiCmd } from "../src/commands/tui.js";
import { openDb } from "../src/db/index.js";
import { callChain } from "../src/provider.js";
import { summarizeSession, enqueueJob } from "../src/summarize.js";
import { TaskSupervisor } from "../src/runtime/tasks.js";
import { HARNESS_IDS, type Config } from "../src/config.js";
import { rebuildLogicalMetrics } from "../src/logical-metrics.js";

const dirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.ATLAS_WAVE0_KEY;
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "atlas-wave0-runtime-"));
  dirs.push(dir);
  return dir;
}

function config(dbPath: string, base: string): Config {
  const sources = Object.fromEntries(HARNESS_IDS.map((source) => [source, {
    mode: "disabled", roots: [], disabledReason: "fixture owns no source",
  }])) as Config["sources"];
  return {
    sources,
    providers: [
      { name: "fixture", base, kind: "anthropic", model: "fixture-model", key_env: "ATLAS_WAVE0_KEY" },
    ],
    launchers: [],
    tunables: {
      tag_promotion_count: 3,
      export_budget_tokens: 20_000,
      fav_default_span: 6,
      summary_stale_pct: 25,
      redact_entropy_threshold: 4.8,
    },
    dbPath,
  };
}

function seedSession(db: Awaited<ReturnType<typeof openDb>>): number {
  const generation = "fixture-v11:runtime-s1";
  const now = Date.now();
  const row = db.prepare(
    `INSERT INTO sessions(
       harness,native_id,source_path,ingested_at,msg_count,transcript_bytes,orphaned,
       artifact_kind,history_completeness,construction_generation,construction_status,
       default_session_visible,source_validation_status,source_observed_ts
     ) VALUES ('claude','runtime-s1','fixture',?,1,20,0,'dialogue_history','complete',?,'valid',1,'current',?)`,
  ).run(now, generation, now) as { lastInsertRowid: number | bigint };
  const id = Number(row.lastInsertRowid);
  db.prepare(
    `INSERT INTO messages(
       session_id,ordinal,source_ordinal,role,ts,text,prose,event_ts,has_tool,tok_estimate,
       record_kind,dialogue_side,source_record_id,source_record_ts,source_identity_kind,construction_generation
     ) VALUES (?,0,0,'user',?,? ,?, ?,0,8,'real_user','user',?,?,'record-id',?)`,
  ).run(id, now, "summarize the runtime ownership work", "summarize the runtime ownership work", now,
    "fixture-runtime-user", now, generation);
  rebuildLogicalMetrics(db, id, generation);
  return id;
}

test("TUI resolves --config and launches only the configured database target", async () => {
  const dir = temp();
  const configPath = join(dir, "atlas.toml");
  const dbPath = join(dir, "isolated", "configured.db");
  writeFileSync(configPath, `dbPath = ${JSON.stringify(dbPath)}\n`);

  let launched: { dbPath: string; configPath?: string } | undefined;
  const code = await tuiCmd(["--config", configPath], async (opts) => {
    launched = opts;
  });

  expect(code).toBe(0);
  expect(launched?.dbPath).toBe(dbPath);
  expect(launched?.configPath).toBe(configPath);
});

test("provider cancellation stops chain fallthrough", async () => {
  process.env.ATLAS_WAVE0_KEY = "fixture";
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return Response.json({ content: [{ type: "text", text: "late" }] });
    },
  });
  servers.push(server);
  const ctrl = new AbortController();
  const providers = [
    ...config("x", server.url.toString()).providers,
    { ...config("x", server.url.toString()).providers[0]!, name: "must-not-run" },
  ];
  const pending = callChain(
    providers,
    { system: "fixture", turns: [{ role: "user", text: "hello", ordinal: 0 }], maxTokens: 20, signal: ctrl.signal },
    () => ({ degenerate: false }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  ctrl.abort("view closed");
  const result = await pending;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.cancelled).toBe(true);
  expect(requests).toBe(1);
});

test("task close aborts provider work and prevents late DB writes", async () => {
  const dir = temp();
  const db = await openDb(join(dir, "atlas.db"));
  process.env.ATLAS_WAVE0_KEY = "fixture";
  const server = Bun.serve({
    port: 0,
    async fetch() {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return Response.json({
        content: [{ type: "text", text: JSON.stringify({ topic_line: "late result", tags: ["runtime"] }) }],
      });
    },
  });
  servers.push(server);
  const sid = seedSession(db);
  const supervisor = new TaskSupervisor();
  const task = supervisor.run((ctx) =>
    summarizeSession(db, config(join(dir, "atlas.db"), server.url.toString()), sid, {
      signal: ctx.signal,
      shouldCommit: ctx.isCurrent,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  await supervisor.close();
  const result = await task;
  expect(result.reason).toBe("cancelled");
  expect(supervisor.activeCount).toBe(0);
  expect((db.prepare(`SELECT COUNT(*) n FROM summaries`).get() as { n: number }).n).toBe(0);
  const cancelledWork = db.prepare(
    `SELECT id,current_status,current_error,attempt_count FROM job_work
     WHERE target_harness='claude' AND target_native_id='runtime-s1' AND kind='tier1'`,
  ).get() as { id: number; current_status: string; current_error: string; attempt_count: number };
  expect(cancelledWork).toMatchObject({ current_status: "pending", current_error: "cancelled", attempt_count: 1 });
  expect(db.prepare(`SELECT status,error FROM job_attempts WHERE work_id=?`).get(cancelledWork.id)).toEqual({
    status: "failed", error: "cancelled",
  });
  db.close();
});

test("redo replaces tier-1 cache and pending jobs upsert attempts", async () => {
  const dir = temp();
  const dbPath = join(dir, "atlas.db");
  const db = await openDb(dbPath);
  process.env.ATLAS_WAVE0_KEY = "fixture";
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        content: [{ type: "text", text: JSON.stringify({ topic_line: "new runtime summary", tags: ["fresh"] }) }],
      });
    },
  });
  servers.push(server);
  const sid = seedSession(db);
  db.prepare(
    `INSERT INTO summaries(session_id,tier,topic_line,msg_count_covered,model,generated_at)
     VALUES (?,1,'old summary',1,'old-model',1)`,
  ).run(sid);
  db.prepare(`INSERT INTO tag_candidates(name,session_id) VALUES ('stale',?)`).run(sid);

  const result = await summarizeSession(db, config(dbPath, server.url.toString()), sid, { redo: true });
  expect(result.status).toBe("summarized");
  const summary = db.prepare(`SELECT topic_line,model FROM summaries WHERE session_id=? AND tier=1`).get(sid) as {
    topic_line: string;
    model: string;
  };
  expect(summary).toEqual({ topic_line: "new runtime summary", model: "fixture-model" });
  expect((db.prepare(`SELECT name FROM tag_candidates WHERE session_id=?`).all(sid) as { name: string }[]).map((r) => r.name)).toEqual(["fresh"]);

  enqueueJob(db, sid, "tier1", "first");
  enqueueJob(db, sid, "tier1", "second");
  const generation = (db.prepare(`SELECT construction_generation FROM sessions WHERE id=?`).get(sid) as {
    construction_generation: string;
  }).construction_generation;
  const work = db.prepare(
    `SELECT id,current_status,attempt_count,current_error
     FROM job_work
     WHERE kind='tier1' AND target_harness='claude' AND target_native_id='runtime-s1'
       AND input_version=?`,
  ).get(`tier1:${generation}`) as {
    id: number; current_status: string; attempt_count: number; current_error: string | null;
  };
  expect(work).toMatchObject({ current_status: "blocked", attempt_count: 2, current_error: "second" });
  expect(db.prepare(`SELECT status,error FROM job_attempts WHERE work_id=? ORDER BY attempt_ordinal`).all(work.id)).toEqual([
    { status: "blocked", error: "first" },
    { status: "blocked", error: "second" },
  ]);
  db.close();
});
