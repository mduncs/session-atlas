import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/db/index.js";
import { LATEST_SCHEMA_VERSION } from "../src/db/schema.js";
import { ingest } from "../src/ingest.js";
import type { Adapter, ContinuitySupport, IngestRecord } from "../src/adapters/types.js";
import type { Config } from "../src/config.js";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const tunables={tag_promotion_count:3,export_budget_tokens:20_000,fav_default_span:6,summary_stale_pct:25,redact_entropy_threshold:4.8};

function fixture(declared:ContinuitySupport){
 const root=mkdtempSync(join(tmpdir(),`atlas-derived-${declared}-`));roots.push(root);const source=join(root,"session.jsonl");
 writeFileSync(source,'{"durable":"source"}\n');
 let parses=0;
 const record:IngestRecord={nativeId:"native",cwd:root,project:"fixture",title:"fixture",startTs:1,endTs:2,models:[],transcriptBytes:statSync(source).size,origin:"human",originDetail:"fixture",continuitySupport:declared,messages:[{ordinal:0,sourceOrdinal:0,role:"user",ts:1,text:"durable raw message",toolText:null,hasTool:false,recordKind:"real_user",dialogueSide:"user",prose:"durable raw message",eventTs:1,toolActivities:[],sourceRecordId:"record-1",sourceRecordUuid:null,sourceRecordTs:1,sourceIdentityKind:"record-id"}],continuityEvents:declared==="supported"?[{kind:"compaction",sourceOrdinal:1,sourceRecordId:"compact-1",sourceRecordTs:2,sourceIdentityKind:"record-id",detail:"explicit"}]:[],construction:{artifactKind:"dialogue_history",historyCompleteness:"complete",defaultSessionVisible:true,sourceValidationStatus:"current",sourceObservedTs:null,project:{originalProjectKey:"fixture",canonicalProjectKey:"fixture",canonicalizationRuleVersion:"fixture-project-v1"},titleCandidates:[{value:"durable raw message",authority:"real_user_fallback",harnessSourceClass:"fixture-user",sourceRecordId:"record-1",sourceReference:"session.jsonl",sourceOrdinal:0,eligibilityRuleVersion:"fixture-title-v1"}],classificationRuleVersion:"fixture-class-v1",replayRuleVersion:"fixture-replay-v1"}};
 const adapter:Adapter={source:"fixture",continuitySupport:declared,discover:()=>[{root,relPath:"session.jsonl",fullPath:source,nativeId:"native"}],parse:()=>{parses++;return{record,consumed:statSync(source).size};}};
 const dbPath=join(root,"atlas.db");const db=new Database(dbPath);runMigrations(db);const config:Config={dbPath,sources:{fixture:{roots:[root]}},providers:[],launchers:[],tunables};
 return{root,source,db,config,adapter,parses:()=>parses};
}

function makePartial(db:Database,dirtyV9=false){
 const id=(db.prepare(`SELECT id FROM sessions WHERE harness='fixture'`).get() as {id:number}).id;
 db.exec(`DELETE FROM logical_message_members;DELETE FROM logical_messages;DELETE FROM logical_metrics;DELETE FROM continuity_projection;DELETE FROM continuity_evidence;`);
 db.prepare(`UPDATE continuity_state SET support='unknown',updated_at=0 WHERE session_id=?`).run(id);
 if(dirtyV9){
  db.exec(`ALTER TABLE logical_metrics DROP COLUMN logical_tool_call_count;UPDATE meta SET value='9' WHERE key='schema_version';`);
  runMigrations(db);
 }
 // Any core refresh would now fail the test. Derived-only repair must not touch
 // archived raw sessions/messages or their FTS content.
 db.exec(`CREATE TRIGGER forbid_session_update BEFORE UPDATE OF source_path,source_root,transcript_bytes,ingested_at ON sessions BEGIN SELECT RAISE(ABORT,'raw session rewrite');END;
          CREATE TRIGGER forbid_message_delete BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'raw message rewrite');END;
          CREATE TRIGGER forbid_message_update BEFORE UPDATE ON messages BEGIN SELECT RAISE(ABORT,'raw message rewrite');END;`);
 return id;
}

function sourceFingerprint(path:string){const st=statSync(path);return{bytes:readFileSync(path),size:st.size,mtime:st.mtimeMs,mode:st.mode&0o777};}

test("unchanged supported winner repairs exact partial projection without raw rewrite and is idempotent",async()=>{
 const f=fixture("supported");try{
  const first=await ingest(f.db,f.config,{adapters:{fixture:f.adapter}});expect(first[0]?.inserted).toBe(1);expect(f.parses()).toBe(1);
  const id=makePartial(f.db,true);expect((f.db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as {value:string}).value).toBe(String(LATEST_SCHEMA_VERSION));chmodSync(f.source,0o400);const before=sourceFingerprint(f.source);
  const second=await ingest(f.db,f.config,{adapters:{fixture:f.adapter}});
  expect(second[0]).toMatchObject({inserted:0,replaced:0,derivedRepaired:1,unchanged:0});expect(f.parses()).toBe(2);
  expect(f.db.prepare(`SELECT count(*) n FROM logical_metrics WHERE session_id=?`).get(id)).toEqual({n:1});
  expect(f.db.prepare(`SELECT support FROM continuity_state WHERE session_id=?`).get(id)).toEqual({support:"supported"});
  expect(f.db.prepare(`SELECT count(*) n FROM continuity_evidence WHERE session_id=?`).get(id)).toEqual({n:1});
  expect(f.db.prepare(`SELECT count(*) n FROM session_search_documents WHERE scope='dialogue'`).get()).toEqual({n:1});expect(sourceFingerprint(f.source)).toEqual(before);
  const lastWrite=(f.db.prepare(`SELECT value FROM meta WHERE key='last_write'`).get() as {value:string}).value;
  const third=await ingest(f.db,f.config,{adapters:{fixture:f.adapter}});
  expect(third[0]).toMatchObject({inserted:0,replaced:0,derivedRepaired:0,unchanged:1});expect(f.parses()).toBe(3);
  expect((f.db.prepare(`SELECT value FROM meta WHERE key='last_write'`).get() as {value:string}).value).toBe(lastWrite);expect(sourceFingerprint(f.source)).toEqual(before);
 }finally{f.db.close();}
});

test("unchanged known-unsupported winner repairs logically and marks capability without a source parse",async()=>{
 const f=fixture("unsupported");try{
  await ingest(f.db,f.config,{adapters:{fixture:f.adapter}});expect(f.parses()).toBe(1);const id=makePartial(f.db);chmodSync(f.source,0o400);const before=sourceFingerprint(f.source);
  const repaired=await ingest(f.db,f.config,{adapters:{fixture:f.adapter}});
  expect(repaired[0]).toMatchObject({inserted:0,replaced:0,derivedRepaired:1,unchanged:0});expect(f.parses()).toBe(2);
  expect(f.db.prepare(`SELECT support FROM continuity_state WHERE session_id=?`).get(id)).toEqual({support:"unsupported"});
  expect(f.db.prepare(`SELECT count(*) n FROM logical_metrics WHERE session_id=?`).get(id)).toEqual({n:1});expect(sourceFingerprint(f.source)).toEqual(before);
  const again=await ingest(f.db,f.config,{adapters:{fixture:f.adapter}});expect(again[0]?.derivedRepaired).toBe(0);expect(f.parses()).toBe(3);
 }finally{f.db.close();}
});

test("unknown-capability winner repairs only missing logical metrics without broadening parsing",async()=>{
 const f=fixture("unknown");try{
  await ingest(f.db,f.config,{adapters:{fixture:f.adapter}});const id=makePartial(f.db);const repaired=await ingest(f.db,f.config,{adapters:{fixture:f.adapter}});
  expect(repaired[0]?.derivedRepaired).toBe(1);expect(f.parses()).toBe(2);
  expect(f.db.prepare(`SELECT support FROM continuity_state WHERE session_id=?`).get(id)).toEqual({support:"unknown"});
 }finally{f.db.close();}
});
