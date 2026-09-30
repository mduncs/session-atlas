import React from "react";
import { Box, Text } from "ink";
import type { SessionKey, ProjectedListRow } from "./domain.js";
import type { InteractionZone } from "./interaction.js";
import type { FilterTerm, ListFilter } from "./queries.js";
import { railTagEntries } from "./layer-tags.js";
import {
  ATLAS_COLORS,
  DashboardListView,
  type DashboardListActions,
} from "./list-view.js";
import type {
  CountDatum,
  DashboardAnalytics,
  DashboardEvent,
  DashboardRowState,
} from "./analytics.js";

const EMPTY_FILTER: ListFilter = {};
const EMPTY_SESSION_KEYS: ReadonlySet<SessionKey> = new Set();
const EMPTY_ROW_STATES: ReadonlyMap<SessionKey, DashboardRowState> = new Map();

export type DashboardTier = "full" | "operational" | "center" | "essential" | "minimum";

export interface DashboardLayout {
  tier: DashboardTier;
  width: number;
  leftWidth: number;
  centerWidth: number;
  rightWidth: number;
}

export function dashboardLayout(width: number): DashboardLayout {
  const safe = Math.max(40, Math.floor(width));
  if (safe >= 140) {
    return { tier: "full", width: safe, leftWidth: 22, centerWidth: safe - 52, rightWidth: 28 };
  }
  if (safe >= 100) {
    return { tier: "operational", width: safe, leftWidth: 22, centerWidth: safe - 23, rightWidth: 0 };
  }
  if (safe >= 80) return { tier: "center", width: safe, leftWidth: 0, centerWidth: safe, rightWidth: 0 };
  if (safe >= 60) return { tier: "essential", width: safe, leftWidth: 0, centerWidth: safe, rightWidth: 0 };
  return { tier: "minimum", width: safe, leftWidth: 0, centerWidth: safe, rightWidth: 0 };
}

export interface InspectorData {
  key: SessionKey;
  title: string;
  source: string;
  model?: string | null;
  path?: string | null;
  started?: string | null;
  duration?: string | null;
  tokens?: number | null;
  messages?: number | null;
  state?: string | null;
  tags?: readonly string[];
  origin?: string | null;
  originDetail?: string | null;
  classificationConfidence?: number | null;
  classificationMethod?: string | null;
  rawOrigin?: string | null;
  rawOriginDetail?: string | null;
}

export interface PeekData {
  key: SessionKey;
  title: string;
  lines: readonly string[];
  status?: string | null;
}

export interface UltraDenseDashboardProps {
  width: number;
  /** Explicit terminal line budget. The dashboard never renders beyond it. */
  height?: number;
  projections: readonly ProjectedListRow[];
  analytics: DashboardAnalytics;
  /** Configured provider for current work; null means provider-backed actions are offline. */
  activeProvider?: string | null;
  focusKey?: SessionKey | null;
  /** The row under the pointer; its title fills the context line. */
  hoverKey?: SessionKey | null;
  selectedKeys?: ReadonlySet<SessionKey>;
  rowStates?: ReadonlyMap<SessionKey, DashboardRowState>;
  filter?: ListFilter;
  filterSummary?: string;
  pendingLiveCount?: number;
  inspector?: InspectorData | null;
  peek?: PeekData | null;
  message?: string;
  commandInput?: string | null;
  onboardingHint?: string;
  now?: number;
  actions?: DashboardListActions;
  /** Makes the hidden right rail reachable at operational widths. */
  operationalExcursion?: "list" | "analytics" | "inspector";
  onInteractionZones?: (zones: readonly InteractionZone[]) => void;
}

export interface DashboardSurfaceLayout extends DashboardLayout {
  height: number;
  filterRows: number;
  detailRows: number;
  bodyRows: number;
  bodyY: number;
  footerY: number;
}

export function dashboardSurfaceLayout(width: number, height = 40, hasFilter = false, hasDetail = false): DashboardSurfaceLayout {
  const base = dashboardLayout(width);
  const safeHeight = Math.max(8, Math.floor(height));
  const filterRows = hasFilter ? 1 : 0;
  const detailRows = hasDetail ? Math.min(6, Math.max(3, Math.floor(safeHeight / 4))) : 0;
  const bodyRows = Math.max(3, safeHeight - 3 - filterRows - detailRows);
  return { ...base, height: safeHeight, filterRows, detailRows, bodyRows, bodyY: 1 + filterRows, footerY: safeHeight - 2 };
}

export interface DashboardZoneOptions {
  layout: DashboardSurfaceLayout;
  analytics: DashboardAnalytics;
  actions: DashboardListActions;
  offsetX?: number;
  offsetY?: number;
  leftMode?: "operational" | "analytics" | "inspector";
  rightMode?: "analytics" | "inspector" | "none";
  /** Selects the TAGS rail level (facets, or one facet's detail tags). */
  filter?: Pick<ListFilter, "facet" | "layerTag">;
}

function activation(run: () => void): NonNullable<InteractionZone["onEvent"]> {
  return (event) => {
    const active = event.event.type === "mouse" && event.event.action === "press"
      || event.event.type === "key" && event.event.key === "enter";
    if (!active) return false;
    run();
    return true;
  };
}

/** Rail controls use the same line positions as the rendered rails. */
export function dashboardRailInteractionZones({ layout, analytics, actions, offsetX = 0, offsetY = 0, leftMode = "operational", rightMode = layout.rightWidth > 0 ? "analytics" : "none", filter = {} }: DashboardZoneOptions): InteractionZone[] {
  if (layout.leftWidth === 0) return [];
  const zones: InteractionZone[] = [];
  if (leftMode === "analytics") {
    let modelY = offsetY + layout.bodyY + 1;
    for (const model of analytics.models) {
      zones.push({ id: `dashboard:rail:model:${model.label}`, rect: { x: offsetX, y: modelY, width: layout.leftWidth, height: 1 }, focusable: true, onEvent: activation(() => actions.onFilter?.({ kind: "model", value: model.label })) });
      modelY += 1;
    }
    return zones.filter((zone) => zone.rect.y < offsetY + layout.footerY);
  }
  if (leftMode === "inspector") return zones;
  let y = offsetY + layout.bodyY + 1;
  for (const source of analytics.sources) {
    zones.push({ id: `dashboard:rail:source:${source.source}`, rect: { x: offsetX, y, width: layout.leftWidth, height: 1 }, focusable: true, onEvent: activation(() => actions.onFilter?.({ kind: "source", value: source.source })) });
    y += 1;
  }
  y += 2;
  const stateRows: Array<[string, "summarized" | "pending" | "orphaned"]> = [["summarized", "summarized"], ["pending", "pending"], ["orphaned", "orphaned"]];
  for (const [id, state] of stateRows) {
    zones.push({ id: `dashboard:rail:state:${id}`, rect: { x: offsetX, y, width: layout.leftWidth, height: 1 }, focusable: true, onEvent: activation(() => actions.onFilter?.({ kind: "state", value: state })) });
    y += 1;
  }
  zones.push({ id: "dashboard:rail:favorites", rect: { x: offsetX, y, width: layout.leftWidth, height: 1 }, focusable: true, onEvent: activation(() => actions.onFilter?.({ kind: "favorite", value: true })) });
  y += 1;
  if (analytics.origins?.length) {
    // The flat rail emits a blank line and the CREATOR title before the
    // clickable "all" row. Keep the hit lattice on the rendered data rows.
    y += 2;
    zones.push({ id: "dashboard:rail:origin:all", rect: { x: offsetX, y, width: layout.leftWidth, height: 1 }, focusable: true, onEvent: activation(() => actions.onRemoveFilter?.("origin")) });
    y += 1;
    for (const origin of analytics.origins) {
      zones.push({ id: `dashboard:rail:origin:${origin.label}`, rect: { x: offsetX, y, width: layout.leftWidth, height: 1 }, focusable: true, onEvent: activation(() => actions.onFilter?.({ kind: "origin", value: origin.label as "human" | "agent" | "mixed" | "unknown" | "empty" })) });
      y += 1;
    }
  }
  y += 2;
  for (const entry of railTagEntries(analytics, filter, analytics.origins?.length ? 2 : 7)) {
    const { apply, remove } = entry;
    if (apply || remove) {
      zones.push({ id: `dashboard:rail:${entry.kind === "tag" ? `tag:${entry.label}` : entry.id}`, rect: { x: offsetX, y, width: layout.leftWidth, height: 1 }, focusable: true, onEvent: activation(() => apply ? actions.onFilter?.(apply) : actions.onRemoveFilter?.(remove!)) });
    }
    y += 1;
  }
  if (layout.rightWidth > 0 && rightMode === "analytics") {
    let rightY = offsetY + layout.bodyY + 1;
    const rightX = offsetX + layout.leftWidth + 1 + layout.centerWidth + 1;
    for (const model of analytics.models) {
      zones.push({ id: `dashboard:rail:model:${model.label}`, rect: { x: rightX, y: rightY, width: layout.rightWidth, height: 1 }, focusable: true, onEvent: activation(() => actions.onFilter?.({ kind: "model", value: model.label })) });
      rightY += 1;
    }
  }
  return zones.filter((zone) => zone.rect.y < offsetY + layout.footerY);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

function freshness(ageMs: number | null): string {
  if (ageMs === null) return "never";
  if (ageMs < 60_000) return "now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h`;
  return `${Math.floor(ageMs / 86_400_000)}d`;
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sourceCode(source: string): string {
  const value = source.toLowerCase();
  if (value === "claude") return "CL";
  if (value === "codex") return "CX";
  if (value === "kilo") return "KI";
  return source.slice(0, 2).toUpperCase();
}

function sourceColor(source: string): string {
  const value = source.toLowerCase();
  if (value === "claude") return ATLAS_COLORS.claude;
  if (value === "codex") return ATLAS_COLORS.codex;
  if (value === "kilo") return ATLAS_COLORS.kilo;
  return ATLAS_COLORS.text;
}

function Sparkline({ values }: { values: readonly number[] }) {
  const glyphs = "▁▂▃▄▅▆▇█";
  const maximum = Math.max(0, ...values);
  const value = values.length === 0
    ? "—"
    : values.map((item) => {
        if (maximum === 0) return glyphs[0];
        const index = Math.min(glyphs.length - 1, Math.round((item / maximum) * (glyphs.length - 1)));
        return glyphs[index];
      }).join("");
  return <Text color={ATLAS_COLORS.textLow}>{value}</Text>;
}

function PaneTitle({ children, active = false }: { children: React.ReactNode; active?: boolean }) {
  return <Text color={active ? ATLAS_COLORS.focus : ATLAS_COLORS.textLow}>{children}</Text>;
}

function BarRows({ rows, width = 7 }: { rows: readonly CountDatum[]; width?: number }) {
  if (rows.length === 0) return <Text color={ATLAS_COLORS.textLow}>—</Text>;
  const maximum = Math.max(1, ...rows.map((row) => row.count));
  return (
    <Box flexDirection="column">
      {rows.map((row) => {
        const filled = row.count === 0 ? 0 : Math.max(1, Math.round((row.count / maximum) * width));
        return (
          <Box key={row.label} justifyContent="space-between">
            <Text color={ATLAS_COLORS.text} wrap="truncate-end">{row.label}</Text>
            <Text color={ATLAS_COLORS.textLow}>{"█".repeat(filled)} {compactCount(row.count)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export const LeftOperationalRail = React.memo(function LeftOperationalRail({ analytics, width = 22, activeOrigin = null }: { analytics: DashboardAnalytics; width?: number; activeOrigin?: ListFilter["origin"] }) {
  const maxSource = Math.max(1, ...analytics.sources.map((source) => source.count));
  return (
    <Box width={width} flexDirection="column" backgroundColor={ATLAS_COLORS.background}>
      <Box paddingX={1} flexDirection="column">
        <PaneTitle>SRC</PaneTitle>
        {analytics.sources.length === 0 ? <Text color={ATLAS_COLORS.textLow}>—</Text> : analytics.sources.map((source) => {
          const filled = source.count === 0 ? 0 : Math.max(1, Math.round((source.count / maxSource) * 7));
          return (
            <Box key={source.source} justifyContent="space-between">
              <Text color={sourceColor(source.source)}>{sourceCode(source.source)} {"█".repeat(filled)}</Text>
              <Text color={source.reachable === false ? ATLAS_COLORS.error : ATLAS_COLORS.textLow}>
                {compactCount(source.count)}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} paddingX={1} flexDirection="column">
        <PaneTitle>STATE</PaneTitle>
        <Box justifyContent="space-between"><Text>summarized</Text><Text color={ATLAS_COLORS.textLow}>{compactCount(analytics.states.summarized)}</Text></Box>
        <Box justifyContent="space-between"><Text color={ATLAS_COLORS.favorite}>pending ⋯</Text><Text color={ATLAS_COLORS.textLow}>{compactCount(analytics.states.pending)}</Text></Box>
        <Box justifyContent="space-between"><Text color={ATLAS_COLORS.error}>orphaned ⚑</Text><Text color={ATLAS_COLORS.textLow}>{compactCount(analytics.states.orphaned)}</Text></Box>
        <Box justifyContent="space-between"><Text color={ATLAS_COLORS.favorite}>favorite ★</Text><Text color={ATLAS_COLORS.textLow}>{compactCount(analytics.states.favorite)}</Text></Box>
      </Box>
      {analytics.origins?.length ? <Box marginTop={1} paddingX={1} flexDirection="column">
        <PaneTitle>CREATOR · g CYCLE</PaneTitle>
        <Box justifyContent="space-between">
          <Text color={activeOrigin == null ? ATLAS_COLORS.focus : ATLAS_COLORS.text}>● all</Text>
          <Text color={ATLAS_COLORS.textLow}>{compactCount(analytics.corpusSessionCount)}</Text>
        </Box>
        {analytics.origins.map((origin) => (
          <Box key={origin.label} justifyContent="space-between">
            <Text color={activeOrigin === origin.label ? ATLAS_COLORS.focus : ATLAS_COLORS.text}>{activeOrigin === origin.label ? "●" : "○"} {origin.label === "human" ? "H HUMAN" : origin.label === "agent" ? "A AGENT" : origin.label === "mixed" ? "M MIXED" : "? UNKNOWN"}</Text>
            <Text color={ATLAS_COLORS.textLow}>{compactCount(origin.count)}</Text>
          </Box>
        ))}
      </Box> : null}
      <Box marginTop={1} paddingX={1} flexDirection="column">
        <PaneTitle>TAGS ↑</PaneTitle>
        {analytics.tags.length === 0
          ? <Text color={ATLAS_COLORS.textLow}>— no promoted tags</Text>
          : (analytics.origins?.length ? analytics.tags.slice(0, 2) : analytics.tags).map((tag) => (
              <Box key={tag.label} justifyContent="space-between">
                <Text wrap="truncate-end">{tag.label}</Text>
                <Text color={ATLAS_COLORS.textLow}>{compactCount(tag.count)}</Text>
              </Box>
            ))}
      </Box>
    </Box>
  );
});

export const AnalyticsRail = React.memo(function AnalyticsRail({ analytics, width = 28 }: { analytics: DashboardAnalytics; width?: number }) {
  const freshnessLine = analytics.sources.length === 0
    ? "—"
    : analytics.sources.map((source) => `${sourceCode(source.source).toLowerCase()} ${freshness(source.ageMs)}`).join(" · ");
  return (
    <Box width={width} flexDirection="column" backgroundColor={ATLAS_COLORS.background}>
      <Box paddingX={1} flexDirection="column">
        <PaneTitle>MODEL</PaneTitle>
        <BarRows rows={analytics.models} width={5} />
      </Box>
      <Box marginTop={1} paddingX={1} flexDirection="column">
        <PaneTitle>SIZE DIST · TOK</PaneTitle>
        <BarRows rows={analytics.sizes} width={5} />
      </Box>
      <Box marginTop={1} paddingX={1} flexDirection="column">
        <PaneTitle>INGEST · 24H</PaneTitle>
        <Sparkline values={analytics.ingest.hourlySessions} />
        <Text color={ATLAS_COLORS.textLow} wrap="truncate-end">{freshnessLine}</Text>
      </Box>
      <Box marginTop={1} paddingX={1} flexDirection="column">
        <PaneTitle>SUMMARIZER</PaneTitle>
        <Box justifyContent="space-between"><Text>queue</Text><Text color={ATLAS_COLORS.favorite}>{compactCount(analytics.summarizer.queue)}</Text></Box>
        <Box justifyContent="space-between"><Text>rate</Text><Text color={ATLAS_COLORS.textLow}>{analytics.summarizer.ratePerMinute.toFixed(1)}/min</Text></Box>
        <Box justifyContent="space-between"><Text>failures</Text><Text color={analytics.summarizer.failures ? ATLAS_COLORS.error : ATLAS_COLORS.textLow}>{compactCount(analytics.summarizer.failures)}</Text></Box>
      </Box>
    </Box>
  );
});

export function InspectorPane({ inspector, width = 28 }: { inspector: InspectorData; width?: number }) {
  return (
    <Box width={width} paddingX={1} flexDirection="column" backgroundColor={ATLAS_COLORS.background}>
      <PaneTitle active>INSPECTOR · {inspector.key.slice(0, 8)}</PaneTitle>
      <Text color={ATLAS_COLORS.textHigh} wrap="truncate-end">{inspector.title}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text><Text color={ATLAS_COLORS.textLow}>source  </Text>{inspector.source}{inspector.model ? ` / ${inspector.model}` : ""}</Text>
        {inspector.origin ? <Text><Text color={ATLAS_COLORS.textLow}>class   </Text>{inspector.origin}{inspector.classificationConfidence == null ? "" : ` · ${Math.round(inspector.classificationConfidence * 100)}%`}{inspector.classificationMethod ? ` · ${inspector.classificationMethod}` : ""}</Text> : null}
        {inspector.originDetail ? <Text wrap="truncate-end"><Text color={ATLAS_COLORS.textLow}>reason  </Text>{inspector.originDetail}</Text> : null}
        {inspector.rawOrigin ? <Text><Text color={ATLAS_COLORS.textLow}>prov    </Text>{inspector.rawOrigin}</Text> : null}
        {inspector.rawOriginDetail ? <Text wrap="truncate-end"><Text color={ATLAS_COLORS.textLow}>evidence</Text> {inspector.rawOriginDetail}</Text> : null}
        <Text wrap="truncate-end"><Text color={ATLAS_COLORS.textLow}>path    </Text>{inspector.path ?? "—"}</Text>
        <Text><Text color={ATLAS_COLORS.textLow}>started </Text>{inspector.started ?? "—"}{inspector.duration ? ` · ${inspector.duration}` : ""}</Text>
        <Text><Text color={ATLAS_COLORS.textLow}>tokens  </Text>{inspector.tokens == null ? "—" : formatCount(inspector.tokens)}</Text>
        <Text><Text color={ATLAS_COLORS.textLow}>msgs    </Text>{inspector.messages ?? "—"}</Text>
        <Text><Text color={ATLAS_COLORS.textLow}>state   </Text>{inspector.state ?? "—"}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <PaneTitle>TAGS</PaneTitle>
        <Text color={ATLAS_COLORS.text} wrap="truncate-end">{inspector.tags?.join(" · ") || "—"}</Text>
      </Box>
    </Box>
  );
}

function EmptyState({ analytics, filterSummary, onboardingHint }: {
  analytics: DashboardAnalytics;
  filterSummary: string;
  onboardingHint: string;
}) {
  if (analytics.corpusSessionCount === 0) {
    return (
      <Box flexGrow={1} minHeight={5} alignItems="center" justifyContent="center" flexDirection="column">
        <Text color={ATLAS_COLORS.focus}>NO SESSIONS INDEXED</Text>
        <Text color={ATLAS_COLORS.textLow}>{analytics.hasEverIngested ? "sources returned no sessions" : onboardingHint}</Text>
      </Box>
    );
  }
  return (
    <Box flexGrow={1} minHeight={5} alignItems="center" justifyContent="center" flexDirection="column">
      <Text color={ATLAS_COLORS.text}>NO SESSIONS MATCH</Text>
      <Text color={ATLAS_COLORS.textLow}>{filterSummary === "none" ? "current viewport is empty" : filterSummary}</Text>
    </Box>
  );
}

const TelemetryStrip = React.memo(function TelemetryStrip({ analytics, layout, now, activeProvider }: {
  analytics: DashboardAnalytics;
  layout: DashboardLayout;
  now: number;
  activeProvider?: string | null;
}) {
  const rate = analytics.ingest.sessionsPerSecond === null
    ? "idle"
    : `${analytics.ingest.sessionsPerSecond.toFixed(1)}/s`;
  // `analytics.summarizer.provider` is historical job provenance. Production
  // supplies the configured provider explicitly so an offline archive never
  // presents an old job provider as currently available.
  const provider = activeProvider === undefined ? analytics.summarizer.provider : activeProvider;
  const summarizerStatus = provider ? `${provider} ●` : "off ○";
  const clock = new Date(now).toLocaleTimeString("en-US", { hour12: false });
  let line: string;
  if (layout.tier === "minimum" || layout.tier === "essential") {
    line = `ATLAS ${compactCount(analytics.corpusSessionCount)} · P${compactCount(analytics.states.pending)} · E${analytics.errorCount}`;
  } else if (layout.tier === "center") {
    line = `ATLAS · ${formatCount(analytics.corpusSessionCount)} SESS · ING ${rate} · PEND ${compactCount(analytics.states.pending)} · ERR ${analytics.errorCount}`;
  } else {
    line = `ATLAS · ${formatCount(analytics.corpusSessionCount)} SESS · ING ${rate} · PEND ${formatCount(analytics.states.pending)} · SUM ${summarizerStatus} · ERR ${analytics.errorCount} · ${clock}`;
  }
  return (
    <Box height={1} width={layout.width} paddingX={1} backgroundColor={ATLAS_COLORS.chrome}>
      <Text color={ATLAS_COLORS.text} wrap="truncate-end">
        <Text color={ATLAS_COLORS.focus}>ATLAS</Text>{line.slice("ATLAS".length)}
      </Text>
    </Box>
  );
}, (left, right) => left.analytics === right.analytics
  && left.layout === right.layout
  && left.activeProvider === right.activeProvider
  && Math.floor(left.now / 1_000) === Math.floor(right.now / 1_000));

const EventTail = React.memo(function EventTail({ events, width }: { events: readonly DashboardEvent[]; width: number }) {
  const maximum = width >= 120 ? 3 : width >= 80 ? 2 : 1;
  return (
    <Box width={width} height={1} paddingX={1} columnGap={2} backgroundColor={ATLAS_COLORS.chrome} overflow="hidden">
      <Text color={ATLAS_COLORS.textLow}>LOG</Text>
      {events.length === 0
        ? <Text color={ATLAS_COLORS.textLow}>— no ingest or summary events</Text>
        : events.slice(0, maximum).map((event) => (
            <Text key={event.id} color={event.kind === "error" ? ATLAS_COLORS.error : ATLAS_COLORS.text} wrap="truncate-end">
              {timeLabel(event.at)} {event.label}
            </Text>
          ))}
    </Box>
  );
});

const CommandBar = React.memo(function CommandBar({ width, input, message }: { width: number; input: string | null; message: string }) {
  const hints = width >= 100
    ? "/ SEARCH · g CREATOR · f FAV · e EXPORT · c CHAT · ? HELP"
    : width >= 80
      ? "/ search · g creator · f fav · e export · ? help"
      : "? help · esc back";
  return (
    <Box width={width} height={1} paddingX={1} justifyContent="space-between" backgroundColor={ATLAS_COLORS.chrome}>
      <Text wrap="truncate-end"><Text color={ATLAS_COLORS.focus}>&gt;</Text> {input ?? (message || "_")}</Text>
      <Text color={ATLAS_COLORS.textLow} wrap="truncate-end">{hints}</Text>
    </Box>
  );
});

const FilterBar = React.memo(function FilterBar({ filter, width }: { filter: ListFilter; width: number }) {
  const chips = dashboardFilterChips(filter);
  if (chips.length === 0) return null;
  return <Box width={width} height={1} paddingX={1} columnGap={1} backgroundColor={ATLAS_COLORS.chrome}>
    <Text color={ATLAS_COLORS.textLow}>FILTER</Text>
    {chips.map((chip) => <Text key={chip.kind} color={ATLAS_COLORS.focus}>[{chip.label} ×]</Text>)}
  </Box>;
});

export interface DashboardFilterChip { kind: FilterTerm["kind"]; label: string }
export function dashboardFilterChips(filter: ListFilter): DashboardFilterChip[] {
  return [
    filter.query ? { kind: "query", label: `q:\"${filter.query}\"` } : null,
    (filter.source ?? filter.harness) ? { kind: "source", label: `src:${filter.source ?? filter.harness}` } : null,
    filter.model ? { kind: "model", label: `model:${filter.model}` } : null,
    filter.path ? { kind: "path", label: `path:${filter.path}` } : null,
    filter.tag ? { kind: "tag", label: `#${filter.tag}` } : null,
    filter.facet ? { kind: "facet", label: `facet:${filter.facet}` } : null,
    filter.layerTag ? { kind: "layerTag", label: `tag:${filter.layerTag}` } : null,
    (filter.favorite ?? filter.favoritesOnly) ? { kind: "favorite", label: "★ favorites" } : null,
    filter.state ? { kind: "state", label: `state:${filter.state}` } : null,
    filter.chain ? { kind: "chain", label: `chain:${filter.chain.mode}` } : null,
    filter.origin ? { kind: "origin", label: `creator:${filter.origin}` } : null,
    filter.date ? { kind: "date", label: filter.date.label ?? "date" } : null,
  ].filter((chip): chip is DashboardFilterChip => chip !== null);
}

export function dashboardFilterInteractionZones(filter: ListFilter, width: number, actions: DashboardListActions, y = 1): InteractionZone[] {
  let x = 8; // one-cell pad + FILTER + column gap
  const zones: InteractionZone[] = [];
  for (const chip of dashboardFilterChips(filter)) {
    const chipWidth = Bun.stringWidth(`[${chip.label} ×]`);
    if (x >= width - 1) break;
    zones.push({ id: `dashboard:filter:${chip.kind}`, rect: { x, y, width: Math.min(chipWidth, width - 1 - x), height: 1 }, focusable: true, onEvent: activation(() => actions.onRemoveFilter?.(chip.kind)) });
    x += chipWidth + 1;
  }
  return zones;
}

function DetailExcursion({ inspector, peek, width }: {
  inspector: InspectorData | null;
  peek: PeekData | null;
  width: number;
}) {
  if (peek) {
    return (
      <Box width={width} paddingX={1} flexDirection="column" backgroundColor={ATLAS_COLORS.background}>
        <Text color={ATLAS_COLORS.focus}>PEEK · {peek.title}</Text>
        {peek.lines.slice(0, 3).map((line, index) => <Text key={index} color={ATLAS_COLORS.text} wrap="truncate-end">{line}</Text>)}
        {peek.status ? <Text color={ATLAS_COLORS.textLow}>{peek.status}</Text> : null}
      </Box>
    );
  }
  if (inspector) return <InspectorPane inspector={inspector} width={width} />;
  return null;
}

export function UltraDenseDashboard({
  width,
  height = 40,
  projections,
  analytics,
  activeProvider,
  focusKey = null,
  selectedKeys = EMPTY_SESSION_KEYS,
  rowStates = EMPTY_ROW_STATES,
  filter = EMPTY_FILTER,
  filterSummary = "none",
  pendingLiveCount = 0,
  inspector = null,
  peek = null,
  message = "",
  commandInput = null,
  onboardingHint = "configure source roots, then run atlas index",
  now = Date.now(),
  actions,
  operationalExcursion = "list",
  onInteractionZones,
}: UltraDenseDashboardProps) {
  const hasFilter = Object.keys(filter).some((key) => filter[key as keyof ListFilter] != null);
  const hasDetail = layoutHasDetail(width, inspector, peek);
  const layout = React.useMemo(
    () => dashboardSurfaceLayout(width, height, hasFilter, hasDetail),
    [hasDetail, hasFilter, height, width],
  );
  const showOperationalAnalytics = layout.tier === "operational" && operationalExcursion === "analytics";
  const showOperationalInspector = layout.tier === "operational" && operationalExcursion === "inspector" && inspector !== null;
  const showInlineDetail = layout.tier !== "full" && (inspector !== null || peek !== null) && !showOperationalInspector;
  const leftMode = showOperationalAnalytics ? "analytics" : showOperationalInspector ? "inspector" : "operational";
  const rightMode = layout.rightWidth === 0 ? "none" : inspector ? "inspector" : "analytics";
  const railZones = React.useMemo(() => actions ? dashboardRailInteractionZones({ layout, analytics, actions, leftMode, rightMode }) : [], [actions, analytics, layout, leftMode, rightMode]);
  const filterZones = React.useMemo(() => actions ? dashboardFilterInteractionZones(filter, layout.width, actions) : [], [actions, filter, layout.width]);
  const publishZones = React.useCallback((listZones: readonly InteractionZone[]) => onInteractionZones?.([...railZones, ...filterZones, ...listZones]), [filterZones, onInteractionZones, railZones]);
  React.useLayoutEffect(() => {
    if (projections.length === 0) onInteractionZones?.([...railZones, ...filterZones]);
  }, [filterZones, onInteractionZones, projections.length, railZones]);

  return (
    <Box width={layout.width} height={layout.height} overflow="hidden" flexDirection="column" backgroundColor={ATLAS_COLORS.join}>
      <TelemetryStrip analytics={analytics} layout={layout} now={now} activeProvider={activeProvider} />
      <FilterBar filter={filter} width={layout.width} />
      <Box height={layout.bodyRows} overflow="hidden" width={layout.width} columnGap={layout.tier === "full" || layout.tier === "operational" ? 1 : 0} alignItems="stretch">
        {layout.leftWidth > 0 ? (showOperationalAnalytics
          ? <AnalyticsRail analytics={analytics} width={layout.leftWidth} />
          : showOperationalInspector
            ? <InspectorPane inspector={inspector!} width={layout.leftWidth} />
            : <LeftOperationalRail analytics={analytics} width={layout.leftWidth} activeOrigin={filter.origin} />) : null}
        <Box width={layout.centerWidth} flexDirection="column" backgroundColor={ATLAS_COLORS.background}>
          {projections.length === 0
            ? <EmptyState analytics={analytics} filterSummary={filterSummary} onboardingHint={onboardingHint} />
            : <DashboardListView
                width={layout.centerWidth}
                essential={layout.tier === "essential" || layout.tier === "minimum"}
                projections={projections}
                totalCount={analytics.visibleSessionCount}
                focusKey={focusKey}
                selectedKeys={selectedKeys}
                rowStates={rowStates}
                filterSummary={filterSummary}
                pendingLiveCount={pendingLiveCount}
                height={layout.bodyRows}
                now={now}
                actions={actions}
                interactionOffsetX={layout.leftWidth > 0 ? layout.leftWidth + 1 : 0}
                interactionOffsetY={layout.bodyY}
                onInteractionZones={publishZones}
              />}
        </Box>
        {layout.rightWidth > 0
          ? inspector
            ? <InspectorPane inspector={inspector} width={layout.rightWidth} />
            : <AnalyticsRail analytics={analytics} width={layout.rightWidth} />
          : null}
      </Box>
      {showInlineDetail ? <Box height={layout.detailRows} overflow="hidden"><DetailExcursion inspector={inspector} peek={peek} width={layout.width} /></Box> : null}
      <EventTail events={analytics.events} width={layout.width} />
      <CommandBar width={layout.width} input={commandInput} message={message} />
    </Box>
  );
}

function layoutHasDetail(width: number, inspector: InspectorData | null, peek: PeekData | null): boolean {
  return dashboardLayout(width).tier !== "full" && (inspector !== null || peek !== null);
}
