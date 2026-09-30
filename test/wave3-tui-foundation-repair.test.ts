import { beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/db/index.js";
import { attachLayers } from "../src/layers/db.js";
import {
  projectListRows,
  projectedViewport,
  sessionKey,
  type SessionRow,
} from "../src/tui/domain.js";
import {
  _resetRegistry,
  executeInvocation,
  executeKey,
  executePalette,
  findByKey,
  register,
} from "../src/tui/commands.js";
import { _allowReinit, registerCommands } from "../src/tui/commands-defs.js";
import { InteractionRegistry, TerminalEventAdapter } from "../src/tui/interaction.js";
import { TerminalInputTokenizer } from "../src/tui/input.js";
import {
  appendRows,
  clearSelection,
  esc,
  initialState,
  logicalListViewport,
  moveFocus,
  openSession,
  queueLiveRows,
  toggleChain,
  toggleSelection,
  viewportEdgeLiveState,
} from "../src/tui/store.js";
import { applyFilterTerm, fetchPage, removeFilterTerm, type ListFilter } from "../src/tui/queries.js";
import { encodeOsc52 } from "../src/tui/yank.js";

function row(id: number, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    harness: "claude",
    native_id: `native-${id}`,
    title: `session ${id}`,
    firstUser: null,
    cwd: "/p",
    project: "/p",
    last_activity: 1_800_000_000_000 - id,
    duration_ms: null,
    tok_user: id,
    tok_assistant: id,
    tok_tool: 0,
    tok_total: id * 2,
    msg_count: id,
    models: '["opus"]',
    chain_id: null,
    favorite: 0,
    sizePct: 0.5,
    engagement: 0.5,
    ...overrides,
  };
}

beforeEach(() => {
  _resetRegistry();
  _allowReinit();
});

test("logical cursor survives a chain crossing fetched pages and stays within line budget", () => {
  let state = appendRows(initialState(3), [row(10, { chain_id: 7 }), row(9), row(8)], false);
  state = toggleChain(state, 7);
  state = moveFocus(state, 2); // aggregate -> nested head -> standalone 9
  expect(state.list.focusKey).toBe(sessionKey(row(9)));

  state = appendRows(state, [row(7, { chain_id: 7 }), row(6), row(5)], true);
  expect(state.list.focusKey).toBe(sessionKey(row(9)));
  let viewport = logicalListViewport(state);
  expect(viewport.rows.some((item) => item.kind !== "cluster" && item.key === state.list.projectionFocusKey)).toBe(true);
  expect(viewport.usedLines).toBeLessThanOrEqual(3);

  state = moveFocus(state, -1);
  expect(state.list.focusKey).toBe(sessionKey(row(7, { chain_id: 7 })));
  state = toggleChain(state, 7);
  expect(state.list.projectionFocusKey).toBe("chain:7");
  expect(logicalListViewport(state).rows.some((item) => item.key === "chain:7")).toBe(true);

  const expanded = projectListRows(state.list.rows, new Set([7]));
  expect(expanded.filter((item) => item.kind === "session" && item.nested).map((item) => item.session.id)).toEqual([10, 7]);
  const forced = projectedViewport(expanded, { focusKey: sessionKey(row(5)), anchorKey: expanded[0]!.key }, 2);
  expect(forced.rows.some((item) => item.key === sessionKey(row(5)))).toBe(true);
});

test("registry resolves physical keys with modifiers/context and palette closes transactionally", () => {
  const origins: string[] = [];
  register({
    id: "act",
    label: "Act",
    contexts: ["list"],
    keys: ["ctrl-l"],
    payloadKinds: ["none"],
    run: (state) => ({ state }),
    runPayload: (state, _payload, origin) => {
      origins.push(origin);
      return { state: { ...state, message: origin } };
    },
  });
  const opened = { ...initialState(), paletteInput: "ac", paletteIndex: 2 };
  expect(findByKey({ key: "l", ctrl: true }, "list")?.id).toBe("act");
  expect(executeKey({ key: "l", ctrl: true }, opened).state.message).toBe("key");
  const clicked = executeInvocation({ id: "act", payload: { kind: "none" }, origin: "click" }, opened);
  expect(clicked.state.message).toBe("click");
  const palette = executePalette("act", opened);
  expect(palette.state.paletteInput).toBeNull();
  expect(palette.state.paletteIndex).toBe(0);
  expect(origins).toEqual(["key", "click", "palette"]);

  const wrongContext = { ...opened, paletteInput: null, view: "session" as const };
  expect(executeInvocation({ id: "act", payload: { kind: "none" }, origin: "click" }, wrongContext).message).toContain("unavailable in session");
});

test("canonical # and q semantics are context-aware", () => {
  registerCommands();
  let state = appendRows(initialState(), [row(1)], true);
  state = executeKey("#", state).state;
  expect(state.view).toBe("tag");
  const back = executeKey("q", state);
  expect(back.exit).not.toBe(true);
  expect(back.state.view).toBe("list");
  expect(executeKey("q", back.state).exit).toBe(true);
});

test("canonical paging, boundaries, search, and transcript reader keys are registered", () => {
  registerCommands();
  let state = appendRows(initialState(5), Array.from({ length: 30 }, (_, index) => row(30 - index)), true);
  state = executeKey("pagedown", state).state;
  expect(state.list.focus).toBe(4);
  state = executeKey("end", state).state;
  expect(state.list.focus).toBe(29);
  state = executeKey("pageup", state).state;
  expect(state.list.focus).toBe(25);
  state = executeKey("home", state).state;
  expect(state.list.focus).toBe(0);
  expect(executeKey({ key: "f", ctrl: true }, state).state.searchInput).toBe("");

  state = openSession(state, state.list.rows[0]!.id);
  expect(state.session?.mode).toBe("dialogue");
  state = executeKey("m", state).state;
  expect(state.session?.mode).toBe("stubs");
  state = executeKey("m", state).state;
  expect(state.session?.mode).toBe("full");
  expect(executeKey("2", state).state.session?.mode).toBe("full");
  expect(state.session?.wrap).toBe(true);
  state = executeKey("w", state).state;
  expect(state.session?.wrap).toBe(false);
});

test("clearing selection inside an excursion also clears the restore snapshot", () => {
  let state = appendRows(initialState(), [row(2), row(1)], true);
  state = toggleSelection(state);
  state = openSession(state, 2);
  state = clearSelection(state);
  expect(state.view).toBe("session");
  expect(state.list.selected.size).toBe(0);
  expect(state.restore?.selected.size).toBe(0);
  state = esc(state);
  expect(state.view).toBe("list");
  expect(state.list.selected.size).toBe(0);
});

test("Esc inside an excursion goes back one level and keeps the list selection", () => {
  let state = appendRows(initialState(), [row(2), row(1)], true);
  state = toggleSelection(state);
  state = openSession(state, 2);
  state = esc(state);
  expect(state.view).toBe("list");
  expect(state.list.selected.size).toBe(1);
  state = esc(state);
  expect(state.list.selected.size).toBe(0);
});

test("terminal adapter owns text/key/paste/focus/mouse without duplicate Ink delivery", () => {
  const tokenizer = new TerminalInputTokenizer();
  const registry = new InteractionRegistry();
  const seen: string[] = [];
  registry.register({ id: "one", rect: { x: 0, y: 0, width: 5, height: 2 }, focusable: true, onEvent: (event) => { seen.push(`one:${event.event.type}`); return true; } });
  registry.register({ id: "two", rect: { x: 5, y: 0, width: 5, height: 2 }, focusable: true, onEvent: (event) => { seen.push(`two:${event.event.type}`); return true; } });
  registry.focus("one");
  const unhandledKeys: string[] = [];
  const adapter = new TerminalEventAdapter({ registry, keyboardOwner: "atlas", onUnhandledKey: (event) => unhandledKeys.push(`${event.alt ? "alt+" : ""}${event.key}`) });
  const events = tokenizer.feed("a\t\x1b[Z\x1b[200~many chars\x1b[201~\x1b[I\x1b[<64;2;2M", 0);
  const summary = adapter.dispatch(events);
  expect(summary).toMatchObject({ keyboardOwner: "atlas", pointerEvents: 1, keyboardEvents: 2, focusMoves: 2 });
  expect(seen).toContain("one:key");
  expect(seen).toContain("one:paste");
  expect(seen).toContain("one:focus");
  expect(seen).toContain("one:mouse");

  registry.focus(null);
  adapter.dispatch(tokenizer.feed("\x1bx", 10));
  tokenizer.feed("\x1b", 20);
  adapter.dispatch(tokenizer.flush(70));
  expect(unhandledKeys).toEqual(["alt+x", "escape"]);

  const ignored: string[] = [];
  const inkAdapter = new TerminalEventAdapter({ registry, keyboardOwner: "ink", onUnhandledText: (text) => ignored.push(text) });
  expect(inkAdapter.dispatch([{ type: "text", text: "z" }]).keyboardEvents).toBe(0);
  expect(ignored).toEqual([]);
});

test("OSC52 encoder chooses exactly one passthrough layer", () => {
  const plain = encodeOsc52("hello");
  expect(plain).toBe("\x1b]52;c;aGVsbG8=\x07");
  expect(encodeOsc52("hello", { term: "screen-256color" })).toBe(`\x1bP${plain}\x1b\\`);
  const tmux = encodeOsc52("hello", { tmux: true, term: "screen-256color" });
  expect(tmux).toBe(`\x1bPtmux;${plain.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`);
  expect(tmux.match(/tmux;/g)).toHaveLength(1);
});

test("default literal punctuation is recoverable and filter removals are algebraic", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  attachLayers(db, null);
  const page = fetchPage(db, { query: '"unterminated' });
  expect(page.rows).toEqual([]);
  expect(page.error).toBeUndefined();
  db.close();

  const terms = [
    { kind: "query", value: "q" }, { kind: "source", value: "claude" }, { kind: "model", value: "opus" },
    { kind: "path", value: "/p" }, { kind: "tag", value: "work" },
    { kind: "date", value: { from: 1, to: 2 } }, { kind: "favorite", value: true },
    { kind: "state", value: "summarized" }, { kind: "chain", value: { mode: "chained" } },
  ] as const;
  let filter: ListFilter = {};
  for (const term of terms) filter = applyFilterTerm(filter, term);
  for (const term of terms) {
    const removed = removeFilterTerm(filter, term.kind);
    expect((removed as Record<string, unknown>)[term.kind]).toBeUndefined();
    for (const other of terms) {
      if (other.kind !== term.kind) expect((removed as Record<string, unknown>)[other.kind]).toEqual((filter as Record<string, unknown>)[other.kind]);
    }
  }
});

test("live refresh updates facts by stable key in place and exposes top-edge new count", () => {
  let state = appendRows(initialState(2), [row(5), row(4), row(3), row(2)], true);
  state = moveFocus(state, 3);
  const order = state.list.rows.map(sessionKey);
  const focus = state.list.focusKey;
  state = queueLiveRows(state, [row(5, { title: "fresh", favorite: 1 }), row(7), row(6)], 44);
  expect(state.list.rows.map(sessionKey)).toEqual(order);
  expect(state.list.rows[0]).toMatchObject({ title: "fresh", favorite: 1 });
  expect(state.list.focusKey).toBe(focus);
  expect(viewportEdgeLiveState(state)).toEqual({ edge: "top", count: 2, revision: 44, visible: true });
});
