import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, type DB } from "../src/db/index.js";
import { rebuildLogicalMetrics } from "../src/logical-metrics.js";
import { parseTier2, checkStaleness } from "../src/tier2.js";

let tmp: string;
let dbPath: string;
let db: DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atlas-m5-"));
  dbPath = join(tmp, "atlas.db");
});
afterEach(() => {
  db?.close();
  rmSync(tmp, { recursive: true, force: true });
});
function seedSession(db: DB, nativeId: string, count: number): number {
  const generation = `fixture-v11:${nativeId}`;
  const now = Date.now();
  const row = db.prepare(
    `INSERT INTO sessions(
       harness,native_id,source_path,ingested_at,msg_count,transcript_bytes,orphaned,
       artifact_kind,history_completeness,construction_generation,construction_status,
       default_session_visible,source_validation_status,source_observed_ts
     ) VALUES ('claude',?,'x',?,?,?,?, 'dialogue_history','complete',?,'valid',1,'current',?)`,
  ).run(nativeId, now, count, count * 10, 0, generation, now) as { lastInsertRowid: bigint | number };
  const sid = Number(row.lastInsertRowid);
  appendDialogue(db, sid, 0, count, generation);
  return sid;
}

function appendDialogue(db: DB, sid: number, start: number, count: number, generation?: string): void {
  const gen = generation ?? (db.prepare(`SELECT construction_generation FROM sessions WHERE id=?`).get(sid) as {
    construction_generation: string;
  }).construction_generation;
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO messages(
       session_id,ordinal,source_ordinal,role,ts,text,prose,event_ts,has_tool,tok_estimate,
       record_kind,dialogue_side,source_record_id,source_record_ts,source_identity_kind,construction_generation
     ) VALUES (?,?,?,?,?,?,?,?,0,10,'real_user','user',?,?,'record-id',?)`,
  );
  for (let i = 0; i < count; i++) {
    const ordinal = start + i;
    const ts = now + ordinal;
    insert.run(sid, ordinal, ordinal, "user", ts, `msg ${ordinal}`, `msg ${ordinal}`, ts,
      `fixture-${sid}-${ordinal}`, ts, gen);
  }
  db.prepare(`UPDATE sessions SET msg_count=?,transcript_bytes=? WHERE id=?`).run(start + count, (start + count) * 10, sid);
  rebuildLogicalMetrics(db, sid, gen);
}


test("M5 — parseTier2 extracts valid anchors with ordinal ranges", () => {
  const raw = JSON.stringify({
    body: "This session refactored the adapter layer for multi-root dedupe.",
    topics: [
      { topic: "Initial analysis", from: 0, to: 5, body: "Studied the existing adapter structure." },
      { topic: "Dedupe logic", from: 6, to: 12, body: "Implemented prefer-longer dedupe." },
    ],
  });
  const result = parseTier2(raw);
  expect(result.body).toContain("refactored the adapter layer");
  expect(result.anchors.length).toBe(2);
  expect(result.anchors[0]!.topic).toBe("Initial analysis");
  expect(result.anchors[0]!.fromOrdinal).toBe(0);
  expect(result.anchors[1]!.toOrdinal).toBe(12);
});

test("M5 Law 4 — malformed anchors degrade to unanchored body (anchors dropped)", () => {
  // from > to, negative ordinals, missing topic, non-integer
  const raw = JSON.stringify({
    body: "A valid body despite bad anchors.",
    topics: [
      { topic: "good", from: 0, to: 3, body: "ok" },
      { topic: "bad-from-gt-to", from: 10, to: 5, body: "x" },
      { topic: "bad-negative", from: -1, to: 3, body: "x" },
      { topic: "", from: 0, to: 3, body: "empty topic" },
      { topic: "bad-noninteger", from: 1.5, to: 3, body: "x" },
    ],
  });
  const result = parseTier2(raw);
  expect(result.body).toBe("A valid body despite bad anchors.");
  // Only the valid anchor survives; the four malformed ones are dropped.
  expect(result.anchors.length).toBe(1);
  expect(result.anchors[0]!.topic).toBe("good");
});

test("M5 Law 4 — completely unparseable input degrades to prose body, zero anchors", () => {
  const result = parseTier2("This is just prose, no JSON at all. The model babbled.");
  expect(result.body).toContain("This is just prose");
  expect(result.anchors).toEqual([]);
});

test("M5 F9 — staleness: dialogue growth past threshold flags both tiers and re-queues, keeping the prose", async () => {
  db = await openDb(dbPath);
  // Seed a session with tier-1 summary covering 10 dialogue turns.
  const sid = seedSession(db, "s1", 10);

  db.prepare(
    `INSERT INTO summaries(session_id, tier, topic_line, msg_count_covered, model, generated_at, coverage_basis)
     VALUES (?, 1, 'test topic', 10, 'm', ?, 'dialogue_turn_count_v1')`,
  ).run(sid, Date.now());
  db.prepare(
    `INSERT INTO summaries(session_id, tier, body, msg_count_covered, model, generated_at)
     VALUES (?, 2, 'tier2 body', 10, 'm', ?)`,
  ).run(sid, Date.now());

  // Add 15 dialogue turns: growth 150%, past the 25% threshold.
  appendDialogue(db, sid, 10, 15);

  const check = checkStaleness(db, sid, 25);
  expect(check.stale).toBe(true);
  expect(check.covered).toBe(10);
  expect(check.current).toBe(25);
  expect(check.growthPct).toBe(150);

  // Stale: both tiers stay readable, flagged for revalidation; one job queued.
  expect(db.prepare(`SELECT tier, topic_line, body, needs_revalidation FROM summaries WHERE session_id=? ORDER BY tier`).all(sid)).toEqual([
    { tier: 1, topic_line: "test topic", body: null, needs_revalidation: 1 },
    { tier: 2, topic_line: null, body: "tier2 body", needs_revalidation: 1 },
  ]);
  const work = db.prepare(
    `SELECT id,kind,current_status,blocked_reason,attempt_count
     FROM job_work WHERE target_harness='claude' AND target_native_id='s1' AND kind='tier1'`,
  ).get() as { id: number; kind: string; current_status: string; blocked_reason: string; attempt_count: number };
  expect(work).toMatchObject({ kind: "tier1", current_status: "blocked", attempt_count: 1 });
  expect(work.blocked_reason).toContain("stale");
  expect(db.prepare(`SELECT status,error FROM job_attempts WHERE work_id=?`).get(work.id)).toMatchObject({
    status: "blocked", error: expect.stringContaining("stale"),
  });

  // A later reconciliation of the same flagged summary does not queue again.
  checkStaleness(db, sid, 25);
  expect((db.prepare(`SELECT attempt_count FROM job_work WHERE id=?`).get(work.id) as { attempt_count: number }).attempt_count).toBe(1);
});

test("M5 F9 — tool and control records never count as growth; a legacy basis is never judged", async () => {
  db = await openDb(dbPath);
  const sid = seedSession(db, "s-tools", 10);
  db.prepare(
    `INSERT INTO summaries(session_id, tier, topic_line, msg_count_covered, model, generated_at, coverage_basis)
     VALUES (?, 1, 'tools', 10, 'm', ?, 'dialogue_turn_count_v1')`,
  ).run(sid, Date.now());
  const generation = (db.prepare(`SELECT construction_generation g FROM sessions WHERE id=?`).get(sid) as { g: string }).g;
  const tool = db.prepare(
    `INSERT INTO messages(session_id,ordinal,source_ordinal,role,ts,text,prose,event_ts,has_tool,tok_estimate,
       record_kind,dialogue_side,source_record_id,source_record_ts,source_identity_kind,construction_generation)
     VALUES (?,?,?,'tool',?,'',NULL,?,1,1,'tool',NULL,?,?,'record-id',?)`,
  );
  for (let ordinal = 10; ordinal < 40; ordinal++) tool.run(sid, ordinal, ordinal, ordinal, ordinal, `tool-${ordinal}`, ordinal, generation);
  rebuildLogicalMetrics(db, sid, generation);

  expect(checkStaleness(db, sid, 25)).toMatchObject({ stale: false, covered: 10, current: 10 });
  expect(db.prepare(`SELECT needs_revalidation FROM summaries WHERE session_id=?`).get(sid)).toEqual({ needs_revalidation: 0 });

  const legacy = seedSession(db, "s-legacy", 10);
  db.prepare(
    `INSERT INTO summaries(session_id, tier, topic_line, msg_count_covered, model, generated_at)
     VALUES (?, 1, 'legacy', 2, 'm', ?)`,
  ).run(legacy, Date.now());
  expect(checkStaleness(db, legacy, 25).stale).toBe(false);
  expect(db.prepare(`SELECT COUNT(*) n FROM summaries WHERE session_id=? AND needs_revalidation=0`).get(legacy)).toEqual({ n: 1 });
});

test("M5 F9 — under-threshold growth does NOT invalidate", async () => {
  db = await openDb(dbPath);
  const sid = seedSession(db, "s1", 10);

  db.prepare(
    `INSERT INTO summaries(session_id, tier, topic_line, msg_count_covered, model, generated_at, coverage_basis)
     VALUES (?, 1, 'test', 10, 'm', ?, 'dialogue_turn_count_v1')`,
  ).run(sid, Date.now());

  // Growth of 20% (12 msgs from 10) — under 25% threshold.
  appendDialogue(db, sid, 10, 2);

  const check = checkStaleness(db, sid, 25);
  expect(check.stale).toBe(false);
  expect(check.growthPct).toBe(20);
  // Summary survives.
  const n = (db.prepare(`SELECT COUNT(*) n FROM summaries WHERE session_id=?`).get(sid) as { n: number }).n;
  expect(n).toBe(1);
});
