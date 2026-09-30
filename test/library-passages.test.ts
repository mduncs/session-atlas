import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryStore } from "../src/library/store.js";
import { makePassage, selectPassage, hashText } from "../src/library/passages.js";
import type { CapturedSession } from "../src/library/contracts.js";
function fixture(text = "first\n\n    code 日本語 👨‍👩‍👧‍👦", revision = "r1"): CapturedSession {
  const key = { harness: "claude", nativeId: "stable" }; const observationId = hashText(revision);
  const passages = [makePassage({ sessionKey: key, observationId, record: "raw:8", channel: "prose", text, role: "user", ordinal: 8, timestamp: null })];
  return { session: { key, revision, title: "Technical human discussion", origin: "unknown", originReason: "no orchestration evidence", models: [], cwd: "/unrelated", updatedAt: 1 }, observation: { id: observationId, sourceId: "test", locator: "/synthetic", objectHash: observationId, format: "fixture", retainedBoundary: { observationId, bytes: 1, at: 1 }, indexedBoundary: { observationId, bytes: 1, at: 1 }, summaryCoverage: null, lastCompleteReconciliation: 1, gaps: [] }, passages };
}
test("source refs survive rebuild, tool ordinal gaps, selection, rewrite and durable favorite", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-passages-"));
  try {
    const one = new LibraryStore(join(dir, "a.db")); const two = new LibraryStore(join(dir, "b.db")); const input = fixture();
    one.publish(input); two.publish(input);
    const hit = one.search("日本語").hits[0]!.passage!;
    expect(hit.ref).toBe(two.search("日本語").hits[0]!.passage!.ref);
    expect(one.resolve(hit.ref).passage!.text).toBe(input.passages[0]!.text);
    const selected = selectPassage(hit, 0, Buffer.byteLength("first"));
    expect(one.resolve(selected.ref).passage!.text).toBe("first");
    expect(() => selectPassage(hit, 0, Buffer.byteLength("first\n\n    code ") + 1)).toThrow();
    const saved = one.saveFavorite({ sessionKey: input.session.key, refs: [selected.ref], idempotencyKey: "saved" });
    expect(saved.text).toBe("first");
    one.publish(fixture("new unrelated text", "r2"));
    expect(one.resolve(hit.ref).status).toBe("pinned");
    expect(one.resolve(hit.ref).passage!.text).toBe(hit.text);
    expect(one.favorites()[0]!.text).toBe("first");
    expect([...two.streamCopy(input.session.key)].join("")).toBe(`[user]\n${hit.text}\n\n`);
    one.close(); two.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("human default keeps unknown, worker correction has durable undo", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-scope-")); const store = new LibraryStore(join(dir, "a.db"));
  try {
    const f = fixture(); store.publish(f); expect(store.list().sessions).toHaveLength(1);
    const event = store.correctClassification(f.session.key, "worker"); expect(store.list().sessions).toHaveLength(0); expect(store.list({ view: "everything" }).sessions).toHaveLength(1);
    store.publish(f); expect(store.list().sessions).toHaveLength(0); store.undo(event); expect(store.list().sessions).toHaveLength(1);
    expect(store.search("absent").exhaustion).toContain("in this scope");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
