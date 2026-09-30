import { expect, test } from "bun:test";
import type { DB } from "../src/db/index.js";
import type { SessionSurfaceData } from "../src/intelligence-data.js";
import { productionInkRenderOptions, reflectFavoriteFacts, SessionSurfaceCache } from "../src/tui/app.js";
import { sessionKey, type SessionRow } from "../src/tui/domain.js";
import { initialState, moveFocus } from "../src/tui/store.js";

test("production TUI updates changed lines at 60 fps instead of repainting the full screen", () => {
  expect(productionInkRenderOptions()).toEqual({
    incrementalRendering: true,
    maxFps: 60,
  });
});

test("session surface cache coalesces navigation reads and invalidates on database revision", () => {
  const loads: Array<{ sessionId: number }> = [];
  const loader = ((_db: DB, sessionId: number): SessionSurfaceData => {
    loads.push({ sessionId });
    return {
      facts: {
        id: sessionId,
        harness: "claude",
        nativeId: `native-${sessionId}`,
        title: null,
        path: null,
        models: [],
        tags: [],
        chainMembers: 1,
        durationMs: null,
        tokens: { user: 0, assistant: 0, tool: 0 },
      },
      transcript: [{ ordinal: 0, role: "user", text: "hello", toolText: null, hasTool: false }],
    };
  });
  const cache = new SessionSurfaceCache(loader);
  const db = {} as DB;

  const first = cache.read(db, 7, 11);
  expect(cache.read(db, 7, 11)).toBe(first);
  expect(cache.read(db, 7, 11)).toBe(first);
  expect(loads).toEqual([{ sessionId: 7 }]);

  expect(cache.read(db, 8, 11).facts.id).toBe(8);
  const refreshed = cache.read(db, 7, 12);
  expect(refreshed).not.toBe(first);
  expect(loads).toEqual([{ sessionId: 7 }, { sessionId: 8 }, { sessionId: 7 }]);
});

test("session surface cache is bounded so browsing cannot accumulate the archive in memory", () => {
  const loads: number[] = [];
  const loader = ((_db: DB, sessionId: number): SessionSurfaceData => {
    loads.push(sessionId);
    return {
      facts: { id: sessionId, harness: "codex", nativeId: String(sessionId), title: null, path: null, models: [], tags: [], chainMembers: 1, durationMs: null, tokens: { user: 0, assistant: 0, tool: 0 } },
      transcript: [],
    };
  });
  const cache = new SessionSurfaceCache(loader, 2);
  const db = {} as DB;

  cache.read(db, 1, 1);
  cache.read(db, 2, 1);
  cache.read(db, 3, 1);
  cache.read(db, 1, 1);

  expect(loads).toEqual([1, 2, 3, 1]);
});

test("6K-row navigation cost stays flat instead of growing with cursor depth", () => {
  const rows = Array.from({ length: 6_000 }, (_, index): SessionRow => ({
    id: index + 1,
    harness: "codex",
    native_id: `native-${index}`,
    title: `row ${index}`,
    firstUser: null,
    cwd: null,
    project: null,
    last_activity: Date.now() - index * 1_000,
    duration_ms: null,
    tok_user: 1,
    tok_assistant: 1,
    tok_tool: 0,
    tok_total: 2,
    msg_count: 2,
    models: null,
    chain_id: null,
    favorite: 0,
    sizePct: 0,
    engagement: null,
  }));
  const firstKey = sessionKey(rows[0]!);
  let state = initialState(30);
  state = {
    ...state,
    list: { ...state.list, rows, focusKey: firstKey, projectionFocusKey: firstKey },
  };

  const started = performance.now();
  for (let index = 0; index < 6_000; index++) state = moveFocus(state, 1);
  const elapsed = performance.now() - started;

  expect(state.list.focus).toBe(5_999);
  // The former prefix scans took ~1.7s locally and got slower in every 1K
  // block. Leave generous CI headroom while still catching that regression.
  expect(elapsed).toBeLessThan(400);
});

test("favorite completion updates the visible row without waiting for live polling", () => {
  const row: SessionRow = {
    id: 1,
    harness: "claude",
    native_id: "favorite-now",
    title: "favorite now",
    firstUser: null,
    cwd: null,
    project: null,
    last_activity: 1,
    duration_ms: null,
    tok_user: 1,
    tok_assistant: 1,
    tok_tool: 0,
    tok_total: 2,
    msg_count: 2,
    models: null,
    chain_id: null,
    favorite: 0,
    sizePct: 0,
    engagement: null,
  };
  const state = initialState(20);
  state.list.rows = [row];

  const next = reflectFavoriteFacts(state, new Map([[sessionKey(row), true]]));

  expect(next.list.rows[0]?.favorite).toBe(1);
});
