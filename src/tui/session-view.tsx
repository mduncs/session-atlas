import React from "react";
import { Text } from "ink";
import type { SessionTranscriptDto } from "../contracts/search.js";
import type { RecordKind } from "../contracts/construction.js";
import type { Anchor, Tier2ViewState } from "../tier2.js";
import type { DashboardAnalytics } from "./analytics.js";
import { dashboardFilterInteractionZones, dashboardRailInteractionZones, dashboardSurfaceLayout } from "./dashboard.js";
import { filterLine, operationalRailLines } from "./flat-dashboard.js";
import type { InteractionZone } from "./interaction.js";
import { episodeAnchors, episodeAt, facetChip, type EpisodeAnchor, type SessionLayers } from "./layer-tags.js";
import type { DashboardListActions } from "./list-view.js";
import type { ListFilter } from "./queries.js";
import {
  projectReaderTranscript,
  transcriptStateLabel,
  validateTranscriptDto,
  type ParagraphBreaks,
  type ReaderDisplayRow,
} from "./reader.js";
import { END_BG, SKIN, asciiLabel, bg, compact, compose, fg, harnessSkin, spanWidth, type Span } from "./skin.js";
import type { RoleToggle, TranscriptMode } from "./store.js";
import {
  blockAtLine,
  blockIndexForOrdinal,
  layoutTranscript,
  offsetToReveal,
  transcriptViewport,
  wrapDisplayText,
  type TranscriptEpisode,
  type TranscriptLayout,
  type TranscriptLine,
  type TranscriptViewport,
} from "./transcript-layout.js";

export interface SessionFacts {
  id: number;
  harness: string;
  nativeId: string;
  title: string | null;
  path: string | null;
  models: string[];
  tags: string[];
  chainMembers: number;
  durationMs: number | null;
  tokens: { user: number; assistant: number; tool: number };
  /** Effective creator lens and its evidence, when the layers DB is attached. */
  creator?: { value: "human" | "agent" | "unknown"; reason: string | null; method: string | null } | null;
}

/** Explicit legacy fixture shape. Production SessionView reads only readerTranscript. */
export interface TranscriptRow {
  ordinal: number;
  role: "user" | "assistant" | "tool" | "system" | string;
  text: string | null;
  toolText: string | null;
  hasTool: boolean;
}

export interface TranscriptProjection extends TranscriptRow {
  display: string;
  dimmed: boolean;
  gutter: string;
}

export interface SessionSpanRange { fromOrdinal: number; toOrdinal: number }

/** Imperative reader controls the shell drives from keys. */
export interface SessionViewController {
  scroll(kind: "line-down" | "line-up" | "page-down" | "page-up" | "home" | "end"): void;
  /** Open every closed fold of the active (or first visible) message, or close them all. */
  toggleActiveFolds(): void;
  /** Ordinals of the first and last message with a visible line. */
  visibleOrdinals(): { first: number | null; last: number | null };
  /** Put the message at `ordinal` at the top, with an episode divider above it in view. */
  jumpTo(ordinal: number): void;
}

export interface SessionViewProps {
  facts: SessionFacts;
  summary: Tier2ViewState;
  /** Frozen Phase 3/4 reader DTO. Its generation is validated before display. */
  readerTranscript?: SessionTranscriptDto | null;
  /** Designed fail-closed reason when the reader service cannot supply a DTO. */
  readerDiagnostic?: string | null;
  /** @deprecated Focused pre-Phase-5 tests only. Production never supplies this. */
  transcript?: readonly TranscriptRow[];
  /** Sha-verified display-only paragraph breaks for md's messages. */
  paragraphs?: ParagraphBreaks;
  mode: TranscriptMode;
  /** Wrap message text to the measure. False clips each source line. */
  wrap?: boolean;
  roleToggle: RoleToggle;
  /** Legacy height hint when `height` is absent. */
  visibleRows?: number;
  width: number;
  height?: number;
  activeOrdinal?: number | null;
  /** @deprecated activeOrdinal is the landing coordinate. */
  landingOrdinal?: number | null;
  landingBias?: "earlier" | "later" | "nearest";
  spanRange?: SessionSpanRange | null;
  traversalPosition?: number | null;
  traversalTotal?: number;
  focusedAnchor?: number | null;
  message?: string | null;
  /** Fold ids flipped from the mode default (tools, injections, agent relays). */
  toggledFolds?: ReadonlySet<string>;
  /** Summary/facts pane: null follows the width (shown at 150+ columns). */
  aboutOpen?: boolean | null;
  /** Shape, episodes, and tags from the layers schema; absent before any layer pass. */
  layers?: SessionLayers | null;
  /** List analytics and filter: the detail view keeps the list's rails. */
  analytics?: DashboardAnalytics | null;
  filter?: ListFilter;
  actions?: DashboardListActions;
  controllerRef?: React.MutableRefObject<SessionViewController | null>;
  onLand?: (ordinal: number) => void;
  onToggleFolds?: (ids: readonly string[]) => void;
  onMode?: (mode: TranscriptMode) => void;
  onToggleAbout?: () => void;
  onCreatorToggle?: () => void;
  onAnchorActivate?: (fromOrdinal: number, toOrdinal: number) => void;
  /** An episode row was clicked; the view has already scrolled to `ordinal`. */
  onEpisodeJump?: (ordinal: number) => void;
  onNavigate?: (delta: -1 | 1) => void;
  onFactActivate?: (kind: "model" | "tag" | "path", value: string) => void;
  onFactYank?: (kind: "id" | "path", value: string) => void;
  onBack?: () => void;
  onToggleWrap?: () => void;
  onCopyMessage?: () => void;
  onCopyConversation?: () => void;
  onUndo?: () => void;
  onScroll?: (delta: -1 | 1) => void;
  onSummaryScroll?: (delta: -1 | 1) => void;
  onInteractionZones?: (zones: readonly InteractionZone[]) => void;
}

// ---------------------------------------------------------------- geometry

export interface SessionSurfaceLayout {
  width: number;
  height: number;
  filterRows: number;
  bodyY: number;
  bodyRows: number;
  footerY: number;
  /** Left rail cells including its gutter; 0 when the rail is hidden. */
  railWidth: number;
  /** Right about pane cells including its gutter; 0 when closed or stacked. */
  aboutWidth: number;
  /** Rows of the stacked about block on narrow terminals. */
  aboutRows: number;
  columnX: number;
  columnWidth: number;
  transcriptY: number;
  transcriptRows: number;
  /** Reading measure and its left margin inside the column. */
  measure: number;
  margin: number;
  aboutOpen: boolean;
}

export const READING_MEASURE = 88;

export function sessionSurfaceLayout(width: number, height = 24, options: { hasFilter?: boolean; rail?: boolean; aboutOpen?: boolean | null; notice?: boolean } = {}): SessionSurfaceLayout {
  const safeWidth = Math.max(40, Math.floor(width));
  const safeHeight = Math.max(8, Math.floor(height));
  const dash = dashboardSurfaceLayout(safeWidth, safeHeight, Boolean(options.hasFilter), false);
  const railWidth = options.rail && dash.leftWidth > 0 ? dash.leftWidth + 1 : 0;
  const aboutOpen = options.aboutOpen ?? safeWidth >= 150;
  const aboutWidth = aboutOpen && safeWidth >= 100 ? (safeWidth >= 150 ? 36 : 31) : 0;
  const aboutRows = aboutOpen && safeWidth < 100 ? Math.min(8, Math.max(3, Math.floor(dash.bodyRows / 3))) : 0;
  const columnWidth = Math.max(20, safeWidth - railWidth - aboutWidth);
  // The margin always keeps one blank cell between the rail and md's bar.
  const measure = Math.max(16, Math.min(READING_MEASURE, columnWidth - 6));
  const margin = Math.max(3, Math.min(8, Math.floor((columnWidth - measure) / 2)));
  const noticeRows = options.notice ? 1 : 0;
  return {
    width: safeWidth,
    height: safeHeight,
    filterRows: dash.filterRows,
    bodyY: dash.bodyY,
    bodyRows: dash.bodyRows,
    footerY: dash.footerY,
    railWidth,
    aboutWidth,
    aboutRows,
    columnX: railWidth,
    columnWidth,
    transcriptY: dash.bodyY + aboutRows + noticeRows,
    transcriptRows: Math.max(1, dash.bodyRows - aboutRows - noticeRows),
    measure,
    margin,
    aboutOpen,
  };
}

// ---------------------------------------------------------------- skin

const MD_BAR = bg(94);
const MD_BAR_ACTIVE = bg(214);
const ACTIVE_BAR = bg(242);
const MD_PANEL = bg(235);
const SPAN_PANEL = bg(58);
const CODE = fg(250);
const HEADER_MD = `${fg(214)}\x1b[1m`;
const HEADER_AGENT = fg(137);
const HEADER_MODEL = `${fg(252)}\x1b[1m`;
const MODES: ReadonlyArray<[TranscriptMode, string]> = [["dialogue", "dialogue"], ["stubs", "activity"], ["full", "full output"]];

// ---------------------------------------------------------------- model

export interface SessionLayoutModel {
  layout: SessionSurfaceLayout;
  projected: readonly ReaderDisplayRow[];
  transcript: TranscriptLayout;
  viewport: TranscriptViewport;
  lines: string[];
  zones: InteractionZone[];
  readerDiagnostic: string | null;
  readerNotice: string | null;
  stateLabel: string;
}

export interface SessionProjection {
  projected: readonly ReaderDisplayRow[];
  readerDiagnostic: string | null;
  readerNotice: string | null;
  stateLabel: string;
}

export function projectSession(props: Pick<SessionViewProps, "readerTranscript" | "readerDiagnostic" | "transcript" | "mode" | "roleToggle" | "paragraphs">): SessionProjection {
  const hasReaderBoundary = props.readerTranscript !== undefined || props.readerDiagnostic != null;
  const validation = props.readerTranscript ? validateTranscriptDto(props.readerTranscript) : null;
  const readerDiagnostic = props.readerDiagnostic?.trim()
    || (validation && !validation.readable ? validation.diagnostic : null)
    || (hasReaderBoundary && !props.readerTranscript ? "current construction reader is unavailable" : null);
  const projected = props.readerTranscript
    ? projectReaderTranscript(props.readerTranscript, props.mode, props.roleToggle, validation ?? undefined, props.paragraphs)
    : hasReaderBoundary ? [] : legacyReaderProjection(props.transcript ?? [], props.mode, props.roleToggle);
  return {
    projected,
    readerDiagnostic,
    readerNotice: validation?.warnings.join(" . ") || null,
    stateLabel: props.readerTranscript ? transcriptStateLabel(props.readerTranscript, validation ?? undefined) : hasReaderBoundary ? "PROJECTION UNAVAILABLE" : "LEGACY TEST FIXTURE",
  };
}

/** Episodes in this reader's logical-ordinal space. */
export function sessionEpisodeAnchors(props: Pick<SessionViewProps, "layers" | "readerTranscript" | "transcript">): EpisodeAnchor[] {
  if (!props.layers?.episodes.length) return [];
  const turns = props.readerTranscript
    ? props.readerTranscript.dialogue
    : (props.transcript ?? []).map((row) => ({ logicalOrdinal: row.ordinal, rawRepresentativeOrdinal: row.ordinal }));
  return episodeAnchors(props.layers, turns);
}

/** Transcript dividers: only a session with two or more placed episodes is divided. */
export function transcriptEpisodes(anchors: readonly EpisodeAnchor[]): TranscriptEpisode[] {
  const placed = anchors.filter((anchor): anchor is EpisodeAnchor & { ordinal: number } => anchor.ordinal !== null);
  if (placed.length < 2) return [];
  return placed
    .map((anchor) => ({ ordinal: anchor.ordinal, index: anchor.index, title: asciiLabel(anchor.title) }))
    .sort((a, b) => a.ordinal - b.ordinal);
}

export function sessionModelLabel(facts: SessionFacts): string | null {
  const model = facts.models[0];
  return model ? model.replace(/^claude-/, "").replace(/-(?:20\d{6}|latest)$/i, "").replace(/^openai\//, "") : null;
}

/** Pure frame + hit zones for one reader state. The component memoizes the transcript layout. */
export function sessionLayoutModel(props: SessionViewProps, lineOffset = 0, summaryOffset = 0, prepared?: { projection: SessionProjection; transcript: TranscriptLayout; anchors: readonly EpisodeAnchor[] }): SessionLayoutModel {
  const height = props.height ?? Math.max(12, (props.visibleRows ?? 16) + 7);
  const projection = prepared?.projection ?? projectSession(props);
  const filter = props.filter ?? {};
  const hasFilter = Object.keys(filter).some((key) => filter[key as keyof ListFilter] != null);
  const notice = Boolean(projection.readerDiagnostic || projection.readerNotice || projection.stateLabel !== "CURRENT");
  const layout = sessionSurfaceLayout(props.width, height, { hasFilter, rail: Boolean(props.analytics), aboutOpen: props.aboutOpen, notice });
  const anchors = prepared?.anchors ?? sessionEpisodeAnchors(props);
  const transcript = prepared?.transcript ?? layoutTranscript(projection.projected, { width: layout.measure, wrap: props.wrap !== false, mode: props.mode, toggled: props.toggledFolds, modelLabel: sessionModelLabel(props.facts), episodes: transcriptEpisodes(anchors) });
  const viewport = transcriptViewport(transcript, lineOffset, layout.transcriptRows);
  const zones: InteractionZone[] = [];
  const lines: string[] = [];

  lines.push(headerLine(props, layout, zones));
  if (layout.filterRows) {
    lines.push(filterLine(filter, layout.width));
    if (props.actions) zones.push(...dashboardFilterInteractionZones(filter, layout.width, props.actions, 1));
  }

  const rail = layout.railWidth > 0 && props.analytics ? operationalRailLines(props.analytics, layout.railWidth, layout.bodyRows, filter) : [];
  if (rail.length && props.actions && props.analytics) {
    const dash = dashboardSurfaceLayout(layout.width, layout.height, hasFilter, false);
    zones.push(...dashboardRailInteractionZones({ layout: dash, analytics: props.analytics, actions: props.actions, rightMode: "none", filter }));
  }
  // The current episode follows the active message while it is on screen,
  // otherwise the top of the view.
  const first = transcript.blocks[viewport.firstBlock]?.row.ordinal ?? null;
  const last = transcript.blocks[viewport.lastBlock]?.row.ordinal ?? null;
  const active = props.activeOrdinal ?? null;
  const reading = active !== null && first !== null && last !== null && active >= first && active <= last ? active : first;
  const about = aboutLines(props, layout, summaryOffset, zones, anchors, episodeAt(anchors, reading));
  const column = columnLines(props, layout, projection, transcript, viewport);
  for (let row = 0; row < layout.bodyRows; row++) {
    const stacked = row < layout.aboutRows ? about[row] ?? "" : null;
    const center = stacked ?? column[row - layout.aboutRows] ?? " ".repeat(layout.columnWidth);
    const right = layout.aboutWidth > 0 ? about[row] ?? "" : "";
    lines.push(`${rail[row] ?? ""}${center}${right}`);
  }
  lines.push(footerLine(props, layout, projection, zones));
  lines.push(commandLine(layout.width, props.message ?? ""));
  while (lines.length < layout.height) lines.splice(Math.max(0, lines.length - 2), 0, " ".repeat(layout.width));

  // The transcript column: the wheel scrolls lines and never bubbles; a click
  // on a fold toggles it and a click anywhere else in a message makes it active.
  zones.push({
    id: `session:${props.facts.id}:transcript`,
    rect: { x: layout.columnX, y: layout.transcriptY, width: layout.columnWidth, height: layout.transcriptRows },
    onEvent: (event) => {
      if (event.event.type !== "mouse") return false;
      if (event.event.action === "scroll") {
        props.onScroll?.(event.event.button === "wheel-up" ? -1 : 1);
        event.stopPropagation();
        return true;
      }
      if (event.event.action !== "press") return false;
      const line = viewport.lines[(event.localY ?? event.event.y - layout.transcriptY)];
      if (!line) return true;
      if (line.fold) props.onToggleFolds?.([line.fold]);
      else if (line.block >= 0) props.onLand?.(transcript.blocks[line.block]!.row.ordinal);
      return true;
    },
  });
  // Every other wheel event in the reader stops here: it never moves the list.
  zones.push({
    id: `session:${props.facts.id}:wheel-guard`,
    rect: { x: 0, y: 0, width: layout.width, height: layout.height },
    zIndex: -50,
    onEvent: (event) => {
      if (event.event.type !== "mouse" || event.event.action !== "scroll") return false;
      event.stopPropagation();
      return true;
    },
  });
  return { layout, projected: projection.projected, transcript, viewport, lines: lines.slice(0, layout.height), zones, readerDiagnostic: projection.readerDiagnostic, readerNotice: projection.readerNotice, stateLabel: projection.stateLabel };
}

function press(run: () => void): NonNullable<InteractionZone["onEvent"]> {
  return (event) => {
    if (event.event.type !== "mouse" || event.event.action !== "press") return false;
    run();
    event.stopPropagation();
    return true;
  };
}

/** Lay out clickable chips from x; returns spans and their rects. */
function chipRow(items: ReadonlyArray<{ id: string; label: string; style: string; run?: () => void }>, x: number, y: number, zones: InteractionZone[], prefix: string): Span[] {
  const spans: Span[] = [];
  let cursor = x;
  items.forEach((item, index) => {
    if (index > 0) { spans.push([" "]); cursor += 1; }
    spans.push([item.label, item.style]);
    if (item.run) zones.push({ id: `${prefix}:${item.id}`, rect: { x: cursor, y, width: item.label.length, height: 1 }, onEvent: press(item.run) });
    cursor += item.label.length;
  });
  return spans;
}

function headerLine(props: SessionViewProps, layout: SessionSurfaceLayout, zones: InteractionZone[]): string {
  const id = props.facts.id;
  const back = chipRow([{ id: "back", label: " < back ", style: SKIN.chip, run: props.onBack }], 1, 0, zones, `session:${id}:control`);
  const skin = harnessSkin(props.facts.harness);
  const activeMode = props.mode === "prose" ? "dialogue" : props.mode;
  const tabs = MODES.map(([mode, label]) => ({ id: `mode-${mode}`, label: ` ${label} `, style: mode === activeMode ? SKIN.pill : SKIN.muted, run: props.onMode ? () => props.onMode!(mode) : undefined }));
  const traversal = props.traversalPosition == null ? [] : [
    { id: "prev", label: " < ", style: SKIN.chip, run: props.onNavigate ? () => props.onNavigate!(-1) : undefined },
    { id: "position", label: `${props.traversalPosition + 1}/${props.traversalTotal ?? "?"}`, style: SKIN.dim },
    { id: "next", label: " > ", style: SKIN.chip, run: props.onNavigate ? () => props.onNavigate!(1) : undefined },
  ];
  // Narrow terminals shed traversal, then the inactive tabs; the active mode
  // always stays visible.
  const withTraversal = (items: typeof tabs) => [...items, ...(traversal.length ? [{ id: "gap", label: " ", style: "" }, ...traversal] : [])];
  const active = tabs.filter((tab) => tab.id === `mode-${activeMode}`);
  const measureRow = (items: readonly { label: string }[]) => items.reduce((sum, item, index) => sum + item.label.length + (index > 0 ? 1 : 0), 0);
  const right = [withTraversal(tabs), tabs, withTraversal(active), active].find((items) => layout.width - measureRow(items) - 1 >= 30) ?? active;
  const rightWidth = measureRow(right);
  const rightSpans = chipRow(right, layout.width - 1 - rightWidth, 0, zones, `session:${id}:control`);
  const title = asciiLabel(props.facts.title?.trim() || props.facts.nativeId);
  return compose(layout.width, [...back, ["  "], [skin.code, fg(skin.color)], ["  "], [title, SKIN.bright]], rightSpans, 1, "right");
}

function columnLines(props: SessionViewProps, layout: SessionSurfaceLayout, projection: SessionProjection, transcript: TranscriptLayout, viewport: TranscriptViewport): string[] {
  const out: string[] = [];
  const width = layout.columnWidth;
  const label = projection.stateLabel === "CURRENT" ? null : projection.stateLabel;
  const warnings = projection.readerNotice?.split(" . ")
    .map((warning) => label && warning.startsWith(label) ? warning.slice(label.length).replace(/^\s*[-·.:]\s*/, "") : warning)
    .filter(Boolean).join(" . ") || null;
  const notice: Span[] | null = projection.readerDiagnostic
    ? [["TRANSCRIPT BLOCKED", SKIN.bad], ...(label ? [["  "], [label, SKIN.warn]] as Span[] : []), ["  "], [asciiLabel(projection.readerDiagnostic), SKIN.muted]]
    : label || warnings
      ? [...(label ? [[label, SKIN.warn]] as Span[] : []), ...(warnings ? [[label ? "  " : ""], [asciiLabel(warnings), label ? SKIN.muted : SKIN.warn]] as Span[] : [])]
      : null;
  if (notice) out.push(compose(width, notice, [], layout.margin));
  if (projection.readerDiagnostic) return out;
  if (transcript.lines.length === 0) {
    out.push(compose(width, [[props.mode === "dialogue" || props.mode === "prose" ? "no dialogue in source" : "no activity in source", SKIN.dim], ["  "], ["0/0", SKIN.dim]], [], layout.margin));
    return out;
  }
  const active = props.activeOrdinal ?? null;
  for (const line of viewport.lines) out.push(transcriptLine(line, transcript, layout, active, props.spanRange ?? null));
  return out;
}

function transcriptLine(line: TranscriptLine, transcript: TranscriptLayout, layout: SessionSurfaceLayout, active: number | null, span: SessionSpanRange | null): string {
  const width = layout.columnWidth;
  if (line.kind === "blank" && line.block < 0) return " ".repeat(width);
  if (line.kind === "episode") return compose(width, [[" ".repeat(layout.margin)], [line.text, SKIN.dim]]);
  const row = transcript.blocks[line.block]!.row;
  const isMd = row.role === "user" && row.author !== "agent" && row.author !== "harness";
  const isActive = active !== null && row.ordinal === active;
  const inSpan = Boolean(span && row.ordinal >= span.fromOrdinal && row.ordinal <= span.toOrdinal);
  const bar = isMd ? (isActive ? MD_BAR_ACTIVE : MD_BAR) : isActive ? ACTIVE_BAR : "";
  const panel = inSpan ? SPAN_PANEL : isMd && line.kind !== "header" ? MD_PANEL : "";
  const lead: Span[] = [[" ".repeat(layout.margin - 2)], bar ? [" ", bar] : [" "], [" "]];
  const body = lineSpans(line, row);
  const used = spanWidth(body);
  const fill = Math.max(0, layout.measure - used);
  const trailing = Math.max(0, width - layout.margin - layout.measure);
  const content: Span[] = panel
    ? body.map(([text, style = ""]) => [text, `${panel}${style}`] as Span).concat([[" ".repeat(fill + 1), panel]])
    : [...body, [" ".repeat(fill + 1)]];
  return compose(width, [...lead, ...content, [" ".repeat(Math.max(0, trailing - 1))]]);
}

function lineSpans(line: TranscriptLine, row: ReaderDisplayRow): Span[] {
  const dim = row.dimmed;
  switch (line.kind) {
    case "header": {
      const label = row.role === "user" ? (row.author === "agent" ? HEADER_AGENT : HEADER_MD) : row.role === "assistant" ? HEADER_MODEL : SKIN.dim;
      return [[line.text, dim ? SKIN.dim : label], ...(line.meta ? [["  "], [line.meta, SKIN.dim]] as Span[] : [])];
    }
    case "fold": return [[line.text.slice(0, 1), SKIN.accentSoft], [line.text.slice(1), SKIN.dim], ...(line.meta ? [["  "], [line.meta, SKIN.dim]] as Span[] : [])];
    case "heading": return [[line.text, dim ? SKIN.dim : SKIN.bright]];
    case "code": return [[line.text, dim ? SKIN.dim : CODE]];
    case "tool": case "note": return [[line.text, SKIN.dim]];
    case "quote": return [[line.text, SKIN.muted]];
    case "blank": return [[""]];
    default: return [[line.text, dim ? SKIN.dim : row.author === "agent" ? SKIN.muted : SKIN.text]];
  }
}

function aboutLines(props: SessionViewProps, layout: SessionSurfaceLayout, summaryOffset: number, zones: InteractionZone[], episodes: readonly EpisodeAnchor[], current: number): string[] {
  if (!layout.aboutOpen || (layout.aboutWidth === 0 && layout.aboutRows === 0)) return [];
  const stacked = layout.aboutWidth === 0;
  const paneWidth = stacked ? layout.width - layout.railWidth : layout.aboutWidth;
  const inner = paneWidth - 3;
  const x0 = stacked ? layout.railWidth + 2 : layout.width - layout.aboutWidth + 2;
  const height = stacked ? layout.aboutRows : layout.bodyRows;
  const wrap = (content: string): string => `${SKIN.panel}${stacked ? " " : "  "}${content}${stacked ? "  " : " "}${END_BG}`;
  const rows: AboutRow[] = [];
  const title = (text: string): void => { rows.push({ spans: [[text, SKIN.label]] }); };
  const id = props.facts.id;

  episodeRows(props, episodes, current, inner, height, rows);

  const summary = props.summary;
  title(summary.status === "loading" ? "SUMMARY"
    : summary.status === "degraded" ? "SUMMARY  outline degraded"
    : summary.result ? `SUMMARY  ${asciiLabel(summary.provider ?? "cache")}${summary.model ? `/${asciiLabel(summary.model)}` : ""}`
    : `SUMMARY  ${summary.status}`);
  if (summary.status === "loading") rows.push({ spans: [["summarizing via provider...", SKIN.warn]] });
  if (summary.status === "degraded" && summary.result && summary.reason) rows.push({ spans: [[asciiLabel(summary.reason), SKIN.dim]] });
  const anchors = summary.result?.anchors ?? [];
  anchors.forEach((anchor, index) => rows.push({
    id: anchorZoneId(id, anchor, index),
    spans: [[index === props.focusedAnchor ? ">" : "-", SKIN.accent], [" "], [asciiLabel(anchor.topic), index === props.focusedAnchor ? SKIN.bright : SKIN.text]],
    right: [[`${anchor.fromOrdinal}-${anchor.toOrdinal}`, SKIN.dim]],
    run: () => props.onAnchorActivate?.(anchor.fromOrdinal, anchor.toOrdinal),
  }));
  const body = summary.result?.body ?? summary.reason ?? "No anchored summary";
  const bodyLines = body.split(/\r?\n/u).flatMap((line) => wrapDisplayText(asciiLabel(line), inner));
  const factsRows = 9 + props.facts.models.length + props.facts.tags.length;
  // Episodes above already count in rows.length.
  const bodyBudget = Math.max(2, height - rows.length - (stacked ? 0 : factsRows) - 1);
  const offset = Math.max(0, Math.min(summaryOffset, Math.max(0, bodyLines.length - bodyBudget)));
  const summaryStart = rows.length;
  for (const line of bodyLines.slice(offset, offset + bodyBudget)) rows.push({ spans: [[line, SKIN.muted]] });
  if (bodyLines.length > bodyBudget) rows.push({ spans: [[`wheel: more summary (${offset + 1}-${Math.min(bodyLines.length, offset + bodyBudget)}/${bodyLines.length})`, SKIN.dim]] });
  const summaryEnd = rows.length;

  rows.push({ spans: [] });
  title("SESSION");
  const skin = harnessSkin(props.facts.harness);
  rows.push({ id: `session:${id}:identity`, spans: [[skin.code, fg(skin.color)], [" "], [props.facts.nativeId, SKIN.muted]], right: [["copy id", SKIN.dim]], run: () => props.onFactYank?.("id", props.facts.nativeId) });
  const creator = props.facts.creator;
  if (creator) rows.push({
    id: `session:${id}:creator`,
    spans: [["started by ", SKIN.dim], [creator.value === "unknown" ? "? unsure" : creator.value, creator.value === "human" ? SKIN.accent : creator.value === "agent" ? SKIN.muted : SKIN.warn]],
    right: [["h flips", SKIN.dim]],
    run: props.onCreatorToggle,
  });
  if (creator?.reason) rows.push({ spans: [[asciiLabel(creator.method === "correction" ? "corrected by hand" : creator.reason), SKIN.dim]] });
  props.facts.models.forEach((model, index) => rows.push({ id: `session:${id}:model:${index}`, spans: [["model ", SKIN.dim], [asciiLabel(model), `${SKIN.muted}\x1b[4m`]], run: () => props.onFactActivate?.("model", model) }));
  if (props.facts.path) rows.push({ id: `session:${id}:path`, spans: [["path ", SKIN.dim], [pathTail(props.facts.path, inner - 5), `${SKIN.muted}\x1b[4m`]], run: () => props.onFactActivate?.("path", props.facts.path!) });
  props.facts.tags.forEach((tag, index) => rows.push({ id: `session:${id}:tag:${index}`, spans: [["#", SKIN.dim], [asciiLabel(tag), `${SKIN.text}\x1b[4m`]], run: () => props.onFactActivate?.("tag", tag) }));
  const metrics = props.readerTranscript?.session.metrics;
  if (metrics) {
    rows.push({ spans: [[`${metrics.userDialogueTurnCount} user . ${metrics.assistantDialogueTurnCount} assistant`, SKIN.muted]] });
    rows.push({ spans: [[`${compact(metrics.logicalToolActivityCount)} tools . ${compact(metrics.logicalRecordCount)} records`, SKIN.dim]] });
  }
  rows.push({ spans: [[`${formatDuration(props.facts.durationMs)} . chain ${props.facts.chainMembers || 1}`, SKIN.dim]] });

  const lines: string[] = [];
  rows.slice(0, height).forEach((row, index) => {
    lines.push(wrap(compose(inner, row.spans, row.right ?? [], 0, "left", SKIN.panel)));
    const y = layout.bodyY + index;
    if (row.run) zones.push({ id: row.id ?? `session:${id}:about:${index}`, rect: { x: x0, y, width: inner, height: 1 }, onEvent: press(row.run) });
  });
  const blank = wrap(" ".repeat(inner));
  while (lines.length < height) lines.push(blank);
  if (summaryEnd > summaryStart) zones.push({
    id: `session:${id}:summary-scroll`,
    rect: { x: x0, y: layout.bodyY + summaryStart, width: inner, height: summaryEnd - summaryStart },
    onEvent: (event) => {
      if (event.event.type !== "mouse" || event.event.action !== "scroll") return false;
      props.onSummaryScroll?.(event.event.button === "wheel-up" ? -1 : 1);
      event.stopPropagation();
      return true;
    },
  });
  return lines;
}

type AboutRow = { spans: Span[]; right?: Span[]; run?: () => void; id?: string };

/**
 * `marathon . 18 episodes`, then a window of episodes around the current one:
 * a facet chip, the label (keywords, dimmed, until labelled), the time span,
 * and up to three detail tags. Narrow panes give each episode two lines.
 */
function episodeRows(props: SessionViewProps, anchors: readonly EpisodeAnchor[], current: number, inner: number, height: number, rows: AboutRow[]): void {
  const layers = props.layers;
  if (!layers || (!layers.shape && anchors.length === 0 && !layers.sessionFacet && layers.sessionTags.length === 0)) return;
  const id = props.facts.id;
  const jumpable = anchors.filter((anchor) => anchor.ordinal !== null).length;
  const head = [layers.shape, anchors.length ? `${anchors.length} episode${anchors.length === 1 ? "" : "s"}` : null].filter(Boolean).join(" . ");
  const title = head || "layers";
  const hint = jumpable < 2 ? "" : title.length + 10 <= inner ? "[ ] step" : title.length + 5 <= inner ? "[ ]" : "";
  rows.push({ spans: [[title, SKIN.label]], right: hint ? [[hint, SKIN.dim]] : [] });
  if (layers.sessionFacet || layers.sessionTags.length) {
    rows.push({ spans: [...(layers.sessionFacet ? [facetChip(layers.sessionFacet), [" "]] as Span[] : []), [asciiLabel(layers.sessionTags.slice(0, 3).join(" ")), SKIN.dim]] });
  }
  if (anchors.length === 0) {
    rows.push({ spans: [] });
    return;
  }
  const oneLine = inner >= 70;
  const perEpisode = oneLine ? 1 : 2;
  const visible = Math.max(1, Math.min(anchors.length, Math.floor(height / 3 / perEpisode)));
  const focus = current >= 0 ? current : 0;
  const start = Math.max(0, Math.min(anchors.length - visible, focus - Math.floor(visible / 2)));
  const digits = String(anchors.length).length;
  for (const anchor of anchors.slice(start, start + visible)) {
    const here = anchors.indexOf(anchor) === current;
    const ordinal = anchor.ordinal;
    const run = ordinal === null ? undefined : () => props.onEpisodeJump?.(ordinal);
    const number: Span[] = [[here ? ">" : " ", SKIN.accent], [String(anchor.index).padStart(digits), here ? SKIN.bright : SKIN.dim], [" "]];
    const chip: Span[] = anchor.facet ? [facetChip(anchor.facet), [" "]] : [];
    const title: Span = [asciiLabel(anchor.title), anchor.labelled ? (here ? SKIN.bright : SKIN.text) : SKIN.dim];
    const time = episodeSpan(anchor.startTs, anchor.endTs);
    const span: Span[] = time ? [[time, SKIN.dim], ["  "]] : [];
    const tags: Span[] = anchor.tags.length ? [[asciiLabel(anchor.tags.slice(0, 3).join(" ")), SKIN.dim]] : [];
    const base = `session:${id}:episode:${anchor.index}`;
    if (oneLine) {
      rows.push({ id: base, spans: [...number, ...chip, ...span, title, ...(tags.length ? [["  "] as Span, ...tags] : [])], run });
    } else {
      // The label gets the whole first line; the chip leads the second.
      rows.push({ id: base, spans: [...number, title], run });
      if (chip.length || span.length || tags.length) rows.push({ id: `${base}:meta`, spans: [[" ".repeat(digits + 2)], ...chip, ...span, ...tags], run });
    }
  }
  if (anchors.length > visible) rows.push({ spans: [[`${start + 1}-${start + visible} of ${anchors.length}`, SKIN.dim]] });
  rows.push({ spans: [] });
}

function clock(ts: number): string {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function episodeSpan(start: number | null, end: number | null): string {
  if (start === null) return "";
  if (end === null || end <= start) return clock(start);
  const days = Math.round((new Date(end).setHours(0, 0, 0, 0) - new Date(start).setHours(0, 0, 0, 0)) / 86_400_000);
  return `${clock(start)}-${clock(end)}${days > 0 ? `+${days}d` : ""}`;
}

function footerLine(props: SessionViewProps, layout: SessionSurfaceLayout, projection: SessionProjection, zones: InteractionZone[]): string {
  const metrics = props.readerTranscript?.session.metrics;
  const left: Span[] = [[" "]];
  if (metrics) {
    left.push([`${metrics.userDialogueTurnCount}`, SKIN.text], [" user   ", SKIN.dim], [`${metrics.assistantDialogueTurnCount}`, SKIN.text], [" assistant   ", SKIN.dim], [compact(metrics.logicalToolActivityCount), SKIN.text], [" tools", SKIN.dim]);
  } else left.push([`${projection.projected.length} messages`, SKIN.dim]);
  const items = [
    { id: "wrap", label: props.wrap === false ? " wrap " : " no wrap ", run: props.onToggleWrap },
    { id: "about", label: layout.aboutOpen ? " hide about " : " about ", run: props.onToggleAbout },
    { id: "copy-message", label: " copy ", run: props.onCopyMessage },
    { id: "copy-conversation", label: " copy all ", run: props.onCopyConversation },
    { id: "undo", label: " undo ", run: props.onUndo },
  ].filter((item) => item.run);
  const total = items.reduce((sum, item, index) => sum + item.label.length + (index > 0 ? 1 : 0), 0);
  const fits = layout.width - total - 2 >= spanWidth(left);
  const right = fits ? chipRow(items.map((item) => ({ ...item, style: SKIN.chip })), layout.width - 1 - total, layout.footerY, zones, `session:${props.facts.id}:control`) : [];
  return compose(layout.width, left, right, 0, "right");
}

function commandLine(width: number, message: string): string {
  const right: Span[] = width >= 80
    ? [["j/k", SKIN.accent], [" message", SKIN.dim], ["   "], ["m", SKIN.accent], [" view", SKIN.dim], ["   "], ["?", SKIN.accent], [" help", SKIN.dim], ["   "], ["esc", SKIN.accent], [" back", SKIN.dim]]
    : [["?", SKIN.accent], [" help", SKIN.dim], ["   "], ["esc", SKIN.accent], [" back", SKIN.dim]];
  return compose(width, [[">", SKIN.accent], [" "], message ? [asciiLabel(message), SKIN.muted] : ["_", SKIN.dim]], right, 1, "right");
}

// ---------------------------------------------------------------- component

export function SessionView(props: SessionViewProps): React.JSX.Element {
  const [, rerender] = React.useReducer((value: number) => value + 1, 0);
  const projection = React.useMemo(
    () => projectSession(props),
    [props.readerTranscript, props.readerDiagnostic, props.transcript, props.mode, props.roleToggle, props.paragraphs],
  );
  const filter = props.filter ?? {};
  const hasFilter = Object.keys(filter).some((key) => filter[key as keyof ListFilter] != null);
  const notice = Boolean(projection.readerDiagnostic || projection.readerNotice || projection.stateLabel !== "CURRENT");
  const height = props.height ?? Math.max(12, (props.visibleRows ?? 16) + 7);
  const layout = sessionSurfaceLayout(props.width, height, { hasFilter, rail: Boolean(props.analytics), aboutOpen: props.aboutOpen, notice });
  const modelLabel = sessionModelLabel(props.facts);
  const anchors = React.useMemo(
    () => sessionEpisodeAnchors(props),
    [props.layers, props.readerTranscript, props.transcript],
  );
  const transcript = React.useMemo(
    () => layoutTranscript(projection.projected, { width: layout.measure, wrap: props.wrap !== false, mode: props.mode, toggled: props.toggledFolds, modelLabel, episodes: transcriptEpisodes(anchors) }),
    [anchors, layout.measure, modelLabel, projection.projected, props.mode, props.toggledFolds, props.wrap],
  );

  // Scroll position is an absolute line offset. It is re-derived in render
  // from what changed: a new session starts at the top, a new active message
  // is revealed, and a relayout (mode, wrap, width, folds) keeps the message
  // that was at the top of the view where it was.
  const offset = React.useRef(0);
  const summaryOffset = React.useRef(0);
  const seen = React.useRef<{ id: number; active: number | null; transcript: TranscriptLayout | null; anchor: { ordinal: number; delta: number } | null }>({ id: -1, active: null, transcript: null, anchor: null });
  const rows = layout.transcriptRows;
  const active = props.activeOrdinal ?? props.landingOrdinal ?? null;
  if (seen.current.id !== props.facts.id) {
    seen.current = { id: props.facts.id, active: null, transcript, anchor: null };
    offset.current = 0;
    summaryOffset.current = 0;
  } else if (seen.current.transcript !== transcript) {
    const anchor = seen.current.anchor;
    const index = anchor ? blockIndexForOrdinal(transcript, anchor.ordinal, "later") : -1;
    const block = transcript.blocks[index];
    offset.current = block ? block.start + Math.min(anchor!.delta, Math.max(0, block.end - block.start - 1)) : 0;
    seen.current.transcript = transcript;
  }
  if (seen.current.active !== active) {
    seen.current.active = active;
    if (active !== null) {
      const index = blockIndexForOrdinal(transcript, active, props.landingBias ?? "later");
      offset.current = offsetToReveal(transcript, index, offset.current, rows);
    }
  }
  const model = sessionLayoutModel({
    ...props,
    onSummaryScroll: (delta) => { summaryOffset.current = Math.max(0, summaryOffset.current + delta * 3); rerender(); },
    onEpisodeJump: (ordinal) => { controller.jumpTo(ordinal); props.onEpisodeJump?.(ordinal); },
  }, offset.current, summaryOffset.current, { projection, transcript, anchors });
  offset.current = model.viewport.offset;
  const top = transcript.blocks[blockAtLine(transcript, offset.current)];
  seen.current.anchor = top ? { ordinal: top.row.ordinal, delta: Math.max(0, offset.current - top.start) } : null;

  const propsRef = React.useRef(props);
  propsRef.current = props;
  const modelRef = React.useRef(model);
  modelRef.current = model;
  const scrollBy = React.useCallback((delta: number) => {
    const current = modelRef.current;
    const next = Math.max(0, Math.min(current.viewport.maxOffset, offset.current + delta));
    if (next === offset.current) return;
    offset.current = next;
    rerender();
  }, []);
  const controller = React.useMemo<SessionViewController>(() => ({
    scroll(kind) {
      const page = Math.max(1, modelRef.current.layout.transcriptRows - 2);
      if (kind === "line-down") scrollBy(3);
      else if (kind === "line-up") scrollBy(-3);
      else if (kind === "page-down") scrollBy(page);
      else if (kind === "page-up") scrollBy(-page);
      else if (kind === "home") scrollBy(-offset.current);
      else scrollBy(modelRef.current.viewport.maxOffset - offset.current);
    },
    toggleActiveFolds() {
      const { transcript: layoutNow, viewport } = modelRef.current;
      const activeOrdinal = propsRef.current.activeOrdinal ?? null;
      const index = activeOrdinal === null ? viewport.firstBlock : blockIndexForOrdinal(layoutNow, activeOrdinal, "later");
      const block = layoutNow.blocks[index];
      if (!block || block.folds.length === 0) return;
      const state = new Map<string, boolean>();
      for (const line of layoutNow.lines.slice(block.start, block.end)) if (line.fold) state.set(line.fold, Boolean(line.open));
      const closed = [...state].filter(([, open]) => !open).map(([fold]) => fold);
      propsRef.current.onToggleFolds?.(closed.length ? closed : [...state.keys()]);
    },
    visibleOrdinals() {
      const { transcript: layoutNow, viewport } = modelRef.current;
      return { first: layoutNow.blocks[viewport.firstBlock]?.row.ordinal ?? null, last: layoutNow.blocks[viewport.lastBlock]?.row.ordinal ?? null };
    },
    jumpTo(ordinal) {
      const { transcript: layoutNow, viewport } = modelRef.current;
      const block = layoutNow.blocks[blockIndexForOrdinal(layoutNow, ordinal, "later")];
      if (!block) return;
      const divided = layoutNow.lines[block.start - 1]?.kind === "episode";
      offset.current = Math.max(0, Math.min(viewport.maxOffset, block.start - (divided ? 1 : 0)));
      rerender();
    },
  }), [scrollBy]);
  if (props.controllerRef) props.controllerRef.current = controller;

  const zones = model.zones.map((zone) => zone.id === `session:${props.facts.id}:transcript`
    ? { ...zone, onEvent: wheelFirst(zone.onEvent!, (delta) => { scrollBy(delta * 3); props.onScroll?.(delta); }) }
    : zone);
  React.useLayoutEffect(() => { props.onInteractionZones?.(zones); });
  return <Text>{model.lines.join("\n")}</Text>;
}

function wheelFirst(inner: NonNullable<InteractionZone["onEvent"]>, scroll: (delta: -1 | 1) => void): NonNullable<InteractionZone["onEvent"]> {
  return (event) => {
    if (event.event.type === "mouse" && event.event.action === "scroll") {
      scroll(event.event.button === "wheel-up" ? -1 : 1);
      event.stopPropagation();
      return true;
    }
    return inner(event);
  };
}

// ---------------------------------------------------------------- legacy + helpers

/** Legacy pure projection retained only for pre-Phase-5 focused helper tests. */
export function projectTranscript(rows: readonly TranscriptRow[], mode: TranscriptMode, roleToggle: RoleToggle): TranscriptProjection[] {
  const out: TranscriptProjection[] = [];
  for (const row of rows) {
    const isTool = row.role === "tool" || (!row.text && Boolean(row.toolText));
    const isDialogueRole = row.role === "user" || row.role === "assistant";
    if ((mode === "dialogue" || mode === "prose") && (!isDialogueRole || !(row.text ?? "").trim())) continue;
    const otherRole = roleToggle !== "all" && isDialogueRole && row.role !== roleToggle;
    const prose = (row.text ?? "").replace(/\s+/g, " ").trim();
    const tool = (row.toolText ?? "").replace(/\s+/g, " ").trim();
    let display = prose || tool;
    let dimmed = otherRole;
    if (mode === "full" && prose && tool) display = `${prose}  [tool: ${tool}]`;
    else if (mode === "stubs" && row.hasTool && prose) display = `${prose}  [tool activity]`;
    else if (isTool && mode !== "full") { display = `tool ${tool.split(" ").slice(0, 12).join(" ")}`; dimmed = true; }
    if (!display) display = `(${row.role} event)`;
    out.push({ ...row, display, dimmed, gutter: row.role === "user" ? "◆" : row.role === "assistant" ? "◇" : "·" });
  }
  return out;
}

function legacyReaderProjection(rows: readonly TranscriptRow[], mode: TranscriptMode, roleToggle: RoleToggle): ReaderDisplayRow[] {
  const withTools = mode === "stubs" || mode === "full";
  return projectTranscript(rows, mode, roleToggle).map((row, index) => ({
    logicalRecordId: -(index + 1),
    ordinal: row.ordinal,
    role: row.role === "user" || row.role === "assistant" ? row.role : legacyKind(row),
    recordKind: legacyKind(row),
    prose: row.text,
    toolActivities: withTools && row.toolText
      ? [{ toolActivityId: -(index + 1), rawRecordId: -(index + 1), activityOrdinal: 0, activityKind: "result" as const, toolName: null, toolText: row.toolText, sourceActivityId: null }]
      : [],
    display: row.text?.trim() || (withTools && row.toolText ? "" : row.display),
    dimmed: row.dimmed,
    gutter: row.gutter,
    constructionGeneration: "legacy-test-fixture",
    author: row.role === "user" ? "human" : null,
  }));
}

function legacyKind(row: TranscriptRow): RecordKind {
  if (row.role === "user") return "real_user";
  if (row.role === "assistant") return "assistant_dialogue_prose";
  if (row.role === "tool" || row.hasTool) return "tool";
  if (row.role === "system") return "developer_system";
  return "unclassified";
}

export function projectedTranscriptIndexForOrdinal(rows: readonly { ordinal: number }[], ordinal: number, bias: "earlier" | "later" | "nearest" = "nearest"): number {
  if (rows.length === 0) return 0;
  const exact = rows.findIndex((row) => row.ordinal === ordinal);
  if (exact >= 0) return exact;
  const later = rows.findIndex((row) => row.ordinal > ordinal);
  const earlier = later < 0 ? rows.length - 1 : Math.max(0, later - 1);
  if (bias === "later") return later >= 0 ? later : rows.length - 1;
  if (bias === "earlier") return earlier;
  if (later < 0) return rows.length - 1;
  return ordinal - rows[earlier]!.ordinal <= rows[later]!.ordinal - ordinal ? earlier : later;
}

export function transcriptIndexForOrdinal(rows: readonly TranscriptRow[], ordinal: number): number {
  return projectedTranscriptIndexForOrdinal(rows, ordinal, "later");
}

export function yankActiveMessagePayload(rows: readonly TranscriptRow[], activeOrdinal: number | null | undefined): string | null {
  const row = activeOrdinal == null ? null : rows.find((item) => item.ordinal === activeOrdinal);
  return row ? (row.text ?? row.toolText ?? "") || null : null;
}

export function yankProsePayload(rows: readonly TranscriptRow[], range?: SessionSpanRange | null): string {
  return rows.filter((row) => row.role !== "tool" && (row.text ?? "").trim() && (!range || inSpan(row.ordinal, range)))
    .map((row) => `${row.role}: ${row.text!.trim()}`).join("\n\n");
}

export function yankReaderMessagePayload(rows: readonly ReaderDisplayRow[], activeOrdinal: number | null | undefined): string | null {
  const row = activeOrdinal == null ? null : rows.find((item) => item.ordinal === activeOrdinal);
  return row?.prose?.trim() || row?.toolActivities.map((activity) => activity.toolText).filter(Boolean).join("\n") || null;
}

export function yankReaderProsePayload(rows: readonly ReaderDisplayRow[], range?: SessionSpanRange | null): string {
  return rows.filter((row) => (row.role === "user" || row.role === "assistant") && row.prose?.trim() && (!range || inSpan(row.ordinal, range)))
    .map((row) => `${row.role}: ${row.prose!.trim()}`).join("\n\n");
}

export function activateAnchor(anchors: readonly Anchor[], index: number, callback?: (fromOrdinal: number, toOrdinal: number) => void): boolean {
  const anchor = anchors[index];
  if (!anchor) return false;
  callback?.(anchor.fromOrdinal, anchor.toOrdinal);
  return true;
}

export function anchorZoneId(sessionId: number, anchor: Anchor, index: number): string { return `session:${sessionId}:anchor:${index}:${anchor.fromOrdinal}-${anchor.toOrdinal}`; }
function inSpan(ordinal: number, range?: SessionSpanRange | null): boolean { return Boolean(range && ordinal >= range.fromOrdinal && ordinal <= range.toOrdinal); }
function formatDuration(ms: number | null): string { if (ms === null) return "-"; const minutes = Math.round(ms / 60_000); return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`; }
function pathTail(path: string, width: number): string {
  const home = path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  return home.length <= width ? home : `...${home.slice(home.length - Math.max(1, width - 3))}`;
}
