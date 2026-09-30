import React from "react";
import { Text } from "ink";
import type { DashboardAnalytics, DashboardRowState } from "./analytics.js";
import {
  dashboardFilterChips,
  dashboardFilterInteractionZones,
  dashboardRailInteractionZones,
  dashboardSurfaceLayout,
  type DashboardSurfaceLayout,
  type UltraDenseDashboardProps,
} from "./dashboard.js";
import {
  dateFilterForCluster,
  dashboardColumnBoundaries,
  dashboardListHeaderLayout,
  dashboardListViewport,
  dashboardRowLayout,
  resizeDashboardColumnPair,
  type ColumnBoundary,
  type DashboardListActions,
  type RowLayout,
} from "./list-view.js";
import { projectionSession, sessionKey, type ProjectedListRow, type SessionKey, type SessionRow } from "./domain.js";
import type { InteractionZone } from "./interaction.js";
import { facetShort, facetStyle, railTagEntries } from "./layer-tags.js";
import type { ListFilter } from "./queries.js";
import { ASCII, END_BG, SKIN, asciiLabel, bg, cell, clip, compact, compose, fg, fit, fixed, harnessSkin, paint, serialize, spanWidth, type Span } from "./skin.js";

/** Ingest heat, cold to hot. */
const HEAT = [236, 58, 94, 130, 166, 208, 214].map(bg);

/**
 * The interactive dashboard is one Ink text node, not a Yoga tree. Atlas owns
 * the layout math and hit zones; Ink only performs terminal diffing. Peek is
 * a strip inside the same frame; there are no modal rail excursions.
 */
export function FlatDashboard(props: UltraDenseDashboardProps): React.JSX.Element {
  const width = Math.max(40, Math.floor(props.width));
  const height = Math.max(8, Math.floor(props.height ?? 40));
  const filter = props.filter ?? {};
  const hasFilter = Object.keys(filter).some((key) => filter[key as keyof ListFilter] != null);
  const layout = dashboardSurfaceLayout(width, height, hasFilter, Boolean(props.peek));
  const actions = props.actions;
  const essential = layout.tier === "essential" || layout.tier === "minimum";
  const baseRowLayout = React.useMemo(
    () => flatRowLayout(layout.centerWidth, essential),
    [essential, layout.centerWidth],
  );
  const rowLayoutKey = `${layout.centerWidth}:${essential ? "essential" : "full"}`;
  const [resizedRowLayout, setResizedRowLayout] = React.useState<{ key: string; layout: RowLayout } | null>(null);
  const rowLayout = resizedRowLayout?.key === rowLayoutKey ? resizedRowLayout.layout : baseRowLayout;
  const resizeDrag = React.useRef<ResizeDrag | null>(null);
  React.useEffect(() => { resizeDrag.current = null; }, [rowLayoutKey]);
  const zones = React.useMemo(
    () => actions ? flatDashboardInteractionZones({
      layout,
      analytics: props.analytics,
      projections: props.projections,
      filter,
      actions,
      pendingLiveCount: props.pendingLiveCount ?? 0,
      now: props.now ?? Date.now(),
      rowLayout,
      rowLayoutKey,
      resizeDrag,
      setResizedRowLayout,
      peekKey: props.peek?.key ?? null,
    }) : [],
    [actions, filter, props.peek?.key, layout.detailRows, layout.bodyRows, layout.bodyY, layout.centerWidth, layout.footerY, layout.height, layout.leftWidth, layout.rightWidth, layout.tier, layout.width, props.analytics, props.now, props.pendingLiveCount, props.projections, rowLayout, rowLayoutKey],
  );
  React.useLayoutEffect(() => { props.onInteractionZones?.(zones); }, [props.onInteractionZones, zones]);

  return <Text>{renderFlatDashboardFrame({ ...props, width, height, filter }, layout, rowLayout)}</Text>;
}

interface ResizeDrag {
  boundary: ColumnBoundary;
  startX: number;
  initial: RowLayout;
}

interface FlatZoneOptions {
  layout: DashboardSurfaceLayout;
  analytics: DashboardAnalytics;
  projections: readonly ProjectedListRow[];
  filter: ListFilter;
  actions: DashboardListActions;
  pendingLiveCount: number;
  now: number;
  rowLayout: RowLayout;
  rowLayoutKey: string;
  resizeDrag: { current: ResizeDrag | null };
  setResizedRowLayout: React.Dispatch<React.SetStateAction<{ key: string; layout: RowLayout } | null>>;
  peekKey: SessionKey | null;
}

function flatDashboardInteractionZones(options: FlatZoneOptions): InteractionZone[] {
  const { layout, analytics, projections, filter, actions, pendingLiveCount, now, rowLayout, rowLayoutKey, resizeDrag, setResizedRowLayout, peekKey } = options;
  const rail = dashboardRailInteractionZones({ layout, analytics, actions, filter });
  const filters = dashboardFilterInteractionZones(filter, layout.width, actions);
  const listX = layout.leftWidth > 0 ? layout.leftWidth + 1 : 0;
  const list = flatListInteractionZones({
    width: layout.centerWidth,
    essential: layout.tier === "essential" || layout.tier === "minimum",
    projections,
    actions,
    offsetX: listX,
    offsetY: layout.bodyY,
    height: layout.bodyRows,
    pendingLiveCount,
    now,
    layout: rowLayout,
  });
  list.push({
    id: "dashboard:column-resize",
    rect: { x: listX, y: layout.bodyY + 1, width: layout.centerWidth, height: 1 },
    zIndex: 2,
    onEvent: (event) => {
      if (event.event.type !== "mouse") return false;
      if (event.event.action === "press" && event.event.button === "left") {
        const boundary = dashboardColumnBoundaries(rowLayout)
          .find((candidate) => Math.abs(candidate.x - (event.localX ?? 0)) <= 1);
        if (!boundary) return false;
        resizeDrag.current = { boundary, startX: event.event.x, initial: rowLayout };
        event.stopPropagation();
        return true;
      }
      const drag = resizeDrag.current;
      if (!drag) return false;
      if (event.event.action === "release") {
        resizeDrag.current = null;
        event.stopPropagation();
        return true;
      }
      if (event.event.action !== "move") return false;
      setResizedRowLayout({ key: rowLayoutKey, layout: resizeDashboardColumnPair(drag.initial, drag.boundary, event.event.x - drag.startX) });
      event.stopPropagation();
      return true;
    },
  });
  if (actions.onSearch) list.push({
    id: "dashboard:search",
    rect: { x: listX + Math.max(0, layout.centerWidth - 30), y: layout.bodyY, width: Math.min(30, layout.centerWidth), height: 1 },
    zIndex: 3,
    onEvent: (event) => {
      if (event.event.type !== "mouse" || event.event.action !== "press") return false;
      actions.onSearch?.();
      event.stopPropagation();
      return true;
    },
  });
  if (peekKey !== null && layout.detailRows > 0) list.push({
    id: "dashboard:peek",
    rect: { x: 0, y: layout.bodyY + layout.bodyRows, width: layout.width, height: layout.detailRows },
    onEvent: (event) => {
      if (event.event.type !== "mouse" || event.event.action !== "press") return false;
      actions.onOpenSession?.(peekKey);
      return true;
    },
  });
  const footer = dashboardFooterControls(layout.width, layout.height - 1);
  if (actions.onUndo) list.push({ id: "dashboard:footer:undo", rect: footer.undo, focusable: true, onEvent: footerActivation(actions.onUndo) });
  if (actions.onProcessing) list.push({ id: "dashboard:footer:processing", rect: footer.processing, focusable: true, onEvent: footerActivation(actions.onProcessing) });
  return [...rail, ...filters, ...list];
}

function footerActivation(run: () => void): NonNullable<InteractionZone["onEvent"]> {
  return (event) => {
    const active = event.event.type === "mouse" && event.event.action === "press" || event.event.type === "key" && event.event.key === "enter";
    if (!active) return false;
    run();
    return true;
  };
}

function flatListInteractionZones(options: {
  width: number;
  projections: readonly ProjectedListRow[];
  actions: DashboardListActions;
  essential: boolean;
  offsetX: number;
  offsetY: number;
  height: number;
  pendingLiveCount: number;
  now: number;
  layout: RowLayout;
}): InteractionZone[] {
  const { width, projections, actions, offsetX, offsetY, height, pendingLiveCount, now, layout } = options;
  const viewport = dashboardListViewport(projections, height, pendingLiveCount);
  const favoriteX = layout.focus + layout.gap;
  const topicX = favoriteX + layout.favorite + layout.gap;
  const pathX = topicX + layout.topic + layout.gap;
  const sourceX = pathX + layout.path + layout.gap;
  const inside = (x: number, start: number, span: number): boolean => span > 0 && x >= start && x < start + span;
  const zones: InteractionZone[] = [];

  viewport.projections.forEach((projection, index) => {
    const y = offsetY + 2 + index;
    if (projection.kind === "cluster") {
      zones.push({
        id: `dashboard:${projection.key}`,
        rect: { x: offsetX, y, width, height: 1 },
        focusable: true,
        onEvent: (event) => {
          const activate = event.event.type === "mouse" && event.event.action === "press"
            || event.event.type === "key" && event.event.key === "enter";
          if (!activate) return false;
          actions.onFilter?.(dateFilterForCluster(projection, now));
          return true;
        },
      });
      return;
    }

    const row = projection.kind === "chain" ? projection.head : projection.session;
    const key = sessionKey(row);
    zones.push({
      id: `dashboard:row:${projection.key}`,
      rect: { x: offsetX, y, width, height: 1 },
      focusable: true,
      onEvent: (event) => {
        if (event.event.type === "hover") { actions.onHoverSession?.(event.event.entered ? key : null); return false; }
        if (event.event.type === "key") {
          if (event.event.key === "enter") { actions.onOpenSession?.(key); return true; }
          if (event.event.key === " ") { actions.onPeekSession?.(key); return true; }
          return false;
        }
        if (event.event.type !== "mouse") return false;
        // A wheel moves rows under a still pointer; the next move re-enters.
        if (event.event.action === "scroll") { actions.onHoverSession?.(null); return false; }
        if (event.event.action !== "press") return false;
        // Only cells drawn as links filter: the path and the model name are
        // underlined on the focused row. Everything else on a row opens it.
        const x = event.localX ?? event.event.x - offsetX;
        const model = layout.essential ? null : rawFirstModel(row.models);
        if (inside(x, pathX, layout.path) && (row.project !== null || row.cwd !== null)) {
          actions.onFilter?.({ kind: "path", value: row.project ?? row.cwd! });
        } else if (model !== null && inside(x, sourceX + 3, Math.max(0, layout.source - 3))) {
          actions.onFilter?.({ kind: "model", value: model });
        } else if (projection.kind === "chain" && inside(x, topicX, Math.min(3, layout.topic))) {
          actions.onToggleChain?.(projection.chainId);
        } else actions.onOpenSession?.(key, { extendSelection: Boolean(event.event.shift) });
        return true;
      },
    });
  });

  if (viewport.livePillRow !== null) zones.push({
    id: "dashboard:live-apply",
    rect: { x: offsetX + Math.max(0, width - 16), y: offsetY + viewport.livePillRow, width: Math.min(16, width), height: 1 },
    focusable: true,
    onEvent: (event) => {
      const activate = event.event.type === "mouse" && event.event.action === "press"
        || event.event.type === "key" && event.event.key === "enter";
      if (!activate) return false;
      actions.onApplyLive?.();
      return true;
    },
  });
  return zones;
}

interface FlatFrameProps extends UltraDenseDashboardProps {
  width: number;
  height: number;
  filter: ListFilter;
}


export function renderFlatDashboardFrame(props: FlatFrameProps, suppliedLayout?: DashboardSurfaceLayout, suppliedRowLayout?: RowLayout): string {
  const now = props.now ?? Date.now();
  const layout = suppliedLayout ?? dashboardSurfaceLayout(
    props.width,
    props.height,
    Object.keys(props.filter).some((key) => props.filter[key as keyof ListFilter] != null),
    false,
  );
  const lines: string[] = [];
  lines.push(telemetryLine(layout, props.analytics, props.activeProvider, now));
  if (layout.filterRows) lines.push(filterLine(props.filter, layout.width));

  const center = listLines({
    width: layout.centerWidth,
    height: layout.bodyRows,
    essential: layout.tier === "essential" || layout.tier === "minimum",
    projections: props.projections,
    totalCount: props.analytics.visibleSessionCount,
    focusKey: props.focusKey ?? null,
    selectedKeys: props.selectedKeys ?? EMPTY_SESSION_KEYS,
    rowStates: props.rowStates ?? EMPTY_ROW_STATES,
    filterSummary: props.filterSummary ?? "none",
    pendingLiveCount: props.pendingLiveCount ?? 0,
    now,
    analytics: props.analytics,
    onboardingHint: props.onboardingHint ?? "configure source roots, then run atlas index",
    rowLayout: suppliedRowLayout,
  });
  // Rails sit on a panel background; the one-cell gutter beside each rail
  // belongs to the panel, so the center reads as the open page.
  const left = layout.leftWidth > 0 ? operationalRailLines(props.analytics, layout.leftWidth + 1, layout.bodyRows, props.filter) : [];
  const right = layout.rightWidth > 0 ? analyticsRailLines(props.analytics, layout.rightWidth + 1, layout.bodyRows) : [];
  const blankCenter = " ".repeat(layout.centerWidth);
  for (let row = 0; row < layout.bodyRows; row++) {
    lines.push(`${left[row] ?? ""}${center[row] ?? blankCenter}${right[row] ?? ""}`);
  }
  if (layout.detailRows > 0 && props.peek) lines.push(...peekLines(props.peek, layout.width, layout.detailRows));
  lines.push(contextLine(props, layout.width, suppliedRowLayout ?? flatRowLayout(layout.centerWidth, layout.tier === "essential" || layout.tier === "minimum")));
  lines.push(commandLine(layout.width, props.commandInput ?? null, props.message ?? ""));
  while (lines.length < layout.height) lines.splice(Math.max(0, lines.length - 2), 0, " ".repeat(layout.width));
  return lines.slice(0, layout.height).join("\n");
}

/** Peek: a panel strip under the list. Click opens; Space or Esc closes. */
function peekLines(peek: NonNullable<UltraDenseDashboardProps["peek"]>, width: number, height: number): string[] {
  const row = (left: readonly Span[], right: readonly Span[] = []): string => `${SKIN.panel}${compose(width, left, right, 2, "left", SKIN.panel)}${END_BG}`;
  const lines = [row([["PEEK", SKIN.label], ["  "], [asciiLabel(peek.title), SKIN.bright]], [["click open", SKIN.dim], ["   "], ["space close", SKIN.dim]])];
  for (const line of peek.lines) lines.push(row([[asciiLabel(line), SKIN.muted]]));
  while (lines.length < height) lines.push(row([]));
  return lines.slice(0, height);
}

const EMPTY_SESSION_KEYS: ReadonlySet<SessionKey> = new Set();
const EMPTY_ROW_STATES: ReadonlyMap<SessionKey, DashboardRowState> = new Map();

function telemetryLine(layout: DashboardSurfaceLayout, analytics: DashboardAnalytics, activeProvider: string | null | undefined, now: number): string {
  const rate = analytics.ingest.sessionsPerSecond === null ? "idle" : `${analytics.ingest.sessionsPerSecond.toFixed(1)}/s`;
  const provider = activeProvider === undefined ? analytics.summarizer.provider : activeProvider;
  const pending = analytics.states.pending;
  const errors = analytics.errorCount;
  const stat = (value: string, label: string, style: string = SKIN.text): Span[] => [[value, style], [` ${label}`, SKIN.dim], ["    "]];
  const badge: Span[] = [[" "], [" ATLAS ", SKIN.badge], ["   "]];
  if (layout.tier === "minimum" || layout.tier === "essential") {
    return compose(layout.width, [
      ...badge,
      ...stat(compact(analytics.corpusSessionCount), "sess"),
      ...stat(compact(pending), "pend", pending > 0 ? SKIN.warn : SKIN.text),
      ...stat(String(errors), "err", errors > 0 ? SKIN.bad : SKIN.text),
    ]);
  }
  const left: Span[] = [
    ...badge,
    ...stat(number(analytics.corpusSessionCount), "sessions"),
    ...stat(layout.tier === "center" ? compact(pending) : number(pending), "pending", pending > 0 ? SKIN.warn : SKIN.text),
    ...stat(String(errors), errors === 1 ? "error" : "errors", errors > 0 ? SKIN.bad : SKIN.text),
    ["ingest ", SKIN.dim], [rate, rate === "idle" ? SKIN.muted : SKIN.good], ["    "],
  ];
  if (layout.tier === "center") return compose(layout.width, left);
  left.push(["summary ", SKIN.dim], provider ? [asciiLabel(provider), SKIN.good] : ["off", SKIN.muted]);
  const clock = new Date(now).toLocaleTimeString("en-US", { hour12: false });
  return compose(layout.width, left, [[clock, SKIN.dim]], 1);
}

export function filterLine(filter: ListFilter, width: number): string {
  // Chip geometry matches dashboardFilterInteractionZones: " FILTER " is eight
  // cells and each chip is as wide as "[label ×]", separated by one space.
  const spans: Span[] = [[" filter ", SKIN.dim]];
  for (const chip of dashboardFilterChips(filter)) spans.push([` ${chip.label.replace(/^★ /, "* ")} x `, SKIN.chip], [" "]);
  return compose(width, spans);
}

interface ListLinesOptions {
  width: number;
  height: number;
  essential: boolean;
  projections: readonly ProjectedListRow[];
  totalCount: number;
  focusKey: SessionKey | null;
  selectedKeys: ReadonlySet<SessionKey>;
  rowStates: ReadonlyMap<SessionKey, DashboardRowState>;
  filterSummary: string;
  pendingLiveCount: number;
  now: number;
  analytics: DashboardAnalytics;
  onboardingHint: string;
  rowLayout?: RowLayout;
}

function listLines(options: ListLinesOptions): string[] {
  const blank = " ".repeat(options.width);
  const lines = Array.from({ length: options.height }, () => blank);
  if (options.projections.length === 0) {
    const first = options.analytics.corpusSessionCount === 0 ? "NO SESSIONS INDEXED" : "NO SESSIONS MATCH";
    const second = options.analytics.corpusSessionCount === 0
      ? (options.analytics.hasEverIngested ? "sources returned no sessions" : options.onboardingHint)
      : (options.filterSummary === "none" ? "current viewport is empty" : options.filterSummary);
    const y = Math.max(0, Math.floor(options.height / 2) - 1);
    lines[y] = serialize([cell(first, options.width, SKIN.label, "center")]);
    if (y + 1 < lines.length) lines[y + 1] = serialize([cell(second, options.width, SKIN.dim, "center")]);
    return lines;
  }

  const logicalRows = options.projections.filter((row) => row.kind !== "cluster").length;
  lines[0] = listHeader(options.width, logicalRows, options.totalCount, options.filterSummary);
  const rowLayout = options.rowLayout ?? flatRowLayout(options.width, options.essential);
  lines[1] = listColumnHeader(rowLayout, options.width);
  const viewport = dashboardListViewport(options.projections, options.height, options.pendingLiveCount);
  const counts = clusterCounts(options.projections);
  viewport.projections.forEach((projection, index) => {
    lines[index + 2] = projection.kind === "cluster"
      ? clusterLine(projection.label, counts.get(projection.key) ?? 0, options.width)
      : sessionLine(projection, rowLayout, options.width, options.focusKey, options.selectedKeys, options.rowStates, options.now);
  });
  if (viewport.livePillRow !== null && viewport.livePillRow < lines.length) {
    lines[viewport.livePillRow] = compose(options.width, [], [[` ${options.pendingLiveCount} new  enter `, SKIN.pill]], 1);
  }
  return lines;
}

/**
 * The shared row lattice, tuned for reading: one gutter cell before the right
 * rail, and TOPIC keeps a readable floor by retiring SIZE, then MSG, then DUR.
 */
const TOPIC_FLOOR = 32;
export function flatRowLayout(width: number, essential: boolean): RowLayout {
  const base = dashboardRowLayout(width, essential);
  if (base.essential) return base;
  const layout = { ...base, topic: Math.max(10, base.topic - 1) };
  for (const column of ["size", "messages", "duration"] as const) {
    if (layout.topic >= TOPIC_FLOOR) break;
    layout.topic += layout[column] + layout.gap;
    layout[column] = 0;
  }
  return layout;
}

function listHeader(width: number, logicalRows: number, totalCount: number, filterSummary: string): string {
  const left: Span[] = [["SESSIONS", SKIN.label], ["  "], [String(logicalRows), SKIN.text], [" of ", SKIN.dim], [number(totalCount), SKIN.muted]];
  const key = (value: string): Span => [value, SKIN.accent];
  const hint = (value: string): Span => [value, SKIN.dim];
  const candidates: Span[][] = filterSummary !== "none"
    ? [
      [[asciiLabel(filterSummary), SKIN.muted], ["    "], key("/"), hint(" edit"), ["    "], hint("drag column edges")],
      [[asciiLabel(filterSummary), SKIN.muted], ["    "], key("/"), hint(" edit")],
      [key("/"), hint(" edit")],
    ]
    : [
      [key("/"), hint(" search"), ["    "], hint("drag column edges")],
      [key("/"), hint(" search")],
    ];
  const budget = width - 2 - spanWidth(left) - 1;
  const right = candidates.find((spans) => spanWidth(spans) <= budget) ?? candidates.at(-1)!;
  return compose(width, left, right, 1);
}

function listColumnHeader(layout: RowLayout, width: number): string {
  const text = cells(layout, [
    [layout.focus, ""], [layout.favorite, ""], [layout.topic, "TOPIC"], [layout.path, "PATH"],
    [layout.source, layout.essential ? "S" : "SRC MODEL"], [layout.age, "AGE", "right"], [layout.duration, "DUR", "right"],
    [layout.tokens, "TOK", "right"], [layout.messages, "MSG", "right"], [layout.size, "SIZE", "right"],
  ]);
  return paint(fixed(text, width), SKIN.dim);
}

/** Month divider: label, then an underlined run of spaces as the rule. */
function clusterLine(label: string, count: number, width: number): string {
  const tail = String(count);
  const fill = Math.max(0, width - 2 - Bun.stringWidth(label) - 2 - tail.length);
  return compose(width, [[label, SKIN.label], [" "], [" ".repeat(fill), SKIN.rule]], [[tail, SKIN.dim]], 1);
}

function sessionLine(
  projection: Exclude<ProjectedListRow, { kind: "cluster" }>,
  layout: RowLayout,
  width: number,
  focusKey: SessionKey | null,
  selectedKeys: ReadonlySet<SessionKey>,
  rowStates: ReadonlyMap<SessionKey, DashboardRowState>,
  now: number,
): string {
  const row = projectionSession(projection);
  const key = sessionKey(row);
  const focused = focusKey === key;
  const selected = selectedKeys.has(key);
  const base = focused ? SKIN.focusRow : selected ? SKIN.selectRow : "";
  const state = rowStates.get(key);
  const favorite = projection.kind === "chain" ? projection.aggregate.favoriteCount > 0 : row.favorite > 0;
  const tokens = projection.kind === "chain" ? projection.aggregate.tokTotal : row.tok_total;
  const messages = projection.kind === "chain" ? projection.aggregate.msgCount : row.msg_count;
  const harness = harnessSkin(row.harness);
  const spans: Span[] = [];
  let used = 0;
  const push = (cellWidth: number, content: readonly Span[]): void => {
    if (cellWidth <= 0) return;
    if (used > 0) spans.push([" ".repeat(layout.gap)]);
    spans.push(...content);
    used += (used > 0 ? layout.gap : 0) + cellWidth;
  };

  // Focus stays legible without color: a glyph, then the row highlight.
  push(layout.focus, [focused ? [fixed(">", layout.focus), SKIN.focusMark] : [" ".repeat(layout.focus)]]);
  const mark: Span = favorite ? ["*", SKIN.accent] : selected ? ["+", SKIN.accent] : [" "];
  // One flag cell: failed, then an unsure creator (h corrects it), agent, orphaned.
  const creator = row.effective_origin;
  const flag: Span = state?.failed ? ["x", SKIN.bad] : creator === "unknown" ? ["?", SKIN.warn] : creator === "agent" ? ["a", SKIN.dim] : state?.orphaned ? ["o", SKIN.dim] : [" "];
  push(layout.favorite, layout.favorite >= 2 ? [mark, flag, [" ".repeat(layout.favorite - 2)]] : [mark]);
  // Typographic punctuation folds to ASCII: one em dash sends the whole line down string-width's slow path.
  const raw = row.title ?? row.firstUser;
  const title = raw ? asciiLabel(raw) : raw;
  const topic: Span[] = [];
  if (projection.kind === "chain") topic.push([projection.expanded ? "-" : "+", SKIN.accentSoft], [`${projection.aggregate.memberCount} `, SKIN.dim]);
  else if (projection.nested) topic.push(["   "]);
  topic.push([title ?? "untitled session", !title ? SKIN.dim : focused ? SKIN.bright : projection.kind !== "chain" && projection.nested ? SKIN.muted : SKIN.text]);
  // The layer facet rides at the end of a wide topic cell, dim; a narrow cell keeps the whole title.
  const facet = state?.facet && layout.topic >= FACET_TOPIC_FLOOR ? facetShort(state.facet) : null;
  push(layout.topic, facet ? fit(layout.topic, topic, [[facet, SKIN.dim]], 0, "right") : fit(layout.topic, topic));
  push(layout.path, pathSpans(pathLabel(row, layout.essential), layout.path, focused));
  push(layout.source, layout.essential
    ? [cell(harness.letter, layout.source, fg(harness.color))]
    : fit(layout.source, [[harness.code, fg(harness.color)], [" "], [firstModel(row.models), focused ? LINK : SKIN.muted]]));
  push(layout.age, [cell(formatAge(row.last_activity, now), layout.age, ageStyle(row.last_activity, now), "right")]);
  // Duration, tokens, and messages share one tone: one transition, not three.
  push(layout.duration, [cell(formatDuration(row.duration_ms), layout.duration, SKIN.muted, "right")]);
  push(layout.tokens, [cell(compact(tokens), layout.tokens, SKIN.muted, "right")]);
  push(layout.messages, [cell(compact(messages), layout.messages, SKIN.muted, "right")]);
  push(layout.size, meter(row.sizePct, layout.size));
  if (width > used) spans.push([" ".repeat(width - used)]);
  return base ? `${base}${serialize(spans, base)}${END_BG}` : serialize(spans);
}

/** Filterable cells read as links on the focused row: a dim underline, no hover needed. */
const LINK = `${SKIN.muted}\x1b[4m`;
const LINK_DIM = `${SKIN.dim}\x1b[4m`;

function pathSpans(label: string, width: number, link = false): Span[] {
  const fitted = fixed(label, width);
  if (label === "-") return [[fitted, SKIN.dim]];
  if (link) {
    const text = fitted.trimEnd();
    const slash = text.lastIndexOf("/");
    const tail = " ".repeat(fitted.length - text.length);
    return slash < 0 ? [[text, LINK], [tail]] : [[text.slice(0, slash + 1), LINK_DIM], [text.slice(slash + 1), LINK], [tail]];
  }
  const slash = fitted.lastIndexOf("/");
  return slash < 0 ? [[fitted, SKIN.muted]] : [[fitted.slice(0, slash + 1), SKIN.dim], [fitted.slice(slash + 1), SKIN.muted]];
}

/** Recency cools from amber through warm neutrals to gray. */
function ageStyle(timestamp: number | null, now: number): string {
  if (timestamp === null) return SKIN.dim;
  const age = now - timestamp;
  if (age < 3_600_000) return SKIN.accent;
  if (age < 21_600_000) return AGE_WARM;
  if (age < 86_400_000) return AGE_MILD;
  if (age < 604_800_000) return SKIN.text;
  return SKIN.muted;
}
const AGE_WARM = fg(215);
const AGE_MILD = fg(223);

function cells(layout: RowLayout, values: Array<[number, string, ("left" | "right" | "center")?]>): string {
  return values.filter(([width]) => width > 0).map(([width, value, align]) => fixed(value, width, align)).join(" ".repeat(layout.gap));
}

function clusterCounts(projections: readonly ProjectedListRow[]): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  let current: string | null = null;
  for (const projection of projections) {
    if (projection.kind === "cluster") { current = projection.key; result.set(current, 0); }
    else if (current) result.set(current, (result.get(current) ?? 0) + 1);
  }
  return result;
}

/**
 * Rail rows. Line order is a hit-zone lattice shared with
 * dashboardRailInteractionZones; `width` includes the panel gutter cell.
 */
function railPane(width: number, gutter: "left" | "right") {
  const inner = width - 1;
  const wrap = (content: string): string => `${SKIN.panel}${gutter === "right" ? " " : ""}${content}${gutter === "left" ? " " : ""}${END_BG}`;
  return {
    blank: wrap(" ".repeat(inner)),
    row: (left: readonly Span[], right: readonly Span[] = [], priority: "left" | "right" = "left"): string => wrap(compose(inner, left, right, 1, priority, SKIN.panel)),
    title: (title: string): string => {
      const fill = Math.max(0, inner - 2 - title.length - 1);
      return wrap(compose(inner, [[title, SKIN.label], [" "], [" ".repeat(fill), SKIN.rule]], [], 1, "left", SKIN.panel));
    },
    pad: (lines: string[], height: number, blank: string): string[] => Array.from({ length: height }, (_, index) => lines[index] ?? blank),
  };
}

export type RailFilter = Pick<ListFilter, "origin" | "facet" | "layerTag">;

export function operationalRailLines(analytics: DashboardAnalytics, width: number, height: number, filter: RailFilter): string[] {
  const activeOrigin = filter.origin;
  const pane = railPane(width, "left");
  const lines: string[] = [pane.title("SOURCES")];
  const maxSource = Math.max(1, ...analytics.sources.map((source) => source.count));
  for (const source of analytics.sources) {
    const skin = harnessSkin(source.source);
    lines.push(pane.row([[skin.code, fg(skin.color)], [" "], [runBar(source.count / maxSource, 9), fg(skin.color)]], [[compact(source.count), SKIN.muted]]));
  }
  lines.push(pane.blank, pane.title("STATE"));
  lines.push(pane.row([["  summarized", SKIN.good]], [[compact(analytics.states.summarized), SKIN.muted]]));
  lines.push(pane.row([["  pending", SKIN.warn]], [[compact(analytics.states.pending), SKIN.muted]]));
  lines.push(pane.row([["o", SKIN.dim], [" orphaned", SKIN.muted]], [[compact(analytics.states.orphaned), SKIN.muted]]));
  lines.push(pane.row([["*", SKIN.accent], [" favorite", SKIN.text]], [[compact(analytics.states.favorite), SKIN.muted]]));
  if (analytics.origins?.length) {
    lines.push(pane.blank, pane.title("CREATOR"));
    const option = (active: boolean, label: string, count: number): string =>
      pane.row([[active ? ">" : " ", SKIN.accent], [` ${label}`, active ? SKIN.bright : SKIN.muted]], [[compact(count), SKIN.muted]]);
    lines.push(option(activeOrigin == null, "all", analytics.origins.reduce((sum, origin) => sum + origin.count, 0)));
    for (const origin of analytics.origins) lines.push(option(activeOrigin === origin.label, origin.label === "unknown" ? "? unsure" : origin.label, origin.count));
  }
  lines.push(pane.blank, pane.title(filter.facet ? "TAGS" : "FACETS"));
  for (const entry of railTagEntries(analytics, filter, analytics.origins?.length ? 2 : 7)) {
    const count: Span[] = entry.count === null ? [] : [[compact(entry.count), SKIN.muted]];
    const mark: Span = [entry.active ? ">" : " ", SKIN.accent];
    switch (entry.kind) {
      case "empty": lines.push(pane.row([[entry.display, SKIN.dim]])); break;
      case "all": lines.push(pane.row([[entry.display, SKIN.muted]])); break;
      // Counts win over long labels: the label clips, the number never does.
      case "facet": lines.push(pane.row([mark, [" "], [asciiLabel(entry.display), entry.active ? `${facetStyle(entry.label)}\x1b[1m` : facetStyle(entry.label)]], count, "right")); break;
      case "layerTag": lines.push(pane.row([mark, [entry.nested ? "   /" : "  ", SKIN.dim], [asciiLabel(entry.display), entry.active ? SKIN.bright : SKIN.text]], count, "right")); break;
      case "tag": lines.push(pane.row([["#", SKIN.dim], [asciiLabel(entry.display), SKIN.text]], count, "right")); break;
    }
  }
  return pane.pad(lines, height, pane.blank);
}

function analyticsRailLines(analytics: DashboardAnalytics, width: number, height: number): string[] {
  const pane = railPane(width, "right");
  const bars = (rows: readonly { label: string; count: number }[]): string[] => {
    if (rows.length === 0) return [pane.row([["-", SKIN.dim]])];
    const maximum = Math.max(1, ...rows.map((entry) => entry.count));
    return rows.map((entry) => pane.row([[asciiLabel(entry.label), SKIN.text]], [[fixed(runBar(entry.count / maximum, 6), 6, "right"), SKIN.tan], [fixed(compact(entry.count), 6, "right"), SKIN.muted]]));
  };
  const lines: string[] = [pane.title("MODELS"), ...bars(analytics.models), pane.blank, pane.title("SIZE / TOKENS"), ...bars(analytics.sizes), pane.blank, pane.title("INGEST 24H")];
  lines.push(pane.row(heatStrip(analytics.ingest.hourlySessions)));
  const freshnessSpans: Span[] = analytics.sources.length === 0 ? [["-", SKIN.dim]] : analytics.sources.flatMap((source, index): Span[] => {
    const skin = harnessSkin(source.source);
    return [...(index > 0 ? [["  "] as Span] : []), [skin.code, fg(skin.color)], [` ${freshness(source.ageMs)}`, SKIN.dim]];
  });
  lines.push(pane.row(freshnessSpans));
  lines.push(pane.blank, pane.title("SUMMARIZER"));
  lines.push(pane.row([["queue", SKIN.muted]], [[compact(analytics.summarizer.queue), SKIN.text]]));
  lines.push(pane.row([["rate", SKIN.muted]], [[`${analytics.summarizer.ratePerMinute.toFixed(1)}/min`, SKIN.text]]));
  lines.push(pane.row([["failures", SKIN.muted]], [[compact(analytics.summarizer.failures), analytics.summarizer.failures > 0 ? SKIN.bad : SKIN.text]]));
  return pane.pad(lines, height, pane.blank);
}

/**
 * The LOG line doubles as the title strip: the hovered row's title, or the
 * focused row's when its TOPIC cell clips it. One fixed line, so rows never
 * move under the pointer; the newest event keeps the right edge when wide.
 */
export function contextLine(props: Pick<FlatFrameProps, "projections" | "hoverKey" | "focusKey" | "analytics">, width: number, rowLayout: RowLayout): string {
  const hovered = props.hoverKey ? projectionTitle(props.projections, props.hoverKey) : null;
  const focused = hovered === null && props.focusKey ? projectionTitle(props.projections, props.focusKey) : null;
  const title = hovered ?? (focused !== null && Bun.stringWidth(focused) > Math.max(0, rowLayout.topic - 2) ? focused : null);
  if (title === null) return eventLine(props.analytics, width);
  const latest = props.analytics.events[0];
  const right: Span[] = width >= 120 && latest ? [[timeLabel(latest.at), SKIN.dim], [" "], [latest.label, SKIN.muted]] : [];
  const label: Span[] = [[" "], ["TITLE", SKIN.label], ["  "]];
  const budget = Math.max(8, width - spanWidth(label) - spanWidth(right) - 4);
  const text = Bun.stringWidth(title) > budget ? `${clip(title, budget - 3).trimEnd()}...` : title;
  return compose(width, [...label, [text, hovered !== null ? SKIN.bright : SKIN.text]], right, 1);
}

function projectionTitle(projections: readonly ProjectedListRow[], key: SessionKey): string | null {
  for (const projection of projections) {
    if (projection.kind === "cluster") continue;
    const row = projection.kind === "chain" ? projection.head : projection.session;
    if (sessionKey(row) !== key) continue;
    const title = row.title ?? row.firstUser;
    return title ? asciiLabel(title.replace(/\s+/gu, " ").trim()) : null;
  }
  return null;
}

export function eventLine(analytics: DashboardAnalytics, width: number): string {
  const maximum = width >= 120 ? 3 : width >= 80 ? 2 : 1;
  const spans: Span[] = [[" "], ["LOG", SKIN.label], ["   "]];
  if (analytics.events.length === 0) spans.push(["no ingest or summary events", SKIN.dim]);
  else analytics.events.slice(0, maximum).forEach((event, index) => {
    if (index > 0) spans.push(["     "]);
    spans.push([timeLabel(event.at), SKIN.dim], [" "], [event.label, SKIN.muted]);
  });
  return compose(width, spans);
}

export function commandLine(width: number, input: string | null, message: string): string {
  // Rows, rails, and chips are the primary controls; the footer names only
  // the two ways into everything else.
  const shortcuts: Array<[string, string]> = width >= 80 ? [["/", "search"], ["?", "help"]] : [["?", "help"], ["esc", "back"]];
  const right: Span[] = shortcuts.flatMap(([key, label], index): Span[] => [...(index > 0 ? [["   "] as Span] : []), [key, SKIN.accent], [` ${label}`, SKIN.dim]]);
  // Footer control cells match dashboardFooterControls: six and twelve cells,
  // one apart, ending one cell before the right edge.
  if (width >= 80) right.push(["    "], [" undo ", SKIN.chip], [" "], [" processing ", SKIN.chip]);
  const prompt: Span = input !== null ? [input, SKIN.text] : message ? [asciiLabel(message), SKIN.muted] : ["_", SKIN.dim];
  return compose(width, [[">", SKIN.accent], [" "], prompt], right, 1, "right");
}

function dashboardFooterControls(width: number, y: number): { undo: { x: number; y: number; width: number; height: number }; processing: { x: number; y: number; width: number; height: number } } {
  const undoWidth = 6;
  const processingWidth = 12;
  const start = Math.max(1, width - undoWidth - processingWidth - 2);
  return { undo: { x: start, y, width: undoWidth, height: 1 }, processing: { x: start + undoWidth + 1, y, width: processingWidth, height: 1 } };
}



/** Topic cells narrower than this show no facet. */
const FACET_TOPIC_FLOOR = 36;

function firstModel(models: string | null): string {
  const raw = rawFirstModel(models);
  return raw?.replace(/^claude-/, "").replace(/-(?:20\d{6}|latest)$/i, "").replace(/^openai\//, "").replace(/^deepseek-/, "") ?? "-";
}

function rawFirstModel(models: string | null): string | null {
  if (!models) return null;
  try {
    const values: unknown = JSON.parse(models);
    return Array.isArray(values) && typeof values[0] === "string" ? values[0] : null;
  } catch { return null; }
}

function pathLabel(row: SessionRow, essential: boolean): string {
  const path = row.project ?? row.cwd;
  if (!path) return "-";
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return path;
  if (essential) return parts.at(-1) ?? path;
  return parts.length > 1 ? `${parts.at(-2)}/${parts.at(-1)}` : parts[0] ?? path;
}

function formatAge(timestamp: number | null, now: number): string {
  if (timestamp === null) return "-";
  const age = Math.max(0, now - timestamp);
  if (age < 60_000) return "now";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`;
  if (age < 604_800_000) return `${Math.floor(age / 86_400_000)}d`;
  const date = new Date(timestamp);
  return `${MONTHS[date.getMonth()]}${date.getDate()}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDuration(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 60_000) return "<1m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${String(minutes % 60).padStart(2, "0")}`;
  return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, "0")}h`;
}


function number(value: number): string { return NUMBER_FORMAT.format(value); }
const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

function freshness(ageMs: number | null): string {
  if (ageMs === null) return "-";
  if (ageMs < 60_000) return "now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h`;
  return `${Math.floor(ageMs / 86_400_000)}d`;
}

/**
 * Glyph bars, not background cells: stacked background runs fuse into one
 * slab across rows, while a colored glyph run keeps each row distinct.
 */
function runBar(ratio: number, width: number): string {
  if (!(ratio > 0)) return "";
  return "=".repeat(Math.max(1, Math.round(Math.min(1, ratio) * width)));
}

/** Fixed-width percentile meter: a filled run over a faint track, warmer as it fills. */
function meter(ratio: number, width: number): Span[] {
  if (width <= 0) return [];
  const filled = Math.max(1, Math.min(width, Math.round(ratio * width)));
  const tone = ratio >= .9 ? SKIN.accentSoft : ratio >= .5 ? SKIN.muted : SKIN.dim;
  return [["=".repeat(filled), tone], ["-".repeat(width - filled), SKIN.faint]];
}

/** One background cell per hour on a cold-to-hot ramp. */
function heatStrip(values: readonly number[]): Span[] {
  if (values.length === 0) return [["-", SKIN.dim]];
  const maximum = Math.max(0, ...values);
  const spans: Span[] = values.map((value): Span => [" ", HEAT[maximum === 0 || value === 0 ? 0 : Math.max(1, Math.round((value / maximum) * (HEAT.length - 1)))]]);
  if (maximum === 0) spans.push(["  quiet", SKIN.dim]);
  return spans;
}

function timeLabel(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

