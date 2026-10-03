import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import type { DB } from "./db/index.js";
import { bumpLastWrite } from "./db/index.js";
import type { Config, SourceConfig } from "./config.js";
import { DEFAULT_TUNABLES, HARNESS_IDS, resolvedSourceConfig, sourcePlanDigest } from "./config.js";
import { estimateTokens, engagementRatio } from "./metrics.js";
import type { Adapter, AdmissionResult, DiscoveredSource, IngestRecord, ContinuitySupport, NormalizedMessage } from "./adapters/types.js";
import { MalformedJsonlLineError } from "./adapters/types.js";
import { claudeAdapter } from "./adapters/claude.js";
import { codexAdapter } from "./adapters/codex.js";
import { kiloAdapter } from "./adapters/kilo.js";
import { primeAdapter } from "./adapters/prime.js";
import { zcodeAdapter } from "./adapters/zcode.js";
import { hermesAdapter } from "./adapters/hermes.js";
import { kimiAdapter } from "./adapters/kimi.js";
import { rebuildLogicalMetrics } from "./logical-metrics.js";
import { countContinuityEvidence, syncContinuityEvidence } from "./continuity-history.js";
import { assembleChains } from "./chains.js";
import { checkStaleness } from "./tier2.js";
import type { HarnessId, ReconciliationTrigger, RejectionReasonCode } from "./contracts/construction.js";
import {
  constructionGeneration,
  defaultIngestSidecarRoot,
  ensureIngestSidecarRoot,
  InvalidIngestSidecarError,
  loadPreparedConstruction,
  resolveIngestSidecar,
  type AdmittedSidecarSummary,
  type PreparedConstruction,
  type ResolvedSidecar,
} from "./ingest-sidecar.js";
import {
  assertMutablePath,
  StorageIdentityError,
  type VolumeIdentityProbe,
} from "./runtime/storage-identity.js";

export const ADAPTERS: Record<HarnessId,Adapter>={claude:claudeAdapter,codex:codexAdapter,prime:primeAdapter,hermes:hermesAdapter,kimi:kimiAdapter,zcode:zcodeAdapter,kilo:kiloAdapter};
export interface RootResult { root:string; reachable:boolean; sessionsSeen:number; bytesConsumed:number; physicalUnits:number; canonicalCandidates:number; sidecarHits:number; sidecarMisses:number; sourceParses:number; error?:string; unitErrors?:number; changedDuringWalk?:boolean|null; }
export interface IngestSummary { source:string; mode:SourceConfig["mode"]; disabledReason:string|null; roots:RootResult[]; inserted:number; replaced:number; derivedRepaired:number; unchanged:number; orphans:number; bytesConsumed:number; elapsedMs:number; chains:number; chainMembers:number; physicalDiscoveredUnits:number; canonicalCandidates:number; uniqueIdentities:number|null; rejectedUnits:number; reconciliationSourceId:number; sidecarHits:number; sidecarMisses:number; sourceParses:number; publicationChunks:number; }
export interface IngestProgress {source:string;processed:number;total:number;}
export interface IngestOptions { full?:boolean;onlySource?:string;adapters?:Record<string,Adapter>;onSourceComplete?:(summary:IngestSummary)=>void;onProgress?:(progress:IngestProgress)=>void;trigger?:ReconciliationTrigger;configPath?:string;faultAfterRaw?:()=>void;sidecarDir?:string;publicationChunkSize?:number;faultAfterPublicationChunk?:(completedChunks:number)=>void;storageProbe?:VolumeIdentityProbe; }
interface Candidate {src:DiscoveredSource;rootOrdinal:number;nativeId:string;semanticBytes:number;consumed:number;freshness:{mtime:number;size:number};generation:string;record:IngestRecord|null;sidecar:ResolvedSidecar|null;prepared:PreparedConstruction|null;}
interface RootWork {root:string;ordinal:number;rowId:number;legacyRunId:number;reachable:boolean;complete:boolean;startToken:string|null;walkStartToken:string|null;endToken:string|null;changed:boolean|null;physical:number;canonical:number;bytes:number;errors:string[];unitErrors:number;observedSources:DiscoveredSource[];rejections:Array<{src:DiscoveredSource;reason:RejectionReasonCode;detail:string|null}>;candidates:Candidate[];sidecarHits:number;sidecarMisses:number;sourceParses:number;}

export async function ingest(db:DB,config:Config,opts:IngestOptions={}):Promise<IngestSummary[]>{
  const started=Date.now(),digest=sourcePlanDigest(config),trigger=opts.trigger??"manual";
  const adapters:Record<string,Adapter>=opts.adapters??ADAPTERS;
  const sidecarDir=opts.sidecarDir??defaultIngestSidecarRoot(config.dbPath);
  assertMutablePath(sidecarDir,config,opts.storageProbe);
  if(Object.values(adapters).some(adapter=>Boolean(adapter.sidecarVersion)))ensureIngestSidecarRoot(sidecarDir);
  const requested=opts.onlySource?[opts.onlySource]:(opts.adapters?Object.keys(adapters):[...HARNESS_IDS]);
  const selected=[...requested.filter(source=>programmaticPlan(config,source).mode!=="disabled"),...requested.filter(source=>programmaticPlan(config,source).mode==="disabled")];
  const enabled=selected.filter(source=>programmaticPlan(config,source).mode!=="disabled"&&adapters[source]);
  const groupId=Number((db.prepare(`INSERT INTO reconciliation_groups(config_digest,trigger_kind,started_at,status,enabled_source_count) VALUES (?,?,?,'running',?)`).run(digest,trigger,started,enabled.length) as {lastInsertRowid:number|bigint}).lastInsertRowid);
  const summaries:IngestSummary[]=[];let completeSources=0;const groupErrors:string[]=[];
  for(const sourceName of selected){
    const plan=programmaticPlan(config,sourceName),adapter=adapters[sourceName];
    const sourceRow=Number((db.prepare(`INSERT INTO reconciliation_sources(group_id,source,resolution_mode,disabled_reason,resolved_roots_json,status) VALUES (?,?,?,?,?,'running')`).run(groupId,sourceName,plan.mode,plan.disabledReason,JSON.stringify(plan.roots)) as {lastInsertRowid:number|bigint}).lastInsertRowid);
    if(plan.mode==="disabled"){
      db.prepare(`UPDATE reconciliation_sources SET status='disabled' WHERE id=?`).run(sourceRow);
      const summary:IngestSummary={source:sourceName,mode:plan.mode,disabledReason:plan.disabledReason,roots:[],inserted:0,replaced:0,derivedRepaired:0,unchanged:0,orphans:0,bytesConsumed:0,elapsedMs:0,chains:0,chainMembers:0,physicalDiscoveredUnits:0,canonicalCandidates:0,uniqueIdentities:null,rejectedUnits:0,reconciliationSourceId:sourceRow,sidecarHits:0,sidecarMisses:0,sourceParses:0,publicationChunks:0};
      summaries.push(summary);opts.onSourceComplete?.(summary);continue;
    }
    if(!adapter){
      db.prepare(`UPDATE reconciliation_sources SET status='failed' WHERE id=?`).run(sourceRow);groupErrors.push(`${sourceName}: adapter unavailable`);continue;
    }
    try{
      const summary=await reconcileSource(db,adapter,plan,sourceRow,config,{...opts,sidecarDir});
      summaries.push(summary);opts.onSourceComplete?.(summary);
      if(summary.uniqueIdentities!==null)completeSources++;else groupErrors.push(`${sourceName}: incomplete reconciliation`);
    }catch(error){
      const message=errorMessage(error);groupErrors.push(`${sourceName}: ${message}`);
      db.prepare(`UPDATE reconciliation_sources SET status='failed' WHERE id=?`).run(sourceRow);
      const summary:IngestSummary={source:sourceName,mode:plan.mode,disabledReason:null,roots:plan.roots.map(root=>({root,reachable:false,sessionsSeen:0,bytesConsumed:0,physicalUnits:0,canonicalCandidates:0,sidecarHits:0,sidecarMisses:0,sourceParses:0,error:message})),inserted:0,replaced:0,derivedRepaired:0,unchanged:0,orphans:0,bytesConsumed:0,elapsedMs:0,chains:0,chainMembers:0,physicalDiscoveredUnits:0,canonicalCandidates:0,uniqueIdentities:null,rejectedUnits:0,reconciliationSourceId:sourceRow,sidecarHits:0,sidecarMisses:0,sourceParses:0,publicationChunks:0};
      summaries.push(summary);opts.onSourceComplete?.(summary);
    }finally{adapter.cleanup?.();}
  }
  const complete=completeSources===enabled.length;
  db.prepare(`UPDATE reconciliation_groups SET finished_at=?,status=?,complete_source_count=?,error=? WHERE id=?`).run(Date.now(),complete?"complete":"incomplete",completeSources,groupErrors.length?groupErrors.join("; "):null,groupId);
  updateScheduleState(db,config,opts.configPath??"<runtime-config>",digest,trigger,groupId);
  if(summaries.some(summary=>summary.inserted+summary.replaced+summary.derivedRepaired+summary.orphans>0))bumpLastWrite(db);
  return summaries;
}

async function reconcileSource(db:DB,adapter:Adapter,plan:SourceConfig,reconciliationSourceId:number,config:Config,opts:IngestOptions):Promise<IngestSummary>{
  const started=Date.now();const roots:RootWork[]=[];
  const sidecarDir=opts.sidecarDir??defaultIngestSidecarRoot(config.dbPath);

  // Discover every configured root before parsing. Some contract evidence
  // (notably Codex title authority) depends on ordered peer roots.
  for(const [ordinal,root] of plan.roots.entries()){
    const identityError=sourceRootIdentityError(root,config,opts.storageProbe);
    const startToken=identityError===null?computeRootChangeToken(root):null;
    const rootId=Number((db.prepare(`INSERT INTO reconciliation_roots(reconciliation_source_id,root_ordinal,root,reachability,started_at,start_change_token) VALUES (?,?,?,'unreachable',?,?)`).run(reconciliationSourceId,ordinal,root,Date.now(),startToken) as {lastInsertRowid:number|bigint}).lastInsertRowid);
    const legacy=Number((db.prepare(`INSERT INTO ingest_runs(source,root,started_at,reachable) VALUES (?,?,?,0)`).run(adapter.source,root,Date.now()) as {lastInsertRowid:number|bigint}).lastInsertRowid);
    const work:RootWork={root,ordinal,rowId:rootId,legacyRunId:legacy,reachable:false,complete:false,startToken,walkStartToken:startToken,endToken:null,changed:null,physical:0,canonical:0,bytes:0,errors:[],unitErrors:0,observedSources:[],rejections:[],candidates:[],sidecarHits:0,sidecarMisses:0,sourceParses:0};roots.push(work);
    try{
      if(identityError!==null)throw new Error(identityError);
      if(startToken===null)throw new Error("source root is unreachable");
      work.reachable=true;
      const discovered=adapter.discover([root]);work.observedSources=discovered;work.physical=discovered.length;work.walkStartToken=computeRootChangeToken(root,discovered);
    }catch(error){work.unitErrors++;work.errors.push(errorMessage(error));}
  }

  // Each successfully captured unit is durable before publication. A crash can
  // therefore restart from sidecar headers without reparsing completed units.
  for(const work of roots){
    if(work.reachable){
      for(const src of work.observedSources){
        const withOrdinal={...src,rootOrdinal:work.ordinal};
        try{
          if(adapter.sidecarVersion){
            const resolved=resolveIngestSidecar({
              root:sidecarDir,
              adapter,
              source:withOrdinal,
              parse:()=>{work.sourceParses++;return parseAdmission(adapter,withOrdinal);},
              validate:record=>{validateIdentity(record,adapter.source);validateDraft(record,adapter.source);},
            });
            if(resolved.cache==="hit")work.sidecarHits++;else work.sidecarMisses++;
            // A miss is durable on disk now; publication reloads it like a hit, so a
            // source-wide miss never holds every parsed transcript at once.
            resolved.prepared=null;
            if(resolved.header.outcome.kind==="rejected"){
              recordRejection(work,withOrdinal,resolved.header.outcome.reason,resolved.header.outcome.detail);
              continue;
            }
            const summary=resolved.header.outcome;
            work.canonical++;work.bytes+=summary.consumed;
            work.candidates.push({src:withOrdinal,rootOrdinal:work.ordinal,nativeId:summary.nativeId,semanticBytes:summary.semanticBytes,consumed:summary.consumed,freshness:sourceFreshness(withOrdinal),generation:summary.constructionGeneration,record:null,sidecar:resolved,prepared:null});
          }else{
            work.sourceParses++;
            const admitted=parseAdmission(adapter,withOrdinal);
            if(!admitted.admitted){recordRejection(work,withOrdinal,admitted.reason,admitted.detail);continue;}
            validateIdentity(admitted.record,adapter.source);validateDraft(admitted.record,adapter.source);
            const generation=constructionGeneration(adapter.source,admitted.record);
            work.canonical++;
            const freshness=sourceFreshness(withOrdinal);
            work.candidates.push({src:withOrdinal,rootOrdinal:work.ordinal,nativeId:admitted.record.nativeId,semanticBytes:admitted.record.transcriptBytes,consumed:admitted.consumed,freshness,generation,record:admitted.record,sidecar:null,prepared:null});
            work.bytes+=admitted.consumed;
          }
        }catch(error){
          if(error instanceof MalformedJsonlLineError){work.rejections.push({src:withOrdinal,reason:"malformed_complete_record",detail:error.message});work.unitErrors++;work.errors.push(`${src.relPath}: ${error.message}`);}
          else{work.unitErrors++;work.errors.push(`${src.relPath}: ${errorMessage(error)}`);}
        }
      }
    }
    const walkEndToken=work.startToken===null?null:computeRootChangeToken(work.root,work.observedSources);work.endToken=work.startToken===null?null:computeRootChangeToken(work.root);work.changed=work.walkStartToken!==null&&walkEndToken!==null?work.walkStartToken!==walkEndToken:null;
    work.complete=work.reachable&&work.changed===false&&work.unitErrors===0;
  }

  const allCandidates=roots.flatMap(root=>root.candidates);const groups=new Map<string,Candidate[]>();
  for(const candidate of allCandidates){const group=groups.get(candidate.nativeId)??[];group.push(candidate);groups.set(candidate.nativeId,group);}
  let inserted=0,replaced=0,derivedRepaired=0,unchanged=0,orphans=0,processed=0,publicationChunks=0;
  const safeWalk=roots.length>0&&roots.every(root=>root.complete);
  const admittedKeys=new Set(groups.keys());
  type Existing={id:number;construction_generation:string;source_path:string;transcript_bytes:number;construction_status:string;source_validation_status:string;source_observed_ts:number|null;orphaned:number};
  type Action={kind:"retain"|"unchanged"|"repair"|"publish";winner:Candidate;candidates:Candidate[];existing:Existing|null;generation:string;record:IngestRecord|null;prepared:PreparedConstruction|null};
  const existingRows=db.prepare(`SELECT id,native_id,construction_generation,source_path,transcript_bytes,construction_status,source_validation_status,source_observed_ts,orphaned FROM sessions WHERE harness=?`).all(adapter.source) as Array<Existing&{native_id:string}>;
  const existingByNative=new Map(existingRows.map(row=>[row.native_id,row]));
  const actions:Action[]=[];
  for(const [nativeId,candidates] of groups){
    processed++;if(processed%500===0)opts.onProgress?.({source:adapter.source,processed,total:groups.size});
    candidates.sort((a,b)=>b.semanticBytes-a.semanticBytes||a.rootOrdinal-b.rootOrdinal||a.src.relPath.localeCompare(b.src.relPath));
    const winner=candidates[0]!;
    try{
      const existing=existingByNative.get(nativeId)??null;
      const generation=winner.generation;
      const same=existing?.construction_status==="valid"&&existing.construction_generation===generation&&existing.source_path===winner.src.fullPath&&existing.transcript_bytes===winner.semanticBytes;
      if(existing&&!safeWalk&&existing.source_path!==winner.src.fullPath){
        actions.push({kind:"retain",winner,candidates,existing,generation,record:null,prepared:null});
        continue;
      }
      if(same){
        if(winner.sidecar){
          const summary=winner.sidecar.header.outcome as AdmittedSidecarSummary;
          if(needsDerivedRepairSummary(db,existing.id,generation,summary))actions.push({kind:"repair",winner,candidates,existing,generation,record:null,prepared:null});
          else actions.push({kind:"unchanged",winner,candidates,existing,generation,record:null,prepared:null});
        }else{
          const record=winner.record!;const draft=validateDraft(record,adapter.source);
          actions.push({kind:needsDerivedRepair(db,existing.id,generation,record,draft)?"repair":"unchanged",winner,candidates,existing,generation,record,prepared:null});
        }
      }else{
        if(winner.sidecar)actions.push({kind:"publish",winner,candidates,existing,generation:winner.generation,record:null,prepared:null});
        else actions.push({kind:"publish",winner,candidates,existing,generation,record:winner.record!,prepared:null});
      }
    }catch(error){const root=roots[winner.rootOrdinal]!;root.unitErrors++;root.complete=false;root.errors.push(`${winner.src.relPath}: ${errorMessage(error)}`);}
  }

  // Planning defers sidecar loads; a load that fails is a unit error, as before.
  const materializeAction=(action:Action):boolean=>{
    if(!action.winner.sidecar||action.prepared||action.kind==="retain"||action.kind==="unchanged")return true;
    try{
      const prepared=materializeCandidate(action.winner,adapter,sidecarDir,roots[action.winner.rootOrdinal]!);
      if(action.kind==="repair"&&action.winner.generation!==action.generation)action.kind="publish";
      action.generation=action.winner.generation;action.prepared=prepared;action.record=prepared.record;return true;
    }catch(error){const root=roots[action.winner.rootOrdinal]!;root.unitErrors++;root.complete=false;root.errors.push(`${action.winner.src.relPath}: ${errorMessage(error)}`);return false;}
  };
  const chunkSize=normalizeChunkSize(opts.publicationChunkSize);
  for(let offset=0;offset<actions.length;offset+=chunkSize){
    // Constructions load one chunk at a time and are released once it commits,
    // so publication memory follows the chunk, not every changed session.
    const chunk=actions.slice(offset,offset+chunkSize).filter(materializeAction);
    db.transaction(()=>{
      for(const action of chunk){
        const root=roots[action.winner.rootOrdinal]!;
        db.exec("SAVEPOINT atlas_ingest_unit");
        try{
          insertCandidateEvidence(db,reconciliationSourceId,adapter.source,action.candidates,action.kind==="retain"?null:action.winner);
          if(action.kind==="retain")unchanged++;
          else if(action.kind==="unchanged"){
            refreshUnchangedSession(db,action.existing!,action.winner,action.generation,action.winner.sidecar?.header.outcome as AdmittedSidecarSummary|undefined,action.record?.construction);
            updateCandidateCursors(db,adapter.source,action.candidates,action.generation);unchanged++;
          }else if(action.kind==="repair"){
            if(action.prepared)repairDerivedPrepared(db,action.existing!.id,adapter,action.prepared,action.generation);
            else repairDerived(db,action.existing!.id,adapter,action.record!,validateDraft(action.record!,adapter.source),action.generation);
            refreshUnchangedSession(db,action.existing!,action.winner,action.generation,action.winner.sidecar?.header.outcome as AdmittedSidecarSummary|undefined,action.record?.construction);
            updateCandidateCursors(db,adapter.source,action.candidates,action.generation);derivedRepaired++;
          }else{
            if(action.prepared)publishPreparedWinner(db,adapter,action.winner,action.prepared,action.generation,opts.faultAfterRaw,action.candidates);
            else publishWinner(db,adapter,action.winner,action.record!,action.generation,reconciliationSourceId,opts.faultAfterRaw,action.candidates);
            if(action.existing){replaced++;checkStaleness(db,action.existing.id,config.tunables.summary_stale_pct);}else inserted++;
          }
          db.exec("RELEASE SAVEPOINT atlas_ingest_unit");
        }catch(error){
          db.exec("ROLLBACK TO SAVEPOINT atlas_ingest_unit");db.exec("RELEASE SAVEPOINT atlas_ingest_unit");
          root.unitErrors++;root.complete=false;root.errors.push(`${action.winner.src.relPath}: ${errorMessage(error)}`);
        }
      }
    })();
    for(const action of chunk){action.prepared=null;action.record=null;action.winner.prepared=null;if(action.winner.sidecar)action.winner.sidecar.prepared=null;}
    publicationChunks++;opts.faultAfterPublicationChunk?.(publicationChunks);
  }
  for(const root of roots)persistRootResult(db,reconciliationSourceId,root);
  const complete=roots.length>0&&roots.every(root=>root.complete);
  if(complete){
    const live=db.prepare(`SELECT native_id,orphaned FROM sessions WHERE harness=?`).all(adapter.source) as {native_id:string;orphaned:number}[];
    const mark=db.prepare(`UPDATE sessions SET orphaned=1 WHERE harness=? AND native_id=? AND orphaned=0`);
    const tx=db.transaction(()=>{for(const row of live)if(!admittedKeys.has(row.native_id))orphans+=Number(mark.run(adapter.source,row.native_id).changes);});tx();
  }else{
    // A retained winner rooted only in an unavailable path becomes snapshot-only;
    // partial evidence never orphans, deletes, or promotes another candidate.
    const unreachable=new Set(roots.filter(root=>!root.reachable).map(root=>root.root));
    if(unreachable.size){const rows=db.prepare(`SELECT id,source_root FROM sessions WHERE harness=?`).all(adapter.source) as {id:number;source_root:string|null}[];
      for(const row of rows)if(row.source_root&&unreachable.has(row.source_root))db.prepare(`UPDATE sessions SET source_validation_status='snapshot_only' WHERE id=?`).run(row.id);}
  }
  const chain=assembleChains(db,adapter.source);
  const physical=roots.reduce((sum,root)=>sum+root.physical,0),canonical=roots.reduce((sum,root)=>sum+root.canonical,0),rejected=roots.reduce((sum,root)=>sum+root.rejections.length,0),errors=roots.reduce((sum,root)=>sum+root.unitErrors,0);
  const archived=complete?Number((db.prepare(`SELECT COUNT(*) n FROM sessions WHERE harness=? AND orphaned=0`).get(adapter.source) as {n:number}).n):null;
  const snapshot=Number((db.prepare(`SELECT COUNT(*) n FROM sessions WHERE harness=? AND source_validation_status='snapshot_only'`).get(adapter.source) as {n:number}).n);
  const unresolved=Number((db.prepare(`SELECT COUNT(*) n FROM lineage_claims lc JOIN sessions s ON s.id=lc.session_id WHERE s.harness=? AND lc.resolution_status!='resolved'`).get(adapter.source) as {n:number}).n);
  db.prepare(`UPDATE reconciliation_sources SET status=?,physical_unit_count=?,canonical_candidate_count=?,admissible_identity_count=?,archived_identity_count=?,duplicate_candidate_count=?,rejected_unit_count=?,error_unit_count=?,snapshot_only_count=?,unresolved_lineage_count=? WHERE id=?`)
    .run(complete?"complete":"incomplete",physical,canonical,complete?groups.size:null,archived,canonical-groups.size,rejected,errors,snapshot,unresolved,reconciliationSourceId);
  const sidecarHits=roots.reduce((sum,root)=>sum+root.sidecarHits,0),sidecarMisses=roots.reduce((sum,root)=>sum+root.sidecarMisses,0),sourceParses=roots.reduce((sum,root)=>sum+root.sourceParses,0);
  return {source:adapter.source,mode:plan.mode,disabledReason:null,roots:roots.map(root=>({root:root.root,reachable:root.reachable,sessionsSeen:root.canonical,bytesConsumed:root.bytes,physicalUnits:root.physical,canonicalCandidates:root.canonical,sidecarHits:root.sidecarHits,sidecarMisses:root.sidecarMisses,sourceParses:root.sourceParses,error:root.errors.length?root.errors.slice(0,5).join("; "):undefined,unitErrors:root.unitErrors,changedDuringWalk:root.changed})),inserted,replaced,derivedRepaired,unchanged,orphans,bytesConsumed:roots.reduce((sum,root)=>sum+root.bytes,0),elapsedMs:Date.now()-started,chains:chain.chains,chainMembers:chain.members,physicalDiscoveredUnits:physical,canonicalCandidates:canonical,uniqueIdentities:complete?groups.size:null,rejectedUnits:rejected,reconciliationSourceId,sidecarHits,sidecarMisses,sourceParses,publicationChunks};
}

function parseAdmission(adapter:Adapter,src:DiscoveredSource):AdmissionResult{
  if(adapter.admit)return adapter.admit(src);
  const parsed=adapter.parse(src);return {admitted:true,...parsed};
}
function validateIdentity(record:IngestRecord,source:string):void{if(typeof record.nativeId!=="string"||!record.nativeId.trim())throw new Error(`${source} adapter returned missing native identity`);if(!Number.isSafeInteger(record.transcriptBytes)||record.transcriptBytes<0)throw new Error(`${source} adapter returned invalid semantic byte count`);}
function validateDraft(record:IngestRecord,source:string):NonNullable<IngestRecord["construction"]>{
  const draft=record.construction;if(!draft)throw new Error(`${source} adapter returned no v11 construction draft`);
  if(!draft.classificationRuleVersion.trim()||!draft.replayRuleVersion.trim())throw new Error(`${source} adapter returned unversioned construction draft`);
  if(!Array.isArray(draft.titleCandidates)||!draft.project)throw new Error(`${source} adapter returned incomplete construction draft`);
  const ordinals=new Set<number>();
  for(const [index,message] of record.messages.entries()){
    if(message.ordinal!==index||ordinals.has(message.ordinal))throw new Error(`${source} adapter returned noncontiguous raw ordinals`);ordinals.add(message.ordinal);
    if(!Number.isSafeInteger(message.sourceOrdinal)||message.sourceOrdinal!<0)throw new Error(`${source} adapter returned missing source ordinal`);
    if(!message.recordKind)throw new Error(`${source} adapter returned unclassified draft field`);
    const side=message.recordKind==="real_user"?"user":message.recordKind==="assistant_dialogue_prose"?"assistant":null;
    if((message.dialogueSide??null)!==side)throw new Error(`${source} adapter record kind/side contradiction`);
    if(side&&!(message.prose??"").trim())throw new Error(`${source} adapter returned blank dialogue`);
    const tools=message.toolActivities??[];tools.forEach((tool,i)=>{if(tool.activityOrdinal!==i)throw new Error(`${source} adapter returned noncontiguous tool activities`);});
  }
  const visible=record.messages.some(message=>(message.recordKind==="real_user"||message.recordKind==="assistant_dialogue_prose")&&Boolean(message.prose?.trim()));
  if(draft.defaultSessionVisible!==visible)throw new Error(`${source} adapter returned inconsistent visibility`);
  return draft;
}
function recordRejection(work:RootWork,src:DiscoveredSource,reason:RejectionReasonCode,detail:string|null):void{
  work.rejections.push({src,reason,detail});
  if(reason==="malformed_complete_record"){work.unitErrors++;work.errors.push(`${src.relPath}: ${detail??"malformed complete record"}`);}
}
function materializeCandidate(candidate:Candidate,adapter:Adapter,sidecarDir:string,work:RootWork):PreparedConstruction{
  if(candidate.prepared)return candidate.prepared;
  if(!candidate.sidecar)throw new Error("candidate has no sidecar payload");
  try{
    const prepared=loadPreparedConstruction(candidate.sidecar);validateIdentity(prepared.record,adapter.source);validateDraft(prepared.record,adapter.source);candidate.prepared=prepared;return prepared;
  }catch(error){
    if(!(error instanceof InvalidIngestSidecarError))throw error;
    const previous=candidate.sidecar.header.outcome;
    const refreshed=resolveIngestSidecar({root:sidecarDir,adapter,source:candidate.src,force:true,parse:()=>{work.sourceParses++;return parseAdmission(adapter,candidate.src);},validate:record=>{validateIdentity(record,adapter.source);validateDraft(record,adapter.source);}});
    work.sidecarMisses++;
    if(refreshed.header.outcome.kind!=="admitted"||previous.kind!=="admitted")throw new Error("sidecar recapture no longer admits the candidate");
    const next=refreshed.header.outcome;
    if(next.nativeId!==candidate.nativeId||next.semanticBytes!==candidate.semanticBytes||next.consumed!==candidate.consumed)throw new Error("sidecar recapture changed candidate election evidence");
    candidate.sidecar=refreshed;candidate.generation=next.constructionGeneration;candidate.prepared=loadPreparedConstruction(refreshed);
    return candidate.prepared;
  }
}
function needsDerivedRepairSummary(db:DB,sessionId:number,generation:string,summary:AdmittedSidecarSummary):boolean{
  const raw=Number((db.prepare(`SELECT COUNT(*) n FROM messages WHERE session_id=? AND construction_generation=?`).get(sessionId,generation) as {n:number}).n);if(raw!==summary.rawRecordCount)return true;
  const metrics=db.prepare(`SELECT raw_provenance_row_count,logical_record_count,raw_tool_activity_count FROM construction_metrics WHERE session_id=? AND construction_generation=?`).get(sessionId,generation) as {raw_provenance_row_count:number;logical_record_count:number;raw_tool_activity_count:number}|null;
  if(!metrics||metrics.raw_provenance_row_count!==raw||metrics.logical_record_count!==summary.logicalRecordCount||metrics.raw_tool_activity_count!==summary.rawToolActivityCount)return true;
  const logical=Number((db.prepare(`SELECT COUNT(*) n FROM logical_messages WHERE session_id=? AND construction_generation=?`).get(sessionId,generation) as {n:number}).n);
  const members=Number((db.prepare(`SELECT COUNT(*) n FROM logical_message_members WHERE construction_generation=? AND logical_message_id IN (SELECT id FROM logical_messages WHERE session_id=?)`).get(generation,sessionId) as {n:number}).n);
  if(logical!==summary.logicalRecordCount||members!==raw)return true;
  const titleRows=Number((db.prepare(`SELECT COUNT(*) n FROM title_evidence WHERE session_id=? AND construction_generation=?`).get(sessionId,generation) as {n:number}).n);
  const override=db.prepare(`SELECT 1 ok FROM atlas_title_overrides WHERE harness=(SELECT harness FROM sessions WHERE id=?) AND native_id=(SELECT native_id FROM sessions WHERE id=?) AND trim(value)!=''`).get(sessionId,sessionId);
  if(titleRows!==summary.titleCandidateCount+(override?1:0))return true;
  const continuity=db.prepare(`SELECT reset_at,construction_generation FROM continuity_state WHERE session_id=?`).get(sessionId) as {reset_at:number|null;construction_generation:string|null}|null;
  if(!continuity||continuity.construction_generation!==generation)return true;
  const evidence=Number((db.prepare(`SELECT COUNT(*) n FROM continuity_evidence WHERE session_id=? AND construction_generation=?`).get(sessionId,generation) as {n:number}).n);
  const evidenceTotal=Number((db.prepare(`SELECT COUNT(*) n FROM continuity_evidence WHERE session_id=?`).get(sessionId) as {n:number}).n);
  if(evidence!==summary.continuityEvidenceCount||evidenceTotal!==summary.continuityEvidenceCount)return true;
  const projection=Number((db.prepare(`SELECT COUNT(*) n FROM continuity_projection WHERE session_id=? AND construction_generation=?`).get(sessionId,generation) as {n:number}).n);
  if(projection!==(continuity.reset_at===null?summary.continuityEvidenceCount:0))return true;
  const lineage=Number((db.prepare(`SELECT COUNT(*) n FROM lineage_claims WHERE session_id=? AND construction_generation=?`).get(sessionId,generation) as {n:number}).n);
  return lineage!==summary.lineageClaimCount;
}
function normalizeChunkSize(value:number|undefined):number{return Number.isSafeInteger(value)&&value!>0?Math.min(512,value!):64;}
function refreshUnchangedSession(db:DB,existing:{id:number;source_validation_status:string;source_observed_ts:number|null;orphaned:number},winner:Candidate,_generation:string,summary:AdmittedSidecarSummary|undefined,draft:IngestRecord["construction"]|undefined):void{
  const status=summary?.sourceValidationStatus??draft?.sourceValidationStatus??"current";
  const observed=summary?.sourceObservedTs??draft?.sourceObservedTs??winner.freshness.mtime;
  if(existing.orphaned!==0||existing.source_validation_status!==status||existing.source_observed_ts!==observed)db.prepare(`UPDATE sessions SET orphaned=0,source_validation_status=?,source_observed_ts=? WHERE id=?`).run(status,observed,existing.id);
}
function needsDerivedRepair(db:DB,sessionId:number,generation:string,record:IngestRecord,draft:NonNullable<IngestRecord["construction"]>):boolean {
  const raw=Number((db.prepare(`SELECT COUNT(*) n FROM messages WHERE session_id=? AND construction_generation=?`).get(sessionId,generation) as {n:number}).n);
  if(raw!==record.messages.length)return true;
  const metrics=db.prepare(`SELECT raw_provenance_row_count,logical_record_count FROM construction_metrics WHERE session_id=? AND construction_generation=?`).get(sessionId,generation) as {raw_provenance_row_count:number;logical_record_count:number}|null;
  if(!metrics||metrics.raw_provenance_row_count!==raw)return true;
  const logical=Number((db.prepare(`SELECT COUNT(*) n FROM logical_messages WHERE session_id=? AND construction_generation=?`).get(sessionId,generation) as {n:number}).n);
  const members=Number((db.prepare(`SELECT COUNT(*) n FROM logical_message_members WHERE construction_generation=? AND logical_message_id IN (SELECT id FROM logical_messages WHERE session_id=?)`).get(generation,sessionId) as {n:number}).n);
  if(logical!==metrics.logical_record_count||members!==raw)return true;
  const titleRows=Number((db.prepare(`SELECT COUNT(*) n FROM title_evidence WHERE session_id=? AND construction_generation=?`).get(sessionId,generation) as {n:number}).n);
  const override=db.prepare(`SELECT 1 ok FROM atlas_title_overrides WHERE harness=(SELECT harness FROM sessions WHERE id=?) AND native_id=(SELECT native_id FROM sessions WHERE id=?) AND trim(value)!=''`).get(sessionId,sessionId);
  if(titleRows!==draft.titleCandidates.length+(override?1:0))return true;
  const continuity=db.prepare(`SELECT reset_at,construction_generation FROM continuity_state WHERE session_id=?`).get(sessionId) as {reset_at:number|null;construction_generation:string|null}|null;
  if(!continuity||continuity.construction_generation!==generation)return true;
  const expectedContinuity=countContinuityEvidence(record.continuityEvents);
  const evidence=Number((db.prepare(`SELECT COUNT(*) n FROM continuity_evidence WHERE session_id=? AND construction_generation=?`).get(sessionId,generation) as {n:number}).n);
  const evidenceTotal=Number((db.prepare(`SELECT COUNT(*) n FROM continuity_evidence WHERE session_id=?`).get(sessionId) as {n:number}).n);
  if(evidence!==expectedContinuity||evidenceTotal!==expectedContinuity)return true;
  const projection=Number((db.prepare(`SELECT COUNT(*) n FROM continuity_projection WHERE session_id=? AND construction_generation=?`).get(sessionId,generation) as {n:number}).n);
  if(projection!==(continuity.reset_at===null?expectedContinuity:0))return true;
  const lineage=Number((db.prepare(`SELECT COUNT(*) n FROM lineage_claims WHERE session_id=? AND construction_generation=?`).get(sessionId,generation) as {n:number}).n);
  return lineage!==(record.parentNativeId?1:0);
}
function repairDerived(db:DB,sessionId:number,adapter:Adapter,record:IngestRecord,draft:NonNullable<IngestRecord["construction"]>,generation:string):void {
  // v12 search refreshes only committed valid generations. Suppress partial
  // row-trigger refreshes while this complete derived generation republishes.
  db.prepare(`UPDATE sessions SET construction_status='invalid',construction_invalid_reason='repairing-derived' WHERE id=?`).run(sessionId);
  rebuildLogicalMetrics(db,sessionId,generation,draft.replayRuleVersion);
  const selected=selectTitle(db,adapter.source,record.nativeId,draft.titleCandidates);
  insertTitles(db,sessionId,generation,selected,draft.titleCandidates);
  syncContinuityEvidence(db,sessionId,record.continuityEvents??[],record.continuitySupport??adapter.continuitySupport??"unknown",generation);
  publishLineage(db,sessionId,adapter.source,record.parentNativeId??null,generation);
  db.prepare(`UPDATE sessions SET construction_status='valid',construction_invalid_reason=NULL WHERE id=?`).run(sessionId);
}
function repairDerivedPrepared(db:DB,sessionId:number,adapter:Adapter,prepared:PreparedConstruction,generation:string):void{
  const record=prepared.record,draft=validateDraft(record,adapter.source);
  db.prepare(`UPDATE sessions SET construction_status='invalid',construction_invalid_reason='repairing-derived' WHERE id=?`).run(sessionId);
  const rawRows=db.prepare(`SELECT id,ordinal,construction_generation FROM messages WHERE session_id=? ORDER BY ordinal`).all(sessionId) as Array<{id:number;ordinal:number;construction_generation:string|null}>;
  if(rawRows.length!==record.messages.length||rawRows.some((row,index)=>row.ordinal!==index||row.construction_generation!==generation))throw new Error(`raw generation mismatch during prepared repair for ${record.nativeId}`);
  publishPreparedLogical(db,sessionId,prepared,generation,rawRows.map(row=>row.id),draft.replayRuleVersion);
  const selected=selectTitle(db,adapter.source,record.nativeId,draft.titleCandidates);
  insertTitles(db,sessionId,generation,selected,draft.titleCandidates);
  syncContinuityEvidence(db,sessionId,record.continuityEvents??[],record.continuitySupport??adapter.continuitySupport??"unknown",generation);
  publishLineage(db,sessionId,adapter.source,record.parentNativeId??null,generation);
  db.prepare(`UPDATE sessions SET construction_status='valid',construction_invalid_reason=NULL WHERE id=?`).run(sessionId);
}
function publishPreparedWinner(db:DB,adapter:Adapter,winner:Candidate,prepared:PreparedConstruction,generation:string,faultAfterRaw:(()=>void)|undefined,candidates:Candidate[]):void{
  const record=prepared.record,draft=validateDraft(record,adapter.source),now=Date.now(),agg=prepared.aggregate;
  const existing=db.prepare(`SELECT id FROM sessions WHERE harness=? AND native_id=?`).get(adapter.source,record.nativeId) as {id:number}|null;
  let sessionId:number;const selected=selectTitle(db,adapter.source,record.nativeId,draft.titleCandidates);
  if(existing){
    sessionId=existing.id;
    db.prepare(`UPDATE sessions SET project=?,original_project_key=?,canonical_project_key=?,project_key_rule_version=?,cwd=?,source_path=?,source_root=?,title=?,start_ts=?,end_ts=?,last_activity=?,duration_ms=?,models=?,tok_user=?,tok_assistant=?,tok_tool=?,msg_count=?,engagement=?,orphaned=0,transcript_bytes=?,parent_native_id=?,origin=?,origin_detail=?,ingested_at=?,artifact_kind=?,history_completeness=?,construction_generation=?,construction_status='invalid',construction_invalid_reason='publishing',default_session_visible=?,source_validation_status=?,source_observed_ts=? WHERE id=?`).run(record.project,draft.project.originalProjectKey,draft.project.canonicalProjectKey,draft.project.canonicalizationRuleVersion,record.cwd,winner.src.fullPath,winner.src.root,displayTitle(selected?.value),record.startTs,record.endTs,agg.lastActivity,agg.durationMs,JSON.stringify(record.models),agg.tokUser,agg.tokAssistant,agg.tokTool,record.messages.length,agg.engagement,record.transcriptBytes,record.parentNativeId??null,record.origin,record.originDetail??null,now,draft.artifactKind,draft.historyCompleteness,generation,draft.defaultSessionVisible?1:0,draft.sourceValidationStatus,draft.sourceObservedTs??winner.freshness.mtime,sessionId);
    clearConstruction(db,sessionId);
  }else{
    sessionId=Number((db.prepare(`INSERT INTO sessions(harness,native_id,project,original_project_key,canonical_project_key,project_key_rule_version,cwd,source_path,source_root,title,start_ts,end_ts,last_activity,duration_ms,models,tok_user,tok_assistant,tok_tool,msg_count,engagement,orphaned,transcript_bytes,parent_native_id,origin,origin_detail,ingested_at,artifact_kind,history_completeness,construction_generation,construction_status,construction_invalid_reason,default_session_visible,source_validation_status,source_observed_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'invalid','publishing',?,?,?)`).run(adapter.source,record.nativeId,record.project,draft.project.originalProjectKey,draft.project.canonicalProjectKey,draft.project.canonicalizationRuleVersion,record.cwd,winner.src.fullPath,winner.src.root,displayTitle(selected?.value),record.startTs,record.endTs,agg.lastActivity,agg.durationMs,JSON.stringify(record.models),agg.tokUser,agg.tokAssistant,agg.tokTool,record.messages.length,agg.engagement,0,record.transcriptBytes,record.parentNativeId??null,record.origin,record.originDetail??null,now,draft.artifactKind,draft.historyCompleteness,generation,draft.defaultSessionVisible?1:0,draft.sourceValidationStatus,draft.sourceObservedTs??winner.freshness.mtime) as {lastInsertRowid:number|bigint}).lastInsertRowid);
  }
  const rawIds=insertPreparedRaw(db,sessionId,prepared,generation);faultAfterRaw?.();
  publishPreparedLogical(db,sessionId,prepared,generation,rawIds,draft.replayRuleVersion);
  insertTitles(db,sessionId,generation,selected,draft.titleCandidates);
  syncContinuityEvidence(db,sessionId,record.continuityEvents??[],record.continuitySupport??adapter.continuitySupport??"unknown",generation);
  publishLineage(db,sessionId,adapter.source,record.parentNativeId??null,generation);
  updateCandidateCursors(db,adapter.source,candidates,generation);
  db.prepare(`UPDATE sessions SET construction_status='valid',construction_invalid_reason=NULL WHERE id=?`).run(sessionId);
}
function insertPreparedRaw(db:DB,sessionId:number,prepared:PreparedConstruction,generation:string):number[]{
  const insert=db.prepare(`INSERT INTO messages(session_id,ordinal,role,ts,text,tool_text,has_tool,tok_estimate,source_record_id,source_record_uuid,source_record_ts,source_identity_kind,source_ordinal,record_kind,dialogue_side,prose,event_ts,construction_generation,content_digest,content_bytes,content_token_estimate,source_prose_present) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tool=db.prepare(`INSERT INTO tool_activities(raw_record_id,activity_ordinal,activity_kind,tool_name,tool_text,source_activity_id,construction_generation,payload_digest,payload_bytes,payload_token_estimate) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const ids:number[]=[];
  for(const message of prepared.record.messages){
    const toolTokens=(message.toolActivities??[]).reduce((sum,activity)=>sum+(activity.payloadTokenEstimate??estimateTokens(activity.toolText)),0);
    const contentTokens=message.contentTokenEstimate??estimateTokens(message.prose??message.text);
    const res=insert.run(sessionId,message.ordinal,message.role,message.ts,message.text,null,message.hasTool?1:0,contentTokens+toolTokens,message.sourceRecordId??null,message.sourceRecordUuid??null,message.sourceRecordTs??null,message.sourceIdentityKind??"none",message.sourceOrdinal!,message.recordKind!,message.dialogueSide??null,message.prose??null,message.eventTs??null,generation,message.contentDigest??null,message.contentBytes??0,contentTokens,message.sourceProsePresent?1:0) as {lastInsertRowid:number|bigint};
    const raw=Number(res.lastInsertRowid);ids.push(raw);
    for(const activity of message.toolActivities??[])tool.run(raw,activity.activityOrdinal,activity.activityKind,activity.toolName,null,activity.sourceActivityId,generation,activity.payloadDigest??null,activity.payloadBytes??0,activity.payloadTokenEstimate??estimateTokens(activity.toolText));
  }
  return ids;
}
function publishPreparedLogical(db:DB,sessionId:number,prepared:PreparedConstruction,generation:string,rawIds:number[],evidenceRuleVersion:string):void{
  db.prepare(`DELETE FROM logical_messages WHERE session_id=?`).run(sessionId);
  db.prepare(`DELETE FROM logical_metrics WHERE session_id=?`).run(sessionId);
  db.prepare(`DELETE FROM construction_metrics WHERE session_id=?`).run(sessionId);
  const logical=db.prepare(`INSERT INTO logical_messages(session_id,representative_message_id,logical_ordinal,logical_key,identity_kind,source_record_id,source_record_uuid,source_record_ts,member_count,replay_count,record_kind,dialogue_side,identity_status,construction_generation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const member=db.prepare(`INSERT INTO logical_message_members(logical_message_id,message_id,raw_ordinal,is_replay,construction_generation) VALUES (?,?,?,?,?)`);
  const evidence=db.prepare(`INSERT INTO replay_election_evidence(logical_record_id,evidence_rule_version,source_identity_kind,source_record_id,source_record_uuid,source_record_ts,representative_raw_record_id,construction_generation) VALUES (?,?,?,?,?,?,?,?)`);
  const electionMember=db.prepare(`INSERT INTO replay_election_members(logical_record_id,raw_record_id,member_ordinal,is_representative) VALUES (?,?,?,?)`);
  for(const item of prepared.logicalRecords){
    const representativeOrdinal=item.memberOrdinals[0];if(representativeOrdinal===undefined||rawIds[representativeOrdinal]===undefined)throw new Error(`prepared representative missing for session ${sessionId}`);
    const representative=rawIds[representativeOrdinal]!;
    const result=logical.run(sessionId,representative,item.logicalOrdinal,item.logicalKey,item.identityKind,item.sourceRecordId,item.sourceRecordUuid,item.sourceRecordTs,item.memberOrdinals.length,item.memberOrdinals.length-1,item.recordKind,item.dialogueSide,item.identityStatus,generation) as {lastInsertRowid:number|bigint};
    const logicalId=Number(result.lastInsertRowid);
    evidence.run(logicalId,evidenceRuleVersion,item.identityKind,item.sourceRecordId,item.sourceRecordUuid,item.sourceRecordTs,representative,generation);
    item.memberOrdinals.forEach((ordinal,index)=>{const rawId=rawIds[ordinal];if(rawId===undefined)throw new Error(`prepared member missing for session ${sessionId}`);member.run(logicalId,rawId,ordinal,index===0?0:1,generation);electionMember.run(logicalId,rawId,index,index===0?1:0);});
  }
  const lm=prepared.logicalMetrics,now=Date.now();
  db.prepare(`INSERT INTO logical_metrics(session_id,logical_tok_user,logical_tok_assistant,logical_tok_tool,logical_tool_call_count,logical_msg_count,logical_replay_count,logical_identity_count,logical_unknown_count,identity_status,computed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(sessionId,lm.tokUser,lm.tokAssistant,lm.tokTool,lm.toolActivityCount,lm.logicalRecordCount,lm.logicalReplayCount,lm.logicalIdentityCount,lm.logicalUnknownCount,lm.identityStatus,now);
  const cm=prepared.constructionMetrics;
  db.prepare(`INSERT INTO construction_metrics(session_id,construction_generation,raw_provenance_row_count,logical_record_count,raw_tool_activity_count,logical_tool_activity_count,raw_prose_bearing_record_count,logical_prose_bearing_record_count,dialogue_turn_count,user_dialogue_turn_count,assistant_dialogue_turn_count,logical_replay_count,unknown_identity_raw_row_count,computed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sessionId,generation,cm.rawProvenanceRowCount,cm.logicalRecordCount,cm.rawToolActivityCount,cm.logicalToolActivityCount,cm.rawProseBearingRecordCount,cm.logicalProseBearingRecordCount,cm.dialogueTurnCount,cm.userDialogueTurnCount,cm.assistantDialogueTurnCount,cm.logicalReplayCount,cm.unknownIdentityRawRowCount,now);
}
function publishWinner(db:DB,adapter:Adapter,winner:Candidate,record:IngestRecord,generation:string,reconciliationSourceId:number,faultAfterRaw:(()=>void)|undefined,candidates:Candidate[]):void{
  const draft=validateDraft(record,adapter.source);const now=Date.now(),agg=aggregate(record);
  const existing=db.prepare(`SELECT id FROM sessions WHERE harness=? AND native_id=?`).get(adapter.source,record.nativeId) as {id:number}|null;
  let sessionId:number;
  const selected=selectTitle(db,adapter.source,record.nativeId,draft.titleCandidates);
  if(existing){sessionId=existing.id;db.prepare(`UPDATE sessions SET project=?,original_project_key=?,canonical_project_key=?,project_key_rule_version=?,cwd=?,source_path=?,source_root=?,title=?,start_ts=?,end_ts=?,last_activity=?,duration_ms=?,models=?,tok_user=?,tok_assistant=?,tok_tool=?,msg_count=?,engagement=?,orphaned=0,transcript_bytes=?,parent_native_id=?,origin=?,origin_detail=?,ingested_at=?,artifact_kind=?,history_completeness=?,construction_generation=?,construction_status='invalid',construction_invalid_reason='publishing',default_session_visible=?,source_validation_status=?,source_observed_ts=? WHERE id=?`).run(record.project,draft.project.originalProjectKey,draft.project.canonicalProjectKey,draft.project.canonicalizationRuleVersion,record.cwd,winner.src.fullPath,winner.src.root,displayTitle(selected?.value),record.startTs,record.endTs,agg.lastActivity,agg.durationMs,JSON.stringify(record.models),agg.tokUser,agg.tokAssistant,agg.tokTool,record.messages.length,agg.engagement,record.transcriptBytes,record.parentNativeId??null,record.origin,record.originDetail??null,now,draft.artifactKind,draft.historyCompleteness,generation,draft.defaultSessionVisible?1:0,draft.sourceValidationStatus,draft.sourceObservedTs??winner.freshness.mtime,sessionId);clearConstruction(db,sessionId);}
  else{sessionId=Number((db.prepare(`INSERT INTO sessions(harness,native_id,project,original_project_key,canonical_project_key,project_key_rule_version,cwd,source_path,source_root,title,start_ts,end_ts,last_activity,duration_ms,models,tok_user,tok_assistant,tok_tool,msg_count,engagement,orphaned,transcript_bytes,parent_native_id,origin,origin_detail,ingested_at,artifact_kind,history_completeness,construction_generation,construction_status,construction_invalid_reason,default_session_visible,source_validation_status,source_observed_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'invalid','publishing',?,?,?)`).run(adapter.source,record.nativeId,record.project,draft.project.originalProjectKey,draft.project.canonicalProjectKey,draft.project.canonicalizationRuleVersion,record.cwd,winner.src.fullPath,winner.src.root,displayTitle(selected?.value),record.startTs,record.endTs,agg.lastActivity,agg.durationMs,JSON.stringify(record.models),agg.tokUser,agg.tokAssistant,agg.tokTool,record.messages.length,agg.engagement,0,record.transcriptBytes,record.parentNativeId??null,record.origin,record.originDetail??null,now,draft.artifactKind,draft.historyCompleteness,generation,draft.defaultSessionVisible?1:0,draft.sourceValidationStatus,draft.sourceObservedTs??winner.freshness.mtime) as {lastInsertRowid:number|bigint}).lastInsertRowid);}
  insertRaw(db,sessionId,record,generation);faultAfterRaw?.();
  rebuildLogicalMetrics(db,sessionId,generation,draft.replayRuleVersion);
  insertTitles(db,sessionId,generation,selected,draft.titleCandidates);
  syncContinuityEvidence(db,sessionId,record.continuityEvents??[],record.continuitySupport??adapter.continuitySupport??"unknown",generation);
  publishLineage(db,sessionId,adapter.source,record.parentNativeId??null,generation);
  updateCandidateCursors(db,adapter.source,candidates,generation);
  db.prepare(`UPDATE sessions SET construction_status='valid',construction_invalid_reason=NULL WHERE id=?`).run(sessionId);
  void reconciliationSourceId;
}
function clearConstruction(db:DB,sessionId:number):void{db.prepare(`DELETE FROM messages WHERE session_id=?`).run(sessionId);db.prepare(`DELETE FROM title_evidence WHERE session_id=?`).run(sessionId);db.prepare(`DELETE FROM lineage_claims WHERE session_id=?`).run(sessionId);}
function insertRaw(db:DB,sessionId:number,record:IngestRecord,generation:string):void{
 const insert=db.prepare(`INSERT INTO messages(session_id,ordinal,role,ts,text,tool_text,has_tool,tok_estimate,source_record_id,source_record_uuid,source_record_ts,source_identity_kind,source_ordinal,record_kind,dialogue_side,prose,event_ts,construction_generation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
 const tool=db.prepare(`INSERT INTO tool_activities(raw_record_id,activity_ordinal,activity_kind,tool_name,tool_text,source_activity_id,construction_generation) VALUES (?,?,?,?,?,?,?)`);
 for(const message of record.messages){const tools=message.toolActivities??[];const res=insert.run(sessionId,message.ordinal,message.role,message.ts,message.text,message.toolText,message.hasTool?1:0,estimateTokens(message.text)+estimateTokens(message.toolText),message.sourceRecordId??null,message.sourceRecordUuid??null,message.sourceRecordTs??null,message.sourceIdentityKind??"none",message.sourceOrdinal!,message.recordKind!,message.dialogueSide??null,message.prose??null,message.eventTs??null,generation) as {lastInsertRowid:number|bigint};const raw=Number(res.lastInsertRowid);for(const activity of tools)tool.run(raw,activity.activityOrdinal,activity.activityKind,activity.toolName,activity.toolText,activity.sourceActivityId,generation);}
}
/** Max code points in `sessions.title`, the list/display projection. */
export const TITLE_DISPLAY_MAX=240;
/**
 * `sessions.title` is a one-line display projection. Claude/Codex fall back to
 * the first user message (avg ~3 KB, up to 400 KB), which pushed every later
 * column onto overflow pages. The full selected title stays in title_evidence,
 * which search indexes and the preview strip reads.
 */
export function displayTitle(value:string|null|undefined):string|null{if(value==null)return null;const line=value.replace(/\s+/gu," ").trim();const points=[...line];return points.length<=TITLE_DISPLAY_MAX?line:points.slice(0,TITLE_DISPLAY_MAX).join("").trimEnd();}
function selectTitle(db:DB,harness:string,nativeId:string,candidates:NonNullable<IngestRecord["construction"]>["titleCandidates"]){const override=db.prepare(`SELECT value FROM atlas_title_overrides WHERE harness=? AND native_id=?`).get(harness,nativeId) as {value:string}|null;if(override&&override.value.trim())return {value:override.value,authority:"atlas_user_override" as const,harnessSourceClass:null,sourceRecordId:null,sourceReference:null,sourceOrdinal:null,eligibilityRuleVersion:"atlas-override-v1"};return candidates.find(candidate=>candidate.value.trim())??null;}
function insertTitles(db:DB,sessionId:number,generation:string,selected:ReturnType<typeof selectTitle>,candidates:NonNullable<IngestRecord["construction"]>["titleCandidates"]):void{db.prepare(`DELETE FROM title_evidence WHERE session_id=?`).run(sessionId);const insert=db.prepare(`INSERT INTO title_evidence(session_id,construction_generation,authority,harness_source_class,value,source_record_id,source_reference,source_ordinal,eligibility_rule_version,selected) VALUES (?,?,?,?,?,?,?,?,?,?)`);if(selected?.authority==="atlas_user_override")insert.run(sessionId,generation,selected.authority,null,selected.value,null,null,null,selected.eligibilityRuleVersion,1);for(const candidate of candidates)insert.run(sessionId,generation,candidate.authority,candidate.harnessSourceClass,candidate.value,candidate.sourceRecordId,candidate.sourceReference,candidate.sourceOrdinal,candidate.eligibilityRuleVersion,selected!==null&&selected.authority!=="atlas_user_override"&&candidate===selected?1:0);}
function publishLineage(db:DB,sessionId:number,harness:string,parentNativeId:string|null,generation:string):void{db.prepare(`DELETE FROM lineage_claims WHERE session_id=?`).run(sessionId);if(!parentNativeId)return;const parent=db.prepare(`SELECT id FROM sessions WHERE harness=? AND native_id=? AND orphaned=0 AND construction_status='valid'`).get(harness,parentNativeId) as {id:number}|null;const self=(db.prepare(`SELECT native_id FROM sessions WHERE id=?`).get(sessionId) as {native_id:string}).native_id;const status=parentNativeId===self?"invalid":parent?"resolved":"unresolved";db.prepare(`INSERT INTO lineage_claims(session_id,parent_harness,parent_native_id,resolution_status,resolution_reason,resolved_parent_session_id,construction_generation) VALUES (?,?,?,?,?,?,?)`).run(sessionId,harness,parentNativeId,status,status==="invalid"?"self_parent":status==="unresolved"?"missing_target":null,status==="resolved"?parent!.id:null,generation);}
function insertCandidateEvidence(db:DB,sourceRow:number,harness:string,candidates:Candidate[],winner:Candidate|null):void{const insert=db.prepare(`INSERT INTO session_candidate_evidence(reconciliation_source_id,harness,native_id,root_ordinal,rel_path,semantic_bytes,candidate_kind,semantic_byte_tie,elected,election_rule_version) VALUES (?,?,?,?,?,?,?,?,?,?)`);for(const candidate of candidates){const tied=candidates.some(other=>other!==candidate&&other.nativeId===candidate.nativeId&&other.semanticBytes===candidate.semanticBytes);insert.run(sourceRow,harness,candidate.nativeId,candidate.rootOrdinal,candidate.src.relPath,candidate.semanticBytes,candidate.src.candidateKind??"unknown",tied?1:0,candidate===winner?1:0,winner?"semantic-bytes-root-rel-v1":"incomplete-no-election-v1");}}
function updateCandidateCursors(db:DB,source:string,candidates:Candidate[],generation:string):void{const upsert=db.prepare(`INSERT INTO ingest_state(source,root,rel_path,offset,mtime,size,ingested_at,native_id,transcript_bytes,construction_generation,elected_semantic_bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,root,rel_path) DO UPDATE SET offset=excluded.offset,mtime=excluded.mtime,size=excluded.size,ingested_at=excluded.ingested_at,native_id=excluded.native_id,transcript_bytes=excluded.transcript_bytes,construction_generation=excluded.construction_generation,elected_semantic_bytes=excluded.elected_semantic_bytes`);for(const candidate of candidates)upsert.run(source,candidate.src.root,candidate.src.relPath,candidate.consumed,candidate.freshness.mtime,candidate.freshness.size,Date.now(),candidate.nativeId,candidate.semanticBytes,generation,candidates[0]!.semanticBytes);}
function persistRootResult(db:DB,sourceRow:number,root:RootWork):void{const reach=root.reachable?(root.unitErrors?"error":"reachable"):"unreachable";const error=root.errors.length?root.errors.slice(0,10).join("; "):null;db.prepare(`UPDATE reconciliation_roots SET reachability=?,finished_at=?,end_change_token=?,changed_during_walk=?,physical_unit_count=?,canonical_candidate_count=?,error=? WHERE id=?`).run(reach,Date.now(),root.endToken,root.changed===null?null:root.changed?1:0,root.physical,root.canonical,error,root.rowId);for(const reject of root.rejections)db.prepare(`INSERT INTO reconciliation_rejections(reconciliation_root_id,stable_unit_key,reason_code,detail) VALUES (?,?,?,?)`).run(root.rowId,stableUnitKey(root.ordinal,reject.src.relPath),reject.reason,reject.detail);db.prepare(`UPDATE ingest_runs SET finished_at=?,reachable=?,sessions_seen=?,bytes_consumed=?,error=? WHERE id=?`).run(Date.now(),root.reachable?1:0,root.canonical,root.bytes,error,root.legacyRunId);void sourceRow;}
function sourceFreshness(src:DiscoveredSource):{mtime:number;size:number}{if(src.freshness)return src.freshness;const stat=statSync(src.fullPath);return {mtime:Math.floor(stat.mtimeMs),size:stat.size};}
function stableUnitKey(rootOrdinal:number,rel:string):string{return createHash("sha256").update(`${rootOrdinal}\0${rel}`).digest("hex");}
export function computeRootChangeToken(root:string,sources:readonly DiscoveredSource[]=[]):string|null{try{const paths=[root,`${root}-wal`,...sources.flatMap(source=>[source.fullPath,`${source.fullPath}-wal`])];const items=paths.flatMap((path,index)=>{try{const s=statSync(path);return [[index,path,Math.floor(s.mtimeMs),s.size]];}catch{return [];}});const freshness=sources.map(source=>[source.relPath,source.freshness?.mtime??null,source.freshness?.size??null]);return items.length?createHash("sha256").update(JSON.stringify([items,freshness])).digest("hex"):null;}catch{return null;}}
function sourceRootIdentityError(root:string,config:Config,probe:VolumeIdentityProbe|undefined):string|null{try{assertMutablePath(root,config,probe);return null;}catch(error){if(!(error instanceof StorageIdentityError))throw error;return `volume identity mismatch (expected ${error.expected}, observed ${error.observed??"none"})`;}}
function aggregate(record:IngestRecord){let tokUser=0,tokAssistant=0,tokTool=0;for(const message of record.messages){if(message.recordKind==="real_user")tokUser+=estimateTokens(message.prose);else if(message.recordKind==="assistant_dialogue_prose")tokAssistant+=estimateTokens(message.prose);tokTool+=(message.toolActivities??[]).reduce((sum,tool)=>sum+estimateTokens(tool.toolText),0);}return {tokUser,tokAssistant,tokTool,engagement:engagementRatio({user:tokUser,assistant:tokAssistant,tool:tokTool}),durationMs:record.startTs!==null&&record.endTs!==null?record.endTs-record.startTs:null,lastActivity:record.endTs};}
function updateScheduleState(db:DB,config:Config,configPath:string,digest:string,trigger:ReconciliationTrigger,groupId:number):void{const t={...DEFAULT_TUNABLES,...config.tunables};for(const source of HARNESS_IDS){db.prepare(`INSERT INTO source_schedule_state(source,config_digest,expected_interval_ms,degraded_after_ms,stale_after_ms,target_config_path,target_db_path,last_scheduled_group_id,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(source) DO UPDATE SET config_digest=excluded.config_digest,expected_interval_ms=excluded.expected_interval_ms,degraded_after_ms=excluded.degraded_after_ms,stale_after_ms=excluded.stale_after_ms,target_config_path=excluded.target_config_path,target_db_path=excluded.target_db_path,last_scheduled_group_id=CASE WHEN ?='scheduled' THEN excluded.last_scheduled_group_id ELSE source_schedule_state.last_scheduled_group_id END,updated_at=excluded.updated_at`).run(source,digest,t.full_walk_interval_ms,t.full_walk_degraded_after_ms,t.full_walk_stale_after_ms,configPath,config.dbPath,trigger==="scheduled"?groupId:null,Date.now(),trigger);}}
function programmaticPlan(config:Config,source:string):SourceConfig {if(isHarness(source))return resolvedSourceConfig(config,source);const raw=(config.sources as unknown as Record<string,Partial<SourceConfig>|undefined>)[source];if(!raw)return {mode:"disabled",roots:[],disabledReason:"programmatic source omitted"};return {mode:raw.mode??"replace",roots:raw.roots??[],disabledReason:raw.mode==="disabled"?(raw.disabledReason??"programmatic source disabled"):null};}
function errorMessage(error:unknown):string{return error instanceof Error?error.message:String(error);}
function isHarness(value:string):value is HarnessId{return (HARNESS_IDS as readonly string[]).includes(value);}

export interface IngestOneOptions {storageProbe?:VolumeIdentityProbe;}
export async function ingestOne(db:DB,config:Config,harness:string,nativeId:string,options:IngestOneOptions={}):Promise<{found:boolean;sessionId:number|null}>{
 if(!isHarness(harness))return {found:false,sessionId:null};
 const adapter=ADAPTERS[harness],plan=resolvedSourceConfig(config,harness);
 if(plan.mode==="disabled")return {found:false,sessionId:null};
 const sidecarDir=defaultIngestSidecarRoot(config.dbPath);assertMutablePath(sidecarDir,config,options.storageProbe);ensureIngestSidecarRoot(sidecarDir);
 const started=Date.now();
 db.prepare(`INSERT INTO targeted_ingest_runs(source,harness,native_id,trigger_kind,started_at,status) VALUES (?,?,?,?,?,'running')`).run(harness,harness,nativeId,"hook",started);
 const run=Number((db.prepare(`SELECT last_insert_rowid() id`).get() as {id:number}).id);
 try{
  const discoveredRoots:Array<{ordinal:number;root:string;sources:DiscoveredSource[]}>=[];
  let allRootsReachable=true;
  // Discover every root first because adapter sidecar context may depend on
  // ordered peer roots (for example Codex title authority).
  for(const [ordinal,root] of plan.roots.entries()){
   try{
    if(sourceRootIdentityError(root,config,options.storageProbe)!==null){allRootsReachable=false;continue;}
    if(computeRootChangeToken(root)===null){allRootsReachable=false;continue;}
    discoveredRoots.push({ordinal,root,sources:adapter.discover([root])});
   }catch{allRootsReachable=false;}
  }
  const candidates:Candidate[]=[];
  for(const discovered of discoveredRoots){
   for(const source of discovered.sources){
    const withOrdinal={...source,rootOrdinal:discovered.ordinal};
    try{
     const resolved=resolveIngestSidecar({
      root:sidecarDir,
      adapter,
      source:withOrdinal,
      parse:()=>parseAdmission(adapter,withOrdinal),
      validate:record=>{validateIdentity(record,adapter.source);validateDraft(record,adapter.source);},
     });
     if(resolved.header.outcome.kind!=="admitted"||resolved.header.outcome.nativeId!==nativeId)continue;
     const summary=resolved.header.outcome;
     candidates.push({
      src:withOrdinal,
      rootOrdinal:discovered.ordinal,
      nativeId,
      semanticBytes:summary.semanticBytes,
      consumed:summary.consumed,
      freshness:sourceFreshness(withOrdinal),
      generation:summary.constructionGeneration,
      record:null,
      sidecar:resolved,
      prepared:resolved.prepared,
     });
    }catch{}
   }
  }
  if(!candidates.length){
   db.prepare(`UPDATE targeted_ingest_runs SET finished_at=?,status='complete' WHERE id=? AND status='running' AND finished_at IS NULL`).run(Date.now(),run);
   return {found:false,sessionId:null};
  }
  candidates.sort((a,b)=>b.semanticBytes-a.semanticBytes||a.rootOrdinal-b.rootOrdinal||a.src.relPath.localeCompare(b.src.relPath));
  const winner=candidates[0]!;
  const existing=db.prepare(`SELECT id,source_path FROM sessions WHERE harness=? AND native_id=?`).get(harness,nativeId) as {id:number;source_path:string}|null;
  if(existing&&!allRootsReachable&&existing.source_path!==winner.src.fullPath){
   db.prepare(`UPDATE sessions SET source_validation_status='snapshot_only' WHERE id=?`).run(existing.id);
   db.prepare(`UPDATE targeted_ingest_runs SET finished_at=?,status='complete' WHERE id=? AND status='running' AND finished_at IS NULL`).run(Date.now(),run);
   bumpLastWrite(db);return {found:true,sessionId:existing.id};
  }
  const prepared=loadOrRefreshTargetedCandidate(winner,adapter,sidecarDir);
  db.transaction(()=>publishPreparedWinner(db,adapter,winner,prepared,winner.generation,undefined,candidates))();
  assembleChains(db,harness);
  const row=db.prepare(`SELECT id FROM sessions WHERE harness=? AND native_id=?`).get(harness,nativeId) as {id:number};
  db.prepare(`UPDATE targeted_ingest_runs SET finished_at=?,status='complete' WHERE id=? AND status='running' AND finished_at IS NULL`).run(Date.now(),run);
  bumpLastWrite(db);return {found:true,sessionId:row.id};
 }
 catch(error){db.prepare(`UPDATE targeted_ingest_runs SET finished_at=?,status='failed',error=? WHERE id=? AND status='running' AND finished_at IS NULL`).run(Date.now(),errorMessage(error),run);return {found:false,sessionId:null};}finally{adapter.cleanup?.();}
}

function loadOrRefreshTargetedCandidate(candidate:Candidate,adapter:Adapter,sidecarDir:string):PreparedConstruction{
 if(candidate.prepared)return candidate.prepared;
 try{return loadPreparedConstruction(candidate.sidecar!);}
 catch(error){
  if(!(error instanceof InvalidIngestSidecarError))throw error;
  const refreshed=resolveIngestSidecar({
   root:sidecarDir,
   adapter,
   source:candidate.src,
   force:true,
   parse:()=>parseAdmission(adapter,candidate.src),
   validate:record=>{validateIdentity(record,adapter.source);validateDraft(record,adapter.source);},
  });
  if(refreshed.header.outcome.kind!=="admitted"||refreshed.header.outcome.nativeId!==candidate.nativeId)throw new Error("targeted sidecar recapture changed candidate identity");
  candidate.sidecar=refreshed;candidate.generation=refreshed.header.outcome.constructionGeneration;
  candidate.prepared=loadPreparedConstruction(refreshed);return candidate.prepared;
 }
}
