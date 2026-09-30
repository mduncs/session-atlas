import type { DB } from "./db/index.js";

interface SessionRow {
  id:number; native_id:string; parent_native_id:string|null; last_activity:number|null;
  tok_user:number; tok_assistant:number; tok_tool:number;
}
interface ClaimRow { session_id:number; parent_native_id:string; }

/**
 * Resolve source claims and republish deterministic, fully referenced chain
 * projections. Unresolved/invalid claims remain evidence with chain_id NULL.
 */
export function assembleChains(db:DB,harness:string):{chains:number;members:number}{
  const apply=()=>{
    const rows=db.prepare(`SELECT id,native_id,parent_native_id,last_activity,tok_user,tok_assistant,tok_tool FROM sessions WHERE harness=? AND orphaned=0 AND construction_status='valid' ORDER BY native_id`).all(harness) as SessionRow[];
    const byNative=new Map(rows.map(row=>[row.native_id,row]));
    // Backfill a claim for older current rows. Ingest normally writes this atomically.
    const insertClaim=db.prepare(`INSERT INTO lineage_claims(session_id,parent_harness,parent_native_id,resolution_status,resolution_reason,
      resolved_parent_session_id,construction_generation) VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      parent_harness=excluded.parent_harness,parent_native_id=excluded.parent_native_id,construction_generation=excluded.construction_generation`);
    for(const row of rows){
      if(!row.parent_native_id) continue;
      const gen=(db.prepare(`SELECT construction_generation FROM sessions WHERE id=?`).get(row.id) as {construction_generation:string}).construction_generation;
      insertClaim.run(row.id,harness,row.parent_native_id,"unresolved","awaiting_resolution",null,gen);
    }

    const claims=db.prepare(`SELECT lc.session_id,lc.parent_native_id FROM lineage_claims lc JOIN sessions s ON s.id=lc.session_id
      WHERE s.harness=? AND lc.parent_harness=?`).all(harness,harness) as ClaimRow[];
    const parentByChild=new Map<number,number>();
    const claimByChild=new Map(claims.map(claim=>[claim.session_id,claim]));
    for(const claim of claims){
      const child=rows.find(row=>row.id===claim.session_id);
      const parent=byNative.get(claim.parent_native_id);
      if(!child||!parent){ setClaim(db,claim.session_id,"unresolved","missing_target",null); continue; }
      if(parent.id===child.id){ setClaim(db,claim.session_id,"invalid","self_parent",null); continue; }
      parentByChild.set(child.id,parent.id);
    }
    // Any directed cycle invalidates every edge participating in it.
    const cycleMembers=new Set<number>();
    for(const start of parentByChild.keys()){
      const seen=new Map<number,number>(); let cur:number|undefined=start; let step=0;
      while(cur!==undefined){
        if(seen.has(cur)){ const from=seen.get(cur)!; for(const [id,pos] of seen) if(pos>=from) cycleMembers.add(id); break; }
        seen.set(cur,step++); cur=parentByChild.get(cur);
      }
    }
    for(const child of cycleMembers){ parentByChild.delete(child); setClaim(db,child,"invalid","cycle",null); }
    for(const [child,parent] of parentByChild) setClaim(db,child,"resolved",null,parent);

    db.prepare(`UPDATE sessions SET chain_id=NULL WHERE harness=?`).run(harness);
    const undirected=new Map<number,Set<number>>();
    for(const row of rows) undirected.set(row.id,new Set());
    for(const [child,parent] of parentByChild){undirected.get(child)!.add(parent);undirected.get(parent)!.add(child);}
    const groups:number[][]=[];const visited=new Set<number>();
    for(const row of rows){
      if(visited.has(row.id))continue; const stack=[row.id],group:number[]=[];visited.add(row.id);
      while(stack.length){const id=stack.pop()!;group.push(id);for(const next of undirected.get(id)??[]){if(!visited.has(next)){visited.add(next);stack.push(next);}}}
      if(group.length>1)groups.push(group);
    }
    const keepKeys:string[]=[];let members=0;
    for(const ids of groups){
      const set=new Set(ids); const component=rows.filter(row=>set.has(row.id));
      const roots=component.filter(row=>!parentByChild.has(row.id)).sort((a,b)=>a.native_id.localeCompare(b.native_id));
      const stableHead=(roots[0]??component.slice().sort((a,b)=>a.native_id.localeCompare(b.native_id))[0])!;
      const key=`lineage-v1:${harness}:${stableHead.native_id}`;keepKeys.push(key);
      const times=component.map(row=>row.last_activity).filter((value):value is number=>value!==null);
      const latest=component.slice().sort((a,b)=>(b.last_activity??-Infinity)-(a.last_activity??-Infinity)||a.native_id.localeCompare(b.native_id))[0]!;
      const tok=component.reduce((sum,row)=>sum+row.tok_user+row.tok_assistant+row.tok_tool,0);
      const existing = db.prepare(`SELECT id FROM chains WHERE stable_key=?`).get(key) as {id:number}|null;
      if (existing) db.prepare(`UPDATE chains SET harness=?,head_native_id=?,member_count=?,first_ts=?,last_ts=?,tok_total=?,head_session_id=? WHERE id=?`)
        .run(harness,stableHead.native_id,component.length,times.length?Math.min(...times):null,times.length?Math.max(...times):null,tok,latest.id,existing.id);
      else db.prepare(`INSERT INTO chains(stable_key,harness,head_native_id,member_count,first_ts,last_ts,tok_total,head_session_id) VALUES (?,?,?,?,?,?,?,?)`)
        .run(key,harness,stableHead.native_id,component.length,times.length?Math.min(...times):null,times.length?Math.max(...times):null,tok,latest.id);
      const chain=(db.prepare(`SELECT id FROM chains WHERE stable_key=?`).get(key) as {id:number}).id;
      const placeholders=ids.map(()=>"?").join(",");db.prepare(`UPDATE sessions SET chain_id=? WHERE id IN (${placeholders})`).run(chain,...ids);
      members+=ids.length;
    }
    if(keepKeys.length){const placeholders=keepKeys.map(()=>"?").join(",");db.prepare(`DELETE FROM chains WHERE harness=? AND stable_key NOT IN (${placeholders})`).run(harness,...keepKeys);}
    else db.prepare(`DELETE FROM chains WHERE harness=?`).run(harness);
    // Retire all pre-v11 garbage and any cross-harness dangling projection.
    db.prepare(`DELETE FROM chains WHERE stable_key IS NULL OR id NOT IN (SELECT DISTINCT chain_id FROM sessions WHERE chain_id IS NOT NULL)`).run();
    const mismatch=Number((db.prepare(`SELECT COUNT(*) n FROM chains c WHERE member_count<>(SELECT COUNT(*) FROM sessions s WHERE s.chain_id=c.id)`).get() as {n:number}).n);
    if(mismatch!==0)throw new Error(`chain projection count mismatch: ${mismatch}`);
    void claimByChild;
    return {chains:groups.length,members};
  };
  return db.inTransaction?apply():db.transaction(apply)();
}
function setClaim(db:DB,sessionId:number,status:"resolved"|"unresolved"|"invalid",reason:string|null,parent:number|null):void{
  db.prepare(`UPDATE lineage_claims SET resolution_status=?,resolution_reason=?,resolved_parent_session_id=? WHERE session_id=?`).run(status,reason,parent,sessionId);
}
