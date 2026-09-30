import React from "react";
import { Box, Text } from "ink";
import {
  sessionKey,
  type ProjectedListRow,
  type SessionKey,
  type SessionRow,
} from "./domain.js";
import type { DashboardRowState } from "./analytics.js";
import type { FilterTerm } from "./queries.js";
import type { InteractionZone } from "./interaction.js";
import { displayWidth, truncateDisplayText } from "./transcript-layout.js";

export const ATLAS_COLORS = {
  background: "#070707",
  chrome: "#000000",
  join: "#1c1914",
  focus: "#ff9800",
  favorite: "#ffd600",
  error: "#ff1744",
  good: "#22c55e",
  textHigh: "#cfcfcf",
  text: "#9a9a9a",
  textLow: "#525252",
  track: "#292929",
  claude: "#c98a2a",
  codex: "#2a9d9d",
  kilo: "#8a5fc0",
} as const;

const EMPTY_SESSION_KEYS: ReadonlySet<SessionKey> = new Set();
const EMPTY_ROW_STATES: ReadonlyMap<SessionKey, DashboardRowState> = new Map();

export interface DashboardListActions {
  onUndo?: () => void;
  onProcessing?: () => void;
  onOpenSession?: (key: SessionKey, options?: { extendSelection?: boolean }) => void;
  onPeekSession?: (key: SessionKey) => void;
  /** Pointer entered a row (its key) or left the rows (null). */
  onHoverSession?: (key: SessionKey | null) => void;
  onToggleFavorite?: (key: SessionKey) => void;
  onToggleChain?: (chainId: number) => void;
  onFilter?: (term: FilterTerm) => void;
  onApplyLive?: () => void;
  onRemoveFilter?: (kind: FilterTerm["kind"]) => void;
  onSearch?: () => void;
}

export interface DashboardListViewProps {
  width: number;
  /** The shell breakpoint, distinct from the center pane's allocated width. */
  essential?: boolean;
  projections: readonly ProjectedListRow[];
  totalCount: number;
  focusKey?: SessionKey | null;
  selectedKeys?: ReadonlySet<SessionKey>;
  rowStates?: ReadonlyMap<SessionKey, DashboardRowState>;
  filterSummary?: string;
  pendingLiveCount?: number;
  /** Total lines available to this list, including its two pinned header rows. */
  height?: number;
  now?: number;
  actions?: DashboardListActions;
  interactionOffsetX?: number;
  interactionOffsetY?: number;
  onInteractionZones?: (zones: readonly InteractionZone[]) => void;
}

export interface DashboardListZoneOptions {
  width: number;
  projections: readonly ProjectedListRow[];
  actions: DashboardListActions;
  essential?: boolean;
  offsetX?: number;
  offsetY?: number;
  height?: number;
  pendingLiveCount?: number;
  now?: number;
  layout?: RowLayout;
}

export interface DashboardListViewport {
  projections: readonly ProjectedListRow[];
  hiddenCount: number;
  contentRows: number;
  livePillRow: number | null;
}

/** Exact list-line budget shared by rendering and hit-zone publication. */
export function dashboardListViewport(
  projections: readonly ProjectedListRow[],
  height = Number.POSITIVE_INFINITY,
  pendingLiveCount = 0,
): DashboardListViewport {
  const finite = Number.isFinite(height);
  const liveRows = pendingLiveCount > 0 ? 1 : 0;
  const contentRows = finite ? Math.max(0, Math.floor(height) - 2 - liveRows) : projections.length;
  const visible = projections.slice(0, contentRows);
  return {
    projections: visible,
    hiddenCount: Math.max(0, projections.length - visible.length),
    contentRows,
    livePillRow: pendingLiveCount > 0 ? 2 + contentRows : null,
  };
}

export function dateFilterForCluster(cluster: ProjectedListRow & { kind: "cluster" }, now = Date.now()): Extract<FilterTerm, { kind: "date" }> {
  const day = new Date(now);
  const today = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  if (cluster.cluster === "today") return { kind: "date", value: { from: today, to: today + 86_400_000, label: cluster.label } };
  if (cluster.cluster === "yesterday") return { kind: "date", value: { from: today - 86_400_000, to: today, label: cluster.label } };
  if (cluster.cluster === "this-week") {
    const mondayOffset = (day.getDay() + 6) % 7;
    return { kind: "date", value: { from: today - mondayOffset * 86_400_000, to: today, label: cluster.label } };
  }
  if (cluster.cluster === "unknown") return { kind: "date", value: { from: 0, to: null, label: cluster.label } };
  const [year, month] = cluster.cluster.slice("month:".length).split("-").map(Number);
  return { kind: "date", value: { from: new Date(year!, month! - 1, 1).getTime(), to: new Date(year!, month!, 1).getTime(), label: cluster.label } };
}

export interface RowLayout {
  essential: boolean;
  focus: number;
  favorite: number;
  topic: number;
  path: number;
  source: number;
  age: number;
  duration: number;
  tokens: number;
  messages: number;
  size: number;
  gap: number;
}

/** Public so the integration owner can derive matching mouse zones. */
export function dashboardRowLayout(width: number, essential = width < 80): RowLayout {
  const available = Math.max(20, Math.floor(width));
  if (essential) {
    const fixed = 1 + 2 + 10 + 2 + 4 + 6 + 6;
    return {
      essential: true,
      focus: 1,
      favorite: 2,
      topic: Math.max(4, available - fixed),
      path: 10,
      source: 2,
      age: 4,
      duration: 0,
      tokens: 6,
      messages: 0,
      size: 0,
      gap: 1,
    };
  }
  const fixed = 1 + 2 + 12 + 14 + 5 + 6 + 6 + 5 + 6 + 9;
  return {
    essential: false,
    focus: 1,
    favorite: 2,
    topic: Math.max(10, available - fixed),
    path: 12,
    source: 14,
    age: 5,
    duration: 6,
    tokens: 6,
    messages: 5,
    size: 6,
    gap: 1,
  };
}

/**
 * Renderer-independent zones matching the exact one-cell list geometry. The
 * shell registers these with Wave 0's InteractionRegistry; callbacks in this
 * component API then route to the command registry rather than side channels.
 */
export function dashboardListInteractionZones({
  width,
  projections,
  actions,
  essential = width < 80,
  offsetX = 0,
  offsetY = 0,
  height,
  pendingLiveCount = 0,
  now = Date.now(),
  layout: suppliedLayout,
}: DashboardListZoneOptions): InteractionZone[] {
  const layout = suppliedLayout ?? dashboardRowLayout(width, essential);
  const viewport = dashboardListViewport(projections, height, pendingLiveCount);
  const x = {
    favorite: layout.focus + layout.gap,
    topic: layout.focus + layout.gap + layout.favorite + layout.gap,
  };
  const pathX = x.topic + layout.topic + layout.gap;
  const sourceX = pathX + layout.path + layout.gap;
  const zones: InteractionZone[] = [];
  viewport.projections.forEach((projection, index) => {
    const y = offsetY + 2 + index;
    if (projection.kind === "cluster") {
      zones.push({
        id: `dashboard:cluster:${projection.cluster}`,
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
    const parentId = `dashboard:row:${projection.key}`;
    zones.push({
      id: parentId,
      rect: { x: offsetX, y, width, height: 1 },
      focusable: true,
      onEvent: (event) => {
        if (event.event.type === "mouse" && event.event.action === "press") {
          actions.onOpenSession?.(key, { extendSelection: Boolean(event.event.shift) });
          return true;
        }
        if (event.event.type === "key" && event.event.key === "enter") {
          actions.onOpenSession?.(key);
          return true;
        }
        if (event.event.type === "key" && event.event.key === " ") {
          actions.onPeekSession?.(key);
          return true;
        }
        return false;
      },
    });
    zones.push({
      id: `${parentId}:favorite`,
      parentId,
      rect: { x: offsetX + x.favorite, y, width: layout.favorite, height: 1 },
      onEvent: (event) => {
        if (event.event.type !== "mouse" || event.event.action !== "press") return false;
        actions.onToggleFavorite?.(key);
        event.stopPropagation();
        return true;
      },
    });
    if (layout.path > 0 && (row.project !== null || row.cwd !== null)) {
      zones.push({
        id: `${parentId}:path`,
        parentId,
        rect: { x: offsetX + pathX, y, width: layout.path, height: 1 },
        onEvent: (event) => {
          if (event.event.type !== "mouse" || event.event.action !== "press") return false;
          const path = row.project ?? row.cwd;
          if (path) actions.onFilter?.({ kind: "path", value: path });
          event.stopPropagation();
          return true;
        },
      });
    }
    zones.push({
      id: `${parentId}:source`,
      parentId,
      rect: { x: offsetX + sourceX, y, width: layout.essential ? layout.source : Math.min(3, layout.source), height: 1 },
      onEvent: (event) => {
        if (event.event.type !== "mouse" || event.event.action !== "press") return false;
        actions.onFilter?.({ kind: "source", value: row.harness });
        event.stopPropagation();
        return true;
      },
    });
    const model = rawFirstModel(row.models);
    if (!layout.essential && model !== null && layout.source > 3) zones.push({
      id: `${parentId}:model`,
      parentId,
      rect: { x: offsetX + sourceX + 3, y, width: layout.source - 3, height: 1 },
      onEvent: (event) => {
        if (event.event.type !== "mouse" || event.event.action !== "press") return false;
        actions.onFilter?.({ kind: "model", value: model });
        event.stopPropagation();
        return true;
      },
    });
    if (projection.kind === "chain") {
      zones.push({
        id: `${parentId}:chain`,
        parentId,
        rect: { x: offsetX + x.topic, y, width: Math.min(3, layout.topic), height: 1 },
        onEvent: (event) => {
          if (event.event.type !== "mouse" || event.event.action !== "press") return false;
          actions.onToggleChain?.(projection.chainId);
          event.stopPropagation();
          return true;
        },
      });
    }
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

function sourceColor(harness: string): string {
  const value = harness.toLowerCase();
  if (value === "claude") return ATLAS_COLORS.claude;
  if (value === "codex") return ATLAS_COLORS.codex;
  if (value === "kilo") return ATLAS_COLORS.kilo;
  return ATLAS_COLORS.text;
}

function sourceCode(harness: string, essential: boolean): string {
  const value = harness.toLowerCase();
  if (value === "claude") return essential ? "C" : "CL";
  if (value === "codex") return essential ? "X" : "CX";
  if (value === "kilo") return essential ? "K" : "KI";
  return essential ? harness.slice(0, 1).toUpperCase() : harness.slice(0, 2).toUpperCase();
}

/** Compact creator marker: human, agent, mixed, or metadata-unknown. */
function originPrefix(row: SessionRow): string {
  const decision = row.effective_origin ?? (row.origin === "human" || row.origin === "agent" ? row.origin : null);
  if (!decision) return "";
  const code = decision === "human" ? "H" : decision === "agent" ? "A" : "?";
  return `${code}/`;
}

function firstModel(models: string | null): string {
  const raw = rawFirstModel(models);
  if (raw === null) return "—";
  return raw
    .replace(/^claude-/, "")
    .replace(/-(?:20\d{6}|latest)$/i, "")
    .replace(/^openai\//, "")
    .replace(/^deepseek-/, "");
}

function rawFirstModel(models: string | null): string | null {
  if (!models) return null;
  try {
    const values: unknown = JSON.parse(models);
    if (!Array.isArray(values) || typeof values[0] !== "string") return null;
    return values[0];
  } catch {
    return null;
  }
}

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

function formatAge(timestamp: number | null, now: number): string {
  if (timestamp === null) return "—";
  const age = Math.max(0, now - timestamp);
  if (age < 60_000) return "now";
  if (age < 3_600_000) return `${Math.floor(age / 60_000)}m`;
  if (age < 86_400_000) return `${Math.floor(age / 3_600_000)}h`;
  if (age < 604_800_000) return `${Math.floor(age / 86_400_000)}d`;
  return new Date(timestamp).toLocaleString("en-US", { month: "short", day: "numeric" }).replace(" ", "");
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 60_000) return "<1m";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

function pathLabel(row: SessionRow, essential: boolean): string {
  const path = row.project ?? row.cwd;
  if (!path) return "—";
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return path;
  if (essential) return parts.at(-1) ?? path;
  return parts.length > 1 ? `${parts.at(-2)}/${parts.at(-1)}` : (parts[0] ?? path);
}

function engagementColor(row: SessionRow, state: DashboardRowState | undefined): string {
  if (state?.orphaned) return "#e0503a";
  if ((row.engagement ?? 0) >= 0.32) return ATLAS_COLORS.textHigh;
  if ((row.engagement ?? 0) >= 0.16) return ATLAS_COLORS.text;
  return "#5f5f5f";
}

function stateGlyph(state: DashboardRowState | undefined): { glyph: string; color: string } {
  if (state?.orphaned) return { glyph: " ⚑", color: "#e0503a" };
  if (state?.failed) return { glyph: " ×", color: ATLAS_COLORS.error };
  if (state?.summary === "pending") return { glyph: " ⋯", color: ATLAS_COLORS.favorite };
  return { glyph: "", color: ATLAS_COLORS.textLow };
}

function Cell({
  width,
  color = ATLAS_COLORS.text,
  align = "left",
  children,
}: {
  width: number;
  color?: string;
  align?: "left" | "right" | "center";
  children: React.ReactNode;
}) {
  if (width <= 0) return null;
  return (
    <Box
      width={width}
      minWidth={width}
      overflow="hidden"
      justifyContent={align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start"}
    >
      <Text color={color} wrap="truncate-end">{children}</Text>
    </Box>
  );
}

function truncateCell(value: string, width: number): string {
  if (width <= 0) return "";
  if (Bun.stringWidth(value) <= width) return value;
  if (width === 1) return "…";
  let result = "";
  let used = 0;
  for (const character of value) {
    const characterWidth = Bun.stringWidth(character);
    if (used + characterWidth > width - 1) break;
    result += character;
    used += characterWidth;
  }
  return `${result}${" ".repeat(Math.max(0, width - 1 - used))}…`;
}

function fixedCell(value: string, width: number, align: "left" | "right" | "center" = "left"): string {
  const clipped = truncateCell(value, width);
  const padding = Math.max(0, width - Bun.stringWidth(clipped));
  if (align === "right") return `${" ".repeat(padding)}${clipped}`;
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
  }
  return `${clipped}${" ".repeat(padding)}`;
}

const HeaderRow = React.memo(function HeaderRow({ layout }: { layout: RowLayout }) {
  return (
    <Box columnGap={layout.gap} paddingX={0}>
      <Cell width={layout.focus} color={ATLAS_COLORS.textLow}> </Cell>
      <Cell width={layout.favorite} color={ATLAS_COLORS.textLow}> </Cell>
      <Cell width={layout.topic} color={ATLAS_COLORS.textLow}>TOPIC</Cell>
      <Cell width={layout.path} color={ATLAS_COLORS.textLow}>PATH</Cell>
      <Cell width={layout.source} color={ATLAS_COLORS.textLow}>SRC</Cell>
      <Cell width={layout.age} color={ATLAS_COLORS.textLow} align="right">AGE</Cell>
      <Cell width={layout.duration} color={ATLAS_COLORS.textLow} align="right">DUR</Cell>
      <Cell width={layout.tokens} color={ATLAS_COLORS.textLow} align="right">TOK</Cell>
      <Cell width={layout.messages} color={ATLAS_COLORS.textLow} align="right">MSG</Cell>
      <Cell width={layout.size} color={ATLAS_COLORS.textLow} align="right">SIZE</Cell>
    </Box>
  );
});

interface DisplayRow {
  key: SessionKey;
  row: SessionRow;
  topicPrefix: string;
  favorite: boolean;
  tokens: number;
  messages: number;
  chainSize: number | null;
}

interface SessionLineProps {
  item: DisplayRow;
  layout: RowLayout;
  focused: boolean;
  selected: boolean;
  state: DashboardRowState | undefined;
  now: number;
}

function SessionLineView({
  item,
  layout,
  focused,
  selected,
  state,
  now,
}: SessionLineProps) {
  const row = item.row;
  const marker = stateGlyph(state);
  const filled = Math.max(1, Math.min(layout.size, Math.round(row.sizePct * layout.size)));
  const source = layout.essential
    ? sourceCode(row.harness, true)
    : `${originPrefix(row)}${sourceCode(row.harness, false)}·${firstModel(row.models)}`;
  // Keep every session row to one Yoga text measure. The former Box-per-cell
  // tree looked identical but forced Ink to relayout roughly twenty nodes per
  // visible row on every cursor move.
  const cells = [
    { key: "focus", width: layout.focus, value: focused ? "▌" : " ", color: focused ? ATLAS_COLORS.focus : ATLAS_COLORS.background, align: "left" as const },
    { key: "favorite", width: layout.favorite, value: item.favorite ? "★" : selected ? "◆" : " ", color: ATLAS_COLORS.favorite, align: "center" as const },
    { key: "topic", width: layout.topic, value: `${selected ? "◆ " : ""}${layout.essential ? originPrefix(row) : ""}${item.topicPrefix}${row.title ?? row.firstUser ?? "untitled session"}${marker.glyph}`, color: marker.glyph ? marker.color : engagementColor(row, state), align: "left" as const },
    { key: "path", width: layout.path, value: pathLabel(row, layout.essential), color: ATLAS_COLORS.textLow, align: "left" as const },
    { key: "source", width: layout.source, value: source, color: sourceColor(row.harness), align: "left" as const },
    { key: "age", width: layout.age, value: formatAge(row.last_activity, now), color: ATLAS_COLORS.textLow, align: "right" as const },
    { key: "duration", width: layout.duration, value: formatDuration(row.duration_ms), color: ATLAS_COLORS.textLow, align: "right" as const },
    { key: "tokens", width: layout.tokens, value: compactNumber(item.tokens), color: ATLAS_COLORS.text, align: "right" as const },
    { key: "messages", width: layout.messages, value: compactNumber(item.messages), color: ATLAS_COLORS.textLow, align: "right" as const },
    { key: "size", width: layout.size, value: `${"█".repeat(filled)}${"░".repeat(Math.max(0, layout.size - filled))}`, color: row.sizePct >= 0.75 ? ATLAS_COLORS.focus : "#6e6e6e", align: "right" as const },
  ].filter((cell) => cell.width > 0);
  return (
    <Box
      backgroundColor={focused ? "#211708" : ATLAS_COLORS.background}
      aria-role="listitem"
      aria-state={{ selected: focused }}
      aria-label={`${row.title ?? "untitled session"}, ${row.effective_origin ?? "unclassified"} classification, raw ${row.origin ?? "unknown"} provenance, ${row.harness}, ${formatAge(row.last_activity, now)}`}
    >
      <Text backgroundColor={focused ? "#211708" : ATLAS_COLORS.background}>
        {cells.map((cell, index) => (
          <React.Fragment key={cell.key}>
            {index > 0 ? " ".repeat(layout.gap) : null}
            <Text color={cell.color}>{fixedCell(cell.value, cell.width, cell.align)}</Text>
          </React.Fragment>
        ))}
      </Text>
    </Box>
  );
}

const SessionLine = React.memo(SessionLineView, (left, right) =>
  left.item.row === right.item.row
  && left.item.topicPrefix === right.item.topicPrefix
  && left.item.favorite === right.item.favorite
  && left.item.tokens === right.item.tokens
  && left.item.messages === right.item.messages
  && left.focused === right.focused
  && left.selected === right.selected
  && left.now === right.now
  && left.layout === right.layout
  && left.state?.orphaned === right.state?.orphaned
  && left.state?.summary === right.state?.summary
  && left.state?.failed === right.state?.failed,
);

function clusterCounts(projections: readonly ProjectedListRow[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  let current: string | null = null;
  for (const projection of projections) {
    if (projection.kind === "cluster") {
      current = projection.key;
      counts.set(current, 0);
    } else if (current) {
      counts.set(current, (counts.get(current) ?? 0) + 1);
    }
  }
  return counts;
}

type ResizableColumn = "topic" | "path" | "source" | "age" | "duration" | "tokens" | "messages" | "size";

export interface ColumnBoundary {
  left: ResizableColumn;
  right: ResizableColumn;
  x: number;
}

const COLUMN_MINIMUM: Record<ResizableColumn, number> = {
  topic: 8,
  path: 4,
  source: 3,
  age: 3,
  duration: 3,
  tokens: 3,
  messages: 3,
  size: 3,
};

/** Gap-cell coordinates for the visible, user-resizable data columns. */
export function dashboardColumnBoundaries(layout: RowLayout): ColumnBoundary[] {
  const ordered = (layout.essential
    ? ["topic", "path", "source", "age", "tokens"] as const
    : ["topic", "path", "source", "age", "duration", "tokens", "messages", "size"] as const)
    .filter((column) => layout[column] > 0);
  let x = layout.focus + layout.gap + layout.favorite + layout.gap;
  const boundaries: ColumnBoundary[] = [];
  for (let index = 0; index < ordered.length - 1; index++) {
    const left = ordered[index]!;
    const right = ordered[index + 1]!;
    x += layout[left];
    boundaries.push({ left, right, x });
    x += layout.gap;
  }
  return boundaries;
}

/** Resize one adjacent pair without changing the table's total width. */
export function resizeDashboardColumnPair(layout: RowLayout, boundary: ColumnBoundary, delta: number): RowLayout {
  const pairWidth = layout[boundary.left] + layout[boundary.right];
  const requestedLeft = layout[boundary.left] + delta;
  const nextLeft = Math.max(
    COLUMN_MINIMUM[boundary.left],
    Math.min(pairWidth - COLUMN_MINIMUM[boundary.right], requestedLeft),
  );
  return {
    ...layout,
    [boundary.left]: nextLeft,
    [boundary.right]: pairWidth - nextLeft,
  };
}

export interface DashboardListHeaderLayout {
  interiorWidth: number;
  countText: string;
  countWidth: number;
  contextText: string;
  contextWidth: number;
  gap: number;
}

/** Count owns stable cells; filter/search context may truncate but never overwrite it. */
export function dashboardListHeaderLayout(
  width: number,
  logicalRows: number,
  totalCount: number,
  filterSummary: string,
): DashboardListHeaderLayout {
  const interiorWidth = Math.max(1, Math.floor(width) - 2);
  const countText = `SESSIONS ${logicalRows}/${totalCount}`;
  const countWidth = Math.min(interiorWidth, displayWidth(countText));
  const gap = interiorWidth > countWidth ? 1 : 0;
  const contextBudget = Math.max(0, interiorWidth - countWidth - gap);
  const filtered = filterSummary !== "none";
  const candidates = filtered
    ? [`${filterSummary} · [/ EDIT] · ↔ drag headers`, `${filterSummary} · [/ EDIT]`, "[/ EDIT]"]
    : ["[/ SEARCH · Ctrl-F] · ↔ drag headers", "[/ SEARCH · Ctrl-F]", "[/ SEARCH]"];
  const contextText = candidates.find((candidate) => displayWidth(candidate) <= contextBudget)
    ?? (contextBudget > 0 ? truncateDisplayText(candidates.at(-1)!, contextBudget) : "");
  return {
    interiorWidth,
    countText: truncateDisplayText(countText, countWidth || 1),
    countWidth,
    contextText,
    contextWidth: Math.min(contextBudget, displayWidth(contextText)),
    gap,
  };
}

export function DashboardListView({
  width,
  essential = width < 80,
  projections,
  totalCount,
  focusKey = null,
  selectedKeys = EMPTY_SESSION_KEYS,
  rowStates = EMPTY_ROW_STATES,
  filterSummary = "none",
  pendingLiveCount = 0,
  height,
  now = Date.now(),
  actions,
  interactionOffsetX = 0,
  interactionOffsetY = 0,
  onInteractionZones,
}: DashboardListViewProps) {
  const baseLayout = React.useMemo(() => dashboardRowLayout(width, essential), [essential, width]);
  const [resizedLayout, setResizedLayout] = React.useState<RowLayout | null>(null);
  const layout = resizedLayout ?? baseLayout;
  const resizeDrag = React.useRef<{
    boundary: ColumnBoundary;
    startX: number;
    initial: RowLayout;
  } | null>(null);
  React.useEffect(() => {
    resizeDrag.current = null;
    setResizedLayout(null);
  }, [essential, width]);
  const displayNow = Math.floor(now / 60_000) * 60_000;
  const counts = clusterCounts(projections);
  const viewport = dashboardListViewport(projections, height, pendingLiveCount);
  const logicalRows = projections.filter((row) => row.kind !== "cluster").length;
  const header = dashboardListHeaderLayout(width, logicalRows, totalCount, filterSummary);
  const interactionZones = React.useMemo(
    () => {
      if (!actions) return [];
      const zones = dashboardListInteractionZones({
      width,
      projections,
      actions,
      essential,
      offsetX: interactionOffsetX,
      offsetY: interactionOffsetY,
      height,
      pendingLiveCount,
      now,
      layout,
      });
      zones.push({
        id: "dashboard:column-resize",
        rect: { x: interactionOffsetX, y: interactionOffsetY + 1, width, height: 1 },
        zIndex: 2,
        onEvent: (event) => {
          if (event.event.type !== "mouse") return false;
          if (event.event.action === "press" && event.event.button === "left") {
            const localX = event.localX ?? 0;
            const boundary = dashboardColumnBoundaries(layout)
              .find((candidate) => Math.abs(candidate.x - localX) <= 1);
            if (!boundary) return false;
            resizeDrag.current = { boundary, startX: event.event.x, initial: layout };
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
          setResizedLayout(resizeDashboardColumnPair(drag.initial, drag.boundary, event.event.x - drag.startX));
          event.stopPropagation();
          return true;
        },
      });
      if (actions.onSearch) zones.push({
        id: "dashboard:search",
        rect: { x: interactionOffsetX + Math.max(0, width - 30), y: interactionOffsetY, width: Math.min(30, width), height: 1 },
        zIndex: 3,
        onEvent: (event) => {
          if (event.event.type !== "mouse" || event.event.action !== "press") return false;
          actions.onSearch?.();
          event.stopPropagation();
          return true;
        },
      });
      return zones;
    },
    [actions, essential, height, interactionOffsetX, interactionOffsetY, layout, now, pendingLiveCount, projections, width],
  );
  React.useLayoutEffect(() => {
    if (onInteractionZones) onInteractionZones(interactionZones);
  }, [interactionZones, onInteractionZones]);

  return (
    <Box width={width} flexDirection="column" backgroundColor={ATLAS_COLORS.background} aria-role="list">
      {filterSummary.startsWith("q:") ? <Box width={width} height={1} paddingX={1} overflow="hidden">
        <Box width={header.countWidth} overflow="hidden"><Text color={ATLAS_COLORS.focus} wrap="truncate-end">{header.countText}</Text></Box>
        {header.gap ? <Box width={header.gap}><Text> </Text></Box> : null}
        {header.contextWidth ? <Box width={header.contextWidth} justifyContent="flex-end" overflow="hidden"><Text color={ATLAS_COLORS.textLow} wrap="truncate-end">{header.contextText}</Text></Box> : null}
      </Box> : <Box justifyContent="space-between" paddingX={1}>
        <Text color={ATLAS_COLORS.focus}>SESSIONS {logicalRows}/{totalCount}</Text>
        <Text color={ATLAS_COLORS.textLow} wrap="truncate-end">
          {filterSummary === "none" ? "[/ SEARCH · Ctrl-F]" : `${filterSummary} · [/ EDIT]`} · ↔ drag headers
        </Text>
      </Box>}
      <HeaderRow layout={layout} />
      {viewport.projections.map((projection) => {
        if (projection.kind === "cluster") {
          return (
            <Box key={projection.key} paddingLeft={1} justifyContent="space-between">
              <Text color={ATLAS_COLORS.text}>{projection.label} <Text color={ATLAS_COLORS.join}>────────</Text></Text>
              <Text color={ATLAS_COLORS.textLow}>
                {counts.get(projection.key) ?? 0}
              </Text>
            </Box>
          );
        }

        const row = projection.kind === "chain" ? projection.head : projection.session;
        const key = sessionKey(row);
        const item: DisplayRow = projection.kind === "chain"
          ? {
              key,
              row,
              topicPrefix: `${projection.expanded ? "▾" : "▸"}${projection.aggregate.memberCount} `,
              favorite: projection.aggregate.favoriteCount > 0,
              tokens: projection.aggregate.tokTotal,
              messages: projection.aggregate.msgCount,
              chainSize: projection.aggregate.memberCount,
            }
          : {
              key,
              row,
              topicPrefix: projection.nested ? "└ " : "",
              favorite: row.favorite > 0,
              tokens: row.tok_total,
              messages: row.msg_count,
              chainSize: null,
            };
        return (
          <SessionLine
            key={projection.key}
            item={item}
            layout={layout}
            focused={focusKey === key}
            selected={selectedKeys.has(key)}
            state={rowStates.get(key)}
            now={displayNow}
          />
        );
      })}
      {viewport.livePillRow !== null ? (
        <Box height={1} justifyContent="flex-end" paddingRight={1}>
          <Text color={ATLAS_COLORS.favorite}>{pendingLiveCount} new ▲ Enter</Text>
        </Box>
      ) : null}
    </Box>
  );
}
