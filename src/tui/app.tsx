import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout, useWindowSize, type Key, type RenderOptions } from "ink";
import type { Config } from "../config.js";
import { HARNESS_IDS, type HarnessId } from "../contracts/construction.js";
import type { SessionSearchService, SessionTranscriptDto } from "../contracts/search.js";
import { createSessionSearchService } from "../search/service.js";
import { loadConfig } from "../config.js";
import { runChat, type ChatTurn } from "../chat.js";
import { getLastWrite, type DB } from "../db/index.js";
import { hasPublishedLegacyFence, openComparisonDatabase, openTuiDatabase } from "./database.js";
import { InkLibraryBridge } from "./library-bridge.js";
import { createFavorite, toggleWholeSessionFavorite } from "../favorites.js";
import { loadSessionSurface, loadTagSessions } from "../intelligence-data.js";
import { TaskSupervisor } from "../runtime/tasks.js";
import type { VolumeIdentityProbe } from "../runtime/storage-identity.js";
import { providerReadiness } from "../provider.js";
import { synthesizeTag, Tier2SessionController, type TagSynthesisOutcome, type Tier2ViewState } from "../tier2.js";
import { executeInvocation, executePalette, findByKey, search, type CommandOrigin, type KeyInput } from "./commands.js";
import { commandContext, registerCommands } from "./commands-defs.js";
import { readDashboardAnalytics, readDashboardAnalyticsPlaceholder, readDashboardRowStates } from "./analytics.js";
import { DashboardAnalyticsClient, canUseDashboardAnalyticsWorker } from "./analytics-client.js";
import { dashboardSurfaceLayout, type PeekData } from "./dashboard.js";
import { FlatDashboard } from "./flat-dashboard.js";
import { AtlasTestDashboard, atlasTestDashboardLineBudget } from "./atlas-test-dashboard.js";
import { readAtlasTestPreview } from "./atlas-test-preview.js";
import { isFocusableProjection, parseSessionKey, projectionSession, sessionKey, type ProjectedListRow, type SessionKey, type SessionRow } from "./domain.js";
import { FirstRunController, type FirstRunState } from "./first-run.js";
import { ExportFlowController, type ExportFlowState } from "./export-flow.js";
import { InteractionRegistry, TerminalEventAdapter, type InteractionZone } from "./interaction.js";
import { fetchAllSessionKeysResult, fetchPage, listFilterKey, type FilterTerm, type ListFilter } from "./queries.js";
import { SessionView as IntelligenceSessionView, sessionEpisodeAnchors, yankReaderMessagePayload, yankReaderProsePayload, type SessionFacts, type SessionViewController } from "./session-view.js";
import { episodeStep, readSessionLayers, type EpisodeAnchor } from "./layer-tags.js";
import { projectReaderTranscript, readParagraphBreaks, validateTranscriptDto } from "./reader.js";
import { clearCorrection, correctCreator, toggleCreator } from "../layers/corrections.js";
import { creatorJoinSql, effectiveCreatorSql } from "../layers/creator-sql.js";
import { ChatView } from "./chat-view.js";
import { contextualChatLayout, offsetInteractionZones } from "./chat-workspace.js";
import { TagView } from "./tag-view.js";
import {
  appendRows,
  commitSearch,
  esc,
  extendSelectionFromKey,
  focusedSessionRow,
  initialState,
  landOnOrdinal,
  logicalListViewport,
  moveFocus,
  queueLiveRows,
  quitAllowed,
  reconcileRows,
  scrollList,
  selectAllKeys,
  typeSearch,
  type TuiState,
} from "./store.js";
import { TerminalEventPump, TerminalResourceManager, type TerminalStdin } from "./terminal.js";
import { yank } from "./yank.js";
import { ViewportInvalidationFrame } from "./viewport.js";

export type TuiTranscriptReader = Pick<SessionSearchService, "transcript">;

export type TuiUiVariant = "classic" | "atlas-test";
export interface LaunchOpts { dbPath: string; configPath?: string; visibleRows?: number; transcriptReader?: TuiTranscriptReader; storageProbe?: VolumeIdentityProbe; uiVariant?: TuiUiVariant }

/**
 * Production Ink policy. Atlas owns input and repaints frequently while the
 * cursor moves, so only changed terminal lines should be written. Keep this
 * exported: a regression to Ink's full-screen default is visually subtle in
 * tests but painfully obvious on a real terminal.
 */
export function productionInkRenderOptions(): Pick<RenderOptions, "incrementalRendering" | "maxFps"> {
  return { incrementalRendering: true, maxFps: 60 };
}

/** Remount every width/height-bound surface; no row-slot state survives a resize. */
export function viewportGenerationKey(width: number, height: number): string {
  return `viewport:${Math.max(1, Math.floor(width))}x${Math.max(1, Math.floor(height))}`;
}

interface CachedSessionSurface {
  revision: number;
  value: ReturnType<typeof loadSessionSurface>;
}

/** Revision-keyed cache for the multi-query session surface read. */
export class SessionSurfaceCache {
  readonly #entries = new Map<number, CachedSessionSurface>();
  #db: DB | null = null;
  constructor(
    private readonly loader: typeof loadSessionSurface = loadSessionSurface,
    private readonly maxEntries = 8,
  ) {}

  read(db: DB, sessionId: number, revision: number): ReturnType<typeof loadSessionSurface> {
    if (db !== this.#db) {
      this.#entries.clear();
      this.#db = db;
    }
    const cached = this.#entries.get(sessionId);
    if (cached?.revision === revision) {
      this.#entries.delete(sessionId);
      this.#entries.set(sessionId, cached);
      return cached.value;
    }
    const value = this.loader(db, sessionId);
    this.#entries.delete(sessionId);
    this.#entries.set(sessionId, { revision, value });
    while (this.#entries.size > Math.max(1, this.maxEntries)) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return value;
  }
}

/** Every async surface is settled before the database is allowed to close. */
export class TuiRuntime {
  readonly tasks = new TaskSupervisor();
  readonly viewTasks = new TaskSupervisor();
  readonly tier2: Tier2SessionController;
  readonly firstRun: FirstRunController;
  constructor(db: DB, config: Config, options: { storageProbe?: VolumeIdentityProbe } = {}) {
    this.tier2 = new Tier2SessionController(db, config);
    this.firstRun = new FirstRunController(db, config, { storageProbe: options.storageProbe });
  }
  async close(): Promise<void> {
    await this.firstRun.close();
    await this.tier2.close();
    await this.viewTasks.close();
    await this.tasks.close();
  }
}

export async function launchTui(opts: LaunchOpts): Promise<void> {
  registerCommands();
  const uiVariant = opts.uiVariant ?? (process.env.SESSION_ATLAS_UI_VARIANT === "atlas-test" ? "atlas-test" : "classic");
  const loadedConfig = await loadConfig(opts.configPath, { bootstrap: uiVariant !== "atlas-test" });
  const { db, readOnly } = uiVariant === "atlas-test"
    ? openComparisonDatabase(opts.dbPath)
    : await openTuiDatabase(opts.dbPath, { storage: loadedConfig.storage, storageProbe: opts.storageProbe });
  const config = readOnly ? { ...loadedConfig, providers: [] } : loadedConfig;
  const runtime = new TuiRuntime(db, config, { storageProbe: opts.storageProbe });
  const transcriptReader = opts.transcriptReader ?? createSessionSearchService(db);
  let libraryBridge: InkLibraryBridge | undefined;
  if (readOnly && (uiVariant !== "atlas-test" || hasPublishedLegacyFence(opts.dbPath))) {
    try { libraryBridge = InkLibraryBridge.open({ legacyPath: opts.dbPath }); } catch { /* Legacy browsing remains available if the active pointer cannot be opened. */ }
  }
  let ink: ReturnType<typeof render> | null = null;
  const terminal = new TerminalResourceManager({
    stdin: process.stdin,
    stdout: process.stdout,
    signals: process,
    repaint: () => ink?.rerender(<App db={db} config={config} runtime={runtime} terminal={terminal} visibleRows={opts.visibleRows ?? 40} transcriptReader={transcriptReader} readOnly={readOnly} libraryBridge={libraryBridge} uiVariant={uiVariant} />),
    onInterrupt: () => ink?.unmount(),
  });
  try {
    terminal.acquire();
    ink = render(
      <App db={db} config={config} runtime={runtime} terminal={terminal} visibleRows={opts.visibleRows ?? 40} transcriptReader={transcriptReader} readOnly={readOnly} libraryBridge={libraryBridge} uiVariant={uiVariant} />,
      productionInkRenderOptions(),
    );
    await ink.waitUntilExit();
  } finally {
    // Unmount first so the event pump releases stdin; then settle work, modes,
    // and finally the DB in that order.
    ink?.unmount();
    await runtime.close();
    terminal.teardown("normal");
    libraryBridge?.close();
    db.close();
  }
}

export interface AppProps {
  uiVariant?: TuiUiVariant;
  libraryBridge?: InkLibraryBridge;
  readOnly?: boolean;
  db: DB;
  config: Config;
  runtime: TuiRuntime;
  terminal?: TerminalResourceManager;
  visibleRows?: number;
  fixedWidth?: number;
  fixedHeight?: number;
  /** Injectable raw stream for mounted process-boundary tests. */
  terminalStdin?: TerminalStdin;
  /** Injectable clipboard boundary so tests never emit OSC 52 or call pbcopy. */
  copyText?: typeof yank;
  /** Frozen Phase 4/3 DTO seam. Absence is designed fail-closed, never a legacy transcript fallback. */
  transcriptReader?: TuiTranscriptReader;
}

type UiInput = KeyInput & { text?: string };
const DASHBOARD_ANALYTICS_IDLE_MS = 500;

export function App({ db, config, runtime, terminal, visibleRows = 40, fixedWidth, fixedHeight, terminalStdin = process.stdin, copyText = yank, transcriptReader, readOnly = false, libraryBridge, uiVariant = "classic" }: AppProps): React.JSX.Element {
  registerCommands();
  const comparison = uiVariant === "atlas-test";
  const { exit } = useApp();
  const { stdout } = useStdout();
  const windowSize = useWindowSize();
  const width = fixedWidth ?? stdout.columns ?? windowSize.columns ?? 80;
  const height = fixedHeight ?? stdout.rows ?? windowSize.rows ?? visibleRows + 6;
  const activeProvider = readOnly || comparison ? null : config.providers.find((provider) => providerReadiness(provider).ready) ?? null;
  const providerAvailable = activeProvider !== null;
  // md's default lens is human-started sessions; the "creator:human x" chip,
  // the CREATOR rail's "all" row, and `g` all show everything.
  const [state, setStateValue] = useState<TuiState>(() => {
    const filter: ListFilter = comparison ? { hideAgentConversations: true } : { origin: "human" };
    return { ...initialState(visibleRows), filter, baseFilter: filter, providerAvailable };
  });
  const stateRef = useRef(state);
  const setState = useCallback((next: React.SetStateAction<TuiState>) => {
    const value = typeof next === "function" ? (next as (current: TuiState) => TuiState)(stateRef.current) : next;
    stateRef.current = value;
    setStateValue(value);
  }, []);
  stateRef.current = state;
  const undoActions = useRef<Array<{ label: string; run: () => void }>>([]);
  const rememberUndo = useCallback((label: string, run: () => void) => {
    undoActions.current.push({ label, run });
    if (undoActions.current.length > 30) undoActions.current.shift();
  }, []);
  const toggleAgentConversations = useCallback(() => {
    const previous = stateRef.current.filter;
    rememberUndo("agent visibility", () => setState(value => ({ ...value, filter: previous })));
    setState(current => ({
      ...current,
      filter: { ...current.filter, hideAgentConversations: current.filter.hideAgentConversations ? undefined : true },
      message: "",
    }));
  }, [rememberUndo, setState]);

  const surfaceZones = useRef<readonly InteractionZone[]>([]);
  const installSurfaceZones = useRef<(zones: readonly InteractionZone[]) => void>(() => {});
  const publishSurfaceZones = useCallback((next: readonly InteractionZone[]) => {
    surfaceZones.current = next;
    installSurfaceZones.current(next);
  }, []);
  const workspaceZoneParts = useRef(new Map<"archive" | "chat", readonly InteractionZone[]>());
  const workspaceZoneView = useRef(state.view);
  if (workspaceZoneView.current !== state.view) {
    workspaceZoneView.current = state.view;
    workspaceZoneParts.current.clear();
  }
  const publishWorkspaceZones = useCallback((scope: "archive" | "chat", next: readonly InteractionZone[], x: number, y: number) => {
    workspaceZoneParts.current.set(scope, offsetInteractionZones(next, x, y, scope));
    publishSurfaceZones([
      ...(workspaceZoneParts.current.get("archive") ?? []),
      ...(workspaceZoneParts.current.get("chat") ?? []),
    ]);
  }, [publishSurfaceZones]);
  const interactions = useRef(new InteractionRegistry());
  const sessionController = useRef<SessionViewController | null>(null);
  /** Episodes of the open session, in its reader's logical ordinals, for [ and ]. */
  const episodeAnchorsRef = useRef<readonly EpisodeAnchor[]>([]);
  const [toggledFolds, setToggledFolds] = useState<ReadonlySet<string>>(() => new Set());
  const [aboutOverride, setAboutOverride] = useState<boolean | null>(null);
  const [layersRevision, setLayersRevision] = useState(0);
  const [spanAnchor, setSpanAnchor] = useState<number | null>(null);
  // The row under the pointer; the dashboard's context line shows its title.
  const [hoverKey, setHoverKey] = useState<SessionKey | null>(null);
  const [spanEnd, setSpanEnd] = useState<number | null>(null);
  const [tier2, setTier2] = useState<Tier2ViewState>({ sessionId: 0, status: "unavailable", reason: "not opened" });
  const [chatInput, setChatInput] = useState("");
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([]);
  const initialChatStatus = providerAvailable ? "idle" as const : "provider-down" as const;
  const [chatStatus, setChatStatus] = useState<"idle" | "running" | "ready" | "grounding-failed" | "provider-down" | "error">(initialChatStatus);
  const [chatReason, setChatReason] = useState<string | null>(providerAvailable ? null : "no permitted provider available");
  const [tagFocus, setTagFocus] = useState(0);
  const [tagSynthesis, setTagSynthesis] = useState<TagSynthesisOutcome | { status: "loading" } | { status: "provider-down"; reason: string }>({ status: providerAvailable ? "loading" : "provider-down", reason: "no permitted provider available" });
  const [firstRun, setFirstRun] = useState<FirstRunState>(runtime.firstRun.state);
  const [exportFlow, setExportFlow] = useState<ExportFlowState | null>(null);
  const exportController = useRef<ExportFlowController | null>(null);
  const [exportChoice, setExportChoice] = useState(0);
  const [dbRevision, setDbRevision] = useState(() => getLastWrite(db));
  const dbRevisionRef = useRef(dbRevision);
  dbRevisionRef.current = dbRevision;
  const sessionSurfaces = useRef<SessionSurfaceCache | null>(null);
  if (sessionSurfaces.current === null) sessionSurfaces.current = new SessionSurfaceCache();
  const readSessionSurface = useCallback(
    (sessionId: number) => sessionSurfaces.current!.read(db, sessionId, dbRevisionRef.current),
    [db],
  );
  const readContractTranscript = useCallback((current: TuiState): ContractTranscriptOutcome => {
    const ref = activeSessionRef(current, db);
    if (!ref) return { dto: null, diagnostic: "session identity is unavailable" };
    if (!transcriptReader) {
      return { dto: null, diagnostic: "current construction reader is not integrated · legacy rows are not shown" };
    }
    if (!isHarnessId(ref.harness)) return { dto: null, diagnostic: `unsupported harness ${ref.harness}` };
    try {
      const dto = transcriptReader.transcript({ harness: ref.harness, nativeId: ref.nativeId });
      if (dto.session.sessionKey.harness !== ref.harness || dto.session.sessionKey.nativeId !== ref.nativeId) {
        return { dto: null, diagnostic: "reader returned a different session identity" };
      }
      const validation = validateTranscriptDto(dto);
      return validation.readable ? { dto, diagnostic: null } : { dto, diagnostic: validation.diagnostic };
    } catch (error) {
      return { dto: null, diagnostic: `reader failed · ${messageOf(error)}` };
    }
  }, [db, transcriptReader]);
  const tagSessionCache = useRef<{ tag: string; revision: number; value: ReturnType<typeof loadTagSessions> } | null>(null);
  const readTagSessionRows = useCallback((tag: string) => {
    const cached = tagSessionCache.current;
    if (cached?.tag === tag && cached.revision === dbRevisionRef.current) return cached.value;
    const value = loadTagSessions(db, tag);
    tagSessionCache.current = { tag, revision: dbRevisionRef.current, value };
    return value;
  }, [db]);

  const [processingOpen, setProcessingOpen] = useState(false);
  const [helpOffset, setHelpOffset] = useState(0);
  const modalOpen = processingOpen || state.helpOpen || state.paletteInput !== null || exportFlow !== null;
  const layout = dashboardSurfaceLayout(width, height, Object.keys(state.filter).some((key) => state.filter[key as keyof ListFilter] != null), state.peek !== null);
  const dashboardLineBudget = comparison
    ? atlasTestDashboardLineBudget(shellDashboardWidth(width), height, state.filter, state.list.pendingLiveRows.length, state.peek !== null)
    : Math.max(1, layout.bodyRows - 2 - (state.list.pendingLiveRows.length > 0 ? 1 : 0));
  useEffect(() => {
    if (state.visibleRows !== dashboardLineBudget) setState((current) => ({ ...current, visibleRows: dashboardLineBudget }));
  }, [dashboardLineBudget, setState, state.visibleRows]);

  const filterKey = listFilterKey(state.filter);
  const loadedListRef = useRef<{ db: DB; filterKey: string } | null>(null);
  const listLoading = state.view === "list" && (loadedListRef.current?.db !== db || loadedListRef.current.filterKey !== filterKey);
  const [dashboardAnalytics, setDashboardAnalytics] = useState(() => canUseDashboardAnalyticsWorker(config.dbPath)
    ? readDashboardAnalyticsPlaceholder(db)
    : readSafeDashboardAnalytics(db, state.filter));
  const [dashboardAnalyticsFilterKey, setDashboardAnalyticsFilterKey] = useState<string | null>(() => canUseDashboardAnalyticsWorker(config.dbPath) ? null : filterKey);
  const analyticsClient = useRef<{ dbPath: string; client: DashboardAnalyticsClient } | null>(null);
  const analyticsRequest = useRef(0);
  const analyticsSnapshot = useRef<{ db: DB; revision: string; filterKey: string } | null>(null);
  const lastInteractionAt = useRef(Date.now());
  const dashboardFilterRef = useRef(state.filter);
  dashboardFilterRef.current = state.filter;
  useEffect(() => {
    if (!comparison && (firstRun.kind === "ready" || firstRun.kind === "running")) {
      analyticsSnapshot.current = null;
      return;
    }
    const previous = analyticsSnapshot.current;
    const revision = `${dbRevision}:${layersRevision}`;
    analyticsSnapshot.current = { db, revision, filterKey };
    if (previous?.db === db && previous.revision === revision && previous.filterKey === filterKey) return;

    const request = ++analyticsRequest.current;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const accept = (analytics: ReturnType<typeof readDashboardAnalytics>): void => {
      if (analyticsRequest.current === request) {
        setDashboardAnalytics(analytics);
        setDashboardAnalyticsFilterKey(filterKey);
      }
    };
    const fallback = (): void => {
      // In-memory embedders and worker-start failures are rare. Keep their
      // synchronous compatibility read outside React's render transaction.
      fallbackTimer = setTimeout(() => {
        if (analyticsRequest.current === request) accept(readSafeDashboardAnalytics(db, dashboardFilterRef.current));
      }, 0);
    };

    const refresh = (): void => {
      const idleRemaining = DASHBOARD_ANALYTICS_IDLE_MS - (Date.now() - lastInteractionAt.current);
      if (idleRemaining > 0) {
        refreshTimer = setTimeout(refresh, idleRemaining);
        return;
      }
      if (!canUseDashboardAnalyticsWorker(config.dbPath)) {
        fallback();
        return;
      }
      try {
        if (analyticsClient.current?.dbPath !== config.dbPath) {
          analyticsClient.current?.client.close();
          analyticsClient.current = { dbPath: config.dbPath, client: new DashboardAnalyticsClient(config.dbPath) };
        }
        void analyticsClient.current.client.read(dashboardFilterRef.current).then(accept).catch(fallback);
      } catch {
        fallback();
      }
    };
    refreshTimer = setTimeout(refresh, DASHBOARD_ANALYTICS_IDLE_MS);
    return () => {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    };
  }, [comparison, config.dbPath, db, dbRevision, filterKey, firstRun.kind, layersRevision]);
  useEffect(() => () => {
    analyticsRequest.current++;
    analyticsClient.current?.client.close();
    analyticsClient.current = null;
  }, []);
  useEffect(() => {
    if (state.view !== "list") return;
    if (loadedListRef.current?.db === db && loadedListRef.current.filterKey === filterKey) return;
    const requestFilterKey = filterKey;
    loadedListRef.current = { db, filterKey: requestFilterKey };
    const page = fetchPage(db, state.filter, null, dashboardPageSize(state.filter, dashboardLineBudget));
    setState((current) => {
      if (current.view !== "list" || listFilterKey(current.filter) !== requestFilterKey) return current;
      const next = reconcileRows(current, page.rows, !page.hasMore);
      return page.error ? { ...next, message: `invalid search · ${page.error.message} · edit / or remove q chip` } : next;
    });
  }, [db, filterKey, setState, state.filter, state.view]);

  useEffect(() => {
    if (state.view !== "list" || state.list.fetchedAll || state.list.rows.length === 0) return;
    const prefetchRows = state.filter.query ? Math.max(10, dashboardLineBudget) : Math.max(20, dashboardLineBudget * 2);
    if (state.list.focus < state.list.rows.length - prefetchRows) return;
    const last = state.list.rows.at(-1)!;
    const page = fetchPage(
      db,
      state.filter,
      { last_activity: last.last_activity, id: last.id },
      dashboardPageSize(state.filter, dashboardLineBudget),
    );
    setState((current) => appendRows(current, page.rows, !page.hasMore));
  }, [dashboardLineBudget, db, filterKey, setState, state.list.fetchedAll, state.list.focus, state.list.rows.length, state.view]);

  useEffect(() => {
    let seen = getLastWrite(db);
    const timer = setInterval(() => {
      const next = getLastWrite(db);
      if (next === seen) return;
      seen = next;
      dbRevisionRef.current = next;
      setDbRevision(next);
      const current = stateRef.current;
      if (current.view !== "list") return;
      const page = fetchPage(db, current.filter, null, dashboardPageSize(current.filter, dashboardLineBudget));
      setState((value) => queueLiveRows(value, page.rows, next));
    }, 2_000);
    return () => clearInterval(timer);
  }, [dashboardLineBudget, db, setState]);

  // Empty configured archives begin provider-free indexing immediately. The
  // controller owns cancellation and exposes progress as dashboard truth.
  useEffect(() => runtime.firstRun.subscribe((next) => {
    setFirstRun(next);
    if (next.kind === "running" || next.kind === "complete" || next.kind === "cancelled" || next.kind === "failed") {
      const current = stateRef.current;
      if (current.view === "list") {
        const page = fetchPage(db, current.filter, null, dashboardPageSize(current.filter, dashboardLineBudget));
        const revision = getLastWrite(db);
        dbRevisionRef.current = revision;
        setDbRevision(revision);
        setState((value) => reconcileRows(value, page.rows, !page.hasMore));
      }
    }
  }), [dashboardLineBudget, db, runtime, setState]);
  useEffect(() => { if (!readOnly && !comparison && firstRun.kind === "ready") void runtime.firstRun.start(); }, [comparison, firstRun.kind, runtime, readOnly]);

  useEffect(() => {
    if (state.view !== "session" || !state.session) { void runtime.tier2.cancel("session excursion closed"); return; }
    setSpanAnchor(null); setSpanEnd(null); setToggledFolds(new Set());
    const sessionId = state.session.id;
    if (libraryBridge) {
      try {
        const summary = libraryBridge.getSessionView(stableRefForSession(db, sessionId));
        setTier2({ ...summary, sessionId });
      } catch (error) { setTier2({ sessionId, status: "unavailable", reason: messageOf(error) }); }
    } else if (comparison) {
      const row = state.list.rows.find((candidate) => candidate.id === sessionId);
      const saved = row ? readAtlasTestPreview(db, row) : null;
      setTier2(saved?.summary ? { sessionId, status: "degraded", result: { body: saved.summary, anchors: [] }, reason: saved.summaryLabel }
        : { sessionId, status: "unavailable", reason: "No saved summary" });
    } else void runtime.tier2.open(sessionId, setTier2);
  }, [comparison, db, libraryBridge, runtime, setState, state.session?.id, state.view]);

  // A chat lives while it is on screen or under a session opened from it:
  // Esc from a cited session returns to the same turns.
  const chatAlive = useRef(false);
  const chatInStack = state.view === "chat" || state.stack.some((frame) => frame.view === "chat");
  useEffect(() => {
    if (chatInStack && !chatAlive.current) {
      chatAlive.current = true;
      setChatInput(""); setChatTurns([]); setChatStatus(initialChatStatus);
      setChatReason(providerAvailable ? null : "no permitted provider available");
    }
    if (!chatInStack && chatAlive.current) {
      chatAlive.current = false;
      void runtime.viewTasks.cancelAndWait("chat excursion closed");
      setChatInput(""); setChatTurns([]); setChatStatus(initialChatStatus);
    }
  }, [chatInStack, initialChatStatus, providerAvailable, runtime]);

  useEffect(() => {
    if (state.view !== "tag") return;
    const tag = state.activeTag ?? firstTag(db);
    if (!tag) return;
    if (state.activeTag !== tag) setState((current) => ({ ...current, activeTag: tag }));
    setTagFocus(0);
    if (!providerAvailable) { setTagSynthesis({ status: "provider-down", reason: "no permitted provider available" }); return; }
    setTagSynthesis({ status: "loading" });
    void runtime.viewTasks.cancelAndWait("tag changed").then(() => stateRef.current.view === "tag" ? runtime.viewTasks.run(async (task) => {
      const value = await synthesizeTag(db, config, tag, { signal: task.signal, shouldCommit: task.isCurrent });
      if (task.isCurrent()) setTagSynthesis(value);
    }) : undefined).catch((error) => setTagSynthesis({ status: "provider-down", reason: messageOf(error) }));
    return () => { void runtime.viewTasks.cancelAndWait("tag excursion closed"); };
  }, [config, db, providerAvailable, runtime, setState, state.activeTag, state.view]);

  // A creator mark changes row markers, the default lens, and rail counts.
  const refreshCreatorLens = useCallback(() => {
    setLayersRevision((value) => value + 1);
    sessionSurfaces.current = new SessionSurfaceCache();
    loadedListRef.current = null;
    const current = stateRef.current;
    if (current.view !== "list") return;
    const page = fetchPage(db, current.filter, null, dashboardPageSize(current.filter, dashboardLineBudget));
    loadedListRef.current = { db, filterKey: listFilterKey(current.filter) };
    setState((value) => value.view === "list" ? reconcileRows(value, page.rows, !page.hasMore) : value);
  }, [dashboardLineBudget, db, setState]);

  // Status messages are notes, not state: they fade after a few seconds.
  useEffect(() => {
    if (!state.message) return;
    const message = state.message;
    const timer = setTimeout(() => setState((value) => value.message === message ? { ...value, message: "" } : value), 4_000);
    return () => clearTimeout(timer);
  }, [setState, state.message]);

  const beginExport = useCallback((current: TuiState) => {
    try {
      const controller = new ExportFlowController(db, config);
      const range = current.view === "session" ? spanRange(spanAnchor, spanEnd) : null;
      const selectedSpans = range && current.session ? [{ ...stableRefForSession(db, current.session.id), fromOrdinal: range.from, toOrdinal: range.to }] : [];
      const preview = controller.begin({ scope: exportScope(current), options: { selectedSpans } });
      exportController.current = controller;
      setExportChoice(0);
      setExportFlow(preview);
    } catch (error) { setState((value) => ({ ...value, message: `export failed · ${messageOf(error)}` })); }
  }, [config, db, setState, spanAnchor, spanEnd]);

  const sideEffect = useCallback((id: string, current: TuiState, arg?: string) => {
    if (comparison && ["favorite", "export", "tag-resynthesize"].includes(id)) {
      setState(value => ({ ...value, message: "Read-only comparison; use atlas for saved-data changes" }));
      return;
    }
    if (id === "undo") {
      const action = undoActions.current.at(-1);
      if (!action) { setState(value => ({ ...value, message: "Nothing to undo" })); return; }
      try {
        action.run();
        undoActions.current.pop();
        setState(value => ({ ...value, message: `Undone · ${action.label}` }));
      } catch (error) { setState(value => ({ ...value, message: `Undo blocked · ${messageOf(error)}` })); }
      return;
    }
    if (readOnly && (["export", "tag-resynthesize"].includes(id) || (id === "favorite" && !libraryBridge?.store))) {
      setState((value) => ({ ...value, message: "Protected pre-migration index · use atlas library for saved-data changes" }));
      return;
    }
    if (id === "favorite") {
      const clickedRef = arg ? parseSessionKey(arg as SessionKey) : null;
      const keys = actionKeys(current);
      const refs = clickedRef ? [clickedRef] : current.view === "session" && current.session
        ? [stableRefForSession(db, current.session.id)]
        : keys.flatMap((key) => parseSessionKey(key) ?? []);
      const range = current.view === "session" ? spanRange(spanAnchor, spanEnd) : null;
      if (libraryBridge?.store) {
        if (range) {
          setState(value => ({ ...value, message: "Span save needs source-pinned library passages; clear the span to favorite the conversation" }));
          return;
        }
        try {
          for (const ref of refs) {
            const changed = libraryBridge.toggleFavorite(ref);
            const key = sessionKey({ harness: ref.harness, native_id: ref.nativeId });
            setState(value => reflectFavoriteFacts(value, new Map([[key, changed.active]])));
            if (changed.undoId) rememberUndo("favorite", () => {
              libraryBridge.undoFavorite(changed.undoId!);
              setState(value => reflectFavoriteFacts(value, new Map([[key, !changed.active]])));
            });
          }
          setState(value => ({ ...value, message: `★ ${refs.length} conversation(s) updated · Undo / Ctrl-Z` }));
        } catch (error) { setState(value => ({ ...value, message: `Favorite failed · ${messageOf(error)}` })); }
        return;
      }
      void runtime.tasks.run(async (task) => {
        for (const ref of refs) {
          if (!task.isCurrent()) return;
          if (range) await createFavorite(db, { ...ref, fromOrdinal: range.from, toOrdinal: range.to }, { defaultSpan: config.tunables.fav_default_span });
          else toggleWholeSessionFavorite(db, ref);
        }
        if (task.isCurrent()) {
          const favoriteFacts = new Map<SessionKey, boolean>();
          const readFavorite = db.prepare(
            `SELECT EXISTS(SELECT 1 FROM favorites WHERE harness=? AND native_id=?) AS active`,
          );
          for (const ref of refs) {
            const fact = readFavorite.get(ref.harness, ref.nativeId) as { active: number };
            favoriteFacts.set(sessionKey({ harness: ref.harness, native_id: ref.nativeId }), fact.active > 0);
          }
          const revision = getLastWrite(db);
          dbRevisionRef.current = revision;
          setDbRevision(revision);
          setState((value) => ({
            ...reflectFavoriteFacts(value, favoriteFacts),
            message: `★ ${refs.length} ${range ? `span ${range.from}-${range.to} starred` : "session toggled"}`,
          }));
        }
      }).catch((error) => setState((value) => ({ ...value, message: `favorite failed · ${messageOf(error)}` })));
    } else if (id === "export") beginExport(current);
    else if (id === "yank") {
      let payload: string | null = null;
      let label = "focused session";
      if (arg?.startsWith("literal:")) { payload = arg.slice("literal:".length); label = "fact"; }
      else if (current.view === "session" && current.session) {
        const outcome = readContractTranscript(current);
        if (outcome.dto && !outcome.diagnostic) {
          const range = spanRange(spanAnchor, spanEnd);
          const projected = projectReaderTranscript(outcome.dto, current.session.mode, current.session.roleToggle);
          const visibleOrdinal = current.activeOrdinal ?? sessionController.current?.visibleOrdinals().first ?? projected[0]?.ordinal ?? null;
          payload = arg === "conversation"
            ? outcome.dto.activity.map(record => `[${record.recordKind}]\n${record.prose ?? ""}${record.toolActivities.length ? "\n" + JSON.stringify(record.toolActivities, null, 2) : ""}`).join("\n\n")
            : arg === "prose"
            ? yankReaderProsePayload(projectReaderTranscript(outcome.dto, "dialogue", current.session.roleToggle), range ? { fromOrdinal: range.from, toOrdinal: range.to } : null)
            : yankReaderMessagePayload(projected, visibleOrdinal);
          label = arg === "conversation" ? "complete conversation (all records)" : arg === "prose" ? "dialogue prose" : "logical record";
        }
      } else {
        const row = focusedSessionRow(current); payload = row?.title ?? row?.native_id ?? null;
      }
      if (payload) copyText(payload);
      setState((value) => ({ ...value, message: payload ? `yanked ${label}` : "nothing to yank" }));
    } else if (id === "creator-toggle") {
      const ref = current.view === "session" && current.session
        ? activeSessionRef(current, db)
        : (() => { const row = focusedSessionRow(current); return row ? { harness: row.harness, nativeId: row.native_id } : null; })();
      if (!ref) { setState((value) => ({ ...value, message: "nothing to mark" })); return; }
      try {
        const prior = db.query(`SELECT started_by FROM layers.creator_corrections WHERE harness=? AND native_id=?`).get(ref.harness, ref.nativeId) as { started_by: "human" | "agent" } | null;
        const next = toggleCreator(db, ref);
        rememberUndo("creator mark", () => {
          if (prior) correctCreator(db, ref, prior.started_by);
          else clearCorrection(db, ref);
          refreshCreatorLens();
        });
        refreshCreatorLens();
        setState((value) => ({ ...value, message: `marked ${next}-started · ctrl-z undo` }));
      } catch (error) { setState((value) => ({ ...value, message: `creator mark failed · ${messageOf(error)}` })); }
    } else if (id === "span-mark" && current.view === "session") {
      const ordinal = current.activeOrdinal ?? sessionController.current?.visibleOrdinals().first ?? null;
      if (ordinal === null) return;
      if (spanAnchor === null) { setSpanAnchor(ordinal); setSpanEnd(ordinal); setState((value) => ({ ...value, message: "span started · move and x to extend · x on its end clears" })); }
      else if (spanEnd === ordinal) { setSpanAnchor(null); setSpanEnd(null); setState((value) => ({ ...value, message: "span cleared" })); }
      else setSpanEnd(ordinal);
    } else if (id === "tag-resynthesize") {
      const tag = current.activeTag;
      if (!tag || !providerAvailable) return;
      setTagSynthesis({ status: "loading" });
      void runtime.viewTasks.cancelAndWait("tag resynthesize").then(() => runtime.viewTasks.run(async (task) => {
        const value = await synthesizeTag(db, config, tag, { signal: task.signal, shouldCommit: task.isCurrent, forceRefresh: true });
        if (task.isCurrent() && stateRef.current.view === "tag" && stateRef.current.activeTag === tag) setTagSynthesis(value);
      })).catch((error) => setTagSynthesis({ status: "provider-down", reason: messageOf(error) }));
    }
  }, [beginExport, comparison, config.tunables.fav_default_span, copyText, db, readContractTranscript, refreshCreatorLens, runtime, setState, spanAnchor, spanEnd, readOnly, libraryBridge, rememberUndo]);

  const invoke = useCallback((id: string, arg?: string, origin: CommandOrigin = "key", palette = false) => {
    const current = stateRef.current;
    if (comparison && id === "filter-origin") { toggleAgentConversations(); return; }
    if (id === "processing-status") { setProcessingOpen(true); setState(value => ({ ...value, paletteInput: null })); return; }
    if (id === "back") { setState(esc(current)); return; }
    // Navigation remains a command invocation; the surface supplies its
    // ordinal/tag coordinate instead of asking the generic list reducer to guess.
    if (current.view === "session" && current.session) {
      const controller = sessionController.current;
      if (id === "nav-down" || id === "nav-up") {
        const outcome = readContractTranscript(current);
        if (!outcome.dto || outcome.diagnostic) {
          setState((value) => ({ ...value, message: outcome.diagnostic ?? "transcript unavailable" }));
          return;
        }
        const projected = projectReaderTranscript(outcome.dto, current.session.mode, current.session.roleToggle);
        const visible = controller?.visibleOrdinals() ?? { first: null, last: null };
        const at = projected.findIndex((row) => row.ordinal === current.activeOrdinal);
        const inView = at >= 0 && visible.first !== null && visible.last !== null
          && projected[at]!.ordinal >= visible.first && projected[at]!.ordinal <= visible.last;
        // j/k step from the active message while it is on screen; after the
        // wheel moved away, they start from what is visible.
        const next = inView
          ? Math.max(0, Math.min(projected.length - 1, at + (id === "nav-down" ? 1 : -1)))
          : Math.max(0, projected.findIndex((row) => row.ordinal === (id === "nav-down" ? visible.first : visible.last)));
        setState((value) => landOnOrdinal(value, projected[next]?.ordinal ?? null));
        return;
      }
      const scroll = { "nav-page-down": "page-down", "nav-page-up": "page-up", "nav-home": "home", "nav-end": "end" } as const;
      if (id in scroll) { controller?.scroll(scroll[id as keyof typeof scroll]); return; }
      if (id === "transcript-expand") { controller?.toggleActiveFolds(); return; }
      if (id === "episode-next" || id === "episode-prev") {
        const anchors = episodeAnchorsRef.current;
        const visible = controller?.visibleOrdinals() ?? { first: null, last: null };
        const active = current.activeOrdinal ?? null;
        const reading = active !== null && visible.first !== null && visible.last !== null && active >= visible.first && active <= visible.last ? active : visible.first;
        const target = episodeStep(anchors, reading, id === "episode-next" ? 1 : -1);
        if (!target || target.ordinal === null) {
          setState((value) => ({ ...value, message: anchors.length === 0 ? "no episodes for this session" : id === "episode-next" ? "last episode" : "first episode" }));
          return;
        }
        const ordinal = target.ordinal;
        controller?.jumpTo(ordinal);
        setState((value) => ({ ...landOnOrdinal(value, ordinal), message: `episode ${target.index}/${anchors.length} . ${target.title}` }));
        return;
      }
      if (id === "session-about") { setAboutOverride((value) => !(value ?? width >= 150)); return; }
    }
    if ((id === "nav-down" || id === "nav-up") && current.view === "tag") {
      const rows = readTagSessionRows(current.activeTag ?? "");
      setTagFocus((value) => Math.max(0, Math.min(rows.length - 1, value + (id === "nav-down" ? 1 : -1))));
      return;
    }
    if (id === "select-all-filter") {
      const result = fetchAllSessionKeysResult(db, current.filter);
      setState((value) => result.error ? { ...value, message: `select failed · ${result.error.message}` } : selectAllKeys(value, result.keys));
      return;
    }
    const payload = arg === undefined ? { kind: "none" as const } : { kind: "text" as const, value: arg };
    const result = palette ? executePalette(id, current, payload) : executeInvocation({ id, payload, origin }, current);
    if (result.exit) { exit(); return; }
    const resultState = comparison && id === "clear-filters"
      ? { ...result.state, filter: { hideAgentConversations: current.filter.hideAgentConversations } }
      : result.state;
    const nextState = preserveRowsForRefetch(current, resultState);
    if (id.startsWith("filter-") || id === "clear-filters") {
      if (JSON.stringify(current.filter) !== JSON.stringify(nextState.filter)) {
        rememberUndo("filters", () => setState(value => ({ ...value, filter: current.filter, list: { ...value.list, focusKey: current.list.focusKey, scrollAnchorKey: current.list.scrollAnchorKey } })));
      }
    } else if (id === "transcript-wrap" && current.session) {
      const prior = current.session;
      rememberUndo("word wrap", () => setState(value => value.session?.id === prior.id ? { ...value, session: { ...value.session, wrap: prior.wrap } } : value));
    }
    setState(result.message ? { ...nextState, message: result.message } : nextState);
    sideEffect(id, current, arg);
  }, [comparison, db, exit, readContractTranscript, readTagSessionRows, setState, sideEffect, rememberUndo, toggleAgentConversations, width]);

  const runChatQuery = useCallback(() => {
    const query = chatInput.trim();
    if (!query || !providerAvailable) {
      if (!providerAvailable) setState((value) => ({ ...value, message: "chat input disabled · run atlas doctor" }));
      return;
    }
    setChatInput(""); setChatTurns((turns) => [...turns, { role: "user", text: query, citations: [] }]); setChatStatus("running");
    void runtime.viewTasks.cancelAndWait("new chat query").then(() => chatAlive.current ? runtime.viewTasks.run((task) => runChat(db, config, query, (turn) => { if (task.isCurrent()) setChatTurns((turns) => [...turns, turn]); }, { signal: task.signal, shouldDeliver: task.isCurrent })) : undefined).then((outcome) => {
      if (!outcome || outcome.cancelled || !chatAlive.current) return;
      setChatStatus(outcome.ok ? "ready" : outcome.degraded ? "grounding-failed" : "provider-down"); setChatReason(outcome.reason ?? null);
    }).catch((error) => { if (chatAlive.current) { setChatStatus("error"); setChatReason(messageOf(error)); } });
  }, [chatInput, config, db, providerAvailable, runtime, setState]);

  const cancelExport = useCallback(() => {
    exportController.current?.cancel(); exportController.current = null; setExportFlow(null);
    setState((value) => ({ ...value, message: "export cancelled · no file written" }));
  }, [setState]);
  const confirmExport = useCallback((choiceIndex = exportChoice) => {
    const controller = exportController.current;
    if (!controller || controller.state.kind !== "preview") return;
    const choice = controller.state.choices[Math.max(0, Math.min(choiceIndex, controller.state.choices.length - 1))];
    if (!choice) return;
    setExportFlow({ kind: "writing", preview: controller.state.preview, choice });
    void runtime.tasks.run(async () => controller.confirm(choice.name)).then((result) => {
      setExportFlow(result);
      if (result.kind === "complete") {
        if (result.written.launcherCommand) copyText(result.written.launcherCommand);
        setState((value) => ({ ...value, message: `export → ${result.written.path}${result.written.launcherCommand ? " · launcher copied" : ""}` }));
        exportController.current = null;
        setExportFlow(null);
      } else if (result.kind === "failed") setState((value) => ({ ...value, message: `export failed · ${result.error.message}` }));
    });
  }, [copyText, exportChoice, runtime, setState]);

  const handleInput = useCallback((event: UiInput, pasted = false) => {
    lastInteractionAt.current = Date.now();
    const current = stateRef.current;
    const key = event.key;
    const text = event.text ?? (key.length === 1 ? key : "");
    if (processingOpen) { if (key === "escape" || text === "q" || key === "enter") setProcessingOpen(false); return; }
    if (exportFlow) {
      if (key === "escape") cancelExport();
      else if (exportFlow.kind === "preview" && (key === "up" || key === "down")) setExportChoice((value) => Math.max(0, Math.min(exportFlow.choices.length - 1, value + (key === "down" ? 1 : -1))));
      else if (exportFlow.kind === "preview" && key === "enter") confirmExport();
      return;
    }
    if (current.helpOpen) {
      if (key === "escape" || text === "?" || text === "q") { setHelpOffset(0); setState((value) => esc(value)); }
      else if (key === "down" || text === "j") setHelpOffset((value) => value + 1);
      else if (key === "up" || text === "k") setHelpOffset((value) => Math.max(0, value - 1));
      else if (key === "pagedown" || key === "space" || text === " ") setHelpOffset((value) => value + Math.max(1, height - 6));
      else if (key === "pageup") setHelpOffset((value) => Math.max(0, value - Math.max(1, height - 6)));
      else if (key === "home") setHelpOffset(0);
      return;
    }
    if (current.paletteInput !== null) {
      if (key === "escape") setState((value) => esc(value));
      else if (key === "enter") {
        const results = search(current.paletteInput, commandContext(current), current);
        const selected = results[Math.min(current.paletteIndex, Math.max(0, results.length - 1))];
        if (selected && !selected.disabled) invoke(selected.cmd.id, undefined, "palette", true);
        else setState((value) => esc(value));
      } else if (key === "up" || key === "down") setState((value) => ({ ...value, paletteIndex: Math.max(0, value.paletteIndex + (key === "up" ? -1 : 1)) }));
      else if (key === "backspace") setState((value) => ({ ...value, paletteInput: value.paletteInput!.slice(0, -1), paletteIndex: 0 }));
      else if (text && !event.ctrl && !event.alt) setState((value) => ({ ...value, paletteInput: value.paletteInput! + text, paletteIndex: 0 }));
      return;
    }
    if (current.searchInput !== null) {
      if (key === "escape") setState((value) => esc(value));
      else if (key === "enter") setState((value) => preserveRowsForRefetch(value, commitSearch(value)));
      else if (key === "backspace") setState((value) => ({ ...value, searchInput: value.searchInput!.slice(0, -1) }));
      else if (text && !event.ctrl && !event.alt) setState((value) => typeSearch(value, text));
      return;
    }
    // A live chat input owns every printable key; Esc leaves. Without a
    // provider the input is inert and keys keep their command meaning.
    if (current.view === "chat" && providerAvailable && key !== "escape" && !event.ctrl) {
      if (key === "enter") runChatQuery();
      else if (key === "backspace") setChatInput((value) => value.slice(0, -1));
      else if (text && !event.alt) setChatInput((value) => value + text);
      return;
    }
    if (current.view === "chat" && !providerAvailable && pasted) { setState((value) => ({ ...value, message: "chat input disabled · run atlas doctor" })); return; }
    if (current.view === "tag" && key === "enter") {
      const row = readTagSessionRows(current.activeTag ?? "")[tagFocus]; if (row) invoke("open-session", String(row.id)); return;
    }
    if (key === "escape") { setState((value) => esc(value)); return; }
    if (event.ctrl && key === "c") { exit(); return; }
    if (event.ctrl && key === "z") { invoke("undo"); return; }
    if (event.shift && (key === "j" || key === "k" || key === "down" || key === "up") && current.view === "list") {
      const anchor = current.list.focusKey;
      setState((value) => anchor ? extendSelectionFromKey(moveFocus(value, key === "k" || key === "up" ? -1 : 1), anchor) : value);
      return;
    }
    const command = findByKey(event, commandContext(current));
    if (!command) return;
    // q quits only from the bare home list; anywhere else it is Esc.
    if (command.id === "quit" && !quitAllowed(current)) { setState((value) => esc(value)); return; }
    const arg = command.id === "filter-harness" ? harnessForKey(key) : command.id === "yank" && text === "Y" ? "prose" : undefined;
    invoke(command.id, arg, "key");
  }, [cancelExport, confirmExport, exit, exportFlow, height, processingOpen, invoke, providerAvailable, readTagSessionRows, runChatQuery, setState, tagFocus]);
  const handlerRef = useRef(handleInput); handlerRef.current = handleInput;

  // Production installs exactly one Atlas tokenizer/pump and no Ink useInput.
  useEffect(() => {
    if (!terminal) return;
    const adapter = new TerminalEventAdapter({
      registry: interactions.current,
      keyboardOwner: "atlas",
      // Keys are commands, never hidden zone focus: Tab does nothing and a
      // click never changes what Enter or y will act on.
      zoneKeyboard: false,
      onUnhandledText: (text) => handlerRef.current({ key: text, text }),
      onUnhandledPaste: (text) => handlerRef.current({ key: text, text }, true),
      onUnhandledKey: (event) => handlerRef.current({ key: event.key, ctrl: event.ctrl, alt: event.alt, shift: event.shift, meta: event.meta }),
    });
    const pump = new TerminalEventPump({ terminal, adapter, stdin: terminalStdin });
    pump.start();
    return () => pump.stop();
  }, [terminal, terminalStdin]);

  const overlayZones = useMemo<InteractionZone[]>(() => {
    if (!modalOpen) return [];
    const zones: InteractionZone[] = [{ id: "modal:backdrop", rect: { x: 0, y: 0, width, height }, zIndex: 100, onEvent: (event) => { if (event.event.type === "mouse") event.stopPropagation(); return true; } }];
    if (processingOpen) zones.push({ id: "modal:processing:back", rect: { x: 2, y: 1, width: 8, height: 1 }, zIndex: 101,
      onEvent: event => { if (event.event.type === "mouse" && event.event.action === "press") { setProcessingOpen(false); return true; } return false; } });
    if (exportFlow?.kind === "preview") exportFlow.choices.forEach((choice, index) => zones.push({
      id: `modal:export:${choice.name ?? "none"}`, rect: { x: 2, y: 7 + index, width: Math.max(1, width - 4), height: 1 }, zIndex: 101, focusable: true,
      onEvent: (event) => { if (event.event.type !== "mouse" || event.event.action !== "press") return false; setExportChoice(index); confirmExport(index); event.stopPropagation(); return true; },
    }));
    return zones;
  }, [confirmExport, exportFlow, height, modalOpen, processingOpen, width]);

  const installInteractionZones = useCallback((next: readonly InteractionZone[]) => {
    interactions.current.reset();
    const root: InteractionZone = { id: "app:root", rect: { x: 0, y: 0, width, height }, zIndex: -100, onEvent: (event) => {
      if (event.event.type === "mouse") {
        lastInteractionAt.current = Date.now();
        // The list wheel scrolls the viewport; other surfaces own their wheel.
        if (event.event.action === "scroll") {
          if (stateRef.current.view === "list" && !modalOpen) setState((value) => scrollList(value, event.event.type === "mouse" && event.event.button === "wheel-up" ? -3 : 3));
          return true;
        }
      }
      return false;
    } };
    interactions.current.register(root);
    for (const zone of modalOpen ? overlayZones : next) interactions.current.register(zone.parentId === undefined ? { ...zone, parentId: "app:root" } : zone);
    terminal?.setHoverSurface("app-interactions", !modalOpen && next.length > 0);
  }, [height, modalOpen, overlayZones, setState, terminal, width]);
  installSurfaceZones.current = installInteractionZones;

  // Pointer routing must change in the same commit as modal visibility; a
  // passive effect leaves one frame where clicks can leak into stale zones.
  // Surface publications update the registry directly, without scheduling a
  // second React render for every cursor move.
  useLayoutEffect(() => {
    installInteractionZones(surfaceZones.current);
    return () => terminal?.setHoverSurface("app-interactions", false);
  }, [installInteractionZones, terminal]);

  // Hover belongs to the list surface; another view starts from none.
  useEffect(() => { setHoverKey(null); }, [state.view]);

  const dashboardActions = useMemo(() => ({
    onUndo: () => invoke("undo", undefined, "click"),
    onProcessing: () => invoke("processing-status", undefined, "click"),
    onOpenSession: (key: SessionKey, options?: { extendSelection?: boolean }) => {
      const current = stateRef.current;
      const target = current.list.rows.findIndex((row) => sessionKey(row) === key);
      if (target < 0) return;
      const next = { ...current, list: { ...current.list, focus: target, focusKey: key, projectionFocusKey: key } };
      if (options?.extendSelection) { const anchor = current.list.focusKey; setState(anchor ? extendSelectionFromKey(next, anchor) : next); return; }
      setState(next); invoke("open-session", String(current.list.rows[target]!.id), "click");
    },
    onPeekSession: (key: SessionKey) => invoke("peek", key, "click"),
    onHoverSession: (key: SessionKey | null) => setHoverKey(key),
    onToggleFavorite: (key: SessionKey) => invoke("favorite", key, "click"),
    onToggleChain: (chainId: number) => invoke("chain-toggle", String(chainId), "click"),
    onFilter: (term: FilterTerm) => invoke("filter-set", JSON.stringify(term), "click"),
    onRemoveFilter: (kind: FilterTerm["kind"]) => invoke("filter-remove", kind, "click"),
    onSearch: () => invoke("search", undefined, "click"),
    onApplyLive: () => invoke("live-apply", undefined, "click"),
  }), [invoke, setState]);

  const activeSessionId = state.view === "session" ? state.session?.id ?? null : null;
  const activeSessionSurface = useMemo(
    () => activeSessionId === null ? null : sessionSurfaces.current!.read(db, activeSessionId, dbRevision),
    [activeSessionId, db, dbRevision],
  );
  const activeContractTranscript = useMemo(
    () => state.view === "session" && state.session
      ? readContractTranscript(state)
      : { dto: null, diagnostic: null } satisfies ContractTranscriptOutcome,
    [dbRevision, readContractTranscript, state.session?.id, state.session?.traversalIdx, state.view],
  );
  const activeSessionFacts = useMemo((): SessionFacts | null => {
    if (!activeSessionSurface) return null;
    try {
      const row = db.query(`SELECT ${effectiveCreatorSql("s")} AS value, hc.reason AS reason, hc.method AS method FROM sessions s ${creatorJoinSql("s")} WHERE s.id=?`)
        .get(activeSessionSurface.facts.id) as { value: "human" | "agent" | "unknown" | "empty"; reason: string | null; method: string | null } | null;
      return row ? { ...activeSessionSurface.facts, creator: row } : activeSessionSurface.facts;
    } catch { return activeSessionSurface.facts; }
  }, [activeSessionSurface, db, layersRevision]);
  const activeSessionLayers = useMemo(
    () => activeSessionSurface ? readSessionLayers(db, activeSessionSurface.facts.harness, activeSessionSurface.facts.nativeId) : null,
    [activeSessionSurface, db, layersRevision],
  );
  episodeAnchorsRef.current = useMemo(
    () => sessionEpisodeAnchors({ layers: activeSessionLayers, readerTranscript: activeContractTranscript.dto }),
    [activeContractTranscript.dto, activeSessionLayers],
  );
  const activeParagraphs = useMemo(
    () => activeContractTranscript.dto ? readParagraphBreaks(db, activeContractTranscript.dto) : undefined,
    [activeContractTranscript.dto, db],
  );
  const activeTag = state.view === "tag" ? state.activeTag : null;
  const fallbackTag = useMemo(() => state.view === "tag" && activeTag === null ? firstTag(db) : null, [activeTag, db, dbRevision, state.view]);
  const visibleTag = activeTag ?? fallbackTag;
  const tagSessions = useMemo(
    () => state.view === "tag" && visibleTag ? readTagSessionRows(visibleTag) : [],
    [dbRevision, readTagSessionRows, state.view, visibleTag],
  );
  const dashboardViewport = useMemo(
    () => logicalListViewport(state),
    [state.list.expandedChains, state.list.projectionFocusKey, state.list.projectionScrollKey, state.list.rows, state.visibleRows],
  );
  const dashboardRenderRows = useMemo(
    () => dashboardViewport.rows.map(sanitizeDashboardProjection),
    [dashboardViewport.rows],
  );
  // Analytics refreshes on an idle boundary, while a filter page lands
  // immediately. Keep the list denominator truthful during that short
  // handoff without counting date-cluster headings as sessions.
  const dashboardLogicalRowCount = dashboardViewport.rows.reduce(
    (count, projection) => count + (projection.kind === "cluster" ? 0 : 1),
    0,
  );
  const dashboardAnalyticsForRender = useMemo(
    () => dashboardAnalytics.visibleSessionCount >= dashboardLogicalRowCount
      ? dashboardAnalytics
      : { ...dashboardAnalytics, visibleSessionCount: dashboardLogicalRowCount },
    [dashboardAnalytics, dashboardLogicalRowCount],
  );
  const representedRows = useMemo(() => [...new Map(dashboardViewport.rows.filter((row) => row.kind !== "cluster").map((projection) => {
    const row = projectionSession(projection); return [sessionKey(row), row] as const;
  })).values()], [dashboardViewport.rows]);
  const representedRowKey = representedRows.map((row) => `${row.id}:${row.harness}:${row.native_id}`).join("|");
  const dashboardRowStates = useMemo(
    () => readDashboardRowStates(db, representedRows),
    [db, dbRevision, representedRowKey],
  );
  const dashboardFocus = useMemo(() => {
    const focusable = dashboardViewport.rows.filter(isFocusableProjection);
    const focused = focusable.find((row) => row.key === state.list.projectionFocusKey) ?? focusable[0];
    return focused ? projectionSession(focused) : null;
  }, [dashboardViewport.rows, state.list.projectionFocusKey]);
  const dashboardPeek = useMemo(
    () => state.peek === null ? null : peekFor(db, state.peek),
    [db, dbRevision, state.peek],
  );
  const dashboardSelected = useMemo(() => new Set(state.list.selected), [state.list.selected]);
  const comparisonPreview = useMemo(() => {
    if (!comparison || (shellDashboardWidth(width) < 180 && state.peek === null)) return null;
    const row = state.peek === null ? dashboardFocus : state.list.rows.find(candidate => candidate.id === state.peek);
    if (!row) return null;
    try { return readAtlasTestPreview(db, row, libraryBridge); }
    catch { return { sourceTitle: null, summary: null, summaryLabel: "Saved summary unavailable" }; }
  }, [comparison, dashboardFocus, db, dbRevision, libraryBridge, state.list.rows, state.peek, width]);
  const DashboardSurface = comparison ? AtlasTestDashboard : FlatDashboard;
  const chatWorkspace = useMemo(() => contextualChatLayout(width, height), [height, width]);
  const publishChatArchiveZones = useCallback((zones: readonly InteractionZone[]) => {
    publishWorkspaceZones("archive", zones, chatWorkspace.archive.x, chatWorkspace.archive.y);
  }, [chatWorkspace.archive.x, chatWorkspace.archive.y, publishWorkspaceZones]);
  const publishChatPanelZones = useCallback((zones: readonly InteractionZone[]) => {
    publishWorkspaceZones("chat", zones, chatWorkspace.chat.x, chatWorkspace.chat.y);
  }, [chatWorkspace.chat.x, chatWorkspace.chat.y, publishWorkspaceZones]);

  const renderedSurface = renderSurface();
  const surface = <ViewportInvalidationFrame width={width} height={height}>{renderedSurface}</ViewportInvalidationFrame>;
  if (!terminal) return <><InkInputBridge onInput={handleInput} />{surface}</>;
  return surface;

  function renderSurface(): React.JSX.Element {
    if (processingOpen) {
      let status;
      try { status = libraryBridge?.processingStatus(); } catch (error) { status = { status: "unavailable", detail: messageOf(error), command: "atlas library setup" }; }
      if (comparison) return <Box width={width} height={height} paddingX={2} flexDirection="column" overflow="hidden">
        <Text bold color="cyan">ATLAS TEST · Archive status</Text>
        <Text color="cyan">Back · Esc</Text>
        <Text> </Text>
        <Text>{dashboardAnalytics.corpusSessionCount.toLocaleString()} indexed conversations · {dashboardAnalytics.errorCount} recorded issues</Text>
        <Text> </Text>
        {dashboardAnalytics.sources.map(source => <Text key={source.source} wrap="truncate-end">
          {source.label}: {source.count.toLocaleString()} conversations · {source.ageMs === null ? "update time unknown" : `last recorded update ${Math.floor(source.ageMs / 3_600_000)}h ago`}
        </Text>)}
        <Text> </Text>
        <Text>Saved summaries: {dashboardAnalytics.states.summarized.toLocaleString()}</Text>
        <Text>{status?.detail ?? "Existing topics and summaries are shown as saved."}</Text>
        <Text> </Text>
        <Text dimColor>Read-only comparison. No indexing, summary generation, or saved-data changes.</Text>
        <Text dimColor>Agent filtering uses recorded creation provenance; unknown origins remain visible.</Text>
        <Text dimColor>Improved transcript processing and new topics are separate work.</Text>
      </Box>;
      return <Box width={width} height={height} paddingX={2} flexDirection="column" overflow="hidden">
        <Text bold color="#ff9800">SUMMARY PROCESSING</Text>
        <Text color="#ff9800">‹ Back</Text>
        <Text> </Text>
        <Text>Status: {status?.status ?? "legacy archive"}</Text>
        <Text>{status?.detail ?? "Use the current library to configure bounded summary processing."}</Text>
        <Text> </Text>
        <Text>Cached summaries are readable without a provider.</Text>
        <Text>Opening a conversation does not authorize a library processing run.</Text>
        <Text> </Text>
        <Text color="cyan">{status?.command ?? "atlas library setup"}</Text>
        <Text dimColor>Profile: endpoint, model, credential environment, source scope and token caps.</Text>
        <Text dimColor>Progress is recorded by the librarian coordinator; this panel never starts a job.</Text>
      </Box>;
    }
    if (state.helpOpen) return <HelpOverlay state={state} width={width} height={height} offset={helpOffset} comparison={comparison} />;
    if (state.paletteInput !== null) return <PaletteOverlay state={state} width={width} height={height} comparison={comparison} />;
    if (exportFlow) return <ExportOverlay state={exportFlow} choice={exportChoice} width={width} height={height} />;
    if (state.view === "session" && state.session) {
      const surface = activeSessionSurface;
      if (!surface) return <Text color="red">session #{state.session.id} no longer exists · Esc return</Text>;
      return <IntelligenceSessionView facts={activeSessionFacts ?? surface.facts} summary={tier2}
        readerTranscript={activeContractTranscript.dto} readerDiagnostic={activeContractTranscript.diagnostic}
        paragraphs={activeParagraphs} layers={activeSessionLayers}
        mode={state.session.mode} wrap={state.session.wrap} roleToggle={state.session.roleToggle} width={width} height={height}
        landingBias="later" activeOrdinal={state.activeOrdinal}
        toggledFolds={toggledFolds} aboutOpen={aboutOverride}
        analytics={comparison ? null : dashboardAnalyticsForRender} filter={state.filter} actions={dashboardActions}
        controllerRef={sessionController}
        onLand={(ordinal) => invoke("land-ordinal", String(ordinal), "click")}
        onToggleFolds={(ids) => setToggledFolds((current) => { const next = new Set(current); for (const id of ids) { if (next.has(id)) next.delete(id); else next.add(id); } return next; })}
        onMode={(mode) => invoke(`mode-${mode}`, undefined, "click")}
        onToggleAbout={() => invoke("session-about", undefined, "click")}
        onCreatorToggle={() => invoke("creator-toggle", undefined, "click")}
        spanRange={spanRange(spanAnchor, spanEnd) ? { fromOrdinal: spanRange(spanAnchor, spanEnd)!.from, toOrdinal: spanRange(spanAnchor, spanEnd)!.to } : null}
        message={state.message}
        traversalPosition={state.session.traversalIdx} traversalTotal={state.session.traversal.entries.length}
        onAnchorActivate={(from) => invoke("land-ordinal", String(from), "click")}
        onEpisodeJump={(ordinal) => invoke("land-ordinal", String(ordinal), "click")}
        onNavigate={(delta) => invoke(delta > 0 ? "traverse-next" : "traverse-prev", undefined, "click")}
        onFactActivate={(kind, value) => kind === "tag" ? invoke("open-tag", value, "click") : invoke("filter-set", JSON.stringify({ kind, value } satisfies FilterTerm), "click")}
        onFactYank={(_kind, value) => invoke("yank", `literal:${value}`, "click")}
        onBack={() => invoke("back", undefined, "click")}
        onToggleWrap={() => invoke("transcript-wrap", undefined, "click")}
        onCopyMessage={() => invoke("yank", undefined, "click")}
        onCopyConversation={() => invoke("yank", "conversation", "click")}
        onUndo={() => invoke("undo", undefined, "click")}
        onInteractionZones={publishSurfaceZones} />;
    }
    if (state.view === "chat") {
      const archive = chatWorkspace.archive;
      const chat = chatWorkspace.chat;
      return <Box width={width} height={height} overflow="hidden" flexDirection={chatWorkspace.direction}>
        <DashboardSurface width={shellDashboardWidth(archive.width)} height={archive.height} projections={dashboardRenderRows} analytics={comparison ? dashboardAnalytics : dashboardAnalyticsForRender}
          showAgentConversations={!state.filter.hideAgentConversations} onToggleAgentConversations={toggleAgentConversations}
          focusProjectionKey={state.list.projectionFocusKey} preview={comparisonPreview}
          matchingCountKnown={dashboardAnalyticsFilterKey === filterKey}
          activeProvider={activeProvider?.name ?? null}
          focusKey={dashboardFocus ? sessionKey(dashboardFocus) : null} hoverKey={hoverKey} selectedKeys={dashboardSelected} rowStates={dashboardRowStates}
          filter={state.filter} filterSummary={filterSummary(state.filter)} pendingLiveCount={state.list.pendingLiveRows.length}
          inspector={null} peek={null} message={state.message || "archive · click a row to open it · Esc returns to this chat"}
          commandInput={null} onboardingHint={firstRunHint(firstRun)}
          actions={dashboardActions} onInteractionZones={publishChatArchiveZones} />
        <ChatView width={chat.width} height={chat.height} input={chatInput} status={chatStatus} turns={chatTurns}
          provider={activeProvider?.name} model={activeProvider?.model} reason={chatReason} inputDisabled={!providerAvailable}
          onCitationActivate={(id, ordinal) => invoke("navigate-session", citationArg(id, ordinal), "click")} onInteractionZones={publishChatPanelZones} />
      </Box>;
    }
    if (state.view === "tag") {
      const tag = visibleTag ?? "—";
      return <TagView tag={tag} sessions={tagSessions} synthesis={tagSynthesis} width={width} height={height} focus={tagFocus}
        onSessionActivate={(id, ordinal) => invoke("navigate-session", citationArg(id, ordinal), "click")}
        onCitationActivate={(id, ordinal) => invoke("navigate-session", citationArg(id, ordinal), "click")}
        onResynthesize={providerAvailable ? () => invoke("tag-resynthesize", undefined, "click") : undefined}
        onInteractionZones={publishSurfaceZones} />;
    }
    if (listLoading && state.list.rows.length === 0) return <DashboardLoading width={width} height={height}
      comparison={comparison} searching={comparison ? Boolean(state.filter.query) : Object.keys(state.filter).some((key) => state.filter[key as keyof ListFilter] != null)} />;
    const onboardingHint = firstRunHint(firstRun);
    const batchMessage = listLoading
      ? `SEARCHING · ${filterSummary(state.filter)}`
      : state.list.selected.size > 0 ? `${state.list.selected.size} selected · e export · f fav · x clear` : state.message || firstRunMessage(firstRun);
    return <DashboardSurface width={shellDashboardWidth(width)} height={height} projections={dashboardRenderRows} analytics={comparison ? dashboardAnalytics : dashboardAnalyticsForRender}
      showAgentConversations={!state.filter.hideAgentConversations} onToggleAgentConversations={toggleAgentConversations}
      focusProjectionKey={state.list.projectionFocusKey} preview={comparisonPreview}
      matchingCountKnown={dashboardAnalyticsFilterKey === filterKey}
      activeProvider={activeProvider?.name ?? null}
      focusKey={dashboardFocus ? sessionKey(dashboardFocus) : null} hoverKey={hoverKey} selectedKeys={dashboardSelected} rowStates={dashboardRowStates}
      filter={state.filter} filterSummary={filterSummary(state.filter)} pendingLiveCount={state.list.pendingLiveRows.length}
      inspector={null} peek={dashboardPeek} message={comparison ? batchMessage : readOnly ? `Protected index · ${libraryBridge?.store ? "live favorites + summaries" : "library unavailable"}${batchMessage ? ` · ${batchMessage}` : ""}` : batchMessage}
      commandInput={state.searchInput === null ? null : `/${state.searchInput}`} onboardingHint={onboardingHint}
      actions={dashboardActions} onInteractionZones={publishSurfaceZones} />;
  }
}

interface ContractTranscriptOutcome {
  dto: SessionTranscriptDto | null;
  diagnostic: string | null;
}

function activeSessionRef(state: TuiState, db?: DB): { harness: string; nativeId: string } | null {
  if (!state.session) return null;
  const traversal = state.session.traversal.entries[state.session.traversalIdx ?? -1];
  if (traversal) return { harness: traversal.harness, nativeId: traversal.nativeId };
  const row = state.list.rows.find((candidate) => candidate.id === state.session!.id);
  if (row) return { harness: row.harness, nativeId: row.native_id };
  // Citations can open sessions outside the loaded list page.
  if (!db) return null;
  try { return stableRefForSession(db, state.session.id); } catch { return null; }
}

/** 1 and 2 are the two harnesses md uses; everything else is on the SOURCES rail. */
function harnessForKey(key: string): string | undefined {
  return key === "1" ? "claude" : key === "2" ? "codex" : undefined;
}

function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value);
}

function InkInputBridge({ onInput }: { onInput: (event: UiInput) => void }): null {
  useInput((input, key) => onInput(inkKey(input, key)));
  return null;
}

function DashboardLoading({ width, height, searching, comparison = false }: { width: number; height: number; searching: boolean; comparison?: boolean }): React.JSX.Element {
  return <Box width={Math.max(1, width)} height={Math.max(1, height)} overflow="hidden" flexDirection="column">
    <Text color={comparison ? "cyan" : undefined}> {comparison ? "ATLAS TEST" : "ATLAS"} · {searching ? "SEARCHING ARCHIVE" : "LOADING ARCHIVE"}</Text>
    <Text dimColor> reading session index…</Text>
  </Box>;
}

function inkKey(input: string, key: Key): UiInput {
  const named = key.escape ? "escape" : key.return ? "enter" : key.upArrow ? "up" : key.downArrow ? "down" : key.leftArrow ? "left" : key.rightArrow ? "right" : key.backspace || key.delete ? "backspace" : key.tab ? "tab" : input;
  return { key: named, text: input.length > 0 && !key.ctrl && !key.meta ? input : undefined, ctrl: key.ctrl, alt: key.meta, meta: key.meta, shift: key.shift };
}

/** Compatibility only; production resolves directly with `findByKey`. */
export function commandForKey(input: string, key: Key, state: TuiState): { id: string; arg?: string } | null {
  registerCommands();
  const event = inkKey(input, key);
  const command = findByKey(event, commandContext(state));
  if (!command) return null;
  return { id: command.id, arg: command.id === "filter-harness" ? harnessForKey(event.key) : undefined };
}

/** Compatibility adapter used by focused tokenizer tests; App uses TerminalEventPump. */
export function dispatchTerminalInput(terminal: Pick<TerminalResourceManager, "feed">, registry: Pick<InteractionRegistry, "dispatchPointer">, chunk: Uint8Array | string): number {
  let pointers = 0;
  for (const event of terminal.feed(chunk)) if (event.type === "mouse") { registry.dispatchPointer({ type: "mouse", x: event.x, y: event.y, action: event.action, shift: event.shift, alt: event.alt, ctrl: event.ctrl }); pointers++; }
  return pointers;
}

function comparisonCommandLabel(id: string, label: string): string {
  if (id === "filter-origin") return "Show / hide agent-created conversations";
  if (id === "processing-status") return "Archive status";
  if (id === "peek") return "Preview saved summary";
  return label;
}

function PaletteOverlay({ state, width, height, comparison = false }: { state: TuiState; width: number; height: number; comparison?: boolean }) {
  const results = search(state.paletteInput ?? "", commandContext(state), state).slice(0, Math.max(1, height - 4));
  const accent = comparison ? "cyan" : "#ff9800";
  return <Box width={width} height={height} overflow="hidden" flexDirection="column" borderStyle="single" borderColor={accent} paddingX={1}><Text color={accent}>:{state.paletteInput}▏</Text>{results.map((result, index) => <Text key={result.cmd.id} color={index === state.paletteIndex ? accent : result.disabled ? "gray" : "white"}>{index === state.paletteIndex ? "▌" : " "} {comparison ? comparisonCommandLabel(result.cmd.id, result.cmd.label) : result.cmd.label} {result.cmd.keys?.join(" ") ?? ""}{result.disabled ? ` · ${result.disabled}` : ""}</Text>)}<Text dimColor>type · ↑↓ · Enter · Esc</Text></Box>;
}

/** The whole keymap in one scrollable page, grouped by what it is for. Mouse first. */
const HELP_SECTIONS: ReadonlyArray<[string, ReadonlyArray<[string, string]>]> = [
  ["Everywhere", [
    ["click", "rows open · rail rows and chips filter · underlined path/model filter"],
    ["wheel", "scrolls what is under the pointer; never moves another pane"],
    ["Esc", "back one level: overlay, peek, search, then the page you came from"],
    ["q", "quit from the home list; anywhere else it is Esc"],
    ["?  :", "this help · command palette"],
    ["ctrl-z", "undo the last filter, mark, favorite, or wrap change"],
  ]],
  ["List", [
    ["j k  arrows", "move · shift extends the selection"],
    ["Enter  Space", "open · peek (click the peek strip to open)"],
    ["/", "search · Esc clears it"],
    ["g", "creator lens: human-started / everything / agent-started"],
    ["h", "mark the focused session human- or agent-started"],
    ["1  2", "Claude · Codex (other sources on the SOURCES rail)"],
    ["0", "reset filters to the default human-started lens"],
    ["x  *", "select row · select everything in the filter"],
    ["f  e  y", "favorite · export / continue · copy title"],
    ["c  #", "grounded chat · tag page"],
  ]],
  ["Reading a session", [
    ["j k", "previous / next message"],
    ["PgUp PgDn Home End", "scroll by page / to the ends"],
    ["Enter", "open or fold the tools and injections of the current message"],
    ["m", "view: dialogue / activity / full output (or click the tabs)"],
    ["s  w", "summary and facts pane · wrap"],
    ["n p", "next / previous session in list order"],
    ["[ ]", "previous / next episode (or click one in the about pane)"],
    ["h", "mark this session human- or agent-started"],
    ["x", "mark a span (x again on its end clears)"],
    ["y  Y", "copy message · copy all dialogue"],
    ["rail / chips", "clicking one leaves the session and filters the list"],
  ]],
  ["Chat", [
    ["type  Enter", "ask the archive; every key types"],
    ["click [n]", "open a cited session; Esc comes back to the chat"],
  ]],
];

function HelpOverlay({ state, width, height, offset, comparison = false }: { state: TuiState; width: number; height: number; offset: number; comparison?: boolean }) {
  const accent = comparison ? "cyan" : "#ff9800";
  const lines: Array<{ key: string; text: string; heading?: boolean }> = [];
  for (const [section, rows] of HELP_SECTIONS) {
    if (lines.length) lines.push({ key: "", text: "" });
    lines.push({ key: section, text: "", heading: true });
    for (const [key, text] of rows) lines.push({ key, text });
  }
  const bodyRows = Math.max(1, height - 4);
  const start = Math.max(0, Math.min(offset, Math.max(0, lines.length - bodyRows)));
  const shown = lines.slice(start, start + bodyRows);
  const more = start + bodyRows < lines.length;
  return <Box width={width} height={height} overflow="hidden" flexDirection="column" paddingX={1}>
    <Text bold color={accent}>{comparison ? "ATLAS TEST" : "ATLAS"} HELP  <Text color="#777777">you are in: {state.view}</Text></Text>
    {shown.map((line, index) => line.heading
      ? <Text key={index} bold color="#d8d8d8">{line.key}</Text>
      : <Text key={index} wrap="truncate-end"><Text color={accent}>{`  ${line.key}`.padEnd(22)}</Text><Text color="#b8b8b8">{line.text}</Text></Text>)}
    <Text color="#777777">{more || start > 0 ? "j/k scroll · " : ""}Esc or ? closes</Text>
  </Box>;
}

function ExportOverlay({ state, choice, width, height }: { state: ExportFlowState; choice: number; width: number; height: number }) {
  if (state.kind === "idle" || state.kind === "cancelled") return <Box width={width} height={height}><Text>export cancelled</Text></Box>;
  if (state.kind === "writing") return <Box width={width} height={height} flexDirection="column" borderStyle="single" borderColor="#ff9800" paddingX={1}><Text bold color="#ff9800">EXPORT · WRITING ONCE</Text><Text>{state.preview.predictedTokens}/{state.preview.budget} tokens · {state.preview.minimumTokens} immutable floor</Text></Box>;
  if (state.kind === "failed") return <Box width={width} height={height} flexDirection="column" borderStyle="single" borderColor="red" paddingX={1}><Text>EXPORT FAILED</Text><Text>{state.error.message}</Text><Text>Esc cancel</Text></Box>;
  if (state.kind === "complete") return <Box width={width} height={height}><Text>export complete · {state.written.path}</Text></Box>;
  return <Box width={width} height={height} overflow="hidden" flexDirection="column" borderStyle="single" borderColor="#ff9800" paddingX={1}>
    <Text bold color="#ff9800">EXPORT PREVIEW · NO FILE WRITTEN</Text>
    <Text>scope {state.preview.scopeName} · {state.preview.sessionCount} session(s)</Text>
    <Text>predicted {state.preview.predictedTokens} tok · budget {state.preview.budget} · immutable floor {state.preview.minimumTokens}</Text>
    <Text color={state.compressionNeeded ? "yellow" : "green"}>{state.compressionNeeded ? "compression ladder will run on confirm" : "pass 1 fits without compression"}</Text>
    <Text dimColor>Choose continuation · ↑↓ · Enter confirm · Esc cancel</Text>
    {state.choices.map((item, index) => <Text key={item.name ?? "none"} color={index === choice ? "#ff9800" : "white"}>{index === choice ? "▌" : " "} {item.label}</Text>)}
    {/* Border (2) + six header lines + choices + the PAYLOAD title leave the rest for the excerpt. */}
    {height - 9 - state.choices.length > 0 && state.preview.excerpt.length > 0 ? <>
      <Text bold color="#ff9800">PAYLOAD · first lines</Text>
      {state.preview.excerpt.slice(0, height - 9 - state.choices.length).map((line, index) => <Text key={`excerpt-${index}`} color="#b8b8b8" wrap="truncate-end">{line || " "}</Text>)}
    </> : null}
  </Box>;
}

/** Compatibility renderer retained for old reducer-focused tests. */
export function ListView({ state }: { state: TuiState; status?: unknown; home?: string; db?: DB }) {
  const viewport = logicalListViewport(state);
  const focused = state.list.projectionFocusKey ?? viewport.rows.find((projection) => projection.kind !== "cluster")?.key ?? null;
  return <Box flexDirection="column"><Text color="cyan">session-atlas · {viewport.rows.length} rows{state.filter.harness || state.filter.source ? ` · ${state.filter.harness ?? state.filter.source}` : ""}{state.filter.query ? ` · q:\"${state.filter.query}\"` : ""}</Text>{viewport.rows.length === 0 ? <Text dimColor>(no sessions match)</Text> : viewport.rows.filter((row) => row.kind !== "cluster").map((projection) => { const row = projectionSession(projection); return <Text key={projection.key}>{focused === projection.key ? "▶" : " "} {state.list.selected.has(sessionKey(row)) ? "◆" : " "} #{row.id} {row.harness} {row.title ?? "(no title)"}{row.chain_id === null ? "" : " ⛓"}</Text>; })}<Text dimColor>j/k move · / search · 1/2/3 harness</Text>{state.message ? <Text color="green">{state.message}</Text> : null}</Box>;
}

/** Reflect a completed favorite write immediately instead of waiting for the 2s live-write poll. */
export function reflectFavoriteFacts(state: TuiState, facts: ReadonlyMap<SessionKey, boolean>): TuiState {
  const updateRows = (rows: SessionRow[]): SessionRow[] => {
    let changed = false;
    const next = rows.map((row) => {
      const active = facts.get(sessionKey(row));
      if (active === undefined || (row.favorite > 0) === active) return row;
      changed = true;
      return { ...row, favorite: active ? 1 : 0 };
    });
    return changed ? next : rows;
  };
  const rows = updateRows(state.list.rows);
  const pendingLiveRows = updateRows(state.list.pendingLiveRows);
  const restore = state.restore === null ? null : {
    ...state.restore,
    rows: updateRows(state.restore.rows),
    pendingLiveRows: updateRows(state.restore.pendingLiveRows),
  };
  if (rows === state.list.rows && pendingLiveRows === state.list.pendingLiveRows && restore === state.restore) return state;
  return { ...state, list: { ...state.list, rows, pendingLiveRows }, restore };
}

/** Keep the settled viewport visible while a changed filter is being read. */
export function preserveRowsForRefetch(current: TuiState, next: TuiState): TuiState {
  if (current.view !== "list" || next.view !== "list") return next;
  if (current.list.rows.length === 0 || next.list.rows.length > 0) return next;
  if (listFilterKey(current.filter) === listFilterKey(next.filter)) return next;
  return {
    ...next,
    list: {
      ...next.list,
      rows: current.list.rows,
      focus: current.list.focus,
      focusKey: current.list.focusKey,
      projectionFocusKey: current.list.projectionFocusKey,
      scrollTop: current.list.scrollTop,
      scrollAnchorKey: current.list.scrollAnchorKey,
      projectionScrollKey: current.list.projectionScrollKey,
    },
  };
}

function actionKeys(state: TuiState): SessionKey[] { if (state.view === "session" && state.session) { const entry = state.session.traversal.entries[state.session.traversalIdx ?? -1]; return entry ? [entry.key] : []; } if (state.list.selected.size > 0) return [...state.list.selected]; const row = focusedSessionRow(state); return row ? [sessionKey(row)] : []; }
function spanRange(start: number | null, end: number | null): { from: number; to: number } | null { return start === null || end === null ? null : { from: Math.min(start, end), to: Math.max(start, end) }; }
function stableRefForSession(db: DB, id: number): { harness: string; nativeId: string } { const row = db.prepare(`SELECT harness,native_id FROM sessions WHERE id=?`).get(id) as { harness: string; native_id: string } | null; if (!row) throw new Error(`session #${id} is no longer indexed`); return { harness: row.harness, nativeId: row.native_id }; }
function exportScope(state: TuiState): import("../export.js").ExportScope { if (state.view === "tag" && state.activeTag) return { kind: "tag", name: state.activeTag }; if (state.view === "session" && state.session) return { kind: "session", id: state.session.id }; if (state.list.selected.size > 0) return { kind: "selection", sessions: [...state.list.selected].flatMap((key) => parseSessionKey(key) ?? []) }; const row = focusedSessionRow(state); if (!row) throw new Error("nothing focused to export"); return { kind: "session", id: row.id }; }
function filterSummary(filter: ListFilter): string { const values = [filter.query && `q:${filter.query}`, (filter.source ?? filter.harness) && `src:${filter.source ?? filter.harness}`, filter.origin && `creator:${filter.origin}`, filter.model && `model:${filter.model}`, filter.path && `path:${filter.path}`, filter.tag && `#${filter.tag}`, filter.facet && `facet:${filter.facet}`, filter.layerTag && `tag:${filter.layerTag}`, filter.date && (filter.date.label ?? "date"), (filter.favorite ?? filter.favoritesOnly) && "★ favorites", filter.state && `state:${filter.state}`, filter.chain && `chain:${filter.chain.mode}`].filter(Boolean); return values.length ? values.join(" · ") : "none"; }
function peekFor(db: DB, id: number): PeekData | null { const row = db.prepare(`SELECT harness,native_id,title,models,tok_user,tok_assistant,tok_tool,msg_count,duration_ms FROM sessions WHERE id=?`).get(id) as Record<string, unknown> | null; if (!row) return null; return { key: JSON.stringify([row.harness, row.native_id]) as SessionKey, title: String(row.title ?? row.native_id), lines: [`${row.harness} · ${row.models ?? "—"}`, `u${row.tok_user} a${row.tok_assistant} t${row.tok_tool}`, `${row.msg_count} messages · ${row.duration_ms === null ? "—" : `${Math.round(Number(row.duration_ms) / 60000)}m`}`] }; }
function firstTag(db: DB): string | null { return (db.prepare(`SELECT name FROM tags ORDER BY promoted_at DESC,name LIMIT 1`).get() as { name: string } | null)?.name ?? null; }
function firstRunHint(state: FirstRunState): string { if (state.kind === "configuration-needed") return state.reason === "no-source-roots" ? "configure source roots in config.toml, then relaunch" : "configured sources have no supported adapters"; if (state.kind === "running") return `indexing ${state.currentSource} · ${state.queuedSources.length} queued · ${state.sessionCount} rows`; if (state.kind === "failed") return `initial ingest failed · ${state.error.message}`; return "provider-free initial ingest will begin automatically"; }
function firstRunMessage(state: FirstRunState): string { if (state.kind === "running") { const active = state.progress.find((item) => item.source === state.currentSource); return `INGEST ${state.currentSource} · ${active?.phase ?? "queued"} · roots ${active?.rootsComplete ?? 0}/${active?.rootCount ?? 0} · rows ${state.sessionCount}`; } if (state.kind === "complete") return `initial ingest complete · ${state.sessionCount} rows`; if (state.kind === "cancelled") return `initial ingest cancelled · ${state.sessionCount} rows kept`; return ""; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function citationArg(sessionId: number, ordinal: number | null): string { return `${sessionId}${ordinal === null ? "" : `:${ordinal}`}`; }
function sanitizeDashboardProjection(projection: ProjectedListRow): ProjectedListRow {
  if (projection.kind === "cluster") return projection;
  if (projection.kind === "session") return { ...projection, session: sanitizeDashboardSession(projection.session) };
  return {
    ...projection,
    head: sanitizeDashboardSession(projection.head),
    members: projection.members.map(sanitizeDashboardSession),
  };
}
function sanitizeDashboardSession(row: SessionRow): SessionRow {
  const next = { ...row };
  for (const key of ["harness", "native_id", "title", "firstUser", "cwd", "project", "models", "origin_detail", "classification_reason", "classification_method"] as const) {
    const value = next[key];
    if (typeof value === "string") next[key] = value.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  }
  return next;
}
function shellDashboardWidth(width: number): number {
  // Full-width three-pane frames can wrap a terminal cell at the right edge;
  // keep the narrower breakpoints at their exact width so their rail geometry
  // (and published hit coordinates) does not cross a tier boundary.
  return Math.max(40, width >= 140 ? width - 1 : width);
}
function dashboardPageSize(filter: ListFilter, lineBudget: number): number | undefined {
  // Ranked search hydrates bounded dialogue evidence per hit. Fetch only what
  // this terminal can display plus a small scroll runway; the cursor path
  // fills subsequent pages before focus reaches the end.
  return filter.query ? Math.max(30, lineBudget + 12) : undefined;
}
function readSafeDashboardAnalytics(db: DB, filter: ListFilter): ReturnType<typeof readDashboardAnalytics> { try { return readDashboardAnalytics(db, filter); } catch { return readDashboardAnalytics(db, { ...filter, query: null }); } }
