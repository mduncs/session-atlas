import { join } from "node:path";
import { ingest } from "../ingest.js";
import { retryPendingFavorites } from "../favorites.js";
import { withConstructionCtx, hasFlag } from "./ctx.js";
import { HARNESS_IDS, resolvedSourceConfig } from "../config.js";
import type { VolumeIdentityProbe } from "../runtime/storage-identity.js";
import { isConstructionRefusal } from "../runtime/writer-coordinator.js";
import type { DB } from "../db/index.js";
import { refreshLayers } from "../layers/refresh.js";

export interface IndexCommandOptions { storageProbe?: VolumeIdentityProbe; }

export async function indexCmd(argv:string[],options:IndexCommandOptions={}):Promise<number>{
  const full=hasFlag(argv,"--full"),scheduled=hasFlag(argv,"--scheduled");let healthy=true;
  const operation=`atlas index${scheduled?" --scheduled":""}${full?" --full":""}`;
  try{
    await withConstructionCtx(argv,operation,async({db,config,configPath,dbPath})=>{
      const enabled=HARNESS_IDS.filter(source=>resolvedSourceConfig(config,source).mode!=="disabled").length;
      process.stdout.write(`${operation} · full reconciliation · ${enabled} enabled source(s) · provider-free\n`);
      const summaries=await ingest(db,config,{full,trigger:scheduled?"scheduled":"manual",configPath,storageProbe:options.storageProbe,onSourceComplete:printSummary,onProgress:progress=>process.stdout.write(`atlas index · ${progress.source} · ${progress.processed}/${progress.total} identities · rss ${formatMiB(process.memoryUsage().rss)} MiB…\n`)});
      const incomplete=summaries.filter(summary=>summary.mode!=="disabled"&&summary.uniqueIdentities===null);
      // A live root (the active Claude projects dir) often changes mid-walk. Everything seen was
      // published; only orphan marking waits for a stable walk, so that alone is not a failure.
      const churnOnly=incomplete.length>0&&incomplete.every(walkChurnOnly);
      healthy=incomplete.length===0||churnOnly;
      if(churnOnly)process.stdout.write(`atlas index · ${incomplete.map(summary=>summary.source).join(", ")} changed during walk · published, orphan marking deferred to the next run\n`);
      const favorites=retryPendingFavorites(db,{defaultSpan:config.tunables.fav_default_span});
      if(favorites.materialized>0)process.stdout.write(`atlas index · materialized ${favorites.materialized} pending favorite(s)\n`);
      if(scheduled&&!options.storageProbe)refreshLayersIsolated(configPath);
      else refreshLayers(db,dbPath,(line)=>process.stdout.write(`atlas index · ${line}\n`));
      const disabled=summaries.filter(summary=>summary.mode==="disabled");
      if(disabled.length)process.stdout.write(`atlas index · coverage intentionally partial · disabled: ${disabled.map(summary=>`${summary.source} (${summary.disabledReason})`).join(", ")}\n`);
    },{storageProbe:options.storageProbe});
  }catch(error){
    if(!isConstructionRefusal(error))throw error;
    process.stderr.write(`atlas index: ${error.message}\n`);
    return 1;
  }
  return healthy?0:1;
}
/**
 * Scheduled runs refresh layers in a child process. The walk leaves native
 * allocations the layers' JS heap cannot reuse, so in one process their peaks
 * add (about 1 GB on the live archive); the child starts clean and hands its
 * memory back on exit. A layer failure never fails ingest.
 */
function refreshLayersIsolated(configPath:string):void{
  try{
    Bun.gc(true);
    const child=Bun.spawnSync([process.execPath,"run",join(import.meta.dir,"..","cli.ts"),"layers","all","--config",configPath],{stdout:"inherit",stderr:"inherit"});
    if(child.exitCode!==0)process.stdout.write(`atlas index · layers skipped: exit ${child.exitCode}\n`);
  }catch(error){process.stdout.write(`atlas index · layers skipped: ${error instanceof Error?error.message:String(error)}\n`);}
}
export function walkChurnOnly(s:Awaited<ReturnType<typeof ingest>>[number]):boolean{
  return s.roots.length>0&&s.roots.every(root=>root.reachable&&!root.error&&(root.unitErrors??0)===0)&&s.roots.some(root=>root.changedDuringWalk===true);
}
function formatMiB(bytes:number):string{return (bytes/(1024*1024)).toFixed(0);}
function printSummary(s:Awaited<ReturnType<typeof ingest>>[number]):void{
  if(s.mode==="disabled"){process.stdout.write(`atlas index · ${s.source} · [--] disabled · ${s.disabledReason}\n`);return;}
  const reachable=s.roots.filter(root=>root.reachable).length;
  const roots=s.roots.map(root=>root.reachable?`${root.root.replace(process.env.HOME??"~","~")} · physical ${root.physicalUnits} · canonical ${root.canonicalCandidates}${root.changedDuringWalk?" · changed during walk":""}`:`[unreachable] ${root.root}${root.error?`: ${root.error}`:""}`).join("\n    ");
  process.stdout.write([`atlas index · ${s.source} · physical ${s.physicalDiscoveredUnits} · canonical ${s.canonicalCandidates} · unique ${s.uniqueIdentities??"unknown"} · rejected ${s.rejectedUnits} · cache ${s.sidecarHits} hit/${s.sidecarMisses} miss · source parses ${s.sourceParses} · publication chunks ${s.publicationChunks} · +${s.inserted} new · ~${s.replaced} refreshed · ${s.derivedRepaired} derived repaired · ${s.unchanged} unchanged · ${s.orphans} orphaned · ${reachable}/${s.roots.length} roots · ${s.elapsedMs} ms`,`    ${roots}`].join("\n")+"\n");
}
