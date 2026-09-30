import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNoOpenDbLeases, openDb } from "../src/db/index.js";
import { hashText } from "../src/library/passages.js";
import { LibraryStore } from "../src/library/store.js";
import { prepareLiveCutover, publishLiveCutover, rollbackLiveCutover, readLiveCutoverState, type LiveCutoverHooks, type LiveCutoverSpec } from "../src/library/live-cutover.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "atlas-live-cutover-"))); roots.push(root);
  const spec: LiveCutoverSpec = { legacyDatabase: join(root, "legacy.db"), nextDatabase: join(root, "next.db"), pointer: join(root, "pointer.json"), receiptDirectory: join(root, "receipts"), stateFile: join(root, "live-state.json") };
  const old = await openDb(spec.legacyDatabase); old.close(); new LibraryStore(spec.nextDatabase).close();
  const calls: string[] = [];
  const hooks: LiveCutoverHooks = {
    snapshotServices: async () => [
      { label: "healthy", loaded: true, disabled: false, lastExitStatus: 0 },
      { label: "oldindex-failed", loaded: true, disabled: false, lastExitStatus: 1 },
      { label: "disabled", loaded: true, disabled: true, lastExitStatus: 0 },
      { label: "unloaded", loaded: false, disabled: false, lastExitStatus: null },
    ],
    quiesceService: async s => { calls.push(`stop:${s.label}`); },
    validateDestination: async () => { calls.push("validate"); },
    stopNewCapture: async () => { calls.push("stop-new"); },
    restoreService: async s => { calls.push(`restore:${s.label}`); },
  };
  return { spec, hooks, calls, fence: `${spec.legacyDatabase}.maintenance.lock` };
}
test("durable fence, validated publication, replay and absent-pointer rollback; failed oldindex never revived", async () => {
  const f = await fixture();
  const prepared = await prepareLiveCutover(f.spec, f.hooks);
  expect(prepared.phase).toBe("prepared"); expect(prepared.originalPointer).toBeNull(); expect(existsSync(f.fence)).toBe(true);
  expect(JSON.parse(readFileSync(f.spec.pointer, "utf8")).database).toBe(f.spec.legacyDatabase);
  await expect(openDb(f.spec.legacyDatabase)).rejects.toThrow("maintenance");
  expect((await publishLiveCutover(f.spec.stateFile, f.hooks)).phase).toBe("published");
  expect(JSON.parse(readFileSync(f.spec.pointer, "utf8")).database).toBe(f.spec.nextDatabase);
  const next = new LibraryStore(f.spec.nextDatabase);
  const favorite = { id: "post-cutover-favorite", sessionKey: { harness: "codex", nativeId: "post-cutover" }, refs: [], text: "exact user bytes", textHash: hashText("exact user bytes"), createdAt: Date.now(), note: "saved after publish" };
  next.db.query("INSERT INTO library_favorites VALUES(?,?)").run(favorite.id, JSON.stringify(favorite));
  next.db.query("INSERT INTO library_journal VALUES(?,?,?)").run("saved", favorite.createdAt, JSON.stringify({ id: "saved", at: favorite.createdAt, kind: "favorite", target: favorite.id, before: null, after: favorite })); next.close();
  expect((await rollbackLiveCutover(f.spec.stateFile, f.hooks)).phase).toBe("rolled-back");
  expect(existsSync(f.spec.pointer)).toBe(false); expect(existsSync(f.fence)).toBe(false);
  const old = new Database(f.spec.legacyDatabase, { readonly: true });
  expect(old.query("SELECT span_text FROM favorites WHERE native_id='post-cutover'").get()).toEqual({ span_text: "exact user bytes" }); old.close();
  expect(f.calls).toEqual(["stop:healthy", "stop:oldindex-failed", "stop:disabled", "validate", "stop-new", "restore:healthy"]);
});
test("validation failure retains fence and original pointer bytes for explicit rollback", async () => {
  const f = await fixture(); const original = JSON.stringify({ version: 1, database: f.spec.legacyDatabase, custom: "preserved" }, null, 4) + "\n"; writeFileSync(f.spec.pointer, original);
  await prepareLiveCutover(f.spec, f.hooks);
  f.hooks.validateDestination = async () => { throw new Error("coverage incomplete"); };
  await expect(publishLiveCutover(f.spec.stateFile, f.hooks)).rejects.toThrow("coverage incomplete");
  expect(existsSync(f.fence)).toBe(true); expect(readFileSync(f.spec.pointer, "utf8")).toBe(original);
  await rollbackLiveCutover(f.spec.stateFile, f.hooks);
  expect(readFileSync(f.spec.pointer, "utf8")).toBe(original); expect(existsSync(f.fence)).toBe(false);
});
test("existing maintenance fence is never adopted or removed", async () => {
  const f = await fixture(); writeFileSync(f.fence, "another owner");
  await expect(prepareLiveCutover(f.spec, f.hooks)).rejects.toThrow();
  expect(readFileSync(f.fence, "utf8")).toBe("another owner"); expect(existsSync(f.spec.stateFile)).toBe(false); expect(f.calls).toEqual([]);
});
test("open legacy handle refuses prepare but retains an owned recoverable fence", async () => {
  const f = await fixture(); const old = await openDb(f.spec.legacyDatabase);
  await expect(prepareLiveCutover(f.spec, f.hooks)).rejects.toThrow("open Atlas database handle");
  expect(readLiveCutoverState(f.spec.stateFile).phase).toBe("fenced"); expect(existsSync(f.spec.pointer)).toBe(false);
  old.close(); await rollbackLiveCutover(f.spec.stateFile, f.hooks); expect(existsSync(f.fence)).toBe(false);
});
test("foreign fence replacement and pointer changes block rollback without release", async () => {
  const f = await fixture(); await prepareLiveCutover(f.spec, f.hooks);
  const owned = readFileSync(f.fence, "utf8"); writeFileSync(f.fence, JSON.stringify({ liveCutoverToken: "foreign" }));
  await expect(rollbackLiveCutover(f.spec.stateFile, f.hooks)).rejects.toThrow("ownership changed"); expect(f.calls).not.toContain("stop-new");
  writeFileSync(f.fence, owned); writeFileSync(f.spec.pointer, JSON.stringify({ version: 1, database: "/foreign.db" }));
  await expect(rollbackLiveCutover(f.spec.stateFile, f.hooks)).rejects.toThrow("pointer changed"); expect(existsSync(f.fence)).toBe(true);
});

test("rollback resumes after fence unlink but before final receipt write", async () => {
  const f = await fixture(); await prepareLiveCutover(f.spec, f.hooks);
  await rollbackLiveCutover(f.spec.stateFile, f.hooks);
  // Reconstruct the durable state at the interruption boundary: route restored,
  // owned fence unlinked, final phase and service restoration not yet recorded.
  const state = readLiveCutoverState(f.spec.stateFile); state.phase = "releasing"; state.restoredServices = [];
  writeFileSync(f.spec.stateFile, JSON.stringify(state)); f.calls.length = 0;
  expect(existsSync(f.fence)).toBe(false);
  expect((await rollbackLiveCutover(f.spec.stateFile, f.hooks)).phase).toBe("rolled-back");
  expect(f.calls).toEqual(["restore:healthy"]); expect(existsSync(f.spec.pointer)).toBe(false);
});

test("releasing recovery rejects a foreign replacement fence or changed route", async () => {
  const f = await fixture(); await prepareLiveCutover(f.spec, f.hooks); await rollbackLiveCutover(f.spec.stateFile, f.hooks);
  const state = readLiveCutoverState(f.spec.stateFile); state.phase = "releasing"; state.restoredServices = [];
  writeFileSync(f.spec.stateFile, JSON.stringify(state));
  writeFileSync(f.fence, JSON.stringify({ liveCutoverToken: "foreign" }));
  await expect(rollbackLiveCutover(f.spec.stateFile, f.hooks)).rejects.toThrow("ownership changed");
  expect(JSON.parse(readFileSync(f.fence, "utf8")).liveCutoverToken).toBe("foreign");
  rmSync(f.fence); writeFileSync(f.spec.pointer, JSON.stringify({ version: 1, database: "/foreign.db" }));
  await expect(rollbackLiveCutover(f.spec.stateFile, f.hooks)).rejects.toThrow("pointer changed");
});

test("failed healthy-service restoration retries without replay or reviving failed services", async () => {
  const f = await fixture(); await prepareLiveCutover(f.spec, f.hooks);
  let attempts = 0;
  f.hooks.restoreService = async s => { f.calls.push(`restore:${s.label}`); if (++attempts === 1) throw new Error("temporary service failure"); };
  await expect(rollbackLiveCutover(f.spec.stateFile, f.hooks)).rejects.toThrow("temporary service failure");
  expect(readLiveCutoverState(f.spec.stateFile).phase).toBe("rolled-back"); expect(existsSync(f.fence)).toBe(false);
  await rollbackLiveCutover(f.spec.stateFile, f.hooks);
  await rollbackLiveCutover(f.spec.stateFile, f.hooks);
  expect(attempts).toBe(2);
  expect(f.calls.filter(call => call === "stop-new")).toHaveLength(1);
  expect(f.calls.filter(call => call.startsWith("restore:"))).toEqual(["restore:healthy", "restore:healthy"]);
  expect(readLiveCutoverState(f.spec.stateFile).restoredServices).toEqual(["healthy"]);
});

test("writable library leases match legacy discovery and disappear on close or constructor error", async () => {
  const f = await fixture(); const store = new LibraryStore(f.spec.nextDatabase);
  const leaseDir = `${f.spec.nextDatabase}.connections`; const leases = readdirSync(leaseDir);
  expect(leases).toHaveLength(1); expect(leases[0]).toStartWith(`${process.pid}-`);
  expect(Number(readFileSync(join(leaseDir, leases[0]!), "utf8"))).toBeGreaterThan(Date.now() - 10_000);
  await expect(assertNoOpenDbLeases(f.spec.nextDatabase)).rejects.toThrow("open Atlas database handle");
  store.close(); expect(readdirSync(leaseDir)).toEqual([]); await assertNoOpenDbLeases(f.spec.nextDatabase);
  // Use an existing independent malformed database to exercise post-lease open failure.
  const bad = f.spec.nextDatabase + ".invalid"; writeFileSync(bad, "not sqlite");
  expect(() => new LibraryStore(bad)).toThrow(); expect(readdirSync(`${bad}.connections`)).toEqual([]);
});

test("maintenance refuses new/existing library writers but permits lease-free readonly inspection", async () => {
  const f = await fixture(); const writer = new LibraryStore(f.spec.nextDatabase);
  writer.setState("before", "retained");
  writeFileSync(`${f.spec.nextDatabase}.maintenance.lock`, "fenced");
  expect(() => new LibraryStore(f.spec.nextDatabase)).toThrow("maintenance");
  expect(() => writer.setState("after", "forbidden")).toThrow("maintenance");
  expect(writer.getState("after")).toBeNull();
  const reader = new LibraryStore(f.spec.nextDatabase, { readOnly: true });
  expect(reader.getState("before")).toBe("retained");
  expect(readdirSync(`${f.spec.nextDatabase}.connections`)).toHaveLength(1);
  writer.close(); expect(readdirSync(`${f.spec.nextDatabase}.connections`)).toEqual([]);
  await assertNoOpenDbLeases(f.spec.nextDatabase); reader.close();
});

test("rollback fences next library before stopping capture and waits for existing UI writers", async () => {
  const f = await fixture(); await prepareLiveCutover(f.spec, f.hooks); await publishLiveCutover(f.spec.stateFile, f.hooks);
  const ui = new LibraryStore(f.spec.nextDatabase);
  f.hooks.stopNewCapture = async () => {
    expect(existsSync(`${f.spec.nextDatabase}.maintenance.lock`)).toBe(true);
    expect(() => ui.setState("late-write", true)).toThrow("maintenance");
  };
  await expect(rollbackLiveCutover(f.spec.stateFile, f.hooks)).rejects.toThrow("open Atlas database handle");
  expect(JSON.parse(readFileSync(f.spec.pointer, "utf8")).database).toBe(f.spec.nextDatabase);
  expect(existsSync(f.fence)).toBe(true);
  ui.close(); f.hooks.stopNewCapture = async () => {};
  const reader = new LibraryStore(f.spec.nextDatabase, { readOnly: true });
  await rollbackLiveCutover(f.spec.stateFile, f.hooks);
  expect(existsSync(`${f.spec.nextDatabase}.maintenance.lock`)).toBe(true);
  expect(() => new LibraryStore(f.spec.nextDatabase)).toThrow("maintenance");
  expect(reader.getState("late-write")).toBeNull(); reader.close();
  expect(existsSync(f.fence)).toBe(false);
});

test("rollback never adopts or removes a foreign next-library fence", async () => {
  const f = await fixture(); await prepareLiveCutover(f.spec, f.hooks);
  const nextFence = `${f.spec.nextDatabase}.maintenance.lock`; const foreign = JSON.stringify({ liveCutoverToken: "foreign-next" }); writeFileSync(nextFence, foreign);
  await expect(rollbackLiveCutover(f.spec.stateFile, f.hooks)).rejects.toThrow("next library maintenance fence ownership changed");
  expect(readFileSync(nextFence, "utf8")).toBe(foreign); expect(f.calls).not.toContain("stop-new"); expect(existsSync(f.fence)).toBe(true);
});
