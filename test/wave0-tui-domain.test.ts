import { beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { bumpLastWrite, runMigrations } from "../src/db/index.js";
import { attachLayers } from "../src/layers/db.js";
import { publishFixtureDialogue } from "./current-generation-fixture.js";
import {
  clampTranscriptScroll,
  freezeTraversal,
  projectListRows,
  sessionKey,
  type SessionRow,
} from "../src/tui/domain.js";
import {
  applyFilterTerm,
  fetchPage,
  listFilterKey,
  type ListFilter,
} from "../src/tui/queries.js";
import {
  appendRows,
  applyQueuedLiveRows,
  closeSession,
  initialState,
  moveFocus,
  openSession,
  pendingLiveCount,
  queueLiveRows,
  reconcileRows,
  selectedRows,
  setTranscriptMode,
  toggleSelection,
  traverseSession,
} from "../src/tui/store.js";
import {
  _resetRegistry,
  executeInvocation,
  register,
  type CommandPayload,
} from "../src/tui/commands.js";

function row(id: number, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    harness: "claude",
    native_id: `native-${id}`,
    title: `session ${id}`,
    firstUser: null,
    cwd: "/project",
    project: "/project",
    last_activity: 1_720_000_000_000 - id,
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

test("stable selection and focus survive inserts and refetch coordinates", () => {
  let state = appendRows(initialState(2), [row(30), row(20), row(10)], true);
  state = moveFocus(state, 1);
  state = toggleSelection(state);
  const selectedKey = sessionKey(row(20));
  expect([...state.list.selected]).toEqual([selectedKey]);
  expect(state.list.selected.has(1)).toBe(false); // a row index is never a selection key

  state = reconcileRows(state, [row(40), row(30), row(20), row(10)], true);
  expect(state.list.focus).toBe(2);
  expect(state.list.focusKey).toBe(selectedKey);
  expect(selectedRows(state).map((item) => item.native_id)).toEqual(["native-20"]);
});

test("Law 7 restoration and frozen traversal ignore later list mutation", () => {
  const rows = [row(4), row(3, { chain_id: 9 }), row(2, { chain_id: 9 }), row(1)];
  let state = appendRows(initialState(2), rows, true);
  state = { ...state, filter: { source: "claude", model: "opus", tag: "work" } };
  state = { ...state, list: { ...state.list, expandedChains: new Set([9]) } };
  state = moveFocus(state, 2);
  state = toggleSelection(state);
  const before = {
    focus: state.list.focus,
    focusKey: state.list.focusKey,
    scrollTop: state.list.scrollTop,
    filter: listFilterKey(state.filter),
    expanded: [...state.list.expandedChains],
    selected: [...state.list.selected],
  };

  state = openSession(state, 2);
  expect(state.session?.traversal.entries.map((entry) => entry.id)).toEqual([4, 3, 2, 1]);
  state = setTranscriptMode(state, "prose");
  state = traverseSession(state, 1);
  expect(state.session?.id).toBe(1);
  expect(state.session?.mode).toBe("prose");

  // A frozen traversal is immutable operator context even if list data changes.
  state = { ...state, list: { ...state.list, rows: [row(99), ...state.list.rows] } };
  state = closeSession(state);
  // The list snapshot is restored, and focus follows n/p to the last session
  // read so the list shows where reading stopped.
  expect({
    focusKey: state.list.focusKey,
    filter: listFilterKey(state.filter),
    expanded: [...state.list.expandedChains],
    selected: [...state.list.selected],
  }).toEqual({ ...before, focusKey: '["claude","native-1"]', focus: undefined, scrollTop: undefined });
  expect(state.list.rows.map((item) => item.id)).not.toContain(99);
});

test("chain/group projections collapse, expand, aggregate, and freeze logical order", () => {
  const now = new Date(2026, 6, 19, 12).getTime();
  const rows = [
    row(5, { last_activity: now - 1000, chain_id: 7, favorite: 1 }),
    row(4, { last_activity: now - 2000 }),
    row(3, { last_activity: now - 3000, chain_id: 7 }),
  ];
  const collapsed = projectListRows(rows, new Set(), now);
  expect(collapsed.map((item) => item.kind)).toEqual(["cluster", "chain", "session"]);
  const chain = collapsed.find((item) => item.kind === "chain");
  expect(chain?.aggregate).toMatchObject({ memberCount: 2, favoriteCount: 1, msgCount: 8 });
  expect(freezeTraversal(rows, new Set()).entries.map((entry) => entry.id)).toEqual([5, 4]);

  const expanded = projectListRows(rows, new Set([7]), now);
  expect(expanded.filter((item) => item.kind === "session" && item.nested).map((item) => item.session.id)).toEqual([5, 3]);
  expect(freezeTraversal(rows, new Set([7])).entries.map((entry) => entry.id)).toEqual([5, 3, 4]);
});

test("projection cache follows in-place expanded-chain changes without stale rows", () => {
  const now = new Date(2026, 6, 19, 12).getTime();
  const rows = [
    row(1, { chain_id: 10, last_activity: now - 1 }),
    row(2, { chain_id: 10, last_activity: now - 2 }),
    row(3, { chain_id: null, last_activity: now - 3 }),
  ];
  const expanded = new Set<number>();
  const collapsed = projectListRows(rows, expanded, now);
  expect(collapsed.filter((item) => item.kind !== "cluster")).toHaveLength(2);
  expect(projectListRows(rows, expanded, now)).toBe(collapsed);
  expanded.add(10);
  const opened = projectListRows(rows, expanded, now);
  expect(opened).not.toBe(collapsed);
  expect(opened.filter((item) => item.kind !== "cluster")).toHaveLength(4);
});

test("live rows form a pill while scrolled and apply without hidden reflow", () => {
  let state = appendRows(initialState(2), [row(5), row(4), row(3), row(2), row(1)], true);
  state = moveFocus(state, 3);
  const rowsBefore = state.list.rows;
  const focusBefore = state.list.focusKey;
  const anchorBefore = state.list.scrollAnchorKey;

  state = queueLiveRows(state, [row(7), row(6), row(5)], 12);
  expect(state.list.rows.map(sessionKey)).toEqual(rowsBefore.map(sessionKey));
  expect(state.list.focusKey).toBe(focusBefore);
  expect(state.list.scrollAnchorKey).toBe(anchorBefore);
  expect(pendingLiveCount(state)).toBe(2);

  state = applyQueuedLiveRows(state, "preserve");
  expect(pendingLiveCount(state)).toBe(0);
  expect(state.list.focusKey).toBe(focusBefore);
  expect(state.list.scrollAnchorKey).toBe(anchorBefore);
  expect(state.list.rows.slice(0, 2).map((item) => item.id)).toEqual([7, 6]);
});

test("short transcript scrolling clamps to zero", () => {
  expect(clampTranscriptScroll(1, 3, 20)).toBe(0);
  expect(clampTranscriptScroll(-4, 100, 20)).toBe(0);
  expect(clampTranscriptScroll(200, 100, 20)).toBe(80);
});

test("full filter algebra composes in one query", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  attachLayers(db, null);
  const insertSession = db.prepare(`INSERT INTO sessions
    (harness,native_id,project,cwd,source_path,title,last_activity,models,tok_user,tok_assistant,tok_tool,msg_count,chain_id,orphaned,ingested_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertSession.run("claude", "match", "/p", "/p", "/src/a", "match", 1_000, '["opus"]', 10, 10, 0, 1, 77, 0, 1);
  insertSession.run("claude", "wrong-model", "/p", "/p", "/src/b", "wrong", 1_000, '["sonnet"]', 1, 1, 0, 1, 77, 0, 1);
  insertSession.run("codex", "wrong-source", "/p", "/p", "/src/c", "wrong", 1_000, '["opus"]', 1, 1, 0, 1, null, 0, 1);
  const matchId = Number((db.prepare("SELECT id FROM sessions WHERE native_id='match'").get() as { id: number }).id);
  db.prepare("INSERT INTO messages(session_id,ordinal,role,text) VALUES (?,?,?,?)").run(matchId, 0, "user", "needle cosmology");
  publishFixtureDialogue(db, matchId);
  db.prepare("INSERT INTO summaries(session_id,tier,topic_line,msg_count_covered) VALUES (?,?,?,?)").run(matchId, 1, "topic", 1);
  db.prepare("INSERT INTO tags(name,promoted_at) VALUES (?,?)").run("cosmology", 1);
  const tagId = Number((db.prepare("SELECT id FROM tags WHERE name='cosmology'").get() as { id: number }).id);
  db.prepare("INSERT INTO session_tags(session_id,tag_id) VALUES (?,?)").run(matchId, tagId);
  db.prepare(`INSERT INTO favorites
    (harness,native_id,from_ordinal,to_ordinal,span_text,topic,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("claude", "match", 0, 0, "needle cosmology", "topic", "ok", 1, 1);
  bumpLastWrite(db);

  let filter: ListFilter = {};
  filter = applyFilterTerm(filter, { kind: "query", value: "needle" });
  filter = applyFilterTerm(filter, { kind: "source", value: "claude" });
  filter = applyFilterTerm(filter, { kind: "model", value: "opus" });
  filter = applyFilterTerm(filter, { kind: "path", value: "/p" });
  filter = applyFilterTerm(filter, { kind: "tag", value: "cosmology" });
  filter = applyFilterTerm(filter, { kind: "date", value: { from: 900, to: 1_100 } });
  filter = applyFilterTerm(filter, { kind: "favorite", value: true });
  filter = applyFilterTerm(filter, { kind: "state", value: "summarized" });
  filter = applyFilterTerm(filter, { kind: "chain", value: { mode: "chain", id: 77 } });

  const page = fetchPage(db, filter, null, 20);
  expect(page.rows.map((item) => item.native_id)).toEqual(["match"]);
  expect(page.rows[0]?.favorite).toBe(1);
  db.close();
});

beforeEach(() => _resetRegistry());

test("typed command payloads share one handler across key, click, and palette", () => {
  const seen: Array<{ origin: string; payload: CommandPayload }> = [];
  register({
    id: "filter-set",
    label: "Set filter",
    contexts: ["list"],
    payloadKinds: ["filter"],
    run: (state) => ({ state }),
    runPayload: (state, payload, origin) => {
      seen.push({ origin, payload });
      return { state };
    },
  });
  const payload = { kind: "filter", operation: "set", term: { kind: "source", value: "codex" } } as const;
  const state = initialState();
  for (const origin of ["key", "click", "palette"] as const) {
    executeInvocation({ id: "filter-set", payload, origin }, state);
  }
  expect(seen.map((item) => item.origin)).toEqual(["key", "click", "palette"]);
  expect(seen.every((item) => item.payload === payload)).toBe(true);
});
