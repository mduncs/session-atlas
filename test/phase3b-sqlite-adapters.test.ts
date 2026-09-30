import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { hermesAdapter, hermesOpenSnapshotCount, resetHermesCache } from "../src/adapters/hermes.js";
import { zcodeAdapter, zcodeOpenSnapshotCount, resetZcodeCache } from "../src/adapters/zcode.js";
import { kiloAdapter, kiloOpenSnapshotCount, resetKiloCache } from "../src/adapters/kilo.js";
import type { DiscoveredSource, IngestRecord } from "../src/adapters/types.js";

const owned: string[] = [];
afterEach(() => {
  resetHermesCache(); resetZcodeCache(); resetKiloCache();
  while (owned.length) rmSync(owned.pop()!, { recursive: true, force: true });
});
function fixtureRoot(label: string): string { const path = mkdtempSync(join(tmpdir(), `atlas-phase3b-${label}-`)); owned.push(path); return path; }
function vector(record: IngestRecord): { G: number[]; X: number } {
  const rows = record.messages;
  const tools = rows.reduce((total, row) => total + (row.toolActivities?.length ?? 0), 0);
  const prose = rows.filter((row) => typeof row.prose === "string" && row.prose.length > 0).length;
  const user = rows.filter((row) => row.dialogueSide === "user").length;
  const assistant = rows.filter((row) => row.dialogueSide === "assistant").length;
  const unknown = rows.filter((row) => row.sourceIdentityKind === "none" || !row.sourceRecordId || row.sourceRecordTs === null || row.sourceRecordTs === undefined).length;
  return { G: [rows.length, rows.length, tools, tools, prose, prose, user + assistant, user, assistant, 0], X: unknown };
}
function expectVector(record: IngestRecord, G: number[], X: number): void { expect(vector(record)).toEqual({ G, X }); }
function jsonl(...rows: unknown[]): string { return rows.map((row) => JSON.stringify(row)).join("\n") + "\n"; }

function createHermes(path: string, wal = false): Database {
  const db = new Database(path);
  if (wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  db.exec(`
    CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,parent_session_id TEXT,started_at REAL,ended_at REAL,model TEXT,cwd TEXT,git_repo_root TEXT,title TEXT,message_count INTEGER,archived INTEGER);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,tool_call_id TEXT,tool_calls TEXT,tool_name TEXT,timestamp REAL,platform_message_id TEXT,active INTEGER,compacted INTEGER);
  `);
  return db;
}
function addHermesSession(db: Database, id: string, rows: Array<[string, string, number]>, title: string | null = null): void {
  db.prepare(`INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, "cli", null, null, null, "fixture-model", null, null, title, rows.length, 0);
  rows.forEach(([role, content, timestamp], index) => db.prepare(`INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(index + 1 + Number(id.endsWith("b")) * 100, id, role, content, null, null, null, timestamp, `${id}-platform-${index}`, 1, 0));
}

// F29-F30
 test("F29-F30 Hermes authoritative rows title fallback and honest one-sided dialogue", () => {
  const root = fixtureRoot("hermes"); const path = join(root, "state.db"); const db = createHermes(path);
  addHermesSession(db, "fixture-hermes-a", [["user", "fixture hermes task", 101], ["assistant", "fixture hermes result", 102]]);
  addHermesSession(db, "fixture-hermes-b", [["user", "fixture one-sided task", 103]]);
  db.close();
  try {
    const found = hermesAdapter.discover([path]);
    const a = hermesAdapter.parse(found.find((row) => row.nativeId === "fixture-hermes-a")!).record;
    const b = hermesAdapter.parse(found.find((row) => row.nativeId === "fixture-hermes-b")!).record;
    expectVector(a, [2, 2, 0, 0, 2, 2, 2, 1, 1, 0], 0);
    expectVector(b, [1, 1, 0, 0, 1, 1, 1, 1, 0, 0], 0);
    expect(a.title).toBe("fixture hermes task");
    expect(b).toMatchObject({ title: "fixture one-sided task", construction: { historyCompleteness: "complete", defaultSessionVisible: true } });
  } finally { resetHermesCache(); }
 });

function createZcode(path: string, wal = false): Database {
  const db = new Database(path);
  if (wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  db.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY,project_id TEXT,workspace_id TEXT,parent_id TEXT,slug TEXT,directory TEXT,path TEXT,title TEXT,version TEXT,time_created INTEGER,time_updated INTEGER,time_compacting INTEGER,time_archived INTEGER,task_type TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
  `);
  return db;
}
function addZSession(db: Database, id: string, title: string | null = null, parent: string | null = null, taskType = "interactive"): void {
  db.prepare(`INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, "fixture-project", null, parent, "fixture", null, null, title, "fixture-version", null, null, null, null, taskType);
}
function addZText(db: Database, sessionId: string, messageId: string, role: string, text: string, scalar: number): void {
  db.prepare(`INSERT INTO message VALUES (?,?,?,?,?)`).run(messageId, sessionId, scalar, scalar, JSON.stringify({ role, modelID: "fixture-model" }));
  db.prepare(`INSERT INTO part VALUES (?,?,?,?,?,?)`).run(`${messageId}-part`, messageId, sessionId, scalar, scalar, JSON.stringify({ type: "text", text }));
}
function addExternal(root: string, parent: string, agent: string, sessionId: string, user: string, assistant: string): string {
  const dir = join(root, "cli", "agents", parent, agent); mkdirSync(dir, { recursive: true });
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, jsonl(
    { id: `${sessionId}-turn-user`, sessionId, type: "turn_started", timestamp: 201, payload: { input: user } },
    { id: `${sessionId}-turn-assistant`, sessionId, type: "turn_complete", timestamp: 202, payload: { response: assistant } },
  ));
  return path;
}
function elect(candidates: Array<{ source: DiscoveredSource; record: IngestRecord }>): { source: DiscoveredSource; record: IngestRecord } {
  return candidates.sort((a, b) => b.record.transcriptBytes - a.record.transcriptBytes || (a.source.rootOrdinal ?? 0) - (b.source.rootOrdinal ?? 0) || a.source.relPath.localeCompare(b.source.relPath))[0]!;
}

// F37
 test("F37 ZCode exposes divergent DB/external semantic bytes without concatenation", () => {
  const root = fixtureRoot("z37"); const dbDir = join(root, "cli", "db"); mkdirSync(dbDir, { recursive: true }); const path = join(dbDir, "db.sqlite"); const db = createZcode(path);
  addZSession(db, "fixture-z37");
  addZText(db, "fixture-z37", "fixture-z37-m0", "user", "fixture database user prose with longer semantic content", 101);
  for (let index = 1; index < 4; index++) addZText(db, "fixture-z37", `fixture-z37-m${index}`, "assistant", `fixture database assistant prose ${index} with longer semantic content`, 101 + index);
  db.close();
  addExternal(root, "sess_fixture_parent", "fixture-agent", "fixture-z37", "fixture external task", "fixture external result");
  try {
    const candidates = zcodeAdapter.discover([root]).filter((row) => row.nativeId === "fixture-z37").map((source) => ({ source, record: zcodeAdapter.parse(source).record }));
    expect(candidates).toHaveLength(2);
    const winner = elect(candidates);
    expect(winner.source.candidateKind).toBe("zcode:sqlite-session");
    expectVector(winner.record, [4, 4, 0, 0, 4, 4, 4, 1, 3, 0], 0);
    expect(new Set(candidates.map((candidate) => candidate.record.transcriptBytes)).size).toBe(2);
  } finally { resetZcodeCache(); }
 });

test("ZCode external model and streaming envelopes remain bounded control raw records", () => {
  const root = fixtureRoot("z-control");
  const path = addExternal(root, "sess_fixture_parent", "fixture-agent", "fixture-z-control", "fixture control task", "fixture control result");
  const rows = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  rows.splice(1, 0,
    { id: "fixture-control-model", sessionId: "fixture-z-control", type: "model_request", timestamp: 211, payload: { model: { modelId: "fixture-model" } } },
    { id: "fixture-control-stream", sessionId: "fixture-z-control", type: "model_streaming", timestamp: 212, payload: { delta: "fixture excluded delta" } },
  );
  writeFileSync(path, jsonl(...rows));
  const record = zcodeAdapter.parse(zcodeAdapter.discover([root])[0]!).record;
  expectVector(record, [4, 4, 0, 0, 2, 2, 2, 1, 1, 0], 0);
  expect(record.messages.map((message) => message.recordKind)).toEqual(["real_user", "control_context", "control_context", "assistant_dialogue_prose"]);
  expect(record.messages.slice(1, 3).every((message) => message.prose === null)).toBe(true);
  expect(record.models).toEqual(["fixture-model"]);
 });

// F38
 test("F38 ZCode retains an external native parent claim when the target is absent", () => {
  const root = fixtureRoot("z38");
  addExternal(root, "sess_fixture_missing", "fixture-agent", "sess_fixture_child", "fixture child task", "fixture child result");
  const source = zcodeAdapter.discover([root])[0]!;
  const record = zcodeAdapter.parse(source).record;
  expectVector(record, [2, 2, 0, 0, 2, 2, 2, 1, 1, 0], 0);
  expect(record).toMatchObject({ parentNativeId: "sess_fixture_missing", origin: "agent", originDetail: "zcode:external-agent-transcript", construction: { sourceValidationStatus: "current" } });
 });

// F39
 test("F39 ZCode reachable replacement candidate preserves an honest user-only session", () => {
  const root = fixtureRoot("z39"); const dbDir = join(root, "cli", "db"); mkdirSync(dbDir, { recursive: true }); const path = join(dbDir, "db.sqlite"); const db = createZcode(path);
  addZSession(db, "fixture-z39"); addZText(db, "fixture-z39", "fixture-z39-message", "user", "fixture survivor task", 301); db.close();
  try {
    const record = zcodeAdapter.parse(zcodeAdapter.discover([root])[0]!).record;
    expectVector(record, [1, 1, 0, 0, 1, 1, 1, 1, 0, 0], 0);
    expect(record).toMatchObject({ nativeId: "fixture-z39", title: "fixture survivor task", construction: { sourceValidationStatus: "current", historyCompleteness: "complete" } });
  } finally { resetZcodeCache(); }
 });

// F40
 test("F40 ZCode exposes two candidates for each of six identities and stable semantic-byte winners", () => {
  const root = fixtureRoot("z40"); const dbDir = join(root, "cli", "db"); mkdirSync(dbDir, { recursive: true }); const path = join(dbDir, "db.sqlite"); const db = createZcode(path);
  for (let index = 0; index < 6; index++) {
    const id = `fixture-z40-${index}`; addZSession(db, id);
    addZText(db, id, `${id}-user`, "user", `fixture database user ${index} with deliberately longer semantic content`, 400 + index * 10);
    addZText(db, id, `${id}-assistant`, "assistant", `fixture database assistant ${index} with deliberately longer semantic content`, 401 + index * 10);
    addExternal(root, "sess_fixture_parent", `fixture-agent-${index}`, id, `fixture external user ${index}`, `fixture external assistant ${index}`);
  }
  db.close();
  try {
    const found = zcodeAdapter.discover([root]); expect(found).toHaveLength(12);
    const elected = [...new Set(found.map((source) => source.nativeId))].map((id) => elect(found.filter((source) => source.nativeId === id).map((source) => ({ source, record: zcodeAdapter.parse(source).record }))));
    expect(elected).toHaveLength(6);
    expect(elected.every((candidate) => candidate.source.candidateKind === "zcode:sqlite-session")).toBe(true);
    expect(elected.reduce((sum, candidate) => sum + vector(candidate.record).G[0]!, 0)).toBe(12);
    expect(elected.map((candidate) => candidate.source.relPath)).toEqual([...elected].map((candidate) => candidate.source.relPath));
  } finally { resetZcodeCache(); }
 });

function createKilo(path: string, wal = false): Database {
  const db = new Database(path);
  if (wal) db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
  db.exec(`
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,model TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,time_created INTEGER,data TEXT);
  `);
  return db;
}
function addKSession(db: Database, id: string, title: string | null = null, parent: string | null = null): void {
  db.prepare(`INSERT INTO session VALUES (?,?,?,?,?,?,?)`).run(id, null, title, "fixture-model", null, null, parent);
}
function addKMessage(db: Database, sessionId: string, messageId: string, role: string, scalar: number, parts: unknown[]): void {
  db.prepare(`INSERT INTO message VALUES (?,?,?,?)`).run(messageId, sessionId, scalar, JSON.stringify({ role, model: { modelID: "fixture-model" } }));
  parts.forEach((part, index) => db.prepare(`INSERT INTO part VALUES (?,?,?,?)`).run(`${messageId}-part-${index}`, messageId, scalar, JSON.stringify(part)));
}
function oneKiloRecord(setup: (db: Database) => string): IngestRecord {
  const root = fixtureRoot("kilo-one"); const path = join(root, "kilo.db"); const db = createKilo(path); const id = setup(db); db.close();
  const source = kiloAdapter.discover([path]).find((row) => row.nativeId === id)!;
  return kiloAdapter.parse(source).record;
}

// F41
 test("F41 Kilo generic tool part retains a tool-only carrier row", () => {
  const record = oneKiloRecord((db) => { addKSession(db, "fixture-k41"); addKMessage(db, "fixture-k41", "fixture-k41-message", "assistant", 501, [{ type: "tool", tool: "fixture-tool", state: { status: "completed", output: "fixture output" } }]); return "fixture-k41"; });
  expectVector(record, [1, 1, 1, 1, 0, 0, 0, 0, 0, 0], 0);
  expect(record.messages[0]).toMatchObject({ recordKind: "tool", hasTool: true, prose: null });
 });

// F42
 test("F42 Kilo generic tool coexists with one assistant prose turn", () => {
  const record = oneKiloRecord((db) => { addKSession(db, "fixture-k42"); addKMessage(db, "fixture-k42", "fixture-k42-message", "assistant", 502, [{ type: "text", text: "fixture assistant prose" }, { type: "tool", tool: "fixture-tool", state: { output: "fixture output" } }]); return "fixture-k42"; });
  expectVector(record, [1, 1, 1, 1, 1, 1, 1, 0, 1, 0], 0);
  expect(record.messages[0]).toMatchObject({ recordKind: "assistant_dialogue_prose", hasTool: true, prose: "fixture assistant prose" });
 });

// F43-F44
 test("F43-F44 Kilo parseable New session placeholders fall through for content and empty shells", () => {
  const root = fixtureRoot("kilo-title"); const path = join(root, "kilo.db"); const db = createKilo(path);
  const placeholder = "New session - 2000-01-01";
  addKSession(db, "fixture-k43", placeholder); addKMessage(db, "fixture-k43", "fixture-k43-u", "user", 503, [{ type: "text", text: "fixture title fallback" }]); addKMessage(db, "fixture-k43", "fixture-k43-a", "assistant", 504, [{ type: "text", text: "fixture title response" }]);
  addKSession(db, "fixture-k44", placeholder); db.close();
  try {
    const found = kiloAdapter.discover([path]); const content = kiloAdapter.parse(found.find((row) => row.nativeId === "fixture-k43")!).record; const shell = kiloAdapter.parse(found.find((row) => row.nativeId === "fixture-k44")!).record;
    expectVector(content, [2, 2, 0, 0, 2, 2, 2, 1, 1, 0], 0); expect(content.title).toBe("fixture title fallback");
    expectVector(shell, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0); expect(shell).toMatchObject({ title: null, construction: { artifactKind: "metadata_shell", defaultSessionVisible: false } });
  } finally { resetKiloCache(); }
 });

// F45 owner-private evidence reduced to an ordered structural run manifest:
// roles, part-type order, and serialized length buckets only; no source ids or values.
const F45_SHAPE_RUNS = [
  [1, "user", [["compaction", 6]], "unclassified"],
  [2, "assistant", [], "unclassified"],
  [1, "assistant", [["step-start", 4]], "unclassified"],
  [2, "assistant", [], "unclassified"],
  [3, "user", [["compaction", 6]], "unclassified"],
  [1, "assistant", [["step-start", 4], ["reasoning", 6]], "control_context"],
  [1, "user", [["compaction", 6]], "unclassified"],
  [1, "assistant", [["step-start", 4], ["reasoning", 12]], "control_context"],
  [1, "user", [["compaction", 6]], "unclassified"],
  [1, "assistant", [["step-start", 4], ["reasoning", 8]], "control_context"],
  [1, "user", [["compaction", 6]], "unclassified"],
  [1, "assistant", [], "unclassified"],
  [2, "user", [["compaction", 6]], "unclassified"],
  [1, "assistant", [], "unclassified"],
  [4, "user", [["compaction", 6]], "unclassified"],
  [1, "assistant", [["step-start", 4], ["reasoning", 13]], "control_context"],
  [3, "user", [["compaction", 6]], "unclassified"],
  [1, "assistant", [["patch", 8]], "unclassified"],
  [1, "assistant", [], "unclassified"],
  [1, "assistant", [["step-start", 6], ["reasoning", 12]], "control_context"],
  [2, "assistant", [["step-start", 4], ["reasoning", 5]], "control_context"],
  [1, "assistant", [["step-start", 4], ["reasoning", 11], ["text", 5]], "control_context"],
  [1, "assistant", [["step-start", 6], ["reasoning", 14], ["text", 5]], "control_context"],
  [5, "assistant", [["step-start", 4], ["reasoning", 5]], "control_context"],
  [1, "assistant", [["step-start", 4], ["reasoning", 12], ["text", 5]], "control_context"],
  [1, "assistant", [["step-start", 4], ["reasoning", 15], ["text", 5]], "control_context"],
  [2, "assistant", [["step-start", 4], ["reasoning", 5]], "control_context"],
  [2, "assistant", [["step-start", 4], ["reasoning", 10]], "control_context"],
  [1, "assistant", [], "unclassified"],
  [1, "user", [["compaction", 5]], "unclassified"],
  [1, "assistant", [["step-start", 4], ["reasoning", 11]], "control_context"],
  [1, "assistant", [], "unclassified"],
] as const;
function f45Part(type: string, bucket: number): Record<string, unknown> {
  const part: Record<string, unknown> = type === "text" ? { type, text: "" } : { type };
  let padding = 0;
  while (Math.floor(Math.log2(Buffer.byteLength(JSON.stringify(part)))) < bucket) part.fixture_padding = "x".repeat(++padding);
  if (Math.floor(Math.log2(Buffer.byteLength(JSON.stringify(part)))) !== bucket) throw new Error("fixture bucket construction failed");
  return part;
}

 test("F45 Kilo retains the exact 49-row structural order as control or fail-closed unknown", () => {
  const expectedClasses: string[] = [];
  const expectedBuckets: number[][] = [];
  const record = oneKiloRecord((db) => {
    addKSession(db, "fixture-k45");
    let index = 0;
    for (const [count, role, partShapes, recordKind] of F45_SHAPE_RUNS) {
      for (let occurrence = 0; occurrence < count; occurrence++) {
        const parts = partShapes.map(([type, bucket]) => f45Part(type, bucket));
        expectedBuckets.push(parts.map((part) => Math.floor(Math.log2(Buffer.byteLength(JSON.stringify(part))))));
        expectedClasses.push(recordKind);
        addKMessage(db, "fixture-k45", `fixture-k45-message-${index}`, role, 600 + index, parts);
        index++;
      }
    }
    return "fixture-k45";
  });
  expect(expectedClasses).toHaveLength(49);
  expectVector(record, [49, 49, 0, 0, 0, 0, 0, 0, 0, 0], 0);
  expect(record.messages.map((row) => row.recordKind)).toEqual(expectedClasses);
  expect(expectedBuckets).toEqual(F45_SHAPE_RUNS.flatMap(([count, , shapes]) => Array.from({ length: count }, () => shapes.map(([, bucket]) => bucket))));
 });

// F46
 test("F46 Kilo honest user-only dialogue retains assistant tool completion activity", () => {
  const record = oneKiloRecord((db) => { addKSession(db, "fixture-k46"); addKMessage(db, "fixture-k46", "fixture-k46-u", "user", 701, [{ type: "text", text: "fixture user-only task" }]); addKMessage(db, "fixture-k46", "fixture-k46-tool", "assistant", 702, [{ type: "tool", tool: "fixture-tool", state: { output: "fixture completion evidence" } }]); return "fixture-k46"; });
  expectVector(record, [2, 2, 1, 1, 1, 1, 1, 1, 0, 0], 0);
  expect(record.messages[1]).toMatchObject({ role: "assistant", recordKind: "tool", dialogueSide: null, hasTool: true });
 });

// F47
 test("F47 Kilo parent_id preserves resolved-edge evidence for parent and child", () => {
  const root = fixtureRoot("k47"); const path = join(root, "kilo.db"); const db = createKilo(path);
  addKSession(db, "fixture-k47-parent"); addKSession(db, "fixture-k47-child", null, "fixture-k47-parent");
  for (const id of ["fixture-k47-parent", "fixture-k47-child"]) { addKMessage(db, id, `${id}-u`, "user", 801, [{ type: "text", text: `fixture ${id} task` }]); addKMessage(db, id, `${id}-a`, "assistant", 802, [{ type: "text", text: `fixture ${id} result` }]); }
  db.close();
  try {
    const found = kiloAdapter.discover([path]); const parent = kiloAdapter.parse(found.find((row) => row.nativeId.endsWith("parent"))!).record; const child = kiloAdapter.parse(found.find((row) => row.nativeId.endsWith("child"))!).record;
    expectVector(parent, [2, 2, 0, 0, 2, 2, 2, 1, 1, 0], 0); expectVector(child, [2, 2, 0, 0, 2, 2, 2, 1, 1, 0], 0);
    expect(parent.origin).toBe("human"); expect(child).toMatchObject({ parentNativeId: "fixture-k47-parent", origin: "agent", originDetail: "kilo:parent_id" });
  } finally { resetKiloCache(); }
 });

function createKiloCopy(path: string, id: string): void {
  const db = createKilo(path); addKSession(db, id); addKMessage(db, id, `${id}-u`, "user", 901, [{ type: "text", text: "fixture tie task" }]); addKMessage(db, id, `${id}-a`, "assistant", 902, [{ type: "text", text: "fixture tie result" }]); db.close();
}

// F48
 test("F48 Kilo exact semantic ties expose ordered-root bookkeeping for historical and extend variants", () => {
  const root = fixtureRoot("k48");
  const historical = [0, 1, 2].map((index) => { const path = join(root, `historical-${index}.db`); createKiloCopy(path, "fixture-k48-a"); return path; });
  const extend = ["builtin", "retained"].map((name) => { const path = join(root, `${name}.db`); createKiloCopy(path, "fixture-k48-b"); return path; });
  try {
    const aCandidates = kiloAdapter.discover(historical).map((source) => ({ source, record: kiloAdapter.parse(source).record }));
    const bCandidates = kiloAdapter.discover(extend).map((source) => ({ source, record: kiloAdapter.parse(source).record }));
    expect(new Set(aCandidates.map((candidate) => candidate.record.transcriptBytes)).size).toBe(1);
    expect(new Set(bCandidates.map((candidate) => candidate.record.transcriptBytes)).size).toBe(1);
    expect(elect(aCandidates).source.rootOrdinal).toBe(0); expect(elect(bCandidates).source.rootOrdinal).toBe(0);
    expectVector(elect(aCandidates).record, [2, 2, 0, 0, 2, 2, 2, 1, 1, 0], 0); expectVector(elect(bCandidates).record, [2, 2, 0, 0, 2, 2, 2, 1, 1, 0], 0);
  } finally { resetKiloCache(); }
 });

function digest(path: string): string | null { return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null; }
function pair(path: string): [string | null, string | null] { return [digest(path), digest(`${path}-wal`)]; }

 test("DB adapters read WAL-visible snapshots without changing main/WAL bytes and release every handle", () => {
  const root = fixtureRoot("readonly-wal");
  const hermesPath = join(root, "hermes.db"); const hermesWriter = createHermes(hermesPath, true); addHermesSession(hermesWriter, "fixture-hermes-wal", [["user", "fixture wal task", 1001]]);
  const zcodePath = join(root, "zcode.db"); const zcodeWriter = createZcode(zcodePath, true); addZSession(zcodeWriter, "fixture-zcode-wal"); addZText(zcodeWriter, "fixture-zcode-wal", "fixture-zcode-wal-message", "user", "fixture wal task", 1002);
  const kiloPath = join(root, "kilo.db"); const kiloWriter = createKilo(kiloPath, true); addKSession(kiloWriter, "fixture-kilo-wal"); addKMessage(kiloWriter, "fixture-kilo-wal", "fixture-kilo-wal-message", "user", 1003, [{ type: "text", text: "fixture wal task" }]);
  try {
    const before = { hermes: pair(hermesPath), zcode: pair(zcodePath), kilo: pair(kiloPath) };
    expect(before.hermes[1]).not.toBeNull(); expect(before.zcode[1]).not.toBeNull(); expect(before.kilo[1]).not.toBeNull();
    const hermes = hermesAdapter.discover([hermesPath]); expect(hermesAdapter.parse(hermes[0]!).record.messages).toHaveLength(1);
    const zcode = zcodeAdapter.discover([zcodePath]); expect(zcodeAdapter.parse(zcode[0]!).record.messages).toHaveLength(1);
    const kilo = kiloAdapter.discover([kiloPath]); expect(kiloAdapter.parse(kilo[0]!).record.messages).toHaveLength(1);
    expect([hermesOpenSnapshotCount(), zcodeOpenSnapshotCount(), kiloOpenSnapshotCount()]).toEqual([1, 1, 1]);
    resetHermesCache(); resetZcodeCache(); resetKiloCache();
    expect([hermesOpenSnapshotCount(), zcodeOpenSnapshotCount(), kiloOpenSnapshotCount()]).toEqual([0, 0, 0]);
    expect({ hermes: pair(hermesPath), zcode: pair(zcodePath), kilo: pair(kiloPath) }).toEqual(before);
  } finally { hermesWriter.close(); zcodeWriter.close(); kiloWriter.close(); }
 });
