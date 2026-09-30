/**
 * TUI state machine — pure reducers, no Ink. Testable directly (Law 7
 * viewport-restore, Law 9 Esc ladder). The view layer (App.tsx) wires this
 * to React state + key input.
 *
 * The list is home (Law 7): every excursion returns to it exactly as left.
 * Excursions stack: tag → session → Esc returns to the tag page, chat →
 * session → Esc returns to chat. Esc is layered (Law 9): one meaning per
 * press — close an overlay, then pop one excursion, then (at the bare list)
 * clear the selection, then the search query. Other filters die only by
 * their chips, `0`, or Ctrl-L.
 */
import type { ListFilter, SessionRow } from "./queries.js";
import {
  SessionSelection,
  firstFocusableProjectionKey,
  focusedProjection,
  freezeTraversal,
  moveProjectedCursor,
  projectListRows,
  projectedViewport,
  projectionSession,
  sessionKey,
  type FrozenTraversal,
  type ProjectedRowKey,
  type SessionKey,
} from "./domain.js";

export type View = "list" | "session" | "chat" | "tag";
export type TranscriptMode = "dialogue" | "full" | "stubs" | "prose";
export type RoleToggle = "all" | "user" | "assistant";

export interface ListState {
  rows: SessionRow[]; // accumulated loaded rows, newest-first
  focus: number; // index into rows
  /** Authoritative focus identity; `focus` is only its current render coordinate. */
  focusKey: SessionKey | null;
  /** Authoritative cursor in the clustered/chain projection. */
  projectionFocusKey: ProjectedRowKey | null;
  scrollTop: number; // top visible row index
  scrollAnchorKey: SessionKey | null;
  /** Authoritative projection viewport anchor (cluster headers included). */
  projectionScrollKey: ProjectedRowKey | null;
  fetchedAll: boolean;
  expandedChains: Set<number>;
  /** Stable source identities, never row indices. */
  selected: SessionSelection;
  /** Rows withheld while scrolled; rendered only as the `N new` pill. */
  pendingLiveRows: SessionRow[];
  pendingLiveRevision: number | null;
  /** Novel rows held at the viewport's newest edge while the operator is scrolled. */
  viewportEdgeNewCount: number;
}

export interface SessionState {
  id: number;
  mode: TranscriptMode;
  /** Whether transcript text wraps instead of clipping to one terminal row. */
  wrap: boolean;
  roleToggle: RoleToggle;
  /** traversal cursor within a chain/session sequence (n/p) */
  traversalIdx: number | null;
  traversal: FrozenTraversal;
}

/** Snapshot for Law 7: taken on session open, restored on return. */
export interface RestoreSnapshot {
  rows: SessionRow[];
  fetchedAll: boolean;
  focus: number;
  focusKey: SessionKey | null;
  projectionFocusKey: ProjectedRowKey | null;
  scrollTop: number;
  scrollAnchorKey: SessionKey | null;
  projectionScrollKey: ProjectedRowKey | null;
  filter: ListFilter;
  expandedChains: Set<number>;
  selected: SessionSelection;
  pendingLiveRows: SessionRow[];
  pendingLiveRevision: number | null;
  viewportEdgeNewCount: number;
  traversal: FrozenTraversal;
}

/** One suspended excursion beneath the current one. */
export interface ExcursionFrame {
  view: Exclude<View, "list">;
  session: SessionState | null;
  activeTag: string | null;
  activeOrdinal: number | null;
}

export interface TuiState {
  view: View;
  filter: ListFilter;
  /** What `clear-filters` returns to: the default lens, not necessarily `{}`. */
  baseFilter: ListFilter;
  /** Suspended excursions, bottom first. The list is always beneath them. */
  stack: ExcursionFrame[];
  list: ListState;
  searchInput: string | null; // null = closed; non-null = typing
  paletteInput: string | null; // null = closed; non-null = palette open
  paletteIndex: number;
  session: SessionState | null;
  restore: RestoreSnapshot | null;
  message: string;
  visibleRows: number; // viewport height, set by renderer
  peek: number | null; // session id being peeked (Space), null = closed
  helpOpen: boolean;
  activeTag: string | null;
  activeOrdinal: number | null;
  providerAvailable: boolean;
}

export function initialState(visibleRows = 40): TuiState {
  return {
    view: "list",
    filter: {},
    baseFilter: {},
    stack: [],
    list: {
      rows: [],
      focus: 0,
      focusKey: null,
      projectionFocusKey: null,
      scrollTop: 0,
      scrollAnchorKey: null,
      projectionScrollKey: null,
      fetchedAll: false,
      expandedChains: new Set(),
      selected: new SessionSelection(),
      pendingLiveRows: [],
      pendingLiveRevision: null,
      viewportEdgeNewCount: 0,
    },
    searchInput: null,
    paletteInput: null,
    paletteIndex: 0,
    session: null,
    restore: null,
    message: "",
    visibleRows,
    peek: null,
    helpOpen: false,
    activeTag: null,
    activeOrdinal: null,
    providerAvailable: false,
  };
}

// ---- list navigation ----

export function moveFocus(state: TuiState, delta: number): TuiState {
  if (state.view !== "list") return state;
  const list = state.list;
  const projections = projectListRows(list.rows, list.expandedChains);
  const currentProjectionKey = list.projectionFocusKey
    ?? projectionKeyForSessionKey(projections, list.focusKey)
    ?? firstFocusableProjectionKey(projections);
  const projectionFocusKey = moveProjectedCursor(projections, currentProjectionKey, delta);
  const logical = focusedProjection(projections, projectionFocusKey);
  const focusedRow = logical ? projectionSession(logical) : null;
  const next = focusedRow === null ? 0 : Math.max(0, rawRowIndex(list.rows, sessionKey(focusedRow)));
  const rawScrollTop = clampScroll(next, list.scrollTop, state.visibleRows);
  const viewport = projectedViewport(projections, {
    focusKey: projectionFocusKey,
    anchorKey: list.projectionScrollKey ?? projections[list.scrollTop]?.key ?? null,
  }, state.visibleRows);
  return {
    ...state,
    list: {
      ...list,
      focus: next,
      focusKey: focusedRow ? sessionKey(focusedRow) : null,
      projectionFocusKey,
      scrollTop: rawScrollTop,
      scrollAnchorKey: list.rows[rawScrollTop] ? sessionKey(list.rows[rawScrollTop]!) : null,
      projectionScrollKey: projections[viewport.startIndex]?.key ?? null,
    },
  };
}

const rawRowIndexCache = new WeakMap<object, ReadonlyMap<SessionKey, number>>();

function rawRowIndex(rows: readonly SessionRow[], key: SessionKey): number {
  let index = rawRowIndexCache.get(rows as object);
  if (!index) {
    index = new Map(rows.map((row, position) => [sessionKey(row), position] as const));
    rawRowIndexCache.set(rows as object, index);
  }
  return index.get(key) ?? -1;
}

export function openSession(state: TuiState, id: number): TuiState {
  if (state.view === "session" && state.session?.id === id) return state;
  if (state.view !== "list" && state.restore) {
    // Stack the current excursion; the list snapshot beneath stays untouched.
    const traversal = state.session?.traversal ?? state.restore.traversal;
    const index = traversal.entries.findIndex((entry) => entry.id === id);
    return {
      ...state,
      stack: [...state.stack, currentFrame(state)],
      view: "session",
      session: {
        id,
        mode: state.session?.mode ?? "dialogue",
        wrap: true,
        roleToggle: "all",
        traversalIdx: index >= 0 ? index : null,
        traversal,
      },
      activeTag: null,
      activeOrdinal: null,
      message: "",
    };
  }
  const traversal = freezeTraversal(state.list.rows, state.list.expandedChains);
  const openedRow = state.list.rows.find((row) => row.id === id);
  const openedKey = openedRow ? sessionKey(openedRow) : null;
  // Law 7: snapshot the exact list state for byte-identical restore.
  const restore: RestoreSnapshot = {
    rows: [...state.list.rows],
    fetchedAll: state.list.fetchedAll,
    focus: state.list.focus,
    focusKey: state.list.focusKey ?? (state.list.rows[state.list.focus] ? sessionKey(state.list.rows[state.list.focus]!) : null),
    projectionFocusKey: state.list.projectionFocusKey,
    scrollTop: state.list.scrollTop,
    scrollAnchorKey: state.list.scrollAnchorKey ?? (state.list.rows[state.list.scrollTop] ? sessionKey(state.list.rows[state.list.scrollTop]!) : null),
    projectionScrollKey: state.list.projectionScrollKey,
    filter: cloneFilter(state.filter),
    expandedChains: new Set(state.list.expandedChains),
    selected: state.list.selected.clone(),
    pendingLiveRows: [...state.list.pendingLiveRows],
    pendingLiveRevision: state.list.pendingLiveRevision,
    viewportEdgeNewCount: state.list.viewportEdgeNewCount,
    traversal,
  };
  return {
    ...state,
    view: "session",
    restore,
    stack: [],
    session: {
      id,
      mode: "dialogue",
      // Wrapping is the safe reader default: long turns remain reachable on
      // first open, and the setting is retained by frozen traversal.
      wrap: true,
      roleToggle: "all",
      traversalIdx: openedKey === null ? null : (traversal.indexByKey.get(openedKey) ?? null),
      traversal,
    },
    message: "",
  };
}

export function closeSession(state: TuiState): TuiState {
  if (state.view !== "session") return state;
  return closeExcursion(state);
}

/** Open a non-session excursion while preserving the same exact list snapshot. */
export function openExcursion(state: TuiState, view: "chat" | "tag", tag: string | null = null): TuiState {
  if (state.view === view && (view === "chat" || state.activeTag === tag)) return state;
  if (state.view !== "list" && state.restore) {
    return {
      ...state,
      stack: [...state.stack, currentFrame(state)],
      view,
      session: null,
      activeTag: view === "tag" ? tag : null,
      activeOrdinal: null,
      message: "",
    };
  }
  if (state.view !== "list") return state;
  const focused = focusedSessionRow(state);
  const seeded = focused ? openSession(state, focused.id) : openSessionWithEmptyRestore(state);
  return {
    ...seeded,
    view,
    session: null,
    activeTag: view === "tag" ? tag : null,
    message: "",
  };
}

function currentFrame(state: TuiState): ExcursionFrame {
  return { view: state.view as ExcursionFrame["view"], session: state.session, activeTag: state.activeTag, activeOrdinal: state.activeOrdinal };
}

/** Back one level: the excursion beneath, or the list when none remains. */
export function popExcursion(state: TuiState): TuiState {
  if (state.view === "list") return state;
  const frame = state.stack.at(-1);
  if (!frame) return closeExcursion(state);
  return {
    ...state,
    stack: state.stack.slice(0, -1),
    view: frame.view,
    session: frame.session,
    activeTag: frame.activeTag,
    activeOrdinal: frame.activeOrdinal,
    message: "",
  };
}

/**
 * Return any excursion to the byte-for-byte list snapshot. The one permitted
 * difference: when n/p traversal moved the reader, focus follows to the last
 * session read so the operator lands where they left off.
 */
export function closeExcursion(state: TuiState): TuiState {
  if (state.view === "list" || !state.restore) return state;
  const r = state.restore;
  const base = state.stack[0] ?? currentFrame(state);
  const last = base.view === "session" && base.session?.traversalIdx != null
    ? base.session.traversal.entries[base.session.traversalIdx]?.key ?? null
    : null;
  const restored = restoreList(state, r);
  if (last === null || last === r.focusKey || !r.rows.some((row) => sessionKey(row) === last)) return restored;
  const projections = projectListRows(restored.list.rows, restored.list.expandedChains);
  const projectionFocusKey = projectionKeyForSessionKey(projections, last);
  if (projectionFocusKey === null) return restored;
  return moveFocus({ ...restored, list: { ...restored.list, focusKey: last, projectionFocusKey } }, 0);
}

function restoreList(state: TuiState, r: RestoreSnapshot): TuiState {
  return {
    ...state,
    view: "list",
    session: null,
    restore: null,
    stack: [],
    activeTag: null,
    activeOrdinal: null,
    filter: cloneFilter(r.filter),
    list: {
      ...state.list,
      rows: [...r.rows],
      fetchedAll: r.fetchedAll,
      focus: r.focus,
      focusKey: r.focusKey,
      projectionFocusKey: r.projectionFocusKey,
      scrollTop: r.scrollTop,
      scrollAnchorKey: r.scrollAnchorKey,
      projectionScrollKey: r.projectionScrollKey,
      expandedChains: new Set(r.expandedChains),
      selected: r.selected.clone(),
      pendingLiveRows: [...r.pendingLiveRows],
      pendingLiveRevision: r.pendingLiveRevision,
      viewportEdgeNewCount: r.viewportEdgeNewCount,
    },
  };
}

function openSessionWithEmptyRestore(state: TuiState): TuiState {
  const traversal = freezeTraversal(state.list.rows, state.list.expandedChains);
  return {
    ...state,
    restore: {
      rows: [...state.list.rows],
      fetchedAll: state.list.fetchedAll,
      focus: state.list.focus,
      focusKey: state.list.focusKey,
      projectionFocusKey: state.list.projectionFocusKey,
      scrollTop: state.list.scrollTop,
      scrollAnchorKey: state.list.scrollAnchorKey,
      projectionScrollKey: state.list.projectionScrollKey,
      filter: cloneFilter(state.filter),
      expandedChains: new Set(state.list.expandedChains),
      selected: state.list.selected.clone(),
      pendingLiveRows: [...state.list.pendingLiveRows],
      pendingLiveRevision: state.list.pendingLiveRevision,
      viewportEdgeNewCount: state.list.viewportEdgeNewCount,
      traversal,
    },
  };
}

// ---- Esc ladder (Law 9): one meaning per press, never clears filters ----

export function esc(state: TuiState): TuiState {
  // 1. Close any overlay (help, palette, peek, search input). Highest priority.
  if (state.helpOpen) return { ...state, helpOpen: false };
  if (state.paletteInput !== null) return { ...state, paletteInput: null, paletteIndex: 0 };
  if (state.peek !== null) return { ...state, peek: null };
  if (state.searchInput !== null) return { ...state, searchInput: null };
  // 2. Leave one excursion. The list selection is list state and survives.
  if (state.view !== "list") return popExcursion(state);
  // 3. At the bare list: selection, then the search query, then nothing.
  if (state.list.selected.size > 0) return clearSelection(state);
  if (state.filter.query) return { ...state, filter: { ...state.filter, query: null }, list: emptyListForRefetch(state.list), peek: null, message: "search cleared" };
  return state;
}

/** `q` quits only from the bare list with no overlay; elsewhere it is Esc. */
export function quitAllowed(state: TuiState): boolean {
  return state.view === "list" && !state.helpOpen && state.paletteInput === null && state.searchInput === null && state.peek === null;
}

// ---- search as a chip ----

export function beginSearch(state: TuiState): TuiState {
  // Reopening search edits the current query instead of forcing a remove and
  // full retype cycle.
  return { ...state, searchInput: state.filter.query ?? "" };
}

export function typeSearch(state: TuiState, ch: string): TuiState {
  if (state.searchInput === null) return state;
  return { ...state, searchInput: state.searchInput + ch };
}

export function commitSearch(state: TuiState): TuiState {
  if (state.searchInput === null) return state;
  const q = state.searchInput.trim();
  // Compose as a chip: empty query clears the search chip only (not other filters).
  const filter = { ...state.filter, query: q || null };
  return {
    ...state,
    searchInput: null,
    filter,
    list: emptyListForRefetch(state.list),
    peek: null,
    message: q ? `q:"${q}"` : "search cleared",
  };
}

export function clearAllFilters(state: TuiState): TuiState {
  return {
    ...state,
    filter: cloneFilter(state.baseFilter),
    list: emptyListForRefetch(state.list),
    peek: null,
    message: "filters cleared",
  };
}

/** A filter change refetches the list; a peek of the old list closes with it. */
export function replaceFilter(state: TuiState, filter: ListFilter, message = "filter updated"): TuiState {
  return { ...state, filter, list: emptyListForRefetch(state.list), peek: null, message };
}

// ---- session transcript modes (persist across traversal — operator memory) ----

export function setTranscriptMode(state: TuiState, mode: TranscriptMode): TuiState {
  if (!state.session) return state;
  return { ...state, session: { ...state.session, mode } };
}

export function toggleTranscriptWrap(state: TuiState): TuiState {
  if (!state.session) return state;
  const wrap = !state.session.wrap;
  return { ...state, session: { ...state.session, wrap }, message: wrap ? "transcript wrap on" : "transcript wrap off" };
}

export function cycleRoleToggle(state: TuiState): TuiState {
  if (!state.session) return state;
  const next: RoleToggle =
    state.session.roleToggle === "all" ? "user" : state.session.roleToggle === "user" ? "assistant" : "all";
  return { ...state, session: { ...state.session, roleToggle: next } };
}

export function cycleTranscriptMode(state: TuiState): TuiState {
  if (!state.session) return state;
  const mode: TranscriptMode = state.session.mode === "dialogue" || state.session.mode === "prose" ? "stubs" : state.session.mode === "stubs" ? "full" : "dialogue";
  return { ...state, session: { ...state.session, mode }, message: `${transcriptModeName(mode)} view` };
}

export function transcriptModeName(mode: TranscriptMode): string {
  return mode === "stubs" ? "activity" : mode === "full" ? "activity + tool output" : "dialogue";
}

export function traverseSession(state: TuiState, delta: number): TuiState {
  if (!state.session || state.session.traversal.entries.length === 0) return state;
  if (state.session.traversalIdx === null) return { ...state, message: "n/p follow the list order; this session came from a citation" };
  const current = state.session.traversalIdx;
  const next = clamp(current + delta, 0, state.session.traversal.entries.length - 1);
  const entry = state.session.traversal.entries[next];
  if (!entry) return state;
  if (next === current) return { ...state, message: delta > 0 ? "last session in this list" : "first session in this list" };
  return { ...state, session: { ...state.session, id: entry.id, traversalIdx: next }, activeOrdinal: null };
}

// ---- viewport helpers ----

/**
 * Wheel scrolling moves the viewport, and the cursor rides along at the same
 * screen row. At either end the viewport stops and the cursor keeps moving.
 */
export function scrollList(state: TuiState, delta: number): TuiState {
  if (state.view !== "list" || delta === 0) return state;
  const projections = projectListRows(state.list.rows, state.list.expandedChains);
  if (projections.length === 0) return state;
  const viewport = projectedViewport(projections, { focusKey: state.list.projectionFocusKey, anchorKey: state.list.projectionScrollKey }, state.visibleRows);
  const maxStart = Math.max(0, projections.length - state.visibleRows);
  const start = clamp(viewport.startIndex + delta, 0, Math.max(viewport.startIndex, maxStart));
  const anchored = { ...state, list: { ...state.list, projectionScrollKey: projections[start]?.key ?? null } };
  return moveFocus(anchored, delta);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function clampScroll(focus: number, scrollTop: number, visible: number): number {
  if (focus < scrollTop) return focus;
  if (focus >= scrollTop + visible) return focus - visible + 1;
  return scrollTop;
}

/** When new rows are appended to the list (page fetch), merge them. */
export function appendRows(state: TuiState, rows: SessionRow[], fetchedAll: boolean): TuiState {
  if (state.view !== "list") return state;
  const list = state.list;
  const seen = new Set(list.rows.map(sessionKey));
  const appended = rows.filter((row) => {
    const key = sessionKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const merged = [...list.rows, ...appended];
  return { ...state, list: reconcileCoordinates({ ...list, rows: merged, fetchedAll }) };
}

/** Replace a refetched page without retargeting focus or selection. */
export function reconcileRows(state: TuiState, rows: SessionRow[], fetchedAll: boolean): TuiState {
  if (state.view !== "list") return state;
  const deduped = dedupeRows(rows);
  return { ...state, list: reconcileCoordinates({ ...state.list, rows: deduped, fetchedAll }) };
}

/** Reset the list (filter change) — caller refetches the first page. */
export function resetList(state: TuiState): TuiState {
  return {
    ...state,
    list: {
      rows: [],
      focus: 0,
      focusKey: null,
      projectionFocusKey: null,
      scrollTop: 0,
      scrollAnchorKey: null,
      projectionScrollKey: null,
      fetchedAll: false,
      expandedChains: state.list.expandedChains,
      selected: new SessionSelection(),
      pendingLiveRows: [],
      pendingLiveRevision: null,
      viewportEdgeNewCount: 0,
    },
  };
}

// ---- selection model (M4): x toggle, * select-all-visible, shift-extend ----

export function toggleSelection(state: TuiState): TuiState {
  if (state.view !== "list") return state;
  const row = focusedSessionRow(state);
  if (!row) return state;
  const key = sessionKey(row);
  const selected = state.list.selected.clone();
  if (selected.has(key)) {
    selected.delete(key);
    return { ...state, list: { ...state.list, selected }, message: `deselected ${row.harness}/${row.native_id}` };
  }
  selected.add(key);
  return { ...state, list: { ...state.list, selected }, message: `selected ${row.harness}/${row.native_id} (${selected.size})` };
}

export function selectAllVisible(state: TuiState): TuiState {
  if (state.view !== "list") return state;
  const projections = projectListRows(state.list.rows, state.list.expandedChains);
  const viewport = projectedViewport(projections, {
    focusKey: state.list.projectionFocusKey,
    anchorKey: state.list.projectionScrollKey,
  }, state.visibleRows);
  const selected = new SessionSelection(viewport.rows.filter((row) => row.kind !== "cluster").map((row) => sessionKey(projectionSession(row))));
  return { ...state, list: { ...state.list, selected }, message: `selected ${selected.size} rows` };
}

/** `*` selects the entire current filter, supplied as stable identities. */
export function selectAllKeys(state: TuiState, keys: Iterable<SessionKey>): TuiState {
  if (state.view !== "list") return state;
  const selected = new SessionSelection(keys);
  return { ...state, list: { ...state.list, selected }, message: `selected ${selected.size} rows in filter` };
}

export function clearSelection(state: TuiState): TuiState {
  const restore = state.restore === null ? null : { ...state.restore, selected: new SessionSelection() };
  return {
    ...state,
    restore,
    list: { ...state.list, selected: new SessionSelection() },
    message: "selection cleared",
  };
}

export function toggleChain(state: TuiState, chainId?: number | null): TuiState {
  if (state.view !== "list") return state;
  const row = focusedSessionRow(state);
  const id = chainId ?? row?.chain_id ?? null;
  if (id === null) return state;
  const expandedChains = new Set(state.list.expandedChains);
  const wasExpanded = expandedChains.has(id);
  if (wasExpanded) expandedChains.delete(id); else expandedChains.add(id);
  const nextList = reconcileProjectionCoordinates({
    ...state.list,
    expandedChains,
    projectionFocusKey: wasExpanded ? `chain:${id}` : state.list.projectionFocusKey,
  }, state.visibleRows);
  return { ...state, list: nextList, message: `${expandedChains.has(id) ? "expanded" : "collapsed"} chain ${id}` };
}

export function extendSelection(state: TuiState, fromFocus: number): TuiState {
  if (state.view !== "list") return state;
  const selected = state.list.selected.clone();
  const lo = Math.min(fromFocus, state.list.focus);
  const hi = Math.max(fromFocus, state.list.focus);
  for (let i = lo; i <= hi; i++) {
    const row = state.list.rows[i];
    if (row) selected.add(sessionKey(row));
  }
  return { ...state, list: { ...state.list, selected }, message: `extended ${lo}-${hi}` };
}

export function extendSelectionFromKey(state: TuiState, anchor: SessionKey): TuiState {
  if (state.view !== "list") return state;
  const projections = projectListRows(state.list.rows, state.list.expandedChains).filter((row) => row.kind !== "cluster");
  const anchorIndex = projections.findIndex((row) => sessionKey(projectionSession(row)) === anchor);
  const focusIndex = projections.findIndex((row) => row.key === state.list.projectionFocusKey);
  if (anchorIndex < 0 || focusIndex < 0) return state;
  const selected = state.list.selected.clone();
  const lo = Math.min(anchorIndex, focusIndex);
  const hi = Math.max(anchorIndex, focusIndex);
  for (let index = lo; index <= hi; index++) selected.add(sessionKey(projectionSession(projections[index]!)));
  return { ...state, list: { ...state.list, selected }, message: `extended ${lo}-${hi}` };
}

export function selectedRows(state: TuiState): SessionRow[] {
  return state.list.rows.filter((row) => state.list.selected.has(sessionKey(row)));
}

// ---- live invalidation (Law 8: never reflow a scrolled viewport) ----

export function queueLiveRows(state: TuiState, incoming: SessionRow[], revision: number): TuiState {
  if (state.view !== "list" || incoming.length === 0) return state;
  const latestByKey = new Map(incoming.map((row) => [sessionKey(row), row]));
  // Refresh row facts (favorite/state/topic metrics) in place. This cannot
  // reflow a scrolled viewport because existing order and coordinates stay.
  const refreshedRows = state.list.rows.map((row) => latestByKey.get(sessionKey(row)) ?? row);
  const known = new Set([...state.list.rows, ...state.list.pendingLiveRows].map(sessionKey));
  const novel = incoming.filter((row) => {
    const key = sessionKey(row);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  if (novel.length === 0) {
    return { ...state, list: reconcileCoordinates({ ...state.list, rows: refreshedRows, pendingLiveRevision: revision }) };
  }
  if (state.list.scrollTop === 0) {
    const rows = [...novel, ...refreshedRows];
    return {
      ...state,
      list: reconcileCoordinates({ ...state.list, rows, pendingLiveRevision: revision, viewportEdgeNewCount: 0 }),
    };
  }
  return {
    ...state,
    list: {
      ...state.list,
      rows: refreshedRows,
      pendingLiveRows: [...state.list.pendingLiveRows, ...novel],
      pendingLiveRevision: revision,
      viewportEdgeNewCount: state.list.pendingLiveRows.length + novel.length,
    },
  };
}

export function pendingLiveCount(state: TuiState): number {
  return state.list.viewportEdgeNewCount;
}

export interface ViewportEdgeLiveState {
  edge: "top";
  count: number;
  revision: number | null;
  visible: boolean;
}

export function viewportEdgeLiveState(state: TuiState): ViewportEdgeLiveState {
  return {
    edge: "top",
    count: state.list.viewportEdgeNewCount,
    revision: state.list.pendingLiveRevision,
    visible: state.list.viewportEdgeNewCount > 0,
  };
}

export function applyQueuedLiveRows(state: TuiState, destination: "top" | "preserve" = "top"): TuiState {
  if (state.view !== "list" || state.list.pendingLiveRows.length === 0) return state;
  const rows = dedupeRows([...state.list.pendingLiveRows, ...state.list.rows]);
  const cleared = reconcileCoordinates({ ...state.list, rows, pendingLiveRows: [], viewportEdgeNewCount: 0 });
  if (destination === "preserve") return { ...state, list: cleared };
  return {
    ...state,
    list: {
      ...cleared,
      focus: 0,
      focusKey: rows[0] ? sessionKey(rows[0]) : null,
      scrollTop: 0,
      scrollAnchorKey: rows[0] ? sessionKey(rows[0]) : null,
      projectionFocusKey: firstFocusableProjectionKey(projectListRows(rows, cleared.expandedChains)),
      projectionScrollKey: projectListRows(rows, cleared.expandedChains)[0]?.key ?? null,
    },
  };
}

// ---- palette (M4): : opens, fuzzy search, Enter executes ----

export function openPalette(state: TuiState): TuiState {
  return { ...state, paletteInput: "", paletteIndex: 0 };
}

export function toggleHelp(state: TuiState): TuiState {
  return { ...state, helpOpen: !state.helpOpen };
}

export function toggleRole(state: TuiState, role: "user" | "assistant"): TuiState {
  if (!state.session) return state;
  const roleToggle: RoleToggle = state.session.roleToggle === role ? "all" : role;
  return { ...state, session: { ...state.session, roleToggle } };
}

export function landOnOrdinal(state: TuiState, ordinal: number | null): TuiState {
  return { ...state, activeOrdinal: ordinal };
}

export function typePalette(state: TuiState, ch: string): TuiState {
  if (state.paletteInput === null) return state;
  return { ...state, paletteInput: state.paletteInput + ch, paletteIndex: 0 };
}

export function movePalette(state: TuiState, delta: number): TuiState {
  return { ...state, paletteIndex: Math.max(0, state.paletteIndex + delta) };
}

export function closePalette(state: TuiState): TuiState {
  return { ...state, paletteInput: null, paletteIndex: 0 };
}

// ---- peek (M4): Space on focused row, instant popover, no view change ----

export function togglePeek(state: TuiState): TuiState {
  if (state.view !== "list") return state;
  const row = focusedSessionRow(state);
  if (!row) return state;
  return { ...state, peek: state.peek === row.id ? null : row.id };
}

function cloneFilter(filter: ListFilter): ListFilter {
  return {
    ...filter,
    date: filter.date ? { ...filter.date } : filter.date,
    chain: filter.chain ? { ...filter.chain } : filter.chain,
  };
}

function emptyListForRefetch(list: ListState): ListState {
  return {
    ...list,
    rows: [],
    focus: 0,
    focusKey: null,
    projectionFocusKey: null,
    scrollTop: 0,
    scrollAnchorKey: null,
    projectionScrollKey: null,
    fetchedAll: false,
    selected: new SessionSelection(),
    pendingLiveRows: [],
    pendingLiveRevision: null,
    viewportEdgeNewCount: 0,
  };
}

function dedupeRows(rows: readonly SessionRow[]): SessionRow[] {
  const seen = new Set<SessionKey>();
  return rows.filter((row) => {
    const key = sessionKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reconcileCoordinates(list: ListState): ListState {
  if (list.rows.length === 0) {
    return {
      ...list,
      focus: 0,
      focusKey: null,
      projectionFocusKey: null,
      scrollTop: 0,
      scrollAnchorKey: null,
      projectionScrollKey: null,
    };
  }
  const intendedFocus = list.focusKey ?? (list.rows[list.focus] ? sessionKey(list.rows[list.focus]!) : null);
  const focusByKey = intendedFocus === null ? -1 : list.rows.findIndex((row) => sessionKey(row) === intendedFocus);
  const focus = focusByKey >= 0 ? focusByKey : clamp(list.focus, 0, list.rows.length - 1);
  const intendedAnchor = list.scrollAnchorKey ?? (list.rows[list.scrollTop] ? sessionKey(list.rows[list.scrollTop]!) : null);
  const anchorByKey = intendedAnchor === null ? -1 : list.rows.findIndex((row) => sessionKey(row) === intendedAnchor);
  const scrollTop = anchorByKey >= 0 ? anchorByKey : clamp(list.scrollTop, 0, Math.max(0, list.rows.length - 1));
  return reconcileProjectionCoordinates({
    ...list,
    focus,
    focusKey: sessionKey(list.rows[focus]!),
    scrollTop,
    scrollAnchorKey: sessionKey(list.rows[scrollTop]!),
  }, Number.MAX_SAFE_INTEGER);
}

function projectionKeyForSessionKey(
  projections: ReturnType<typeof projectListRows>,
  key: SessionKey | null,
): ProjectedRowKey | null {
  if (key === null) return null;
  const direct = projections.find((row) => row.kind === "session" && row.key === key);
  if (direct) return direct.key;
  const chain = projections.find((row) => row.kind === "chain" && sessionKey(row.head) === key);
  return chain?.key ?? null;
}

function reconcileProjectionCoordinates(list: ListState, visibleRows: number): ListState {
  const projections = projectListRows(list.rows, list.expandedChains);
  const desired = list.projectionFocusKey
    ?? projectionKeyForSessionKey(projections, list.focusKey)
    ?? firstFocusableProjectionKey(projections);
  const logical = focusedProjection(projections, desired);
  const projectionFocusKey = logical?.key ?? null;
  const row = logical ? projectionSession(logical) : null;
  const rawIndex = row ? list.rows.findIndex((candidate) => sessionKey(candidate) === sessionKey(row)) : -1;
  const viewport = projectedViewport(projections, {
    focusKey: projectionFocusKey,
    anchorKey: list.projectionScrollKey ?? projectionKeyForSessionKey(projections, list.scrollAnchorKey),
  }, visibleRows);
  return {
    ...list,
    focus: rawIndex >= 0 ? rawIndex : list.focus,
    focusKey: row ? sessionKey(row) : null,
    projectionFocusKey,
    projectionScrollKey: projections[viewport.startIndex]?.key ?? null,
  };
}

/** Logical projection and line-budgeted viewport for the production renderer. */
export function logicalListViewport(state: TuiState) {
  const projections = projectListRows(state.list.rows, state.list.expandedChains);
  return projectedViewport(projections, {
    focusKey: state.list.projectionFocusKey,
    anchorKey: state.list.projectionScrollKey,
  }, state.visibleRows);
}

/** Focused underlying session, including a collapsed chain's stable head. */
export function focusedSessionRow(state: TuiState): SessionRow | null {
  const projections = projectListRows(state.list.rows, state.list.expandedChains);
  const logical = focusedProjection(projections,
    state.list.projectionFocusKey ?? projectionKeyForSessionKey(projections, state.list.focusKey));
  return logical ? projectionSession(logical) : null;
}
