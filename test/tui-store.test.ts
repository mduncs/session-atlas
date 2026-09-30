import { test, expect } from "bun:test";
import {
  initialState,
  moveFocus,
  openSession,
  closeSession,
  esc,
  beginSearch,
  commitSearch,
  clearAllFilters,
  setTranscriptMode,
  toggleTranscriptWrap,
  cycleRoleToggle,
  openExcursion,
  quitAllowed,
  scrollList,
} from "../src/tui/store.js";
import type { SessionRow } from "../src/tui/queries.js";

function row(id: number): SessionRow {
  return {
    id,
    harness: "claude",
    native_id: `s${id}`,
    title: `session ${id}`,
    firstUser: null,
    cwd: "/p",
    project: "/p",
    last_activity: id,
    duration_ms: null,
    tok_user: 0,
    tok_assistant: 0,
    tok_tool: 0,
    tok_total: 0,
    msg_count: 1,
    models: null,
    chain_id: null,
    favorite: 0,
    sizePct: 0.5,
    engagement: 0.5,
  };
}

function seedRows(n: number, state = initialState(5)) {
  const rows = Array.from({ length: n }, (_, i) => row(i));
  return { ...state, list: { ...state.list, rows } };
}

test("Law 9 — Esc ladder: search closes before session closes before no-op", () => {
  // L0: bare list → Esc is no-op (filters survive).
  let s = seedRows(3);
  const filters = { ...s.filter, harness: "kilo" };
  s = { ...s, filter: filters };
  const s0 = esc(s);
  expect(s0.view).toBe("list");
  expect(s0.filter.harness).toBe("kilo"); // filters NOT cleared by Esc

  // L1: in a session → Esc returns to list.
  s = seedRows(3);
  s = openSession(s, 1);
  expect(s.view).toBe("session");
  s = esc(s);
  expect(s.view).toBe("list");
  expect(s.session).toBeNull();

  // L2: search input open → Esc closes search first, even mid-session context.
  s = seedRows(3);
  s = beginSearch(s);
  s = { ...s, searchInput: "variable stars" };
  const after = esc(s);
  expect(after.searchInput).toBeNull();
  // Did NOT enter a session, so still list.
  expect(after.view).toBe("list");
});

test("Law 9 — Esc at the bare list clears the search chip and nothing else", () => {
  // Esc is back one level: leaving a search is a level; other chips stay.
  let s = seedRows(3);
  s = beginSearch(s);
  s = commitSearch(s);
  expect(s.filter.query).toBeNull(); // empty → cleared at commit (null, not "")
  s = { ...s, filter: { ...s.filter, query: "astronomy", tag: "work" } };
  const after = esc(s);
  expect(after.filter.query).toBeNull();
  expect(after.filter.tag).toBe("work");
  expect(esc(after).filter.tag).toBe("work"); // Esc never removes non-search chips
});

test("Law 7 — open session then close restores focus + scroll byte-identically", () => {
  let s = seedRows(20, initialState(5));
  // Scroll down several pages.
  s = moveFocus(s, 12); // focus 12, scroll ~8
  const focusBefore = s.list.focus;
  const scrollBefore = s.list.scrollTop;
  expect(focusBefore).toBe(12);

  s = openSession(s, s.list.rows[12]!.id);
  expect(s.view).toBe("session");
  // Mutate nothing in list while away; closing restores.
  s = setTranscriptMode(s, "prose");
  s = cycleRoleToggle(s);
  s = esc(s); // → list, restored

  expect(s.view).toBe("list");
  expect(s.list.focus).toBe(focusBefore);
  expect(s.list.scrollTop).toBe(scrollBefore);
});

test("Law 7 — restoring also preserves the active filter + expanded chains", () => {
  let s = seedRows(10, initialState(5));
  s = { ...s, filter: { ...s.filter, harness: "codex" } };
  s = { ...s, list: { ...s.list, expandedChains: new Set([3, 7]) } };
  s = openSession(s, 5);
  s = closeSession(s);
  expect(s.filter.harness).toBe("codex");
  expect([...s.list.expandedChains]).toEqual([3, 7]);
});

test("scroll keeps focus in view (top/bottom edges)", () => {
  let s = seedRows(50, initialState(10));
  s = moveFocus(s, 49); // jump to bottom
  expect(s.list.scrollTop).toBe(40); // 49 - 10 + 1
  s = moveFocus(s, -49); // back to top
  expect(s.list.focus).toBe(0);
  expect(s.list.scrollTop).toBe(0);
});

test("transcript mode + role toggle persist as operator memory", () => {
  let s = { ...initialState(), session: { id: 1, mode: "dialogue" as const, wrap: false, roleToggle: "all" as const, traversalIdx: null, traversal: { entries: [], indexByKey: new Map() } } };
  s = toggleTranscriptWrap(s);
  expect(s.session?.wrap).toBe(true);
  s = setTranscriptMode(s, "prose");
  expect(s.session?.mode).toBe("prose");
  s = cycleRoleToggle(s);
  expect(s.session?.roleToggle).toBe("user");
  s = cycleRoleToggle(s);
  expect(s.session?.roleToggle).toBe("assistant");
  s = cycleRoleToggle(s);
  expect(s.session?.roleToggle).toBe("all");
});

test("search reopens with the current query ready to edit", () => {
  const state = { ...initialState(), filter: { query: "existing terms" } };
  expect(beginSearch(state).searchInput).toBe("existing terms");
});

test("clearAllFilters is the ONLY path that nukes filters (chip death)", () => {
  let s = seedRows(3);
  s = { ...s, filter: { harness: "kilo", query: "git-hooks" } };
  s = clearAllFilters(s);
  expect(s.filter).toEqual({});
  expect(s.list.rows).toEqual([]); // list reset, ready for refetch
});

test("Esc walks a back stack: tag and chat excursions return to the page that opened them", () => {
  let s = seedRows(5);
  s = openSession(s, 2);
  s = { ...s, activeOrdinal: 12 };
  s = openExcursion(s, "tag", "atlas");
  expect(s.view).toBe("tag");
  s = esc(s);
  expect(s.view).toBe("session");
  expect(s.session?.id).toBe(2);
  expect(s.activeOrdinal).toBe(12);
  s = esc(s);
  expect(s.view).toBe("list");
  expect(s.stack).toEqual([]);

  s = openExcursion(seedRows(5), "chat");
  s = openSession(s, 3); // a citation click
  expect(s.view).toBe("session");
  s = esc(s);
  expect(s.view).toBe("chat");
  s = esc(s);
  expect(s.view).toBe("list");
});

test("q quits only from the bare home list", () => {
  const home = seedRows(3);
  expect(quitAllowed(home)).toBe(true);
  expect(quitAllowed(openSession(home, 1))).toBe(false);
  expect(quitAllowed(openExcursion(home, "chat"))).toBe(false);
  expect(quitAllowed({ ...home, helpOpen: true })).toBe(false);
  expect(quitAllowed(beginSearch(home))).toBe(false);
  expect(quitAllowed({ ...home, paletteInput: "" })).toBe(false);
});

test("the list wheel scrolls the viewport and carries focus; it is inert elsewhere", () => {
  let s = seedRows(50, initialState(10));
  s = scrollList(s, 3);
  expect(s.list.focus).toBe(3);
  s = scrollList(s, 30);
  expect(s.list.focus).toBe(33);
  s = scrollList(s, -100);
  expect(s.list.focus).toBe(0);
  const session = openSession(seedRows(5), 1);
  expect(scrollList(session, 3)).toBe(session);
});
