import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { dispatchCli, HELP, splitGlobalArgs } from "../src/cli.js";
import { runMigrations } from "../src/db/index.js";
import { fetchAllSessionKeys } from "../src/tui/queries.js";
import { commandForKey, dispatchTerminalInput, TuiRuntime } from "../src/tui/app.js";
import { _allowReinit, registerCommands } from "../src/tui/commands-defs.js";
import { _resetRegistry, execute } from "../src/tui/commands.js";
import { InteractionRegistry } from "../src/tui/interaction.js";
import { initialState, selectAllKeys } from "../src/tui/store.js";
import type { Config } from "../src/config.js";
import type { TerminalInputEvent } from "../src/tui/input.js";

const config: Config = {
  sources: {}, providers: [], launchers: [], dbPath: ":memory:",
  tunables: { tag_promotion_count: 3, export_budget_tokens: 20_000, fav_default_span: 6, summary_stale_pct: 25, redact_entropy_threshold: 4.8 },
};

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  runMigrations(db);
  _resetRegistry();
  _allowReinit();
  registerCommands();
});

afterEach(() => db.close());

test("bare atlas and global --config route to the TUI while help tells CLI truth", async () => {
  const seen: string[][] = [];
  expect(await dispatchCli([], { tui: async (argv) => { seen.push(argv); return 0; } })).toBe(0);
  expect(await dispatchCli(["--config", "/tmp/clone.toml"], { tui: async (argv) => { seen.push(argv); return 0; } })).toBe(0);
  expect(seen).toEqual([[], ["--config", "/tmp/clone.toml"]]);
  expect(splitGlobalArgs(["--config", "clone.toml", "doctor"])).toEqual({ command: "doctor", rest: ["--config", "clone.toml"] });
  for (const verb of ["fav", "export", "rebuild", "chat", "tags", "doctor"]) expect(HELP).toContain(`atlas ${verb}`);
  expect(HELP).toContain("atlas                       open the interactive TUI");
  for (const verb of ["classify-humans", "layers", "corpus", "searches", "repair titles"]) expect(HELP).toContain(`atlas ${verb}`);
  expect(HELP).not.toContain("list recent sessions");
});

test("whole-filter selection materializes stable keys beyond the rendered page", () => {
  const insert = db.prepare(`INSERT INTO sessions(harness,native_id,source_path,title,last_activity,ingested_at,orphaned) VALUES (?,?,?,?,?,?,0)`);
  for (let index = 0; index < 305; index++) insert.run("claude", `c-${index}`, `/${index}`, `claude ${index}`, index, index);
  insert.run("codex", "x-1", "/x", "codex", 999, 999);
  const keys = fetchAllSessionKeys(db, { source: "claude" });
  expect(keys).toHaveLength(305);
  expect(keys.every((key) => key.startsWith('["claude",'))).toBe(true);
  const selected = selectAllKeys(initialState(10), keys);
  expect(selected.list.selected.size).toBe(305);
  expect(selected.list.selected.has(0)).toBe(false);
});

test("key lattice exposes required list and session actions through registry ids", () => {
  const list = initialState(10);
  expect(commandForKey("f", {} as never, list)?.id).toBe("favorite");
  expect(commandForKey("e", {} as never, list)?.id).toBe("export");
  expect(commandForKey("c", {} as never, list)?.id).toBe("open-chat");
  expect(commandForKey("?", {} as never, list)?.id).toBe("help");
  expect(commandForKey("*", {} as never, list)?.id).toBe("select-all-filter");
  expect(commandForKey("g", {} as never, list)?.id).toBe("filter-origin");
  expect(commandForKey("", { rightArrow: true } as never, list)?.id).toBe("chain-toggle");

  const withRow = { ...list, list: { ...list.list, rows: [session(1)], focusKey: '["claude","s1"]' } };
  const opened = execute("open-session", withRow).state;
  // The reader keeps one mnemonic per action: m cycles views, h marks the creator.
  expect(commandForKey("m", {} as never, opened)?.id).toBe("mode-cycle");
  expect(commandForKey("h", {} as never, opened)?.id).toBe("creator-toggle");
  expect(commandForKey("1", {} as never, opened)).toBeNull();
  expect(commandForKey("3", {} as never, list)).toBeNull();
  expect(commandForKey("n", {} as never, opened)?.id).toBe("traverse-next");
  expect(commandForKey("p", {} as never, opened)?.id).toBe("traverse-prev");
  expect(execute("navigate-session", { ...execute("open-chat", withRow).state }, "1:42").state.activeOrdinal).toBe(42);
});

test("provider-free tag resynthesis is disabled in the canonical command lattice", () => {
  _resetRegistry();
  _allowReinit();
  registerCommands();
  const state = { ...initialState(), view: "tag" as const, activeTag: "astronomy" };
  const result = execute("tag-resynthesize", state);
  expect(result.message).toContain("no providers configured");
});

test("Atlas mouse observer ignores keyboard bytes that Ink also receives", () => {
  const events: TerminalInputEvent[] = [
    { type: "text", text: "f" },
    { type: "mouse", protocol: "sgr", action: "press", x: 3, y: 2, button: "left", shift: false, alt: false, ctrl: false },
  ];
  const registry = new InteractionRegistry();
  let presses = 0;
  registry.register({ id: "hit", rect: { x: 0, y: 0, width: 10, height: 10 }, onEvent: () => { presses++; return true; } });
  const pointers = dispatchTerminalInput({ feed: () => events } as never, registry, "f\x1b[<0;4;3M");
  expect(pointers).toBe(1);
  expect(presses).toBe(1);
});

test("runtime close aborts and awaits owned work before DB close", async () => {
  const runtime = new TuiRuntime(db, config);
  let wrote = false;
  const pending = runtime.tasks.run(async (task) => {
    await new Promise<void>((resolve) => task.signal.addEventListener("abort", () => resolve(), { once: true }));
    if (task.isCurrent()) {
      db.prepare(`INSERT INTO meta(key,value) VALUES ('late','1')`).run();
      wrote = true;
    }
  });
  await runtime.close();
  await pending;
  expect(runtime.tasks.activeCount).toBe(0);
  expect(wrote).toBe(false);
  expect(db.prepare(`SELECT value FROM meta WHERE key='late'`).get()).toBeNull();
});

function session(id: number) {
  return { id, harness: "claude", native_id: `s${id}`, title: `topic ${id}`, firstUser: null, cwd: null, project: null, last_activity: id, duration_ms: null, tok_user: 1, tok_assistant: 1, tok_tool: 0, tok_total: 2, msg_count: 2, models: null, chain_id: null, favorite: 0, sizePct: 0, engagement: 0.5 };
}
