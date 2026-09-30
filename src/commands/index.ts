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
      healthy=summaries.filter(summary=>summary.mode!=="disabled").every(summary=>summary.uniqueIdentities!==null);
      const favorites=retryPendingFavorites(db,{defaultSpan:config.tunables.fav_default_span});
      if(favorites.materialized>0)process.stdout.write(`atlas index · materialized ${favorites.materialized} pending favorite(s)\n`);
      refreshLayers(db,dbPath,(line)=>process.stdout.write(`atlas index · ${line}\n`));
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
function formatMiB(bytes:number):string{return (bytes/(1024*1024)).toFixed(0);}
function printSummary(s:Awaited<ReturnType<typeof ingest>>[number]):void{
  if(s.mode==="disabled"){process.stdout.write(`atlas index · ${s.source} · [--] disabled · ${s.disabledReason}\n`);return;}
  const reachable=s.roots.filter(root=>root.reachable).length;
  const roots=s.roots.map(root=>root.reachable?`${root.root.replace(process.env.HOME??"~","~")} · physical ${root.physicalUnits} · canonical ${root.canonicalCandidates}${root.changedDuringWalk?" · changed during walk":""}`:`[unreachable] ${root.root}${root.error?`: ${root.error}`:""}`).join("\n    ");
  process.stdout.write([`atlas index · ${s.source} · physical ${s.physicalDiscoveredUnits} · canonical ${s.canonicalCandidates} · unique ${s.uniqueIdentities??"unknown"} · rejected ${s.rejectedUnits} · cache ${s.sidecarHits} hit/${s.sidecarMisses} miss · source parses ${s.sourceParses} · publication chunks ${s.publicationChunks} · +${s.inserted} new · ~${s.replaced} refreshed · ${s.derivedRepaired} derived repaired · ${s.unchanged} unchanged · ${s.orphans} orphaned · ${reachable}/${s.roots.length} roots · ${s.elapsedMs} ms`,`    ${roots}`].join("\n")+"\n");
}
