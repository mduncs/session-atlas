import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index";
import { LibraryStore } from "../src/library/store";
import { makePassage } from "../src/library/passages";
import { prepareLiveCutover, publishLiveCutover, rollbackLiveCutover, type LiveCutoverHooks } from "../src/library/live-cutover";

test("separate held service writer rejects post-fence favorites and rollback retries without losing its committed journal", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atlas-rollback-concurrency-")));
  const spec = { legacyDatabase: join(root, "legacy.db"), nextDatabase: join(root, "next.db"), pointer: join(root, "pointer.json"), receiptDirectory: join(root, "receipts"), stateFile: join(root, "state.json") };
  const hooks: LiveCutoverHooks = { snapshotServices: async () => [], quiesceService: async () => {}, validateDestination: async () => {}, stopNewCapture: async () => {}, restoreService: async () => {} };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const old = await openDb(spec.legacyDatabase); old.close();
    const store = new LibraryStore(spec.nextDatabase);
    const key = { harness: "claude", nativeId: "isolated" };
    const passage = makePassage({ sessionKey: key, observationId: "synthetic", record: "record", channel: "prose", text: "Exact saved 日本語\n  bytes", role: "user", ordinal: 0, timestamp: null });
    const boundary = { observationId: "synthetic", bytes: Buffer.byteLength(passage.text), at: Date.now() };
    store.publish({ session: { key, revision: "synthetic", title: "Fixture", origin: "human_started", originReason: "synthetic", models: [], cwd: null, updatedAt: 1 }, observation: { id: "synthetic", sourceId: "synthetic", locator: "synthetic", objectHash: "synthetic", retainedBoundary: boundary, indexedBoundary: boundary, summaryCoverage: null, lastCompleteReconciliation: null, format: "synthetic", gaps: [] }, passages: [passage] });
    store.close();
    await prepareLiveCutover(spec, hooks); await publishLiveCutover(spec.stateFile, hooks);
    const script = join(root, "held-service.ts");
    writeFileSync(script, `import { LibraryStore } from ${JSON.stringify(new URL("../src/library/store.ts", import.meta.url).pathname)};
import { LibraryService } from ${JSON.stringify(new URL("../src/library/service.ts", import.meta.url).pathname)};
import { createInterface } from "node:readline";
const store = new LibraryStore(process.argv[2]); const service = new LibraryService(store);
const save = id => service.execute({ operation: "favorites.save", args: { sessionKey: ${JSON.stringify(key)}, refs: [${JSON.stringify(passage.ref)}], idempotencyKey: id } });
console.log(JSON.stringify({ ready: true, saved: save("before-fence"), journal: store.journal() }));
for await (const line of createInterface({ input: process.stdin })) {
  if (line === "close") { store.close(); console.log(JSON.stringify({ closed: true })); break; }
  try { save("after-fence"); console.log(JSON.stringify({ unexpectedlySaved: true })); }
  catch (error) { console.log(JSON.stringify({ rejected: String(error), journal: store.journal() })); }
}
`);
    const worker = Bun.spawn([process.execPath, script, spec.nextDatabase], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }); child = worker;
    const reader = worker.stdout.getReader(); const decoder = new TextDecoder(); let pending = "";
    const receive = async (): Promise<any> => {
      while (!pending.includes("\n")) { const chunk = await reader.read(); if (chunk.done) throw new Error("service child exited before response"); pending += decoder.decode(chunk.value, { stream: true }); }
      const end = pending.indexOf("\n"); const line = pending.slice(0, end); pending = pending.slice(end + 1); return JSON.parse(line);
    };
    const initial = await receive(); expect(initial.ready).toBe(true); expect(initial.saved.receipt.text).toBe(passage.text); expect(initial.journal).toHaveLength(1);
    await expect(rollbackLiveCutover(spec.stateFile, hooks)).rejects.toThrow("open Atlas database handle");
    expect(JSON.parse(readFileSync(spec.pointer, "utf8")).database).toBe(spec.nextDatabase);
    expect(existsSync(`${spec.nextDatabase}.maintenance.lock`)).toBe(true);
    worker.stdin.write("save\n"); await worker.stdin.flush();
    const rejected = await receive(); expect(rejected.rejected).toContain("maintenance"); expect(rejected.journal).toEqual(initial.journal);
    expect(() => new LibraryStore(spec.nextDatabase)).toThrow("maintenance");
    const readerStore = new LibraryStore(spec.nextDatabase, { readOnly: true });
    expect(readerStore.favorites()).toHaveLength(1); expect(readerStore.journal()).toEqual(initial.journal);
    worker.stdin.write("close\n"); await worker.stdin.end(); expect((await receive()).closed).toBe(true); expect(await worker.exited).toBe(0);
    expect((await rollbackLiveCutover(spec.stateFile, hooks)).phase).toBe("rolled-back");
    expect(existsSync(spec.pointer)).toBe(false); expect(existsSync(`${spec.nextDatabase}.maintenance.lock`)).toBe(true);
    expect(readerStore.read(key).passages[0]!.text).toBe(passage.text); expect(readerStore.journal()).toEqual(initial.journal); readerStore.close();
    const legacy = new Database(spec.legacyDatabase, { readonly: true });
    try {
      expect(legacy.query("SELECT span_text FROM favorites").all()).toEqual([{ span_text: passage.text }]);
      const replay = legacy.query("SELECT archive FROM atlas_library_user_journal").get() as { archive: string };
      expect(JSON.parse(replay.archive).journal).toEqual(initial.journal);
    } finally { legacy.close(); }
  } finally { child?.kill(); rmSync(root, { recursive: true, force: true }); }
}, 10_000);
