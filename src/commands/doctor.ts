import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Config } from "../config.js";
import { DEFAULT_TUNABLES, HARNESS_IDS, resolvedSourceConfig, sourcePlanDigest } from "../config.js";
import type { DB } from "../db/index.js";
import { resolveRuntimeCtx, withReadOnlyCtx } from "./ctx.js";
import { providerReadiness } from "../provider.js";
import { computeRootChangeToken } from "../ingest.js";
import {
 resolveVolumeIdentity,
 defaultVolumeIdentityProbe,
 type VolumeIdentityProbe,
} from "../runtime/storage-identity.js";

export interface DoctorReport {ok:boolean;status:"healthy"|"degraded"|"down";elapsedMs:number;schemaVersion:string;sessions:number;orphaned:number;retainedInvalidOrphaned:number;pendingFavorites:number;lines:string[];}
type Severity="healthy"|"degraded"|"down";
interface LatestSource {group_id:number;source_id:number;started_at:number;finished_at:number|null;source_status:string;resolution_mode:string;disabled_reason:string|null;physical_unit_count:number;canonical_candidate_count:number;admissible_identity_count:number|null;archived_identity_count:number|null;duplicate_candidate_count:number;rejected_unit_count:number;error_unit_count:number;snapshot_only_count:number;unresolved_lineage_count:number;resolved_roots_json:string;}
interface RootRow {root_ordinal:number;root:string;reachability:string;finished_at:number|null;end_change_token:string|null;changed_during_walk:number|null;physical_unit_count:number;canonical_candidate_count:number;error:string|null;}
interface ScheduleRow {expected_interval_ms:number;degraded_after_ms:number;stale_after_ms:number;schedule_kind:string|null;schedule_path:string|null;target_config_path:string;target_db_path:string;last_scheduled_group_id:number|null;}
interface ScheduledSource {finished_at:number|null;source_id:number|null;source_status:string|null;error_unit_count:number|null;}
interface CompletePass {finished_at:number|null;admissible_identity_count:number|null;archived_identity_count:number|null;}

/**
 * Targeted ingestion normally completes within a few minutes. Doctor reports
 * runs beyond this operational visibility boundary; repair still requires an
 * explicit age threshold and confirmation.
 */
export const TARGETED_INGEST_STALE_AFTER_MS = 10 * 60_000;

export function collectDoctorReport(db:DB,config:Config,now=Date.now(),configPath="<runtime-config>",storageProbe:VolumeIdentityProbe=defaultVolumeIdentityProbe):DoctorReport{
 const begun=performance.now(),digest=sourcePlanDigest(config),thresholds={...DEFAULT_TUNABLES,...config.tunables},lines:string[]=[];let severity:Severity="healthy";const launchdStatusCache=new Map<string,boolean|null>();
 const elevate=(next:Severity)=>{if(next==="down"||next==="degraded"&&severity==="healthy")severity=next;};
 const schemaVersion=(db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as {value:string}|null)?.value??"0";
 const sessions=count(db,`SELECT COUNT(*) n FROM sessions`),orphaned=count(db,`SELECT COUNT(*) n FROM sessions WHERE orphaned=1 AND construction_status='valid'`),retainedInvalidOrphaned=count(db,`SELECT COUNT(*) n FROM sessions WHERE orphaned=1 AND construction_status!='valid'`),pendingFavorites=count(db,`SELECT COUNT(*) n FROM favorites WHERE status='pending'`);
 const maintenance=existsSync(`${config.dbPath}.maintenance.lock`);if(maintenance)elevate("down");if(orphaned)elevate("degraded");
 lines.push(`atlas doctor · schema v${schemaVersion} · ${sessions} sessions · ${orphaned} orphaned`);
 if(retainedInvalidOrphaned)lines.push(`  [--] retained invalid/orphaned history · ${retainedInvalidOrphaned}`);
 lines.push(`  [${maintenance?"DOWN":"ok"}] database ${homePath(config.dbPath)}${maintenance?" · maintenance lock present":""}`);
 const storage=storageDoctorLines(config,storageProbe);lines.push(...storage.lines);if(storage.down)elevate("down");
 let intentionallyPartial=false;
 for(const source of HARNESS_IDS){
  const plan=resolvedSourceConfig(config,source);
  lines.push(`  [${plan.mode==="disabled"?"--":"ok"}] ${pad(source,7)} resolution · ${plan.mode}${plan.disabledReason?` · ${plan.disabledReason}`:""} · ${plan.roots.map(homePath).join(" + ")||"no roots"}`);
  if(plan.mode==="disabled"){intentionallyPartial=true;continue;}
  const latest=db.prepare(`SELECT g.id group_id,rs.id source_id,g.started_at,g.finished_at,rs.status source_status,rs.resolution_mode,rs.disabled_reason,rs.physical_unit_count,rs.canonical_candidate_count,rs.admissible_identity_count,rs.archived_identity_count,rs.duplicate_candidate_count,rs.rejected_unit_count,rs.error_unit_count,rs.snapshot_only_count,rs.unresolved_lineage_count,rs.resolved_roots_json FROM reconciliation_groups g JOIN reconciliation_sources rs ON rs.group_id=g.id WHERE g.config_digest=? AND rs.source=? AND g.finished_at IS NOT NULL ORDER BY g.id DESC LIMIT 1`).get(digest,source) as LatestSource|null;
  let rootNewer=false,rootDown=false;
  // A live root is routinely newer than the last walk; that is backlog for the
  // next scheduled walk, and only degrades once walks stop arriving.
  const overdueMs=(db.prepare(`SELECT degraded_after_ms FROM source_schedule_state WHERE source=?`).get(source) as {degraded_after_ms:number}|null)?.degraded_after_ms??thresholds.full_walk_degraded_after_ms;
  const walkOverdue=!latest?.finished_at||now-latest.finished_at>overdueMs;
  const roots=latest?db.prepare(`SELECT rr.* FROM reconciliation_roots rr WHERE rr.reconciliation_source_id=? ORDER BY root_ordinal`).all(latest.source_id) as RootRow[]:[];
  for(const [ordinal,root] of plan.roots.entries()){
    const prior=roots.find(row=>row.root_ordinal===ordinal&&row.root===root);const current=computeRootChangeToken(root);const reachable=current!==null;const knownNewer=reachable&&knownUnitNewer(db,source,root);const newer=reachable&&prior?.end_change_token?current!==prior.end_change_token||knownNewer:null;
    const behind=Boolean(newer&&walkOverdue);
    if(!reachable){rootDown=true;elevate("down");}else if(behind){rootNewer=true;elevate("degraded");}
    lines.push(`  [${reachable?(behind?"DEGRADED":"ok"):"DOWN"}] ${pad(source,7)} root ${ordinal+1} reachability · ${reachable?"reachable":"unreachable"} · root newer ${newer===null?"unknown":newer?behind?"yes · walk overdue":"yes · next walk due":"no"}${prior?.error?` · ${prior.error}`:""}`);
  }
  if(!latest){elevate("down");lines.push(`  [DOWN] ${pad(source,7)} full reconciliation · never · denominator unknown`);}
  else{
    // Live roots that change mid-walk leave a pass incomplete (orphan marking
    // waits) without anything being wrong; the last complete pass then sets
    // the age, on the same degraded/stale clock.
    const churn=latest.source_status!=="complete"&&latest.error_unit_count===0&&walkChurnOnly(db,latest.source_id);
    const basis=churn?lastComplete(db,digest,source):latest.source_status==="complete"?latest:null;
    const ageMs=basis?.finished_at==null?Infinity:now-basis.finished_at;let state:Severity=basis?"healthy":"down";
    if(state==="healthy"&&ageMs>thresholds.full_walk_stale_after_ms)state="down";else if(state==="healthy"&&ageMs>thresholds.full_walk_degraded_after_ms)state="degraded";
    if(rootNewer&&state==="healthy")state="degraded";if(rootDown)state="down";elevate(state);
    const denominator=state==="down"||basis?.admissible_identity_count==null?"unknown":String(basis.admissible_identity_count);
    const percentage=denominator==="unknown"?"":` · ${basis!.archived_identity_count}/${denominator}`;
    const status=churn?`incomplete · roots changed during walk · last complete ${age(basis?.finished_at??null,now)}`:latest.source_status;
    lines.push(`  [${label(state)}] ${pad(source,7)} full reconciliation · ${age(latest.finished_at,now)} · ${status} · denominator ${denominator}${percentage} · observed ${interval(latest.started_at,latest.finished_at)}`);
    lines.push(`  [${latest.error_unit_count?"DOWN":"ok"}] ${pad(source,7)} quality · physical ${latest.physical_unit_count} · canonical ${latest.canonical_candidate_count} · unique ${latest.admissible_identity_count??"unknown"} · duplicate ${latest.duplicate_candidate_count} · rejected ${latest.rejected_unit_count} · errors ${latest.error_unit_count}`);
  }
  const hook=db.prepare(`SELECT status,started_at,finished_at,error FROM targeted_ingest_runs WHERE source=? ORDER BY id DESC LIMIT 1`).get(source) as {status:string;started_at:number;finished_at:number|null;error:string|null}|null;
  const targetedAgeMs=hook?Math.max(0,now-hook.started_at):0;
  const targetedStale=hook?.status==="running"&&hook.finished_at===null&&targetedAgeMs>TARGETED_INGEST_STALE_AFTER_MS;
  if(hook?.status==="failed"||targetedStale)elevate("degraded");
  const targetedState=hook?.status==="failed"||targetedStale?"DEGRADED":hook?.status==="running"?"--":hook?"ok":"--";
  const targetedDetail=hook
    ? `${hook.status} · ${age(hook.finished_at??hook.started_at,now)}${hook.status==="running"?` · ${targetedStale?"unfinished beyond recovery threshold":"in progress"}`:""}${targetedStale?" · recovery candidate only; ingestion not claimed":""}${hook.error?` · ${hook.error}`:""}`
    : "never (latency hint only)";
  lines.push(`  [${targetedState}] ${pad(source,7)} targeted ingestion · ${targetedDetail}`);
  const schedule=db.prepare(`SELECT expected_interval_ms,degraded_after_ms,stale_after_ms,schedule_kind,schedule_path,target_config_path,target_db_path,last_scheduled_group_id FROM source_schedule_state WHERE source=?`).get(source) as ScheduleRow|null;
  const loaded=schedule?.schedule_kind==="launchd"&&schedule.schedule_path?cachedLaunchdStatus(schedule.schedule_path,launchdStatusCache):null;
  const scheduleOk=Boolean(schedule?.schedule_kind&&schedule.schedule_path&&scheduleArtifactMatches(schedule.schedule_path,schedule.target_config_path)&&schedule.target_config_path===configPath&&schedule.target_db_path===config.dbPath&&loaded!==false);
  const scheduledSource=schedule?.last_scheduled_group_id?db.prepare(`SELECT g.finished_at,rs.id source_id,rs.status source_status,rs.error_unit_count FROM reconciliation_groups g LEFT JOIN reconciliation_sources rs ON rs.group_id=g.id AND rs.source=? WHERE g.id=?`).get(source,schedule.last_scheduled_group_id) as ScheduledSource|null:null;
  const scheduledChurn=Boolean(scheduledSource?.source_id&&scheduledSource.source_status!=="complete"&&scheduledSource.error_unit_count===0&&walkChurnOnly(db,scheduledSource.source_id));
  const cadenceOk=Boolean(scheduledSource?.finished_at&&now-scheduledSource.finished_at<=thresholds.full_walk_stale_after_ms&&(scheduledSource.source_status==="complete"||scheduledChurn));
  if(!scheduleOk||!cadenceOk)elevate("down");
  lines.push(`  [${scheduleOk&&cadenceOk?"ok":"DOWN"}] ${pad(source,7)} schedule · ${schedule?.schedule_kind??"missing"} ${schedule?.schedule_path?homePath(schedule.schedule_path):"path missing"}${loaded===false?" · service unloaded":""} · interval ${duration(schedule?.expected_interval_ms??thresholds.full_walk_interval_ms)} · last scheduled ${scheduledSource?age(scheduledSource.finished_at,now):"never"} · source ${scheduledSource?.source_status??"missing"}${scheduledChurn?" (roots changed during walk)":""} · target ${homePath(configPath)} → ${homePath(config.dbPath)}`);
  const snapshot=count(db,`SELECT COUNT(*) n FROM sessions WHERE harness='${source}' AND source_validation_status='snapshot_only'`);
  const unresolved=Number((db.prepare(`SELECT COUNT(*) n FROM lineage_claims lc JOIN sessions s ON s.id=lc.session_id WHERE s.harness=? AND lc.resolution_status!='resolved'`).get(source) as {n:number}).n);
  lines.push(`  [${snapshot?"--":"ok"}] ${pad(source,7)} snapshot-only · ${snapshot}`);
  lines.push(`  [${unresolved?"DEGRADED":"ok"}] ${pad(source,7)} unresolved lineage · ${unresolved}`);if(unresolved)elevate("degraded");
 }
 if(intentionallyPartial)lines.push("  [--] coverage intentionally partial · one or more catalog sources explicitly disabled");
 collectJobs(db,now,lines,elevate);
 collectProviders(config,lines);
 if(pendingFavorites){elevate("down");const oldest=db.prepare(`SELECT updated_at,last_error FROM favorites WHERE status='pending' ORDER BY updated_at LIMIT 1`).get() as {updated_at:number;last_error:string|null};lines.push(`  [DOWN] favorites pending · ${pendingFavorites} · oldest ${age(oldest.updated_at,now)}${oldest.last_error?` · ${oldest.last_error}`:""}`);}else lines.push("  [ok] favorites · all materialized");
 lines.push(`  [${label(severity)}] overall · ${severity==="healthy"?"healthy resolved plan":severity==="degraded"?"degraded":"attention required"}`);
 return {ok:severity==="healthy",status:severity,elapsedMs:performance.now()-begun,schemaVersion,sessions,orphaned,retainedInvalidOrphaned,pendingFavorites,lines};
}

export interface DoctorCommandOptions {storageProbe?:VolumeIdentityProbe;}
export async function doctorCmd(argv:string[],options:DoctorCommandOptions={}):Promise<number>{
 const runtime=await resolveRuntimeCtx(argv,{bootstrap:false});
 if(existsSync(`${runtime.dbPath}.maintenance.lock`)){
  const storage=storageDoctorLines(runtime.config,options.storageProbe??defaultVolumeIdentityProbe);
  process.stdout.write([`atlas doctor`,`  [DOWN] database ${homePath(runtime.dbPath)} · maintenance lock present`,...storage.lines,`  [DOWN] overall · rebuild in progress or stale lock`].join("\n")+"\n");
  return 1;
 }
 const outcome:{status:Severity}={status:"down"};
 await withReadOnlyCtx(argv,async({db,config,configPath})=>{
  const report=collectDoctorReport(db,config,Date.now(),configPath,options.storageProbe);outcome.status=report.status;
  process.stdout.write(report.lines.join("\n")+`\n  measured ${report.elapsedMs.toFixed(1)} ms\n`);
 });
 return outcome.status==="healthy"?0:1;
}
export function storageDoctorLines(config:Config,probe:VolumeIdentityProbe=defaultVolumeIdentityProbe):{down:boolean;lines:string[]}{
 let down=false;const lines:string[]=[];
 for(const [mountPrefix,expected] of Object.entries(config.storage?.volumes??{}).sort(([a],[b])=>a.localeCompare(b))){
  const result=resolveVolumeIdentity({mountPrefix,expected},probe);
  if(result.state==="match")lines.push(`  [ok] storage ${mountPrefix} · mounted · uuid match`);
  else if(result.state==="absent"){down=true;lines.push(`  [DOWN] storage ${mountPrefix} · not mounted (${result.staleDirectoryPresent?"stale directory present":"mountpoint path absent"})`);}
  else if(result.state==="mismatch"){down=true;lines.push(`  [DOWN] storage ${mountPrefix} · uuid mismatch expected ${expected} observed ${result.observed??"unavailable"}`);}
 }
 return {down,lines};
}
function collectJobs(db:DB,now:number,lines:string[],elevate:(severity:Severity)=>void):void{
 const rows=db.prepare(`SELECT w.id,w.current_status,w.updated_at,w.lease_expires_at,w.blocked_reason,w.current_error,(SELECT a.error FROM job_attempts a WHERE a.work_id=w.id ORDER BY a.attempt_ordinal DESC,a.id DESC LIMIT 1) newest_error FROM job_work w WHERE w.current_status NOT IN ('done','superseded') ORDER BY w.created_at,w.id`).all() as Array<{id:number;current_status:string;updated_at:number;lease_expires_at:number|null;blocked_reason:string|null;current_error:string|null;newest_error:string|null}>;
 if(!rows.length){lines.push("  [ok] jobs · no actionable work");return;}
 for(const row of rows){let state="--";if(row.current_status==="failed"){state="DOWN";elevate("down");}else if(row.current_status==="running"&&(!row.lease_expires_at||row.lease_expires_at<=now)){state="DOWN";elevate("down");}else if(row.current_status==="pending"&&now-row.updated_at>15*60_000){state="DEGRADED";elevate("degraded");}else if(row.current_status==="running")state="ok";const detail=row.blocked_reason??row.newest_error??row.current_error;lines.push(`  [${state}] job #${row.id} ${row.current_status} · age ${age(row.updated_at,now)}${row.lease_expires_at?` · lease ${row.lease_expires_at>now?`live ${duration(row.lease_expires_at-now)}`:"expired"}`:""}${detail?` · ${detail}`:""}`);}
}
function collectProviders(config:Config,lines:string[]):void{if(!config.providers.length){lines.push("  [--] providers · none configured (jobs block; zero calls)");return;}for(const provider of config.providers){const readiness=providerReadiness(provider);lines.push(`  [${readiness.ready?"ok":"--"}] provider ${provider.name||"unnamed"} · ${provider.model||"no model"} · ${readiness.ready?`credential ${provider.key_env} available`:readiness.reason??"not ready"}`);}}
function knownUnitNewer(db:DB,source:string,root:string):boolean{const rows=db.prepare(`SELECT source_path,source_observed_ts FROM sessions WHERE harness=? AND source_root=? AND orphaned=0`).all(source,root) as Array<{source_path:string;source_observed_ts:number|null}>;for(const row of rows){if(row.source_observed_ts===null)continue;for(const path of [row.source_path,`${row.source_path}-wal`]){try{if(Math.floor(statSync(path).mtimeMs)>row.source_observed_ts)return true;}catch{}}}return false;}
function scheduleArtifactMatches(path:string,configPath:string):boolean{try{if(!statSync(path).isFile())return false;return readFileSync(path,"utf8").includes(configPath);}catch{return false;}}
function cachedLaunchdStatus(path:string,cache:Map<string,boolean|null>):boolean|null{if(cache.has(path))return cache.get(path)!;const status=launchdStatus(path);cache.set(path,status);return status;}
function launchdStatus(path:string):boolean|null{if(process.platform!=="darwin")return null;let text:string;try{text=readFileSync(path,"utf8");}catch{return null;}const label=text.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1];const uid=typeof process.getuid==="function"?process.getuid():null;if(!label||uid===null)return null;try{execFileSync("/bin/launchctl",["print",`gui/${uid}/${label}`],{stdio:"ignore",timeout:1000});return true;}catch{return false;}}
/** Every root reachable and clean, and at least one changed while it was walked: the same rule `atlas index` exits 0 on. */
function walkChurnOnly(db:DB,sourceId:number):boolean{const row=db.prepare(`SELECT COUNT(*) total,COALESCE(SUM(reachability='reachable' AND error IS NULL),0) clean,COALESCE(SUM(changed_during_walk=1),0) changed FROM reconciliation_roots WHERE reconciliation_source_id=?`).get(sourceId) as {total:number;clean:number;changed:number};return row.total>0&&row.clean===row.total&&row.changed>0;}
function lastComplete(db:DB,digest:string,source:string):CompletePass|null{return db.prepare(`SELECT g.finished_at,rs.admissible_identity_count,rs.archived_identity_count FROM reconciliation_groups g JOIN reconciliation_sources rs ON rs.group_id=g.id WHERE g.config_digest=? AND rs.source=? AND rs.status='complete' AND g.finished_at IS NOT NULL ORDER BY g.id DESC LIMIT 1`).get(digest,source) as CompletePass|null;}
function count(db:DB,sql:string):number{return Number((db.prepare(sql).get() as {n:number}).n);}
function age(timestamp:number|null,now:number):string{if(!timestamp)return "never";return `${duration(Math.max(0,now-timestamp))} ago`;}
function duration(ms:number):string{const s=Math.floor(ms/1000);if(s<60)return `${s}s`;if(s<3600)return `${Math.floor(s/60)}m`;if(s<86400)return `${Math.floor(s/3600)}h`;return `${(s/86400).toFixed(2)}d`;}
function interval(start:number,finish:number|null):string{return `${new Date(start).toISOString()}..${finish?new Date(finish).toISOString():"incomplete"}`;}
function homePath(path:string):string{const home=process.env.HOME;return home&&path.startsWith(home+"/")?`~${path.slice(home.length)}`:path;}
function pad(value:string,width:number):string{return value.length>=width?value:value+" ".repeat(width-value.length);}
function label(severity:Severity):string{return severity==="healthy"?"ok":severity==="degraded"?"DEGRADED":"DOWN";}
