import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, type DB } from "../src/db/index.js";
import { getLogicalMetrics, rebuildLogicalMetrics } from "../src/logical-metrics.js";

let db: DB | undefined;
let dir: string | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("rebuildLogicalMetrics preserves compact token, prose, tool, and replay metrics", async () => {
  dir = mkdtempSync(join(tmpdir(), "atlas-wave8-compact-metrics-"));
  db = await openDb(join(dir, "atlas.db"));
  const generation = "fixture-v13:compact";
  const now = 1_700_000_000_000;
  const session = Number((db.prepare(`
    INSERT INTO sessions(
      harness,native_id,source_path,ingested_at,msg_count,transcript_bytes,
      artifact_kind,history_completeness,construction_generation,construction_status,
      default_session_visible,source_validation_status,source_observed_ts
    ) VALUES ('fixture','compact','fixture',?,3,100,'dialogue_history','complete',?,'valid',1,'current',?)
  `).run(now, generation, now) as { lastInsertRowid: number | bigint }).lastInsertRowid);
  const insertMessage = db.prepare(`
    INSERT INTO messages(
      session_id,ordinal,source_ordinal,role,ts,text,tool_text,has_tool,tok_estimate,
      source_record_id,source_record_ts,source_identity_kind,record_kind,dialogue_side,
      prose,construction_generation,content_digest,content_bytes,content_token_estimate,source_prose_present
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const question = digest("question");
  const answer = digest("answer");
  insertMessage.run(session, 0, 0, "user", now, null, null, 1, 5, "record-user", now, "record-id", "real_user", "user", null, generation, question, 8, 2, 1);
  insertMessage.run(session, 1, 1, "user", now, null, null, 1, 5, "record-user", now, "record-id", "real_user", "user", null, generation, question, 8, 2, 1);
  insertMessage.run(session, 2, 2, "assistant", now + 1, null, null, 0, 2, "record-assistant", now + 1, "record-id", "assistant_dialogue_prose", "assistant", null, generation, answer, 6, 2, 1);
  const insertTool = db.prepare(`
    INSERT INTO tool_activities(
      raw_record_id,activity_ordinal,activity_kind,tool_name,tool_text,source_activity_id,
      construction_generation,payload_digest,payload_bytes,payload_token_estimate
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  const rawIds = db.prepare(`SELECT id FROM messages WHERE session_id=? ORDER BY ordinal`).all(session) as Array<{ id: number }>;
  for (const raw of rawIds.slice(0, 2)) {
    insertTool.run(raw.id, 0, "result", "shell", null, "activity-1", generation, digest("tool payload"), 12, 3);
  }

  const rebuilt = rebuildLogicalMetrics(db, session, generation);
  expect(rebuilt).toMatchObject({
    logicalTokUser: 2,
    logicalTokAssistant: 2,
    logicalTokTool: 3,
    logicalToolCallCount: 1,
    logicalMsgCount: 2,
    logicalReplayCount: 1,
  });
  expect(db.prepare(`
    SELECT raw_prose_bearing_record_count,logical_prose_bearing_record_count,
           dialogue_turn_count,user_dialogue_turn_count,assistant_dialogue_turn_count,
           raw_tool_activity_count,logical_tool_activity_count
    FROM construction_metrics WHERE session_id=?
  `).get(session)).toEqual({
    raw_prose_bearing_record_count: 3,
    logical_prose_bearing_record_count: 2,
    dialogue_turn_count: 2,
    user_dialogue_turn_count: 1,
    assistant_dialogue_turn_count: 1,
    raw_tool_activity_count: 2,
    logical_tool_activity_count: 1,
  });
  expect(getLogicalMetrics(db, session)).toMatchObject({ logicalReplayCount: 1 });
});

test("full legacy bodies still provide metric and replay fallbacks", async () => {
  dir = mkdtempSync(join(tmpdir(), "atlas-wave8-full-metrics-"));
  db = await openDb(join(dir, "atlas.db"));
  const session = Number((db.prepare(`INSERT INTO sessions(harness,native_id,source_path,ingested_at) VALUES ('fixture','full','fixture',1)`).run() as { lastInsertRowid: number | bigint }).lastInsertRowid);
  db.prepare(`
    INSERT INTO messages(session_id,ordinal,role,text,tool_text,has_tool,tok_estimate,prose,source_record_id,source_record_ts,source_identity_kind,record_kind,dialogue_side)
    VALUES (?,0,'user','legacy question',NULL,1,0,'legacy question','legacy-record',1,'record-id','real_user','user'),
           (?,1,'user','legacy question',NULL,1,0,'legacy question','legacy-record',1,'record-id','real_user','user')
  `).run(session, session);
  const rawIds = db.prepare(`SELECT id FROM messages WHERE session_id=? ORDER BY ordinal`).all(session) as Array<{ id: number }>;
  const insertTool = db.prepare(`INSERT INTO tool_activities(raw_record_id,activity_ordinal,activity_kind,tool_text,source_activity_id,construction_generation) VALUES (?,0,'result',?,'legacy-tool','legacy')`);
  rawIds.forEach((raw) => insertTool.run(raw.id, "legacy tool payload"));

  expect(rebuildLogicalMetrics(db, session)).toMatchObject({
    logicalTokUser: 4,
    logicalTokTool: 5,
    logicalToolCallCount: 1,
    logicalMsgCount: 1,
    logicalReplayCount: 1,
  });
});
