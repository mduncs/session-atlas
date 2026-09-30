/** Replay-aware canonical logical projection and exact eleven-metric publication. */
import { createHash } from "node:crypto";
import type { DB } from "./db/index.js";
import { estimateTokens } from "./metrics.js";
import type { ConstructionMetricsDto, RecordKind, SourceIdentityKind } from "./contracts/construction.js";

export type LogicalIdentityStatus = "complete" | "partial";
export interface LogicalSessionMetrics {
  sessionId: number;
  logicalTokUser: number;
  logicalTokAssistant: number;
  logicalTokTool: number;
  logicalToolCallCount: number;
  logicalMsgCount: number;
  logicalReplayCount: number;
  logicalIdentityCount: number;
  logicalUnknownCount: number;
  identityStatus: LogicalIdentityStatus;
}
export interface LogicalMessageRow {
  id: number; sessionId: number; representativeMessageId: number; logicalOrdinal: number;
  logicalKey: string; identityKind: SourceIdentityKind; sourceRecordId: string | null;
  sourceRecordUuid: string | null; sourceRecordTs: number | null; memberCount: number; replayCount: number;
}
interface RawMessage {
  id: number; ordinal: number; source_ordinal: number | null; role: string; text: string | null;
  tool_text: string | null; has_tool: number; record_kind: RecordKind; dialogue_side: string | null;
  prose: string | null; source_record_id: string | null; source_record_uuid: string | null;
  source_record_ts: number | null; source_identity_kind: SourceIdentityKind; construction_generation: string | null;
  content_digest: string | null; content_bytes: number | null; content_token_estimate: number | null;
  source_prose_present: number | null;
}
interface RawToolActivity {
  activity_ordinal: number; activity_kind: string; tool_name: string | null; tool_text: string | null;
  source_activity_id: string | null; payload_digest: string | null; payload_bytes: number | null;
  payload_token_estimate: number | null;
}
interface CompactEvidenceColumns { message: Set<string>; tool: Set<string> }
interface Group { key: string; evidence: Evidence | null; rows: RawMessage[] }
interface Evidence { identityKind: Exclude<SourceIdentityKind,"none">; sourceRecordId: string; sourceRecordUuid: string | null; sourceRecordTs: number }

/**
 * Recompute both legacy compatibility metrics and the v11 projection. When a
 * generation is supplied every raw row must belong to it and canonical metrics
 * are published. No raw-role/count fallback can make an invalid session valid.
 */
export function rebuildLogicalMetrics(
  db: DB,
  sessionId: number,
  generation?: string,
  evidenceRuleVersion = "replay-v1",
): LogicalSessionMetrics {
  const apply = () => publish(db, sessionId, generation, evidenceRuleVersion);
  return db.inTransaction ? apply() : db.transaction(apply)();
}

function publish(db: DB, sessionId: number, requestedGeneration: string | undefined, evidenceRuleVersion: string): LogicalSessionMetrics {
  const session = db.prepare(`SELECT construction_generation,construction_status FROM sessions WHERE id=?`).get(sessionId) as
    | { construction_generation: string; construction_status: string } | null;
  if (!session) throw new Error(`logical construction session not found: ${sessionId}`);
  const generation = requestedGeneration ?? (session.construction_status === "valid" ? session.construction_generation : undefined);
  const columns: CompactEvidenceColumns = {
    message: tableColumns(db, "messages"),
    tool: tableColumns(db, "tool_activities"),
  };
  const rows = db.prepare(
    `SELECT id,ordinal,source_ordinal,role,text,tool_text,has_tool,record_kind,dialogue_side,prose,
            source_record_id,source_record_uuid,source_record_ts,source_identity_kind,construction_generation,
            ${optionalColumn(columns.message, "content_digest")},
            ${optionalColumn(columns.message, "content_bytes")},
            ${optionalColumn(columns.message, "content_token_estimate")},
            ${optionalColumn(columns.message, "source_prose_present")}
     FROM messages WHERE session_id=? ORDER BY ordinal,id`,
  ).all(sessionId) as RawMessage[];
  if (generation) {
    for (const [index,row] of rows.entries()) {
      if (row.ordinal !== index) throw new Error(`noncontiguous raw ordinal for session ${sessionId}`);
      if (row.source_ordinal === null || row.source_ordinal < 0) throw new Error(`missing source ordinal for session ${sessionId}`);
      if (row.construction_generation !== generation) throw new Error(`mixed construction generation for session ${sessionId}`);
      validateSemanticRow(row, sessionId);
    }
  }

  const groups = new Map<string,Group>();
  let unknown = 0;
  for (const row of rows) {
    const evidence = authoritativeEvidence(row);
    const key = evidence ? JSON.stringify([evidence.identityKind,evidence.sourceRecordId,evidence.sourceRecordTs]) : `raw:${row.id}`;
    if (!evidence) unknown++;
    const group = groups.get(key);
    if (group) group.rows.push(row); else groups.set(key,{key,evidence,rows:[row]});
  }
  const ordered = [...groups.values()].sort((a,b) => a.rows[0]!.ordinal-b.rows[0]!.ordinal || a.rows[0]!.id-b.rows[0]!.id);
  for (const group of ordered) validateReplayAgreement(db,group,sessionId,columns);

  db.prepare(`DELETE FROM replay_election_members WHERE logical_record_id IN (SELECT id FROM logical_messages WHERE session_id=?)`).run(sessionId);
  db.prepare(`DELETE FROM replay_election_evidence WHERE logical_record_id IN (SELECT id FROM logical_messages WHERE session_id=?)`).run(sessionId);
  db.prepare(`DELETE FROM logical_message_members WHERE logical_message_id IN (SELECT id FROM logical_messages WHERE session_id=?)`).run(sessionId);
  db.prepare(`DELETE FROM logical_messages WHERE session_id=?`).run(sessionId);
  db.prepare(`DELETE FROM logical_metrics WHERE session_id=?`).run(sessionId);
  if (generation) db.prepare(`DELETE FROM construction_metrics WHERE session_id=?`).run(sessionId);

  let tokUser=0,tokAssistant=0,tokTool=0,logicalToolCount=0,replays=0,proved=0;
  let logicalProse=0,dialogue=0,userDialogue=0,assistantDialogue=0;
  const insertLogical=db.prepare(
    `INSERT INTO logical_messages(session_id,representative_message_id,logical_ordinal,logical_key,identity_kind,
       source_record_id,source_record_uuid,source_record_ts,member_count,replay_count,record_kind,dialogue_side,
       identity_status,construction_generation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertMember=db.prepare(
    `INSERT INTO logical_message_members(logical_message_id,message_id,raw_ordinal,is_replay,construction_generation) VALUES (?,?,?,?,?)`);
  const insertEvidence=db.prepare(
    `INSERT INTO replay_election_evidence(logical_record_id,evidence_rule_version,source_identity_kind,source_record_id,
       source_record_uuid,source_record_ts,representative_raw_record_id,construction_generation) VALUES (?,?,?,?,?,?,?,?)`);
  const insertElectionMember=db.prepare(
    `INSERT INTO replay_election_members(logical_record_id,raw_record_id,member_ordinal,is_representative) VALUES (?,?,?,?)`);

  for (const [logicalOrdinal,group] of ordered.entries()) {
    const representative=group.rows[0]!;
    const replayCount=group.rows.length-1;
    replays+=replayCount;
    if (group.evidence) proved++;
    if (representative.dialogue_side === "user") tokUser += contentTokens(representative);
    else if (representative.dialogue_side === "assistant") tokAssistant += contentTokens(representative);
    tokTool += representativeToolTokens(db,representative.id,columns.tool);
    logicalToolCount += toolCount(db,representative.id);
    if (sourceProsePresent(representative)) logicalProse++;
    if (sourceProsePresent(representative) && representative.record_kind === "real_user") { dialogue++; userDialogue++; }
    if (sourceProsePresent(representative) && representative.record_kind === "assistant_dialogue_prose") { dialogue++; assistantDialogue++; }
    const inserted=insertLogical.run(sessionId,representative.id,logicalOrdinal,group.key,
      group.evidence?.identityKind ?? "none",group.evidence?.sourceRecordId ?? null,group.evidence?.sourceRecordUuid ?? null,
      group.evidence?.sourceRecordTs ?? null,group.rows.length,replayCount,representative.record_kind,representative.dialogue_side,
      group.evidence ? "proved":"unknown",generation ?? null) as {lastInsertRowid:number|bigint};
    const logicalId=Number(inserted.lastInsertRowid);
    group.rows.forEach((member,index)=>{
      insertMember.run(logicalId,member.id,member.ordinal,index===0?0:1,generation ?? null);
    });
    if (generation) {
      insertEvidence.run(logicalId,evidenceRuleVersion,group.evidence?.identityKind ?? "none",group.evidence?.sourceRecordId ?? null,
        group.evidence?.sourceRecordUuid ?? null,group.evidence?.sourceRecordTs ?? null,representative.id,generation);
      group.rows.forEach((member,index)=>insertElectionMember.run(logicalId,member.id,index,index===0?1:0));
    }
  }

  const legacy: LogicalSessionMetrics={sessionId,logicalTokUser:tokUser,logicalTokAssistant:tokAssistant,logicalTokTool:tokTool,
    logicalToolCallCount:logicalToolCount,logicalMsgCount:ordered.length,logicalReplayCount:replays,
    logicalIdentityCount:proved,logicalUnknownCount:unknown,identityStatus:unknown===0?"complete":"partial"};
  db.prepare(`INSERT INTO logical_metrics(session_id,logical_tok_user,logical_tok_assistant,logical_tok_tool,
    logical_tool_call_count,logical_msg_count,logical_replay_count,logical_identity_count,logical_unknown_count,identity_status,computed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(sessionId,tokUser,tokAssistant,tokTool,logicalToolCount,ordered.length,replays,proved,unknown,legacy.identityStatus,Date.now());

  if (generation) {
    const rawTool=Number((db.prepare(`SELECT COUNT(*) n FROM tool_activities ta JOIN messages m ON m.id=ta.raw_record_id WHERE m.session_id=?`).get(sessionId) as {n:number}).n);
    const rawProse=rows.filter((row)=>sourceProsePresent(row)).length;
    const metrics:ConstructionMetricsDto={rawProvenanceRowCount:rows.length,logicalRecordCount:ordered.length,
      rawToolActivityCount:rawTool,logicalToolActivityCount:logicalToolCount,rawProseBearingRecordCount:rawProse,
      logicalProseBearingRecordCount:logicalProse,dialogueTurnCount:dialogue,userDialogueTurnCount:userDialogue,
      assistantDialogueTurnCount:assistantDialogue,logicalReplayCount:replays,unknownIdentityRawRowCount:unknown};
    db.prepare(`INSERT INTO construction_metrics(session_id,construction_generation,raw_provenance_row_count,logical_record_count,
      raw_tool_activity_count,logical_tool_activity_count,raw_prose_bearing_record_count,logical_prose_bearing_record_count,
      dialogue_turn_count,user_dialogue_turn_count,assistant_dialogue_turn_count,logical_replay_count,unknown_identity_raw_row_count,computed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sessionId,generation,metrics.rawProvenanceRowCount,metrics.logicalRecordCount,
      metrics.rawToolActivityCount,metrics.logicalToolActivityCount,metrics.rawProseBearingRecordCount,metrics.logicalProseBearingRecordCount,
      metrics.dialogueTurnCount,metrics.userDialogueTurnCount,metrics.assistantDialogueTurnCount,metrics.logicalReplayCount,
      metrics.unknownIdentityRawRowCount,Date.now());
  }
  return legacy;
}

function validateSemanticRow(row: RawMessage, sessionId:number):void {
  if (!(["real_user","assistant_dialogue_prose","tool","control_context","telemetry","developer_system","automatic_utility","unclassified"] as string[]).includes(row.record_kind)) {
    throw new Error(`invalid record kind for session ${sessionId}`);
  }
  const expected=row.record_kind==="real_user"?"user":row.record_kind==="assistant_dialogue_prose"?"assistant":null;
  if (row.dialogue_side!==expected) throw new Error(`record kind/dialogue side contradiction for session ${sessionId}`);
  if ((expected!==null) && !sourceProsePresent(row)) throw new Error(`blank dialogue record for session ${sessionId}`);
}
function validateReplayAgreement(db:DB,group:Group,sessionId:number,columns:CompactEvidenceColumns):void {
  if (group.rows.length<2) return;
  const first=semanticSignature(db,group.rows[0]!,columns);
  for (const row of group.rows.slice(1)) if (semanticSignature(db,row,columns)!==first) {
    throw new Error(`contradictory replay evidence for session ${sessionId}`);
  }
}
function semanticSignature(db:DB,row:RawMessage,columns:CompactEvidenceColumns):string {
  const tools=db.prepare(
    `SELECT activity_ordinal,activity_kind,tool_name,tool_text,source_activity_id,
            ${optionalColumn(columns.tool, "payload_digest")},
            ${optionalColumn(columns.tool, "payload_bytes")},
            ${optionalColumn(columns.tool, "payload_token_estimate")}
     FROM tool_activities WHERE raw_record_id=? ORDER BY activity_ordinal`,
  ).all(row.id) as RawToolActivity[];
  return JSON.stringify([
    row.record_kind,
    row.dialogue_side,
    contentSemantic(row,columns.message),
    tools.map((tool) => [
      tool.activity_ordinal,
      tool.activity_kind,
      tool.tool_name,
      payloadDigest(tool),
      payloadBytes(tool),
      tool.source_activity_id,
    ]),
  ]);
}
function toolCount(db:DB,rawId:number):number{return Number((db.prepare(`SELECT COUNT(*) n FROM tool_activities WHERE raw_record_id=?`).get(rawId) as {n:number}).n);}
function representativeToolTokens(db:DB,rawId:number,toolColumns:Set<string>):number {
  const rows=db.prepare(
    `SELECT tool_text,${optionalColumn(toolColumns, "payload_token_estimate")}
     FROM tool_activities WHERE raw_record_id=?`,
  ).all(rawId) as RawToolActivity[];
  return rows.reduce((sum,row)=>sum+payloadTokens(row),0);
}
function contentTokens(row:RawMessage):number {
  return row.content_token_estimate ?? estimateTokens(row.prose ?? row.text);
}
function payloadTokens(row:RawToolActivity):number {
  return row.payload_token_estimate ?? estimateTokens(row.tool_text);
}
function sourceProsePresent(row:RawMessage):boolean {
  return row.source_prose_present === 1 || nonblank(row.prose);
}
function contentDigest(row:RawMessage):string|null {
  return digestOrHash(row.content_digest, row.prose ?? row.text);
}
function contentSemantic(row:RawMessage,messageColumns:Set<string>):unknown {
  // Rows written before v13 (and full rows manually inserted into a v13
  // archive) have no compact evidence. Keep their historical prose-only
  // replay agreement rather than treating legacy compatibility text as source
  // semantics. Prepared compact rows always carry at least one metadata value.
  const hasEvidence = messageColumns.has("content_digest") && (
    row.content_digest !== null
    || row.content_bytes !== null
    || row.content_token_estimate !== null
    || row.source_prose_present === 1
  );
  return hasEvidence ? [contentDigest(row),sourceProsePresent(row)] : row.prose;
}
function payloadDigest(row:RawToolActivity):string|null {
  return digestOrHash(row.payload_digest, row.tool_text);
}
function payloadBytes(row:RawToolActivity):number {
  return row.payload_bytes ?? (row.tool_text === null ? 0 : byteLength(row.tool_text));
}
function digestOrHash(stored:string|null, body:string|null):string|null {
  const digest=clean(stored);
  return digest ?? (body === null ? null : sha256(body));
}
function byteLength(value:string):number{return Buffer.byteLength(value,"utf8");}
function sha256(value:string):string{return createHash("sha256").update(value,"utf8").digest("hex");}
function nonblank(value:string|null):boolean{return value!==null && value.trim().length>0;}
function tableColumns(db:DB,table:string):Set<string>{
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map((column)=>column.name));
}
function optionalColumn(columns:Set<string>,column:string):string{return columns.has(column)?column:`NULL AS ${column}`;}
function authoritativeEvidence(row:RawMessage):Evidence|null {
  const kind=row.source_identity_kind;
  const id=clean(row.source_record_id),uuid=clean(row.source_record_uuid),ts=row.source_record_ts;
  if (kind==="none"||!id||ts===null||!Number.isSafeInteger(ts)) return null;
  if (kind!=="uuid"&&kind!=="record-id"&&kind!=="message-id") return null;
  if (uuid!==null&&(!isUuid(uuid)||uuid!==id)) return null;
  if (kind==="uuid"&&(uuid===null||!isUuid(id)||uuid!==id)) return null;
  return {identityKind:kind,sourceRecordId:id,sourceRecordUuid:uuid,sourceRecordTs:ts};
}
function clean(value:unknown):string|null{if(value===null||value===undefined)return null;const text=String(value).trim();return text||null;}
function isUuid(value:string):boolean{return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);}

export function rebuildAllLogicalMetrics(db:DB):LogicalSessionMetrics[]{
  return (db.prepare(`SELECT id,construction_generation,construction_status FROM sessions ORDER BY id`).all() as Array<{id:number;construction_generation:string;construction_status:string}>).map(
    row=>rebuildLogicalMetrics(db,row.id,row.construction_status==="valid"?row.construction_generation:undefined));
}
export function getLogicalMetrics(db:DB,sessionId:number):LogicalSessionMetrics|null{
  const row=db.prepare(`SELECT * FROM logical_metrics WHERE session_id=?`).get(sessionId) as Record<string,unknown>|null;
  return row?{sessionId:Number(row.session_id),logicalTokUser:Number(row.logical_tok_user),logicalTokAssistant:Number(row.logical_tok_assistant),
    logicalTokTool:Number(row.logical_tok_tool),logicalToolCallCount:Number(row.logical_tool_call_count),logicalMsgCount:Number(row.logical_msg_count),
    logicalReplayCount:Number(row.logical_replay_count),logicalIdentityCount:Number(row.logical_identity_count),logicalUnknownCount:Number(row.logical_unknown_count),
    identityStatus:String(row.identity_status) as LogicalIdentityStatus}:null;
}
export function getLogicalMessages(db:DB,sessionId:number):LogicalMessageRow[]{
  return (db.prepare(`SELECT * FROM logical_messages WHERE session_id=? ORDER BY logical_ordinal`).all(sessionId) as Record<string,unknown>[]).map(row=>({
    id:Number(row.id),sessionId:Number(row.session_id),representativeMessageId:Number(row.representative_message_id),logicalOrdinal:Number(row.logical_ordinal),
    logicalKey:String(row.logical_key),identityKind:String(row.identity_kind) as SourceIdentityKind,sourceRecordId:clean(row.source_record_id),
    sourceRecordUuid:clean(row.source_record_uuid),sourceRecordTs:row.source_record_ts===null?null:Number(row.source_record_ts),memberCount:Number(row.member_count),replayCount:Number(row.replay_count)}));
}
