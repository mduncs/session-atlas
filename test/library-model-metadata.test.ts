import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryStore } from "../src/library/store";
import { EvidenceStore } from "../src/library/evidence";
import { makePassage } from "../src/library/passages";
import { refreshCodexModelMetadata } from "../src/library/model-metadata";
test("versioned retained model-history refresh preserves exact refs and index rows without a current-model claim", async () => {
 const root=mkdtempSync(join(tmpdir(),"atlas-model-refresh-"));const store=new LibraryStore(join(root,"library.db"));
 try {
  const evidence=new EvidenceStore(join(root,"evidence"),0);
  const bytes=Buffer.from([{type:"session_meta",payload:{id:"child",model:"child-model",forked_from_id:"parent"}},{type:"session_meta",payload:{id:"parent",model:"ancestor-model"}},{type:"turn_context",payload:{model:"turn-model",model_provider:"not-a-model"}}].map(v=>JSON.stringify(v)).join("\n")+"\n");
  const retained=evidence.retain("codex","/readonly/source.jsonl",bytes,"jsonl");const key={harness:"codex",nativeId:"child"};const id="observed-model-source";const boundary={observationId:id,bytes:bytes.length,at:1};
  const passage=makePassage({sessionKey:key,observationId:id,record:"message",channel:"prose",text:"Exact 日本語 source",role:"user",ordinal:0,timestamp:1});
  store.publish({session:{key,revision:"unchanged-revision",title:"Child",origin:"human_started",originReason:"fixture",models:[],cwd:null,updatedAt:1},observation:{id,sourceId:"codex",locator:"/readonly/source.jsonl",objectHash:retained.hash,format:"jsonl",retainedBoundary:boundary,indexedBoundary:boundary,summaryCoverage:null,lastCompleteReconciliation:null,gaps:[]},passages:[passage]});
  const before=store.db.query("SELECT * FROM library_passages").all();
  expect(await refreshCodexModelMetadata(store,join(root,"evidence"))).toEqual({updated:1,unchanged:0,total:1});
  expect(store.session(key)?.models).toEqual(["child-model","ancestor-model","turn-model"]);
  expect(store.session(key)?.revision).toBe("unchanged-revision");expect(store.resolve(passage.ref).passage?.text).toBe(passage.text);
  expect(store.db.query("SELECT * FROM library_passages").all()).toEqual(before);
  expect(await refreshCodexModelMetadata(store,join(root,"evidence"))).toEqual({updated:0,unchanged:1,total:1});
  expect(evidence.read(retained.hash)).toEqual(bytes);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
