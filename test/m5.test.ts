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

test("M5 F9 — staleness: growth past threshold invalidates tier-1 + tier-2, re-queues", async () => {
  db = await openDb(dbPath);
  // Seed a session with tier-1 summary covering 10 messages.
  const sid = seedSession(db, "s1", 10);

  db.prepare(
    `INSERT INTO summaries(session_id, tier, topic_line, msg_count_covered, model, generated_at)
     VALUES (?, 1, 'test topic', 10, 'm', ?)`,
  ).run(sid, Date.now());
  db.prepare(
    `INSERT INTO summaries(session_id, tier, body, msg_count_covered, model, generated_at)
     VALUES (?, 2, 'tier2 body', 10, 'm', ?)`,
  ).run(sid, Date.now());

  // Add 15 messages → growth = 50%, past the 25% threshold.
  appendDialogue(db, sid, 10, 15);

  const check = checkStaleness(db, sid, 25);
  expect(check.stale).toBe(true);
  expect(check.covered).toBe(10);
  expect(check.current).toBe(25);
  expect(check.growthPct).toBe(150);

  // Stale → tier-1 and tier-2 summaries deleted, job enqueued.
  const remaining = (
    db.prepare(`SELECT COUNT(*) n FROM summaries WHERE session_id=?`).get(sid) as { n: number }
  ).n;
  expect(remaining).toBe(0);
  const work = db.prepare(
    `SELECT id,kind,current_status,blocked_reason,attempt_count
     FROM job_work WHERE target_harness='claude' AND target_native_id='s1' AND kind='tier1'`,
  ).get() as { id: number; kind: string; current_status: string; blocked_reason: string; attempt_count: number };
  expect(work).toMatchObject({ kind: "tier1", current_status: "blocked", attempt_count: 1 });
  expect(work.blocked_reason).toContain("stale");
  expect(db.prepare(`SELECT status,error FROM job_attempts WHERE work_id=?`).get(work.id)).toMatchObject({
    status: "blocked", error: expect.stringContaining("stale"),
  });
});

test("M5 F9 — under-threshold growth does NOT invalidate", async () => {
  db = await openDb(dbPath);
  const sid = seedSession(db, "s1", 10);

  db.prepare(
    `INSERT INTO summaries(session_id, tier, topic_line, msg_count_covered, model, generated_at)
     VALUES (?, 1, 'test', 10, 'm', ?)`,
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
