import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dispatchCli } from "../src/cli.js";
import { readActiveLibrary, resolveLibraryPath } from "../src/library/active-library.js";
import { LibraryStore } from "../src/library/store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "atlas-routing-")); roots.push(root);
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data") };
  const pointer = join(env.XDG_CONFIG_HOME, "session-atlas", "library-pointer.json");
  const database = join(root, "active.db");
  const publish = (value: unknown = { version: 1, database, transaction: "test" }) => { mkdirSync(dirname(pointer), { recursive: true }); writeFileSync(pointer, JSON.stringify(value)); };
  return { root, env, pointer, database, publish };
}

describe("active library resolution", () => {
  test("missing pointer uses existing default without creating configuration", () => {
    const f = fixture();
    expect(readActiveLibrary(f.env)).toBeNull();
    expect(resolveLibraryPath(undefined, f.env)).toBe(join(f.env.XDG_DATA_HOME, "session-atlas-library/library.db"));
    expect(readdirSync(f.root)).toEqual([]);
  });
  test("honors XDG pointer and home fallback; inspection leaves database bytes unchanged", () => {
    const f = fixture(); new LibraryStore(f.database).close(); f.publish();
    const before = readFileSync(f.database);
    expect(readActiveLibrary(f.env)).toEqual({ database: f.database, kind: "library", pointer: f.pointer });
    expect(resolveLibraryPath(undefined, f.env)).toBe(f.database);
    expect(readFileSync(f.database)).toEqual(before);
    const homePointer = join(f.root, ".config/session-atlas/library-pointer.json");
    mkdirSync(dirname(homePointer), { recursive: true }); writeFileSync(homePointer, readFileSync(f.pointer));
    expect(readActiveLibrary({ HOME: f.root })?.pointer).toBe(homePointer);
  });
  test("explicit flag and environment override even a broken pointer", () => {
    const f = fixture(); f.publish({ version: 99 });
    expect(resolveLibraryPath(f.database, f.env)).toBe(f.database);
    expect(resolveLibraryPath(undefined, { ...f.env, ATLAS_LIBRARY_DB: f.database })).toBe(f.database);
    expect(resolveLibraryPath(join(f.root, "flag.db"), { ...f.env, ATLAS_LIBRARY_DB: f.database })).toBe(join(f.root, "flag.db"));
  });
  test("rejects malformed, relative, absent and unrelated destinations without initialization", () => {
    const f = fixture();
    for (const value of [{ version: 2, database: f.database }, { version: 1, database: "relative.db" }, null, { version: 1, database: f.database }]) {
      f.publish(value); expect(() => readActiveLibrary(f.env)).toThrow("Invalid active library pointer");
    }
    expect(readdirSync(f.root)).toEqual(["config"]);
    writeFileSync(f.pointer, "{"); expect(() => readActiveLibrary(f.env)).toThrow("Invalid active library pointer");
    new Database(f.database).close(); f.publish();
    expect(() => resolveLibraryPath(undefined, f.env)).toThrow("unrecognized database schema");
    const db = new Database(f.database, { readonly: true });
    expect(db.query("SELECT name FROM sqlite_master").all()).toEqual([]); db.close();
  });
  test("rollback legacy pointer is detected and rejected by the new CLI resolver", () => {
    const f = fixture(); const db = new Database(f.database);
    db.exec("CREATE TABLE meta(key TEXT,value TEXT); CREATE TABLE sessions(harness TEXT,native_id TEXT)"); db.close();
    f.publish({ version: 1, database: f.database, rollbackOf: "test" });
    expect(readActiveLibrary(f.env)?.kind).toBe("legacy");
    expect(() => resolveLibraryPath(undefined, f.env)).toThrow("incompatible legacy database");
  });
});

describe("atlas entry routing", () => {
  test("real library CLI consumes pointer from an unrelated working directory and refuses legacy targets", async () => {
    const f = fixture(); new LibraryStore(f.database).close(); f.publish();
    const cli = new URL("../src/cli.ts", import.meta.url).pathname;
    // Remove inherited overrides entirely: this verifies the pointer, not an explicit path.
    const previous = process.env.ATLAS_LIBRARY_DB;
    const env = { ...process.env, ...f.env }; delete env.ATLAS_LIBRARY_DB;
    const child = Bun.spawn([process.execPath, cli, "library", "status"], { cwd: f.root, env, stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toBeDefined();
    const legacy = join(f.root, "legacy.db"); const db = new Database(legacy);
    db.exec("CREATE TABLE meta(key TEXT,value TEXT); CREATE TABLE sessions(harness TEXT,native_id TEXT)"); db.close(); f.publish({ version: 1, database: legacy });
    const rejected = Bun.spawn([process.execPath, cli, "library", "init"], { cwd: f.root, env, stdout: "pipe", stderr: "pipe" });
    expect(await rejected.exited).toBe(1);
    expect(await new Response(rejected.stderr).text()).toContain("incompatible legacy database");
    expect(process.env.ATLAS_LIBRARY_DB).toBe(previous);
  });
  test("Ink remains the default with a published library; backend stays explicit", async () => {
    const f = fixture(); new LibraryStore(f.database).close(); f.publish();
    const calls: unknown[] = [];
    const overrides = { activeLibrary: () => readActiveLibrary(f.env), library: async (args: string[]) => { calls.push(["library", args]); }, tui: async (args: string[]) => { calls.push(["legacy", args]); return 0; } };
    expect(await dispatchCli([], overrides)).toBe(0);
    expect(await dispatchCli(["--legacy"], overrides)).toBe(0);
    expect(await dispatchCli(["--config", "/isolated/config.toml"], overrides)).toBe(0);
    expect(await dispatchCli(["tui"], overrides)).toBe(0);
    expect(await dispatchCli(["library", "status"], overrides)).toBe(0);
    expect(calls).toEqual([["legacy", []], ["legacy", []], ["legacy", ["--config", "/isolated/config.toml"]], ["legacy", []], ["library", ["status"]]]);
  });
  test("Ink default is independent of absent, rollback, and malformed library pointers", async () => {
    const f = fixture(); let calls = 0;
    const overrides = { activeLibrary: () => readActiveLibrary(f.env), tui: async () => { calls++; return 0; }, library: async () => { throw new Error("unexpected library invocation"); } };
    expect(await dispatchCli([], overrides)).toBe(0);
    const db = new Database(f.database); db.exec("CREATE TABLE meta(key TEXT,value TEXT); CREATE TABLE sessions(harness TEXT,native_id TEXT)"); db.close(); f.publish();
    expect(await dispatchCli([], overrides)).toBe(0);
    f.publish({ version: 99 }); expect(await dispatchCli([], overrides)).toBe(0);
    expect(calls).toBe(3);
    expect(await dispatchCli(["--legacy"], overrides)).toBe(0);
  });
});
