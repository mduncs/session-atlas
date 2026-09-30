import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LibraryStore } from "../src/library/store";
import { CaptureCoordinator } from "../src/library/capture";
import { EvidenceStore } from "../src/library/evidence";
import { LibraryController } from "../src/library/terminal/controller";
import { LibraryService } from "../src/library/service";
import { exportUserData, importUserData, importLegacy, inventoryLegacy, prepareCutover, publishCutover, rollbackCutover } from "../src/library/migration";
import { importZip, zipCrc32 } from "../src/library/zip-import";
const synthetic = (words: string[]) => JSON.stringify({ sessionId: "s", projectHash: "p", messages: words.map((content, i) => ({ id: String(i), type: "user", content })) });
function fixture() { const dir = mkdtempSync(join(tmpdir(), "atlas-integrated-")); const store = new LibraryStore(join(dir, "library.db")); return { dir, store, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } }; }
test("shared service cursor reader keeps exact cross-page selection, hit context and conflicting copies", async () => {
  const f = fixture();
  try {
    const source = join(f.dir, "gemini.json"); const words = Array.from({ length: 150 }, (_, i) => `message ${i} 日本語`); writeFileSync(source, synthetic(words));
    const capture = new CaptureCoordinator(f.store, join(f.dir, "evidence"), { reserveBytes: 0 }); capture.addSource({ harness: "gemini", root: source }); await capture.reconcile();
    const session = f.store.list().sessions[0]!; const c = new LibraryController(f.store); c.open(session);
    c.top = c.lines.findIndex(l => l.passage === 63 && !l.header); c.select(0, 0);
    c.scroll(c.lines.length); c.top = c.lines.findIndex(l => l.passage === 0 && !l.header); c.select(0, 7, true);
    expect(c.selectedText()).toBe(words[63] + "\n\nmessage");
    const receipt = f.store.saveFavorite({ sessionKey: session.key, refs: c.selectedRefs() }); expect(receipt.text).toBe(c.selectedText());
    const hit = f.store.search("message 80").hits[0]!; c.open(hit.session, hit.passage!.ref); c.scroll(-100); expect(c.page!.passages[0]!.ordinal).toBeLessThan(80);
    while (c.page!.nextCursor) c.scroll(c.lines.length + 1); expect(c.page!.passages.at(-1)!.text).toBe(words[149]);
    const beforeCopies=f.store.db.query("SELECT count(*) n FROM library_passages").get();
    const exactCopy=join(f.dir,"exact-copy.json");writeFileSync(exactCopy,synthetic(words));capture.addSource({harness:"gemini",root:exactCopy});await capture.reconcile();
    expect(f.store.db.query("SELECT count(*) n FROM library_passages").get()).toEqual(beforeCopies);
    expect(f.store.observations().find(o=>o.locator===exactCopy)?.indexedVia).toBeDefined();
    expect(f.store.resolve(hit.passage!.ref).passage!.text).toBe(words[80]);
    const olderCopy=join(f.dir,"older-copy.json");writeFileSync(olderCopy,synthetic(words.slice(0,80)));capture.addSource({harness:"gemini",root:olderCopy});await capture.reconcile();
    expect(f.store.db.query("SELECT count(*) n FROM library_passages").get()).toEqual(beforeCopies);
    expect(f.store.read(session.key).session.passageCount).toBe(150);
    const alias = join(f.dir, "copy.json"); writeFileSync(alias, synthetic(["divergent copy"])); capture.addSource({ harness: "gemini", root: alias }); await capture.reconcile();
    expect(f.store.search("message 80").hits).toHaveLength(1); const variant = f.store.search("divergent copy").hits[0]!; expect(variant.session.key.variant).toBeDefined(); expect(f.store.resolve(variant.passage!.ref).passage!.text).toBe("divergent copy"); expect(f.store.coverage().limitations.join()).toContain("variant");
    const service = new LibraryService(f.store); const read = service.execute({ operation: "read", args: { ref: hit.passage!.ref, before: 0, after: 0 } }) as { context: { passages: unknown[] } }; expect(read.context.passages).toHaveLength(1);
  } finally { f.close(); }
});
test("append retention grows by new bytes and reconstructs each revision", () => {
  const f = fixture(); try {
    const evidence = new EvidenceStore(join(f.dir, "segments"), 0); let previous; let source = Buffer.alloc(0);
    const revisions: { hash: string; bytes: Buffer }[] = [];
    for (let i = 0; i < 20; i++) { source = Buffer.concat([source, Buffer.alloc(10000, i + 32)]); previous = evidence.retain("s", "source", source, "jsonl", previous); revisions.push({ hash: previous.hash, bytes: source }); }
    const stored = readdirSync(join(evidence.directory, "objects")).reduce((n, file) => n + statSync(join(evidence.directory, "objects", file)).size, 0);
    expect(stored).toBeLessThanOrEqual(source.length); for (const r of revisions) expect(evidence.read(r.hash)).toEqual(r.bytes);
  } finally { f.close(); }
});
test("legacy favorite bytes and journal deletion/undo survive shadow cutover and rollback", () => {
  const f = fixture(); const old = new LibraryStore(join(f.dir, "old.db"));
  try {
    const legacyPath = join(f.dir, "legacy.db"); const legacy = new Database(legacyPath); legacy.exec("CREATE TABLE sessions(id INTEGER PRIMARY KEY,harness TEXT,native_id TEXT); CREATE TABLE favorites(id INTEGER PRIMARY KEY,harness TEXT,native_id TEXT,span_text TEXT,topic TEXT,created_at INTEGER); INSERT INTO sessions VALUES(1,'claude','old');");
    legacy.query("INSERT INTO favorites VALUES(1,'claude','old',?,'note',1)").run("exact 日本語\n\n    stored bytes"); legacy.close(); const original = readFileSync(legacyPath);
    const receipt = importLegacy(f.store, inventoryLegacy(legacyPath)); expect(receipt.importedFavorites).toBe(1); expect(f.store.favorites()[0]!.text).toBe("exact 日本語\n\n    stored bytes"); expect(f.store.favorites()[0]!.unresolved).toBe(true); expect(readFileSync(legacyPath)).toEqual(original);
    importUserData(old, exportUserData(f.store)); const pointer = join(f.dir, "pointer.json"); writeFileSync(pointer, JSON.stringify({ database: old.path }));
    const prepared = prepareCutover(pointer, f.store, join(f.dir, "receipts")); expect(JSON.parse(readFileSync(pointer, "utf8")).database).toBe(old.path);
    const published = publishCutover(prepared, join(f.dir, "receipts")); expect(JSON.parse(readFileSync(pointer, "utf8")).database).toBe(f.store.path);
    f.store.removeFavorite(f.store.favorites()[0]!.id); const result = rollbackCutover(published, join(f.dir, "receipts")); expect(result.receipt.state).toBe("rolled-back"); expect(old.favorites()).toHaveLength(0); expect(JSON.parse(readFileSync(pointer, "utf8")).database).toBe(old.path); expect(readFileSync(legacyPath)).toEqual(original);
  } finally { old.close(); f.close(); }
});
function zipMember(name: string, content: string): Buffer {
  const n = Buffer.from(name), body = Buffer.from(content); const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(zipCrc32(body), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(zipCrc32(body), 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(n.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + n.length, 12); end.writeUInt32LE(local.length + n.length + body.length, 16);
  return Buffer.concat([local, n, body, central, n, end]);
}
test("consumer ZIP imports retained extracted content and rejects path traversal", async () => {
  const f = fixture(); try {
    const archive = join(f.dir, "export.zip"); const content = JSON.stringify([{ id: "chat", title: "Exported", current_node: "u", mapping: { u: { parent: null, message: { author: { role: "user" }, content: { content_type: "text", parts: ["zip exact dialogue"] } } } } }]);
    writeFileSync(archive, zipMember("conversations.json", content)); const imported = importZip(archive, join(f.dir, "inbox")); expect(readFileSync(join(imported.root, "conversations.json"), "utf8")).toBe(content);
    const capture = new CaptureCoordinator(f.store, join(f.dir, "evidence"), { reserveBytes: 0 }); capture.addSource({ harness: "chatgpt-export", root: imported.root, capability: "import" }); const result = await capture.reconcile(); expect(result.failed).toBe(0); expect(f.store.search("zip exact").hits).toHaveLength(1);
    const corrupt = zipMember("bad.json", "content"); corrupt[38] = 88; writeFileSync(archive, corrupt); expect(() => importZip(archive, join(f.dir, "inbox"))).toThrow("CRC32");
    writeFileSync(archive, zipMember("../escape.json", "[]")); expect(() => importZip(archive, join(f.dir, "inbox"))).toThrow("unsafe ZIP");
  } finally { f.close(); }
});
test("shared processing controls operate the UI coordinator namespace without dispatch", () => {
  const f = fixture(); try {
    f.store.setState("provider-profile", { id: "test", mode: "local", endpoint: "http://127.0.0.1:9/v1", model: "test-exact-model", allowedHarnesses: ["gemini"], allowedRoles: ["user", "assistant"], redaction: "standard", maxInputTokens: 2000, maxOutputTokens: 500, runTokenCap: 2500, dailyTokenCap: 2500, concurrency: 1 });
    const service = new LibraryService(f.store);
    service.execute({ operation: "processing.pause" }); expect(f.store.getState<{ paused: boolean }>("librarians:test")!.paused).toBe(true);
    const status = service.execute({ operation: "processing.inspect" }) as { state: { paused: boolean; jobs: unknown } }; expect(status.state.paused).toBe(true); expect(status.state.jobs).toEqual({});
    service.execute({ operation: "processing.resume" }); expect(f.store.getState<{ paused: boolean }>("librarians:test")!.paused).toBe(false);
  } finally { f.close(); }
});
test("bounded capture stages invisibly, prioritizes user writes and resumes cancelled revisions", async () => {
  const f = fixture(); const second = new LibraryStore(f.store.path);
  try {
    const source = join(f.dir, "bounded.json"); writeFileSync(source, synthetic(["old complete history"]));
    const capture = new CaptureCoordinator(f.store, join(f.dir, "evidence"), { reserveBytes: 0 }); capture.addSource({ harness: "gemini", root: source }); await capture.reconcile();
    const session = f.store.list().sessions[0]!; const original = f.store.read(session.key).passages[0]!;
    const { makePassage, hashText } = await import("../src/library/passages"); const observation = { ...f.store.observations()[0]!, id: hashText("bounded-next"), locator: source };
    observation.retainedBoundary = { ...observation.retainedBoundary, observationId: observation.id };
    const passages = Array.from({ length: 2048 }, (_, ordinal) => makePassage({ ...original, startByte: 0, endByte: undefined, observationId: observation.id, record: `record:${ordinal}`, ordinal, text: `new stage ${ordinal} 日本語` }));
    const input = { session: { ...session, revision: "next-complete" }, observation, passages };
    const abort = new AbortController(); let committed = false;
    await expect(f.store.publishBounded(input, { signal: abort.signal, afterChunk: count => {
      expect(count).toBeLessThanOrEqual(64); expect(second.search("new stage").hits).toHaveLength(0); expect(second.read(session.key).passages[0]!.text).toBe("old complete history");
      second.saveFavorite({ sessionKey: session.key, refs: [original.ref], idempotencyKey: "during-stage" }); committed = true; abort.abort();
    } })).rejects.toThrow("cancelled");
    expect(committed).toBe(true); expect(second.favorites()[0]!.text).toBe("old complete history"); expect(second.search("new stage").hits).toHaveLength(0);
    await f.store.publishBounded(input); expect(second.read(session.key).session.passageCount).toBe(2048); expect(second.search("new stage 2047").hits).toHaveLength(1); expect(second.resolve(original.ref).status).toBe("pinned"); expect(second.favorites()[0]!.text).toBe("old complete history");
  } finally { second.close(); f.close(); }
});
