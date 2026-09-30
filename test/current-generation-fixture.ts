import type { Database } from "bun:sqlite";

/** Publish a small source-backed dialogue generation for legacy integration fixtures. */
export function publishFixtureDialogue(db: Database, sessionId: number, generation = `fixture-generation-${sessionId}`): void {
  const rows = db.prepare(`SELECT id,ordinal,role,text,ts FROM messages WHERE session_id=? ORDER BY ordinal`).all(sessionId) as Array<{
    id:number; ordinal:number; role:string; text:string|null; ts:number|null;
  }>;
  const dialogue = rows.filter((row) => (row.role === "user" || row.role === "assistant") && row.text?.trim());
  const update = db.prepare(`UPDATE messages SET source_ordinal=?,record_kind=?,dialogue_side=?,prose=?,event_ts=?,
    construction_generation=?,source_identity_kind='record-id',source_record_id=?,source_record_ts=? WHERE id=?`);
  const logical = db.prepare(`INSERT INTO logical_messages(session_id,representative_message_id,logical_ordinal,logical_key,
    identity_kind,source_record_id,source_record_ts,record_kind,dialogue_side,construction_generation)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const member = db.prepare(`INSERT INTO logical_message_members(logical_message_id,message_id,raw_ordinal,is_replay) VALUES (?,?,?,0)`);
  dialogue.forEach((row, logicalOrdinal) => {
    const kind = row.role === "user" ? "real_user" : "assistant_dialogue_prose";
    const sourceId = `fixture-record-${row.ordinal}`;
    update.run(row.ordinal,kind,row.role,row.text,row.ts,generation,sourceId,row.ts,row.id);
    const inserted = logical.run(sessionId,row.id,logicalOrdinal,sourceId,"record-id",sourceId,row.ts,kind,row.role,generation);
    member.run(Number(inserted.lastInsertRowid),row.id,row.ordinal);
  });
  const user = dialogue.filter((row) => row.role === "user").length;
  const assistant = dialogue.length - user;
  db.prepare(`INSERT OR REPLACE INTO construction_metrics(session_id,construction_generation,raw_provenance_row_count,
    logical_record_count,raw_tool_activity_count,logical_tool_activity_count,raw_prose_bearing_record_count,
    logical_prose_bearing_record_count,dialogue_turn_count,user_dialogue_turn_count,assistant_dialogue_turn_count,
    logical_replay_count,unknown_identity_raw_row_count,computed_at) VALUES (?,?,?, ?,0,0,?, ?,?,?,?,0,0,?)`)
    .run(sessionId,generation,dialogue.length,dialogue.length,dialogue.length,dialogue.length,dialogue.length,user,assistant,Date.now());
  db.prepare(`UPDATE sessions SET construction_generation=?,construction_status='valid',construction_invalid_reason=NULL,
    artifact_kind='dialogue_history',history_completeness='complete',default_session_visible=?,source_validation_status='current'
    WHERE id=?`).run(generation,dialogue.length > 0 ? 1 : 0,sessionId);
}

export function publishFixtureTitle(db: Database, sessionId: number, generation: string, value: string): void {
  db.prepare(`UPDATE sessions SET title=? WHERE id=?`).run(value,sessionId);
  db.prepare(`INSERT INTO title_evidence(session_id,construction_generation,authority,harness_source_class,value,
    eligibility_rule_version,selected) VALUES (?,?,'atlas_user_override','fixture',?,'fixture-title-v1',1)`)
    .run(sessionId,generation,value);
}
