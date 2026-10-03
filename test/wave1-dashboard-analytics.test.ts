import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runMigrations } from "../src/db/index.js";
import { attachLayers } from "../src/layers/db.js";
import {
  readDashboardAnalytics,
  readDashboardRowStates,
} from "../src/tui/analytics.js";

const NOW = 1_800_000_000_000;

function fixture(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  runMigrations(db);
  // A private layers file: the creator lens reads who started each session.
  attachLayers(db, join(mkdtempSync(join(tmpdir(), "atlas-analytics-")), "atlas.db"));
  const insert = db.prepare(
    `INSERT INTO sessions(
      harness,native_id,source_path,title,last_activity,duration_ms,models,
      tok_user,tok_assistant,tok_tool,msg_count,engagement,orphaned,ingested_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insert.run("claude", "cl-1", "/src/cl-1", "first", NOW - 60_000, 600_000, '["claude-opus-4-6"]', 2_000, 4_000, 1_000, 12, 0.4, 0, NOW);
  insert.run("claude", "cl-2", "/src/cl-2", "second", NOW - 120_000, 60_000, '["claude-sonnet-4-5"]', 20_000, 20_000, 1_000, 20, 0.2, 1, NOW);
  insert.run("codex", "cx-1", "/src/cx-1", "third", NOW - 180_000, 3_600_000, '["gpt-5.3-codex"]', 50_000, 50_000, 2_000, 40, 0.1, 0, NOW);
  db.prepare("UPDATE sessions SET origin='human' WHERE native_id='cl-1'").run();
  db.prepare("UPDATE sessions SET origin='agent' WHERE native_id IN ('cl-2','cx-1')").run();
  const creator = db.prepare(`INSERT INTO layers.session_creator(harness,native_id,session_id,started_by,confidence,evidence,
    first_human_ordinal,human_turns,agent_turns,harness_turns,rule_version,computed_at) VALUES (?,?,?,?,1,'fixture',NULL,0,0,0,1,?)`);
  creator.run("claude", "cl-1", 1, "human", NOW);
  creator.run("claude", "cl-2", 2, "agent", NOW);
  creator.run("codex", "cx-1", 3, "agent", NOW);

  db.prepare(
    `INSERT INTO summaries(session_id,tier,topic_line,msg_count_covered,model,generated_at)
     VALUES (1,1,'first summary',12,'opus',?)`,
  ).run(NOW - 30_000);
  db.prepare(`INSERT INTO tags(name,promoted_at) VALUES ('atlas-tui',?)`).run(NOW);
  db.prepare(`INSERT INTO session_tags(session_id,tag_id) VALUES (1,1),(2,1)`).run();
  db.prepare(
    `INSERT INTO favorites(
      harness,native_id,from_ordinal,to_ordinal,span_text,span_hash,topic,scope,status,
      created_at,updated_at,last_error
    ) VALUES ('claude','cl-1',NULL,NULL,'favorite session',NULL,NULL,'session','ok',?,?,NULL)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT INTO ingest_runs(
      source,root,started_at,finished_at,reachable,sessions_seen,bytes_consumed,error
    ) VALUES (?,?,?,?,?,?,?,?)`,
  ).run("claude", "/src", NOW - 20_000, NOW - 10_000, 1, 2, 500, null);
  db.prepare(
    `INSERT INTO ingest_runs(
      source,root,started_at,finished_at,reachable,sessions_seen,bytes_consumed,error
    ) VALUES (?,?,?,?,?,?,?,?)`,
  ).run("codex", "/src", NOW - 50_000, NOW - 40_000, 0, 1, 100, "root busy");
  const work = db.prepare(
    `INSERT INTO job_work(kind,target_harness,target_native_id,input_version,current_status,attempt_count,current_error,provider,created_at,updated_at)
     VALUES ('tier1','claude',?,?,?,?,?,?,?,?)`,
  );
  const done = Number((work.run("cl-1", "tier1:fixture-1", "done", 1, null, "zai-glm-air", NOW - 50_000, NOW - 30_000) as { lastInsertRowid: number | bigint }).lastInsertRowid);
  db.prepare(
    `INSERT INTO job_attempts(work_id,attempt_ordinal,status,provider,input_revision,started_at,finished_at,created_at)
     VALUES (?,1,'done','zai-glm-air','fixture-1',?,?,?)`,
  ).run(done, NOW - 40_000, NOW - 30_000, NOW - 40_000);
  work.run("cl-2", "tier1:fixture-2", "pending", 2, "timeout", null, NOW - 20_000, NOW - 5_000);
  return db;
}

test("dashboard analytics are filter-aware and come only from persisted facts", () => {
  const db = fixture();
  try {
    const result = readDashboardAnalytics(db, { source: "claude" }, NOW);
    expect(result.corpusSessionCount).toBe(3);
    expect(result.visibleSessionCount).toBe(2);
    expect(result.sources.find((source) => source.source === "claude")?.count).toBe(2);
    expect(result.sources.find((source) => source.source === "codex")?.count).toBe(0);
    expect(result.origins).toEqual([
      { label: "human", count: 1 },
      { label: "agent", count: 1 },
      { label: "unknown", count: 0 },
      { label: "empty", count: 0 },
    ]);
    expect(result.states).toEqual({ summarized: 1, pending: 1, orphaned: 1, favorite: 1 });
    expect(result.tags).toEqual([{ label: "atlas-tui", count: 2 }]);
    expect(result.models.map((model) => model.label)).toEqual(["opus-4-6", "sonnet-4-5"]);
    expect(result.sizes.map((bucket) => bucket.count)).toEqual([1, 0, 1, 0]);
    // Every run finished: the archive is idle, whatever the day's throughput was.
    expect(result.ingest.sessionsPerSecond).toBeNull();
    expect(result.ingest.hourlySessions.reduce((sum, value) => sum + value, 0)).toBe(3);
    expect(result.summarizer).toMatchObject({
      queue: 1,
      completedLastHour: 1,
      failures: 1,
      provider: "zai-glm-air",
    });
    expect(result.errorCount).toBe(2);
    expect(result.events.map((event) => event.label)).toContain("ingest claude +2");
    expect(result.events.some((event) => event.label.includes("root busy"))).toBe(true);
    expect(result.events.some((event) => event.label.includes("timeout"))).toBe(true);
  } finally {
    db.close();
  }
});

test("ingest rate shows only while a run is open; an interrupted run older than two hours is not live", () => {
  const db = fixture();
  try {
    const open = db.prepare(`INSERT INTO ingest_runs(source,root,started_at,reachable) VALUES ('claude','/src',?,0)`);
    open.run(NOW - 3 * 3_600_000);
    expect(readDashboardAnalytics(db, {}, NOW).ingest.sessionsPerSecond).toBeNull();
    open.run(NOW - 5_000);
    expect(readDashboardAnalytics(db, {}, NOW).ingest.sessionsPerSecond).toBeCloseTo(0.2);
  } finally {
    db.close();
  }
});

test("a root the latest reconciliation no longer walks stops counting as an error", () => {
  const db = fixture();
  try {
    expect(readDashboardAnalytics(db, {}, NOW).errorCount).toBe(2);
    const group = Number((db.prepare(
      `INSERT INTO reconciliation_groups(config_digest,trigger_kind,started_at,finished_at,status,enabled_source_count,complete_source_count)
       VALUES ('d','scheduled',?,?,'complete',1,1)`,
    ).run(NOW - 10_000, NOW - 5_000) as { lastInsertRowid: number | bigint }).lastInsertRowid);
    const source = Number((db.prepare(
      `INSERT INTO reconciliation_sources(group_id,source,resolution_mode,resolved_roots_json,status)
       VALUES (?,'claude','builtin','["/src"]','complete')`,
    ).run(group) as { lastInsertRowid: number | bigint }).lastInsertRowid);
    db.prepare(
      `INSERT INTO reconciliation_roots(reconciliation_source_id,root_ordinal,root,reachability) VALUES (?,0,'/src','reachable')`,
    ).run(source);
    // codex:/src failed last, but the current plan only walks claude:/src.
    expect(readDashboardAnalytics(db, {}, NOW).errorCount).toBe(1);
  } finally {
    db.close();
  }
});

test("row state lookup is bounded to viewport identities", () => {
  const db = fixture();
  try {
    const rows = db.prepare(
      `SELECT id,harness,native_id FROM sessions ORDER BY id`,
    ).all() as Array<{ id: number; harness: string; native_id: string }>;
    const states = readDashboardRowStates(db, rows.slice(0, 2).map((row) => ({ ...row })));
    expect(states.size).toBe(2);
    expect(states.get('["claude","cl-1"]')).toEqual({
      orphaned: false,
      summary: "summarized",
      failed: false,
    });
    expect(states.get('["claude","cl-2"]')).toEqual({
      orphaned: true,
      summary: "pending",
      failed: true,
    });
  } finally {
    db.close();
  }
});

test("never-indexed telemetry stays honestly empty", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    attachLayers(db, null);
    const result = readDashboardAnalytics(db, {}, NOW);
    expect(result.corpusSessionCount).toBe(0);
    expect(result.visibleSessionCount).toBe(0);
    expect(result.hasEverIngested).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.summarizer.provider).toBeNull();
  } finally {
    db.close();
  }
});
