import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { CaptureCoordinator, discoverSources } from "../src/library/capture.js";
import { EvidenceStore, evidenceHash } from "../src/library/evidence.js";
import { parseExport, parseGeminiStream, parseOpenCodeSqlite, legacyAdapters } from "../src/library/adapters/index.js";
import { LibraryStore } from "../src/library/store.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "atlas-library-capture-"));
  const store = new LibraryStore(join(root, "library.db"));
  return { root, store, dispose() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
describe("isolated library capture", () => {
  test("known homes are proposals, not accepted sources", () => {
    const f = fixture(); try {
      mkdirSync(join(f.root, ".claude", "projects"), { recursive: true });
      mkdirSync(join(f.root, ".codex"));
      const found = discoverSources(f.root);
      expect(found.map(s => s.harness)).toEqual(["claude", "codex"]);
      expect(found.every(s => !s.enabled)).toBe(true);
      expect(f.store.sources()).toHaveLength(0);
      expect(Object.keys(legacyAdapters).sort()).toEqual(["claude", "codex", "hermes", "kilo", "kimi", "prime", "zcode"]);
    } finally { f.dispose(); }
  });
  test("retention preserves torn bytes, restart and missed append converge, missing root preserves history", async () => {
    const f = fixture(); try {
      const source = join(f.root, "claude"); mkdirSync(source);
      const path = join(source, "00000000-0000-4000-8000-000000000000.jsonl");
      const line = (uuid: string, value: string) => JSON.stringify({ type: "user", sessionId: "00000000-0000-4000-8000-000000000000", uuid, message: { role: "user", content: value }, timestamp: "2026-01-01T00:00:00Z" }) + "\n";
      const first = line("a", "Hello 世界"); writeFileSync(path, first + '{"type":');
      let capture = new CaptureCoordinator(f.store, join(f.root, "evidence"), { reserveBytes: 0 });
      capture.addSource({ harness: "claude", root: source });
      expect((await capture.reconcile()).failed).toBe(0);
      const observations = f.store.observations();
      expect(observations[0]!.retainedBoundary.bytes).toBe(Buffer.byteLength(first + '{"type":'));
      expect(observations[0]!.indexedBoundary!.bytes).toBe(Buffer.byteLength(first));
      expect(capture.evidence.read(observations[0]!.objectHash).toString()).toBe(first + '{"type":');
      writeFileSync(path, first + line("b", "Missed event append"));
      capture = new CaptureCoordinator(f.store, join(f.root, "evidence"), { reserveBytes: 0 });
      expect((await capture.reconcile(false)).failed).toBe(0);
      const key = { harness: "claude", nativeId: "00000000-0000-4000-8000-000000000000" };
      expect(f.store.read(key).passages.map(p => p.text)).toEqual(["Hello 世界", "Missed event append"]);
      const count = f.store.observations().length;
      await capture.reconcile(); expect(f.store.observations()).toHaveLength(count);
      rmSync(source, { recursive: true }); await capture.reconcile();
      expect(f.store.read(key).passages).toHaveLength(2);
      expect(f.store.sources()[0]!.reachable).toBe(false);
    } finally { f.dispose(); }
  });
  test("crash after retention permits retry; disk reserve never publishes", async () => {
    const f = fixture(); try {
      const path = join(f.root, "gemini.json"); writeFileSync(path, JSON.stringify({ sessionId: "g", projectHash: "project", messages: [{ id: "u", type: "user", content: "hello" }] }));
      let capture = new CaptureCoordinator(f.store, join(f.root, "evidence"), { reserveBytes: 0, afterRetention: () => { throw new Error("injected crash"); } });
      capture.addSource({ harness: "gemini", root: path });
      expect((await capture.reconcile()).failed).toBe(1);
      expect(f.store.observations()[0]!.indexedBoundary).toBeNull();
      capture = new CaptureCoordinator(f.store, join(f.root, "evidence"), { reserveBytes: 0 });
      expect((await capture.reconcile()).failed).toBe(0);
      writeFileSync(path, JSON.stringify({ sessionId: "g", projectHash: "project", messages: [{ type: "user", content: "new bytes" }] }));
      capture = new CaptureCoordinator(f.store, join(f.root, "evidence"), { reserveBytes: Number.MAX_SAFE_INTEGER });
      expect((await capture.reconcile()).failed).toBe(1);
      expect(f.store.read({ harness: "gemini", nativeId: "g" }).passages[0]!.text).toBe("hello");
    } finally { f.dispose(); }
  });
  test("SQLite retention includes active WAL without checkpointing source", () => {
    const f = fixture(); const path = join(f.root, "source.db");
    const db = new Database(path); try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('WAL visible')");
      const before = evidenceHash(readFileSync(path));
      const evidence = new EvidenceStore(join(f.root, "evidence"), 0);
      const bytes = evidence.snapshotSqlite(path); const snapshot = evidence.temporarySnapshot(bytes);
      const copy = new Database(snapshot.path, { readonly: true });
      expect(copy.query("SELECT value FROM sample").get()).toEqual({ value: "WAL visible" });
      copy.close(); snapshot.dispose(); expect(evidenceHash(readFileSync(path))).toBe(before);
    } finally { db.close(); f.dispose(); }
  });
  test("append manifests retain immutable prefix across revisions", () => {
    const f = fixture(); try {
      const e = new EvidenceStore(join(f.root, "evidence"), 0);
      const a = e.retain("s", "loc", Buffer.from("a\n"), "jsonl");
      const b = e.retain("s", "loc", Buffer.from("a\nb\n"), "jsonl", a);
      expect(b.append).toBe(true); expect(b.segments[0]).toEqual(a.segments[0]);
      expect(e.retain("s", "loc", Buffer.from("x\n"), "jsonl", b).append).toBe(false);
    } finally { f.dispose(); }
  });
});

describe("strict new harness shape fixtures (not upstream certification)", () => {
  test("consumer namespaces and ChatGPT branch authority", () => {
    const data = [{ id: "id", title: "test", current_node: "b", mapping: { a: { parent: null, message: null }, b: { parent: "a", message: { id: "m", author: { role: "user" }, content: { content_type: "text", parts: ["chosen"] } } }, c: { parent: "a", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["other branch"] } } } } }];
    expect(parseExport("chatgpt-export", Buffer.from(JSON.stringify(data)))[0]!.messages.map(m => m.text)).toEqual(["chosen"]);
    expect(parseExport("claude-export", Buffer.from(JSON.stringify([{ uuid: "c", chat_messages: [{ uuid: "m", sender: "human", text: "hello" }] }])))[0]!.messages[0]!.role).toBe("user");
    expect(() => parseExport("cursor-export", Buffer.from("arbitrary markdown"))).toThrow("Needs adapter update");
    expect(parseExport("cursor-export", Buffer.from("# Export\n\n**User**\nhello\n\n**Cursor**\nworld"))[0]!.messages).toHaveLength(2);
  });
  test("Gemini snapshot/stream rewind and unknown format rejection", () => {
    const events = [{ sessionId: "g", projectHash: "project" }, { id: "a", type: "user", content: "keep" }, { id: "b", type: "gemini", content: "rewound" }, { $rewindTo: "b" }];
    expect(parseGeminiStream(Buffer.from(events.map(e => JSON.stringify(e)).join("\n") + "\n"))[0]!.messages).toHaveLength(1);
    expect(() => parseExport("gemini", Buffer.from('{"messages":[]}'))).toThrow("Needs adapter update");
  });
  test("OpenCode native schema and export", () => {
    const f = fixture(); const path = join(f.root, "opencode.db"); const db = new Database(path);
    try {
      db.exec("CREATE TABLE session(id TEXT,title TEXT,directory TEXT); CREATE TABLE message(id TEXT,session_id TEXT,data TEXT,time_created INTEGER); CREATE TABLE part(id TEXT,message_id TEXT,data TEXT)");
      db.query("INSERT INTO session VALUES (?,?,?)").run("s", "Native", "/project");
      db.query("INSERT INTO message VALUES (?,?,?,?)").run("m", "s", JSON.stringify({ role: "user" }), 1);
      db.query("INSERT INTO part VALUES (?,?,?)").run("p", "m", JSON.stringify({ type: "text", text: "native exact" }));
      expect(parseOpenCodeSqlite(path)[0]!.messages[0]!.text).toBe("native exact");
      expect(parseExport("opencode", Buffer.from(JSON.stringify({ info: { id: "s" }, messages: [{ info: { id: "m", role: "user" }, parts: [{ type: "text", text: "export exact" }] }] })))[0]!.messages[0]!.text).toBe("export exact");
    } finally { db.close(); f.dispose(); }
  });
});

test("coordinator captures Hermes WAL sessions and serves user actions between units", async () => {
  const f = fixture(); const path = join(f.root, "state.db"); const db = new Database(path);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,parent_session_id TEXT,started_at REAL,ended_at REAL,model TEXT,cwd TEXT,git_repo_root TEXT,title TEXT,message_count INTEGER,archived INTEGER); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,tool_call_id TEXT,tool_calls TEXT,tool_name TEXT,timestamp REAL,platform_message_id TEXT,active INTEGER,compacted INTEGER)");
    for (let i = 0; i < 3; i++) {
      db.query("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(`s${i}`, "cli", null, null, null, "fixture", null, null, `title${i}`, 1, 0);
      db.query("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(i, `s${i}`, "user", `WAL user ${i}`, null, null, null, i, `m${i}`, 1, 0);
    }
    const capture = new CaptureCoordinator(f.store, join(f.root, "evidence"), { reserveBytes: 0 }); capture.addSource({ harness: "hermes", root: path });
    let serviced = false;
    setImmediate(() => { f.store.setState("user-action", "saved during capture"); serviced = true; });
    expect((await capture.reconcile()).failed).toBe(0);
    expect(serviced).toBe(true);
    expect(f.store.read({ harness: "hermes", nativeId: "s2" }).passages[0]!.text).toBe("WAL user 2");
  } finally { db.close(); f.dispose(); }
});
test("Gemini upstream metadata checkpoint, id replacement, and exclusive rewind", () => {
  const events = [{ sessionId: "native", projectHash: "project", startTime: "2026-01-01" }, { id: "m1", type: "user", content: "first" }, { id: "m1", type: "user", content: "updated" }, { $set: { summary: "Changed title", messages: [{ id: "m2", type: "gemini", content: "checkpoint" }] } }, { id: "m3", type: "user", content: "remove" }, { $rewindTo: "m3" }];
  const parsed = parseGeminiStream(Buffer.from(events.map(e => JSON.stringify(e)).join("\n") + "\n"))[0]!;
  expect(parsed.title).toBe("Changed title"); expect(parsed.messages.map(m => m.text)).toEqual(["checkpoint"]);
});


test("Claude native worker identity is separate and contradictory envelopes remain rejected", async () => {
  const f = fixture(); try {
    const source = join(f.root, "claude");
    const parent = "00000000-0000-4000-8000-000000000000";
    const workers = join(source, parent, "subagents"); mkdirSync(workers, { recursive: true });
    const line = (sessionId: string, agentId: string, isSidechain = true) => JSON.stringify({ type: "user", sessionId, agentId, isSidechain, uuid: agentId, message: { role: "user", content: "worker fixture" } }) + "\n";
    const path = join(workers, "agent-aexplore-p4-abc123.jsonl"); writeFileSync(path, line(parent, "aexplore-p4-abc123"));
    const capture = new CaptureCoordinator(f.store, join(f.root, "evidence"), { reserveBytes: 0 }); capture.addSource({ harness: "claude", root: source });
    expect((await capture.reconcile()).published).toBe(1);
    const key = { harness: "claude", nativeId: "agent-aexplore-p4-abc123" };
    expect(f.store.session(key)?.origin).toBe("worker");
    expect(f.store.session({ harness: "claude", nativeId: parent })).toBeNull();
    expect(f.store.read(key).passages[0]!.sessionKey).toEqual(key);
    writeFileSync(join(workers,"agent-rejected.jsonl"),line(parent,"wrong"));
    expect((await capture.reconcile()).failed).toBe(1);
    const retry=await capture.reconcile(); expect(retry.failed).toBe(1); expect(retry.unchanged).toBe(1); expect(retry.published).toBe(0);
    rmSync(join(workers,"agent-rejected.jsonl"));
    const adapter = legacyAdapters.claude!;
    for (const content of [line(parent, "wrong"), line("11111111-1111-4111-8111-111111111111", "aexplore-p4-abc123"), line(parent, "aexplore-p4-abc123", false), line(parent, "aexplore-p4-abc123") + line(parent, "wrong")]) {
      writeFileSync(path, content);
      const parsed = adapter.admit!(adapter.discover([source])[0]!);
      expect(parsed.admitted).toBe(false);
      if (!parsed.admitted) expect(parsed.reason).toBe("identity_mismatch");
    }
  } finally { f.dispose(); }
});

test("known auxiliary evidence is retained and excluded without claiming indexed coverage", async () => {
  const f = fixture(); try {
    const source = join(f.root, "claude"); mkdirSync(source);
    const bytes = JSON.stringify({ type: "started", workflow: "fixture" }) + "\n";
    writeFileSync(join(source, "journal.jsonl"), bytes);
    const prime = join(f.root, "prime"); mkdirSync(join(prime, "tmux-panes"), { recursive: true });
    writeFileSync(join(prime, "tmux-panes", "worker.jsonl"), JSON.stringify({ type: "agent_event" }) + "\n");
    const capture = new CaptureCoordinator(f.store, join(f.root, "evidence"), { reserveBytes: 0 });
    capture.addSource({ harness: "claude", root: source }); capture.addSource({ harness: "prime", root: prime });
    for (let i = 0; i < 2; i++) {
      expect((await capture.reconcile()).failed).toBe(0);
      expect(f.store.sources().every(item => item.error === null && item.lastCompleteReconciliation !== null)).toBe(true);
      expect(f.store.observations().map(item => item.admission?.reason).sort()).toEqual(["auxiliary_agent_artifact", "auxiliary_workflow"]);
      expect(f.store.observations().every(item => item.indexedBoundary === null)).toBe(true);
      expect(f.store.coverage().partial).toBe(false);
    }
    const journal = f.store.observations().find(item => item.locator.endsWith("journal.jsonl"))!;
    expect(capture.evidence.read(journal.objectHash).toString()).toBe(bytes);
    writeFileSync(join(source, "unknown.jsonl"), JSON.stringify({ type: "unrecognized" }) + "\n");
    expect((await capture.reconcile()).failed).toBe(1);
    expect(f.store.sources().find(item => item.harness === "claude")!.error).toContain("no_session_envelope");
    expect(f.store.coverage().partial).toBe(true);
  } finally { f.dispose(); }
});
