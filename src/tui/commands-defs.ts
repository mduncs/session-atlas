/** Canonical TUI command lattice: keys, clicks, and palette resolve here. */
import { register } from "./commands.js";
import {
  applyQueuedLiveRows,
  beginSearch,
  clearAllFilters,
  clearSelection,
  closeExcursion,
  cycleTranscriptMode,
  esc,
  focusedSessionRow,
  moveFocus,
  landOnOrdinal,
  openExcursion,
  openPalette,
  openSession,
  replaceFilter,
  selectAllVisible,
  setTranscriptMode,
  toggleChain,
  toggleHelp,
  togglePeek,
  toggleRole,
  toggleSelection,
  toggleTranscriptWrap,
  traverseSession,
  type TuiState,
  type TranscriptMode,
} from "./store.js";
import { applyFilterTerm, removeFilterTerm, type FilterTerm, type ListFilter } from "./queries.js";
import { sessionKey, type SessionKey } from "./domain.js";

let initialized = false;

export function commandContext(state: TuiState): "list" | "session" | "chat" | "tag" | "search" {
  return state.searchInput !== null ? "search" : state.view;
}

/** Register once in production. Tests may call `_allowReinit` after resetting. */
export function registerCommands(): void {
  if (initialized) return;
  initialized = true;

  // Movement. In a session the shell maps these onto messages and lines.
  register({ id: "nav-down", label: "Move down", contexts: ["list", "session", "tag"], keys: ["j", "↓"], run: (s) => ({ state: moveFocus(s, 1) }) });
  register({ id: "nav-up", label: "Move up", contexts: ["list", "session", "tag"], keys: ["k", "↑"], run: (s) => ({ state: moveFocus(s, -1) }) });
  register({ id: "nav-page-down", label: "Page down", contexts: ["list", "session"], keys: ["PageDown"], run: (s) => ({ state: moveFocus(s, Math.max(1, s.visibleRows - 1)) }) });
  register({ id: "nav-page-up", label: "Page up", contexts: ["list", "session"], keys: ["PageUp"], run: (s) => ({ state: moveFocus(s, -Math.max(1, s.visibleRows - 1)) }) });
  register({ id: "nav-home", label: "Go to top", contexts: ["list", "session"], keys: ["Home"], run: (s) => ({ state: moveFocus(s, -Number.MAX_SAFE_INTEGER) }) });
  register({ id: "nav-end", label: "Go to bottom", contexts: ["list", "session"], keys: ["End"], run: (s) => ({ state: moveFocus(s, Number.MAX_SAFE_INTEGER) }) });
  register({
    id: "open-session", label: "Open session", contexts: ["list", "tag", "chat"], keys: ["↵", "Enter"],
    disabled: (s) => s.view === "list" && s.list.rows.length === 0 ? "no sessions" : null,
    run: (s, arg) => {
      const id = arg ? Number(arg) : focusedSessionRow(s)?.id;
      return Number.isSafeInteger(id) ? { state: openSession(s, id!) } : { state: s, message: "nothing to open" };
    },
  });
  // Citations stack on the current excursion: Esc returns to the page that cited them.
  register({
    id: "navigate-session", label: "Open session citation", contexts: ["list", "session", "chat", "tag"],
    run: (s, arg) => {
      const match = /^(\d+)(?::(\d+))?$/.exec(arg ?? "");
      if (!match) return { state: s, message: "invalid session citation" };
      return { state: landOnOrdinal(openSession(s, Number(match[1])), match[2] ? Number(match[2]) : null) };
    },
  });
  register({ id: "land-ordinal", label: "Land transcript ordinal", contexts: ["session"], run: (s, arg) => ({ state: landOnOrdinal(s, arg === undefined ? null : Number(arg)) }) });
  register({ id: "open-chat", label: "Grounded chat", contexts: ["list", "session", "tag"], keys: ["c"], run: (s) => ({ state: openExcursion(s, "chat") }) });
  register({ id: "open-tag", label: "Open tag page", contexts: ["list", "session"], keys: ["#"], run: (s, arg) => ({ state: openExcursion(s, "tag", arg ?? s.filter.tag ?? null) }) });

  // Filters always apply to the list: from any excursion they return home first.
  register({
    id: "filter-harness", label: "Filter: Claude (1) / Codex (2)", contexts: ["list"], keys: ["1", "2"],
    run: (s, arg) => {
      if (!arg) return { state: s, message: "specify source" };
      const source = (s.filter.source ?? s.filter.harness) === arg ? null : arg;
      const filter: ListFilter = { ...s.filter, source, harness: null };
      return { state: replaceFilter(s, filter, source ? `source:${source}` : "source cleared") };
    },
  });
  register({
    id: "filter-origin", label: "Creator lens: human-started / everything / agent", contexts: ["list"], keys: ["g"],
    run: (s) => {
      const origin = s.filter.origin === "human" ? null : s.filter.origin == null ? "agent" : "human";
      return { state: replaceFilter(s, { ...s.filter, origin }, origin === "human" ? "human-started sessions (g: show everything)" : origin ? `creator:${origin}` : "showing everything (g: agent only)") };
    },
  });
  register({ id: "filter-set", label: "Set filter", contexts: ["list", "session", "tag", "chat"], run: (s, arg) => ({ state: setFilterFromArg(s, arg) }) });
  register({
    id: "filter-remove", label: "Remove filter chip", contexts: ["list", "session", "tag", "chat"],
    run: (s, arg) => {
      if (!arg) return { state: s };
      const list = closeToList(s);
      return { state: replaceFilter(list, removeFilterTerm(list.filter, arg as FilterTerm["kind"]), `${arg} filter removed`) };
    },
  });
  register({ id: "clear-filters", label: "Reset filters to the default lens", contexts: ["list"], keys: ["ctrl-l", "0"], run: (s) => ({ state: clearAllFilters(s) }) });
  register({ id: "search", label: "Search archive", contexts: ["list", "session", "tag"], keys: ["/", "ctrl-f"], run: (s) => ({ state: beginSearch(closeToList(s)) }) });

  register({ id: "select-toggle", label: "Select / deselect row", contexts: ["list"], keys: ["x"], run: (s) => ({ state: toggleSelection(s) }) });
  register({ id: "select-clear", label: "Clear selection", contexts: ["list"], run: (s) => ({ state: clearSelection(s) }) });
  // The shell replaces visible-only selection with the DB-backed whole-filter result.
  register({ id: "select-all-filter", label: "Select all in filter", contexts: ["list"], keys: ["*"], run: (s) => ({ state: selectAllVisible(s) }) });
  register({ id: "chain-toggle", label: "Expand or collapse chain", contexts: ["list"], keys: ["→"], run: (s, arg) => ({ state: toggleChain(s, arg ? Number(arg) : null) }) });
  register({ id: "peek", label: "Peek", contexts: ["list"], keys: ["Space"], run: (s, arg) => ({ state: togglePeek(focusListKey(s, arg)) }) });
  register({ id: "live-apply", label: "Apply live updates", contexts: ["list"], keys: ["r"], disabled: (s) => s.list.pendingLiveRows.length === 0 ? "no queued live rows" : null, run: (s) => ({ state: applyQueuedLiveRows(s) }) });

  register({ id: "favorite", label: "Toggle favorite", contexts: ["list", "session"], keys: ["f"], run: (s, arg) => ({ state: { ...focusListKey(s, arg), message: "favorite requested" } }) });
  // The shell writes md's correction to the layers DB; this id gives keys, clicks and the palette one door.
  register({ id: "creator-toggle", label: "Mark session human / agent started", contexts: ["list", "session"], keys: ["h"], run: (s, arg) => ({ state: focusListKey(s, arg) }) });
  register({ id: "export", label: "Export / continue", contexts: ["list", "session", "tag"], keys: ["e"], run: (s) => ({ state: { ...s, message: "export requested" } }) });
  register({ id: "yank", label: "Copy (y message or title · Y all dialogue)", contexts: ["list", "session", "chat", "tag"], keys: ["y", "Y"], run: (s) => ({ state: { ...s, message: "yank requested" } }) });
  // The shell owns the reversible side effect; this command gives reader
  // controls and the palette one canonical action id to invoke.
  register({ id: "processing-status", label: "Summary processing status / setup", contexts: ["list", "session"], run: (s) => ({ state: s }) });
  register({ id: "undo", label: "Undo last action", contexts: ["session", "list", "chat", "tag"], run: (s) => ({ state: { ...s, message: "undo requested" } }) });

  register({ id: "palette", label: "Command palette", contexts: ["list", "session", "chat", "tag"], keys: [":"], run: (s) => ({ state: openPalette(s) }) });
  register({ id: "help", label: "Full keymap", contexts: ["list", "session", "chat", "tag"], keys: ["?"], run: (s) => ({ state: toggleHelp(s) }) });
  register({ id: "back", label: "Back one level (overlay, excursion, selection, search)", contexts: ["list", "session", "chat", "tag"], keys: ["Esc"], run: (s) => ({ state: esc(s) }) });
  register({ id: "close-view", label: "Back one level (same as Esc)", contexts: ["session", "chat", "tag"], keys: ["q"], run: (s) => ({ state: esc(s) }) });
  register({ id: "go-home", label: "Return to the list", contexts: ["session", "chat", "tag"], run: (s) => ({ state: closeExcursion(s) }) });
  register({
    id: "tag-resynthesize", label: "Resynthesize tag arc", contexts: ["tag"], keys: ["r"],
    disabled: (s) => s.providerAvailable ? null : "no providers configured",
    run: (s) => ({ state: { ...s, message: "tag resynthesis requested" } }),
  });
  register({ id: "quit", label: "Quit", contexts: ["list"], keys: ["q"], run: (s) => ({ state: s, exit: true }) });

  // Reader. One mode key cycles; the header's mode tabs are the clickable door.
  register({ id: "mode-cycle", label: "Cycle view: dialogue / activity / activity + tool output", contexts: ["session"], keys: ["m"], run: (s) => ({ state: cycleTranscriptMode(s) }) });
  for (const mode of ["dialogue", "stubs", "full", "prose"] as const) {
    register({ id: `mode-${mode}`, label: `Transcript view: ${mode === "stubs" ? "activity" : mode === "full" ? "activity + tool output" : mode}`, contexts: ["session"], run: (s) => ({ state: setTranscriptMode(s, mode as TranscriptMode) }) });
  }
  register({ id: "transcript-expand", label: "Expand / fold the current message's tools and injections", contexts: ["session"], keys: ["↵", "Enter"], run: (s) => ({ state: s }) });
  register({ id: "session-about", label: "Show / hide the summary and facts pane", contexts: ["session"], keys: ["s"], run: (s) => ({ state: s }) });
  register({ id: "transcript-wrap", label: "Toggle transcript wrapping", contexts: ["session"], keys: ["w"], run: (s) => ({ state: toggleTranscriptWrap(s) }) });
  register({ id: "role-user", label: "Emphasize your messages", contexts: ["session"], run: (s) => ({ state: toggleRole(s, "user") }) });
  register({ id: "role-assistant", label: "Emphasize assistant messages", contexts: ["session"], run: (s) => ({ state: toggleRole(s, "assistant") }) });
  register({ id: "traverse-next", label: "Next session in list order", contexts: ["session"], keys: ["n"], run: (s) => ({ state: traverseSession(s, 1) }) });
  register({ id: "traverse-prev", label: "Previous session in list order", contexts: ["session"], keys: ["p"], run: (s) => ({ state: traverseSession(s, -1) }) });
  register({ id: "span-mark", label: "Mark a message span (x start/extend, x again clears)", contexts: ["session"], keys: ["x"], run: (s) => ({ state: s }) });
  register({ id: "episode-prev", label: "Previous episode", contexts: ["session"], keys: ["["], run: (s) => ({ state: s }) });
  register({ id: "episode-next", label: "Next episode", contexts: ["session"], keys: ["]"], run: (s) => ({ state: s }) });
}

function setFilterFromArg(state: TuiState, arg?: string): TuiState {
  if (!arg) return { ...state, message: "missing filter payload" };
  try {
    const term = JSON.parse(arg) as FilterTerm;
    const list = closeToList(state);
    return replaceFilter(list, applyFilterTerm(list.filter, term), `${term.kind}:${displayTerm(term)}`);
  } catch {
    return { ...state, message: "invalid filter payload" };
  }
}

function displayTerm(term: FilterTerm): string {
  return "value" in term && typeof term.value === "string" ? term.value : term.kind;
}

function closeToList(state: TuiState): TuiState {
  return state.view === "list" ? state : closeExcursion(state);
}

/** Click-origin commands carry the stable row key they visibly targeted. */
function focusListKey(state: TuiState, arg?: string): TuiState {
  if (state.view !== "list" || !arg) return state;
  const key = arg as SessionKey;
  const index = state.list.rows.findIndex((row) => sessionKey(row) === key);
  if (index < 0) return state;
  return { ...state, list: { ...state.list, focus: index, focusKey: key, projectionFocusKey: key } };
}

export function _allowReinit(): void { initialized = false; }
