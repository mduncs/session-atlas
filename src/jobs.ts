import { randomUUID } from "node:crypto";
import type { DB } from "./db/index.js";
import type { JobState } from "./contracts/construction.js";

export interface WorkInput {kind:string;sessionId:number|null;normalizedScope?:string;inputVersion:string;inputRevision:string;}
export interface WorkRow {id:number;kind:string;targetHarness:string;targetNativeId:string;normalizedScope:string;inputVersion:string;status:JobState;attemptCount:number;ownerToken:string|null;leaseExpiresAt:number|null;inputRevision:string;}
export interface ClaimOptions {ownerToken?:string;now?:number;leaseMs?:number;attemptLimit?:number;workId?:number;}

export function ensureWork(db:DB,input:WorkInput,state:"pending"|"blocked"="pending",reason:string|null=null,force=false):number{
 const apply=()=>{
  const target=stableTarget(db,input.sessionId);const scope=(input.normalizedScope??"").trim();const now=Date.now();
  const old=db.prepare(`SELECT id,current_status FROM job_work WHERE kind=? AND target_harness=? AND target_native_id=? AND legacy_target_ref='' AND normalized_scope=? AND input_version<>? AND current_status IN ('pending','running','blocked')`).all(input.kind,target.harness,target.nativeId,scope,input.inputVersion) as Array<{id:number;current_status:string}>;
  for(const row of old){db.prepare(`UPDATE job_work SET current_status='superseded',current_error='input revision superseded',owner_token=NULL,claimed_at=NULL,heartbeat_at=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?`).run(now,row.id);finishLiveAttempt(db,row.id,"superseded","input revision superseded",now);}
  db.prepare(`INSERT INTO job_work(kind,target_harness,target_native_id,legacy_target_ref,normalized_scope,input_version,current_status,attempt_count,current_error,blocked_reason,created_at,updated_at) VALUES (?,?,?,'',?,?,?,?,?,?,?,?) ON CONFLICT(kind,target_harness,target_native_id,legacy_target_ref,normalized_scope,input_version) DO UPDATE SET current_status=CASE WHEN job_work.current_status='running' OR (job_work.current_status='done' AND ?=0) THEN job_work.current_status ELSE excluded.current_status END,current_error=CASE WHEN excluded.current_status='blocked' THEN excluded.current_error WHEN ?=1 THEN NULL ELSE job_work.current_error END,blocked_reason=excluded.blocked_reason,updated_at=excluded.updated_at`).run(input.kind,target.harness,target.nativeId,scope,input.inputVersion,state,0,state==="blocked"?reason:null,state==="blocked"?reason:null,now,now,force?1:0,force?1:0);
  const work=(db.prepare(`SELECT id,attempt_count,current_status FROM job_work WHERE kind=? AND target_harness=? AND target_native_id=? AND legacy_target_ref='' AND normalized_scope=? AND input_version=?`).get(input.kind,target.harness,target.nativeId,scope,input.inputVersion) as {id:number;attempt_count:number;current_status:string});
  if(state==="blocked"&&work.current_status==="blocked"){
    const latest=db.prepare(`SELECT status,error,input_revision FROM job_attempts WHERE work_id=? ORDER BY attempt_ordinal DESC LIMIT 1`).get(work.id) as {status:string;error:string|null;input_revision:string}|null;
    if(!latest||latest.status!=="blocked"||latest.error!==reason||latest.input_revision!==input.inputRevision){const ord=work.attempt_count+1;db.prepare(`INSERT INTO job_attempts(work_id,attempt_ordinal,status,error,input_revision,created_at,finished_at) VALUES (?,?,'blocked',?,?,?,?)`).run(work.id,ord,reason,input.inputRevision,now,now);db.prepare(`UPDATE job_work SET attempt_count=? WHERE id=?`).run(ord,work.id);}
  }
  return work.id;
 };
 return db.inTransaction?apply():db.transaction(apply).immediate();
}

/** Recover expired leases, then claim at most one runnable work row atomically. */
export function claimWork(db:DB,options:ClaimOptions={}):WorkRow|null{
 const now=options.now??Date.now(),owner=options.ownerToken??randomUUID(),leaseMs=options.leaseMs??10*60_000,limit=options.attemptLimit??5;
 if(leaseMs<=0||limit<1)throw new RangeError("invalid job lease/attempt limit");
 const apply=()=>{
  const expired=db.prepare(`SELECT id,attempt_count FROM job_work WHERE current_status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=? ORDER BY lease_expires_at,id`).all(now) as Array<{id:number;attempt_count:number}>;
  for(const work of expired){finishLiveAttempt(db,work.id,"failed","lease expired",now);if(work.attempt_count>=limit)db.prepare(`UPDATE job_work SET current_status='failed',current_error='lease expired',owner_token=NULL,claimed_at=NULL,heartbeat_at=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?`).run(now,work.id);else db.prepare(`UPDATE job_work SET current_status='pending',current_error='lease expired',owner_token=NULL,claimed_at=NULL,heartbeat_at=NULL,lease_expires_at=NULL,next_attempt_at=?,updated_at=? WHERE id=?`).run(now+backoffMs(work.attempt_count),now,work.id);}
  const candidate=(options.workId===undefined
    ? db.prepare(`SELECT id,attempt_count FROM job_work WHERE current_status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at,id LIMIT 1`).get(now)
    : db.prepare(`SELECT id,attempt_count FROM job_work WHERE id=? AND current_status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)`).get(options.workId,now)) as {id:number;attempt_count:number}|null;if(!candidate)return null;
  const ordinal=candidate.attempt_count+1,expires=now+leaseMs;const changed=db.prepare(`UPDATE job_work SET current_status='running',attempt_count=?,owner_token=?,claimed_at=?,heartbeat_at=?,lease_expires_at=?,next_attempt_at=NULL,blocked_reason=NULL,updated_at=? WHERE id=? AND current_status='pending'`).run(ordinal,owner,now,now,expires,now,candidate.id).changes;if(!changed)return null;
  const inputRevision=currentInputRevision(db,candidate.id);db.prepare(`INSERT INTO job_attempts(work_id,attempt_ordinal,status,input_revision,owner_token,claimed_at,heartbeat_at,lease_expires_at,started_at,created_at) VALUES (?,?,'running',?,?,?,?,?,?,?)`).run(candidate.id,ordinal,inputRevision,owner,now,now,expires,now,now);
  return readWork(db,candidate.id,inputRevision);
 };return db.inTransaction?apply():db.transaction(apply).immediate();
}
export function heartbeatWork(db:DB,workId:number,owner:string,now=Date.now(),leaseMs=10*60_000):boolean{const expires=now+leaseMs;const apply=()=>{const changed=Number(db.prepare(`UPDATE job_work SET heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE id=? AND current_status='running' AND owner_token=? AND lease_expires_at>?`).run(now,expires,now,workId,owner,now).changes);if(changed)db.prepare(`UPDATE job_attempts SET heartbeat_at=?,lease_expires_at=? WHERE work_id=? AND status='running' AND owner_token=?`).run(now,expires,workId,owner);return changed===1;};return db.inTransaction?apply():db.transaction(apply).immediate();}
export function finishWork(db:DB,workId:number,owner:string,status:"done"|"failed",error:string|null=null,options:{now?:number;attemptLimit?:number}={}):boolean{
 const now=options.now??Date.now(),limit=options.attemptLimit??5;const apply=()=>{const work=db.prepare(`SELECT attempt_count,target_harness,target_native_id,input_version FROM job_work WHERE id=? AND current_status='running' AND owner_token=?`).get(workId,owner) as {attempt_count:number;target_harness:string;target_native_id:string;input_version:string}|null;if(!work)return false;const attempt=db.prepare(`SELECT input_revision FROM job_attempts WHERE work_id=? AND status='running' AND owner_token=? ORDER BY attempt_ordinal DESC LIMIT 1`).get(workId,owner) as {input_revision:string}|null;if(!attempt)return false;
  if(!inputStillCurrent(db,work.target_harness,work.target_native_id,attempt.input_revision)){db.prepare(`UPDATE job_attempts SET status='superseded',error='stale input revision',finished_at=? WHERE work_id=? AND status='running' AND owner_token=?`).run(now,workId,owner);db.prepare(`UPDATE job_work SET current_status='superseded',current_error='stale input revision',owner_token=NULL,claimed_at=NULL,heartbeat_at=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?`).run(now,workId);return false;}
  db.prepare(`UPDATE job_attempts SET status=?,error=?,finished_at=?,heartbeat_at=? WHERE work_id=? AND status='running' AND owner_token=?`).run(status,error,now,now,workId,owner);
  if(status==="done")db.prepare(`UPDATE job_work SET current_status='done',current_error=NULL,blocked_reason=NULL,owner_token=NULL,claimed_at=NULL,heartbeat_at=NULL,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=? WHERE id=?`).run(now,workId);
  else if(work.attempt_count>=limit)db.prepare(`UPDATE job_work SET current_status='failed',current_error=?,owner_token=NULL,claimed_at=NULL,heartbeat_at=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?`).run(error,now,workId);
  else db.prepare(`UPDATE job_work SET current_status='pending',current_error=?,owner_token=NULL,claimed_at=NULL,heartbeat_at=NULL,lease_expires_at=NULL,next_attempt_at=?,updated_at=? WHERE id=?`).run(error,now+backoffMs(work.attempt_count),now,workId);
  return true;};return db.inTransaction?apply():db.transaction(apply).immediate();
}
export function blockWork(db:DB,input:WorkInput,reason="no provider configured or authorized"):number{return ensureWork(db,input,"blocked",reason);}
/** Settle a target's outstanding work of `kind` that was completed outside the queue (an on-demand tier-2), recording the attempt. */
export function settleWork(db:DB,kind:string,sessionId:number,provider:string|null,now=Date.now()):number{
 const apply=()=>{const target=stableTarget(db,sessionId);const revision=(db.prepare(`SELECT construction_generation FROM sessions WHERE id=?`).get(sessionId) as {construction_generation:string}).construction_generation;
  const rows=db.prepare(`SELECT id,attempt_count FROM job_work WHERE kind=? AND target_harness=? AND target_native_id=? AND current_status IN ('pending','blocked')`).all(kind,target.harness,target.nativeId) as Array<{id:number;attempt_count:number}>;
  for(const row of rows){const ord=row.attempt_count+1;db.prepare(`INSERT INTO job_attempts(work_id,attempt_ordinal,status,provider,input_revision,started_at,finished_at,created_at) VALUES (?,?,'done',?,?,?,?,?)`).run(row.id,ord,provider,revision,now,now,now);db.prepare(`UPDATE job_work SET current_status='done',current_error=NULL,blocked_reason=NULL,provider=?,attempt_count=?,next_attempt_at=NULL,updated_at=? WHERE id=?`).run(provider,ord,now,row.id);}
  return rows.length;};
 return db.inTransaction?apply():db.transaction(apply).immediate();
}
export function newestRelevantError(db:DB,workId:number):string|null{return (db.prepare(`SELECT error FROM job_attempts WHERE work_id=? AND error IS NOT NULL ORDER BY attempt_ordinal DESC,id DESC LIMIT 1`).get(workId) as {error:string}|null)?.error??null;}
export function backoffMs(attempt:number):number{return Math.min(60*60_000,Math.max(1,2**Math.max(0,attempt-1))*30_000);}
function stableTarget(db:DB,sessionId:number|null):{harness:string;nativeId:string}{if(sessionId===null)return {harness:"",nativeId:""};const row=db.prepare(`SELECT harness,native_id FROM sessions WHERE id=?`).get(sessionId) as {harness:string;native_id:string}|null;if(!row)throw new Error(`job target session missing: ${sessionId}`);return {harness:row.harness,nativeId:row.native_id};}
function currentInputRevision(db:DB,workId:number):string{const work=db.prepare(`SELECT target_harness,target_native_id,input_version FROM job_work WHERE id=?`).get(workId) as {target_harness:string;target_native_id:string;input_version:string};if(!work.target_harness)return work.input_version;const row=db.prepare(`SELECT construction_generation FROM sessions WHERE harness=? AND native_id=?`).get(work.target_harness,work.target_native_id) as {construction_generation:string}|null;return row?.construction_generation??`missing:${work.target_harness}:${work.target_native_id}`;}
function inputStillCurrent(db:DB,harness:string,nativeId:string,revision:string):boolean{if(!harness)return true;const row=db.prepare(`SELECT construction_generation FROM sessions WHERE harness=? AND native_id=?`).get(harness,nativeId) as {construction_generation:string}|null;return row?.construction_generation===revision;}
function finishLiveAttempt(db:DB,workId:number,status:"failed"|"superseded",error:string,now:number):void{db.prepare(`UPDATE job_attempts SET status=?,error=?,finished_at=? WHERE work_id=? AND status='running'`).run(status,error,now,workId);}
function readWork(db:DB,id:number,inputRevision:string):WorkRow{const row=db.prepare(`SELECT * FROM job_work WHERE id=?`).get(id) as Record<string,unknown>;return {id:Number(row.id),kind:String(row.kind),targetHarness:String(row.target_harness),targetNativeId:String(row.target_native_id),normalizedScope:String(row.normalized_scope),inputVersion:String(row.input_version),status:String(row.current_status) as JobState,attemptCount:Number(row.attempt_count),ownerToken:row.owner_token===null?null:String(row.owner_token),leaseExpiresAt:row.lease_expires_at===null?null:Number(row.lease_expires_at),inputRevision};}
