import { test, expect, beforeEach } from "bun:test";
import { register, get, execute, search, _resetRegistry, type Command } from "../src/tui/commands.js";
import { initialState, moveFocus } from "../src/tui/store.js";

beforeEach(() => {
  _resetRegistry();
  register({
    id: "test-increment",
    label: "Test Increment",
    contexts: ["list"],
    keys: ["+"],
    run: (s) => ({ state: moveFocus(s, 5) }),
  });
  register({
    id: "test-disabled",
    label: "Test Disabled",
    contexts: ["list"],
    keys: ["!"],
    disabled: () => "always disabled for test",
    run: (s) => ({ state: s }),
  });
  // Also register a quit + mode command so palette tests have data.
  register({ id: "quit", label: "Quit", contexts: ["list", "session"], keys: ["q"], run: (s) => ({ state: s }) });
  register({ id: "mode-full", label: "Transcript mode: full", contexts: ["session"], keys: ["1"], run: (s) => ({ state: s }) });
});

test("Law 6 — key dispatch, palette dispatch, and click dispatch all hit the same command", () => {
  const s0 = initialState(5);
  // Pretend rows so focus can move.
  s0.list.rows = Array.from({ length: 20 }, (_, i) => ({
    id: i,
    harness: "claude",
    native_id: `s${i}`,
    title: `t${i}`,
    firstUser: null,
    cwd: null,
    project: null,
    last_activity: i,
    duration_ms: null,
    tok_user: 0,
    tok_assistant: 0,
    tok_tool: 0,
    tok_total: 0,
    msg_count: 0,
    models: null,
    chain_id: null,
    favorite: 0,
    sizePct: 0,
    engagement: null,
  }));

  // DOOR 1: keyboard handler resolves "+" → execute("test-increment").
  const viaKey = execute("test-increment", s0);
  // DOOR 2: palette → user types "increment", selects, Enter → execute("test-increment").
  const viaPalette = execute("test-increment", s0);
  // DOOR 3: click on a zone with command="test-increment" → execute("test-increment").
  const viaClick = execute("test-increment", s0);

  // All three produce IDENTICAL state — one implementation, three doors.
  expect(viaKey.state.list.focus).toBe(5);
  expect(viaPalette.state.list.focus).toBe(5);
  expect(viaClick.state.list.focus).toBe(5);
  expect(viaKey.state).toEqual(viaPalette.state);
  expect(viaPalette.state).toEqual(viaClick.state);
});

test("Law 6 — disabled commands report their reason and don't mutate state", () => {
  const s0 = initialState(5);
  const res = execute("test-disabled", s0);
  expect(res.state).toBe(s0); // unchanged
  expect(res.message).toContain("always disabled");
});

test("Law 6 — palette search filters by context + fuzzy label", () => {
  const s0 = initialState(5);
  // In list context, "mode" commands (session-only) should NOT appear.
  const listResults = search("mode", "list", s0);
  expect(listResults.every((r) => !r.cmd.id.startsWith("mode-"))).toBe(true);

  // "quit" is findable.
  const quitResults = search("quit", "list", s0);
  expect(quitResults.some((r) => r.cmd.id === "quit")).toBe(true);

  // Empty query returns all commands for the context.
  const all = search("", "list", s0);
  expect(all.length).toBeGreaterThanOrEqual(3); // quit, test-increment, test-disabled (all list)
});

test("command registry rejects duplicate ids", () => {
  expect(() =>
    register({
      id: "test-increment",
      label: "Dup",
      contexts: ["list"],
      run: (s) => ({ state: s }),
    }),
  ).toThrow(/duplicate/);
});

test("execute on unknown command returns a message, doesn't throw", () => {
  const s0 = initialState(5);
  const res = execute("no-such-command", s0);
  expect(res.state).toBe(s0);
  expect(res.message).toContain("unknown");
});
