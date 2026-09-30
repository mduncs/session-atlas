import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoOpenDbLeases, runMigrations } from "../src/db/index.js";
import { Database } from "bun:sqlite";
const roots:string[]=[];
afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});
test("connection leases reject live owners but do not confuse PID reuse for a live Atlas handle", async()=>{
 const root=mkdtempSync(join(tmpdir(),"atlas-lease-"));roots.push(root);const db=join(root,"atlas.db");const dir=`${db}.connections`;mkdirSync(dir);
 const stale=join(dir,`${process.pid}-stale`);writeFileSync(stale,"0\n");
 await assertNoOpenDbLeases(db);expect(existsSync(stale)).toBe(false);
 const permissionDeniedReuse=join(dir,"1-stale-root-owner");writeFileSync(permissionDeniedReuse,"0\n");
 await assertNoOpenDbLeases(db);expect(existsSync(permissionDeniedReuse)).toBe(false);
 const live=join(dir,`${process.pid}-live`);writeFileSync(live,`${Date.now()}\n`);
 expect(assertNoOpenDbLeases(db)).rejects.toThrow("1 open Atlas database handle");
});


test("v10 conditionally repairs dirty pre-release v9 table shapes",()=>{
 const root=mkdtempSync(join(tmpdir(),"atlas-v9-repair-"));roots.push(root);const db=new Database(join(root,"atlas.db"));
 db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version','9');
   CREATE TABLE logical_metrics(session_id INTEGER PRIMARY KEY,logical_tok_user INTEGER NOT NULL DEFAULT 0,logical_tok_assistant INTEGER NOT NULL DEFAULT 0,logical_tok_tool INTEGER NOT NULL DEFAULT 0,logical_msg_count INTEGER NOT NULL DEFAULT 0,logical_replay_count INTEGER NOT NULL DEFAULT 0,logical_identity_count INTEGER NOT NULL DEFAULT 0,logical_unknown_count INTEGER NOT NULL DEFAULT 0,identity_status TEXT NOT NULL DEFAULT 'partial',computed_at INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE ingest_state(source TEXT,root TEXT,rel_path TEXT,offset INTEGER,mtime INTEGER,size INTEGER,ingested_at INTEGER,native_id TEXT,PRIMARY KEY(source,root,rel_path));
   INSERT INTO ingest_state VALUES ('x','r','p',42,1,2,3,'n');`);
 runMigrations(db, 10);
 const metricColumns=(db.prepare(`PRAGMA table_info(logical_metrics)`).all() as Array<{name:string}>).map((row)=>row.name);
 const stateColumns=(db.prepare(`PRAGMA table_info(ingest_state)`).all() as Array<{name:string}>).map((row)=>row.name);
 expect(metricColumns).toContain("logical_tool_call_count");expect(stateColumns).toContain("transcript_bytes");
 expect((db.prepare(`SELECT transcript_bytes n FROM ingest_state`).get() as {n:number}).n).toBe(42);
 expect((db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as {value:string}).value).toBe("10");db.close();
});

test("v13 conditionally completes a partially materialized compact-evidence shape",()=>{
 const root=mkdtempSync(join(tmpdir(),"atlas-v13-repair-"));roots.push(root);const db=new Database(join(root,"atlas.db"));
 runMigrations(db,12);
 db.exec(`ALTER TABLE messages ADD COLUMN content_digest TEXT;`);
 runMigrations(db,13);
 const messages=new Set((db.prepare(`PRAGMA table_info(messages)`).all() as Array<{name:string}>).map(row=>row.name));
 const tools=new Set((db.prepare(`PRAGMA table_info(tool_activities)`).all() as Array<{name:string}>).map(row=>row.name));
 expect([...messages].filter(name=>name.startsWith("content_")||name==="source_prose_present").sort()).toEqual(["content_bytes","content_digest","content_token_estimate","source_prose_present"]);
 expect([...tools].filter(name=>name.startsWith("payload_")).sort()).toEqual(["payload_bytes","payload_digest","payload_token_estimate"]);
 const expectedIndexes=[
  "idx_continuity_projection_evidence",
  "idx_lineage_claims_resolved_parent",
  "idx_logical_messages_representative_message",
  "idx_replay_election_evidence_representative_raw",
  "idx_replay_election_members_raw",
  "idx_session_search_logical_record",
  "idx_session_search_representative_raw",
  "idx_session_tags_tag",
  "idx_source_schedule_last_group",
  "idx_summary_anchors_summary",
  "idx_tag_candidates_session",
 ];
 const indexes=new Set((db.prepare(`SELECT name FROM sqlite_schema WHERE type='index'`).all() as Array<{name:string}>).map(row=>row.name));
 for(const index of expectedIndexes)expect(indexes.has(index)).toBe(true);
 db.exec(`DROP INDEX idx_logical_messages_representative_message;`);
 runMigrations(db,13);
 expect((db.prepare(`SELECT 1 present FROM sqlite_schema WHERE type='index' AND name='idx_logical_messages_representative_message'`).get() as {present:number}|null)?.present).toBe(1);
 db.exec(`PRAGMA foreign_keys=ON;`);
 const messageDeletePlan=(db.prepare(`EXPLAIN QUERY PLAN DELETE FROM messages WHERE session_id='probe'`).all() as Array<{detail:string}>).map(row=>row.detail);
 const logicalDeletePlan=(db.prepare(`EXPLAIN QUERY PLAN DELETE FROM logical_messages WHERE session_id='probe'`).all() as Array<{detail:string}>).map(row=>row.detail);
 expect(messageDeletePlan.filter(detail=>detail.startsWith("SCAN "))).toEqual([]);
 expect(logicalDeletePlan.filter(detail=>detail.startsWith("SCAN "))).toEqual([]);
 expect((db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get() as {value:string}).value).toBe("13");db.close();
});
