import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { primeAdapter } from "../src/adapters/prime.js";
import { zcodeAdapter, resetZcodeCache } from "../src/adapters/zcode.js";
import { hermesAdapter, resetHermesCache } from "../src/adapters/hermes.js";
import { kimiAdapter } from "../src/adapters/kimi.js";
import { runMigrations } from "../src/db/index.js";
import { ingest } from "../src/ingest.js";
import type { Config } from "../src/config.js";

const roots: string[] = [];
afterEach(() => { resetZcodeCache(); resetHermesCache(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function root(prefix: string): string { const value = mkdtempSync(join(tmpdir(), prefix)); roots.push(value); return value; }
function line(value: unknown): string { return `${JSON.stringify(value)}\n`; }
const tunables = { tag_promotion_count: 3, export_budget_tokens: 20_000, fav_default_span: 6, summary_stale_pct: 25, redact_entropy_threshold: 4.8 };

test("Prime uses embedded ids and only official RLM parentSession lineage", () => {
  const base = root("atlas-prime-");
  const sessions = join(base, "sessions");
  const childDir = join(base, "session-artifacts", "root-file-name", "sub-abcd1234");
  mkdirSync(sessions, { recursive: true }); mkdirSync(childDir, { recursive: true });
  const parent = join(sessions, "filename-does-not-own-id.jsonl");
  writeFileSync(parent,
    line({ type: "session", version: 3, id: "embedded-parent", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp/project", rlmDepth: 0 }) +
    line({ type: "model_change", id: "model-1", timestamp: "2026-01-01T00:00:01Z", provider: "openai", modelId: "gpt-fixture" }) +
    line({ type: "message", id: "u-1", timestamp: "2026-01-01T00:00:02Z", message: { role: "user", content: [{ type: "text", text: "sanitized root task" }] } }) +
    line({ type: "compaction", id: "compact-1", timestamp: "2026-01-01T00:00:03Z", summary: "sanitized compact summary" }),
  );
  const child = join(childDir, "also-not-the-embedded-id.jsonl");
  writeFileSync(child,
    line({ type: "session", version: 3, id: "embedded-child", timestamp: "2026-01-01T00:01:00Z", cwd: "/tmp/project", parentSession: parent, rlmDepth: 1 }) +
    line({ type: "session_info", id: "info-1", timestamp: "2026-01-01T00:01:01Z", name: "fixture-child" }) +
    line({ type: "custom_message", id: "task-1", timestamp: "2026-01-01T00:01:02Z", customType: "agent_message", content: "sanitized delegated task", details: { fromRelationship: "parent" } }) +
    line({ type: "message", id: "a-1", timestamp: "2026-01-01T00:01:03Z", message: { role: "assistant", model: "fixture-model", content: [{ type: "thinking", thinking: "excluded" }, { type: "text", text: "sanitized result" }] } }),
  );

  const found = primeAdapter.discover([base]);
  expect(found.map((item) => item.nativeId).sort()).toEqual(["embedded-child", "embedded-parent"]);
  const childRecord = primeAdapter.parse(found.find((item) => item.nativeId === "embedded-child")!).record;
  expect(childRecord.parentNativeId).toBe("embedded-parent");
  expect(childRecord.originDetail).toBe("prime:rlm-child:depth-1");
  expect(childRecord.title).toBe("fixture-child");
  expect(childRecord.messages.map((item) => item.text).filter(Boolean)).toEqual(["sanitized delegated task", "sanitized result"]);
  expect(childRecord.messages.some((item) => item.text?.includes("excluded"))).toBe(false);
  const parentRecord = primeAdapter.parse(found.find((item) => item.nativeId === "embedded-parent")!).record;
  expect(parentRecord.continuityEvents).toHaveLength(1);
  expect(parentRecord.models).toEqual(["gpt-fixture"]);
});

test("ZCode ingests SQLite sessions and bounded final external-agent turns", () => {
  const base = root("atlas-zcode-"); const cli = join(base, "cli"); const dbDir = join(cli, "db"); mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, "db.sqlite"); const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY,project_id TEXT,workspace_id TEXT,parent_id TEXT,slug TEXT,directory TEXT,path TEXT,title TEXT,version TEXT,time_created INTEGER,time_updated INTEGER,time_compacting INTEGER,time_archived INTEGER,task_type TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
  `);
  db.prepare(`INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("z-root","p",null,null,"s","/tmp/z",null,"Z fixture","1",1000,2000,null,null,"interactive");
  db.prepare(`INSERT INTO message VALUES (?,?,?,?,?)`).run("zm1","z-root",1000,1000,JSON.stringify({ role: "user", model: { modelID: "z-model" } }));
  db.prepare(`INSERT INTO part VALUES (?,?,?,?,?,?)`).run("zp1","zm1","z-root",1000,1000,JSON.stringify({ type: "text", text: "zcode fixture question" }));
  db.prepare(`INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("embedded-external","p",null,"parent-retired","s","/tmp/z",null,"DB-backed external fixture","1",1000,4000,null,null,"subagent_child");
  for (let index=0; index<4; index++) {
    db.prepare(`INSERT INTO message VALUES (?,?,?,?,?)`).run(`zem${index}`,"embedded-external",2000+index,2000+index,JSON.stringify({ role:index===0?"user":"assistant", modelID:"z-model" }));
    db.prepare(`INSERT INTO part VALUES (?,?,?,?,?,?)`).run(`zep${index}`,`zem${index}`,"embedded-external",2000+index,2000+index,JSON.stringify({ type:"text", text:`richer DB transcript ${index} ${"x".repeat(500)}` }));
  }
  db.close();
  const agentDir = join(cli,"agents","parent-retired","agent-fixture"); mkdirSync(agentDir,{recursive:true});
  writeFileSync(join(agentDir,"transcript.jsonl"),
    line({ id:"turn-start-id",sessionId:"embedded-external",turnId:"t",type:"turn_started",timestamp:"2026-01-01T00:00:00Z",payload:{input:"external fixture task"} }) +
    line({ id:"delta",sessionId:"embedded-external",turnId:"t",type:"model_streaming",timestamp:"2026-01-01T00:00:01Z",payload:{delta:"not duplicated"} }) +
    line({ id:"request",sessionId:"embedded-external",turnId:"t",type:"model_request",timestamp:"2026-01-01T00:00:01Z",payload:{model:{modelId:"external-model"}} }) +
    line({ id:"turn-end-id",sessionId:"embedded-external",turnId:"t",type:"turn_complete",timestamp:"2026-01-01T00:00:02Z",payload:{response:"external fixture result"} }),
  );
  const found = zcodeAdapter.discover([base]);
  expect(found.map((item) => item.nativeId).sort()).toEqual(["embedded-external","embedded-external","z-root"]);
  const externalSource = found.find((item) => item.nativeId === "embedded-external" && item.fullPath.endsWith(".jsonl"))!;
  const external = zcodeAdapter.parse(externalSource).record;
  expect(external.messages.map((item) => item.text)).toEqual([
    "external fixture task",
    null,
    null,
    "external fixture result",
  ]);
  expect(external.messages.map((item) => item.recordKind)).toEqual([
    "real_user",
    "control_context",
    "control_context",
    "assistant_dialogue_prose",
  ]);
  expect(external.messages.filter((item) => item.dialogueSide !== null).map((item) => item.text)).toEqual([
    "external fixture task",
    "external fixture result",
  ]);
  expect(external.models).toEqual(["external-model"]);
  expect(external.originDetail).toBe("zcode:external-agent-transcript");
  const rootRecord = zcodeAdapter.parse(found.find((item) => item.nativeId === "z-root")!).record;
  expect(rootRecord.messages[0]?.text).toBe("zcode fixture question");

  const atlas = new Database(join(base,"atlas.db")); runMigrations(atlas);
  const cfg: Config = { sources:{zcode:{roots:[base]}}, providers:[], launchers:[], tunables, dbPath:join(base,"atlas.db") };
  return ingest(atlas,cfg,{full:true}).then(() => {
    const winner=atlas.prepare(`SELECT source_path,msg_count FROM sessions WHERE harness='zcode' AND native_id='embedded-external'`).get() as {source_path:string;msg_count:number};
    expect(winner.source_path).toBe(dbPath); expect(winner.msg_count).toBe(4); atlas.close();
  });
});

test("Hermes reads state.db as immutable session units", () => {
  const base = root("atlas-hermes-"); const dbPath = join(base,"state.db"); const db = new Database(dbPath);
  db.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,parent_session_id TEXT,started_at REAL,ended_at REAL,model TEXT,cwd TEXT,git_repo_root TEXT,title TEXT,message_count INTEGER,archived INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,tool_call_id TEXT,tool_calls TEXT,tool_name TEXT,timestamp REAL,platform_message_id TEXT,active INTEGER,compacted INTEGER);`);
  db.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("h1","cli",null,1700000000,1700000001,"h-model","/tmp/h",null,"Hermes fixture",2,0);
  db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(1,"h1","user","hermes fixture question",null,null,null,1700000000,"platform-1",1,0);
  db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(2,"h1","assistant","hermes fixture response",null,null,null,1700000001,"platform-2",1,0); db.close();
  const source = hermesAdapter.discover([dbPath])[0]!; const record = hermesAdapter.parse(source).record;
  expect(record.nativeId).toBe("h1"); expect(record.models).toEqual(["h-model"]); expect(record.messages).toHaveLength(2); expect(record.origin).toBe("human");
});

test("Kimi contexts preserve explicit checkpoints and subagent path lineage", () => {
  const base = root("atlas-kimi-"); const parent = join(base,"workspace","kimi-parent"); const child = join(parent,"subagents","child-a"); mkdirSync(child,{recursive:true});
  writeFileSync(join(parent,"context.jsonl"), line({role:"user",content:"kimi parent fixture"}) + line({role:"_checkpoint",id:7}) + line({role:"assistant",content:[{type:"text",text:"kimi response"},{type:"think",think:"excluded"}]}));
  writeFileSync(join(parent,"state.json"),JSON.stringify({custom_title:"Kimi fixture"}));
  writeFileSync(join(child,"context.jsonl"),line({role:"user",content:"kimi child fixture"}));
  const found = kimiAdapter.discover([base]); expect(found.map((item)=>item.nativeId).sort()).toEqual(["kimi-parent","kimi-parent/subagent/child-a"]);
  const rootRecord = kimiAdapter.parse(found.find((item)=>item.nativeId==="kimi-parent")!).record;
  expect(rootRecord.title).toBe("Kimi fixture"); expect(rootRecord.continuityEvents).toHaveLength(1); expect(rootRecord.messages.map((item)=>item.text).filter(Boolean)).not.toContain("excluded");
  const childRecord = kimiAdapter.parse(found.find((item)=>item.nativeId.includes("subagent"))!).record;
  expect(childRecord.parentNativeId).toBe("kimi-parent"); expect(childRecord.origin).toBe("agent");
});

test("all added adapters reconcile idempotently through the production orchestrator", async () => {
  const base = root("atlas-added-ingest-"); const prime = join(base,"prime"); mkdirSync(join(prime,"sessions"),{recursive:true});
  writeFileSync(join(prime,"sessions","copy.jsonl"),line({type:"session",id:"p1",timestamp:"2026-01-01T00:00:00Z",cwd:"/tmp",rlmDepth:0})+line({type:"message",id:"m1",timestamp:"2026-01-01T00:00:01Z",message:{role:"user",content:"orchestrator fixture"}}));
  const kimi = join(base,"kimi"); mkdirSync(join(kimi,"workspace","k1"),{recursive:true}); writeFileSync(join(kimi,"workspace","k1","context.jsonl"),line({role:"user",content:"kimi orchestrator fixture"}));
  const atlas = new Database(join(base,"atlas.db")); runMigrations(atlas);
  const cfg: Config = { sources:{prime:{roots:[prime]},kimi:{roots:[kimi]}},providers:[],launchers:[],tunables,dbPath:join(base,"atlas.db") };
  const first = await ingest(atlas,cfg); const second = await ingest(atlas,cfg);
  expect(first.reduce((n,item)=>n+item.inserted,0)).toBe(2); expect(second.reduce((n,item)=>n+item.unchanged,0)).toBe(2);
  expect((atlas.prepare(`SELECT COUNT(*) n FROM sessions`).get() as {n:number}).n).toBe(2); atlas.close();
});


test("machine-readable coverage has no silent discovered-harness gaps and authorizes no consolidation action",()=>{
 const coverage=JSON.parse(readFileSync(join(import.meta.dir,"../harness-coverage.json"),"utf8")) as {harnesses:Array<Record<string,any>>};
 const byId=new Map(coverage.harnesses.map((item)=>[item.id,item]));
 for(const id of ["claude","codex","prime","hermes","kimi","zcode","kilo"]) expect(byId.get(id)?.status).toMatch(/supported_recording|historical_read_only/);
 expect(byId.get("prime-external-claude")?.requiredProvenance).toEqual({manager:"prime",runtime:"external/claude",native_prime_child:false,rlmParentSession:null});
 for(const id of ["opencode","aider","gemini-cli","goose","amp","cursor-cli"]) expect(byId.get(id)?.status).toBe("unsupported_no_source");
 // The owner's consolidation inventory is local-only; published copies omit it.
 const consolidationPath=join(import.meta.dir,"../archive-consolidation.json");
 if(!existsSync(consolidationPath)) return;
 const consolidation=JSON.parse(readFileSync(consolidationPath,"utf8")) as {actionAuthorized:boolean;retentionPolicyProposal:string[]};
 expect(consolidation.actionAuthorized).toBe(false);expect(consolidation.retentionPolicyProposal.join(" ")).toContain("Do not delete");
});
