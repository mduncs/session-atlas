import React from "react";
import { Box, Text } from "ink";
import { dashboardFilterChips, UltraDenseDashboard, type UltraDenseDashboardProps } from "./dashboard.js";
import { dateFilterForCluster } from "./list-view.js";
import { projectionSession, sessionKey, type ProjectedListRow, type SessionRow } from "./domain.js";
import type { InteractionZone } from "./interaction.js";
import type { AtlasTestPreview } from "./atlas-test-preview.js";
import type { FilterTerm, ListFilter } from "./queries.js";
import { displayWidth, truncateDisplayText, wrapDisplayText } from "./transcript-layout.js";

export interface AtlasTestDashboardProps extends UltraDenseDashboardProps {
  showAgentConversations: boolean;
  onToggleAgentConversations: () => void;
  focusProjectionKey?: string | null;
  preview?: AtlasTestPreview | null;
  matchingCountKnown?: boolean;
}

const CYAN = "\x1b[38;5;81m";
const DIM = "\x1b[38;5;245m";
const FOCUS = "\x1b[48;5;24m\x1b[38;5;255m";
const RESET = "\x1b[39m\x1b[49m";

type ConversationProjection = Exclude<ProjectedListRow, { kind: "cluster" }>;
type ResizableColumnKey = "topic" | "project" | "source" | "active";
export type AtlasTestColumnWidths = Partial<Record<ResizableColumnKey, number>>;
interface Column { key: "markers" | "group" | "topic" | "project" | "source" | "active"; x: number; width: number }
interface Layout {
  width: number;
  height: number;
  listWidth: number;
  previewWidth: number;
  filterRows: number;
  headerY: number;
  dataY: number;
  dataRows: number;
  footerY: number;
  liveY: number | null;
  bottomPreviewY: number | null;
  bottomPreviewRows: number;
  columns: Column[];
}
interface Control { id: string; x: number; y: number; text: string; run?: () => void }
interface Frame { text: string; zones: InteractionZone[] }
interface ResizeDrag { geometry: string; startX: number; left: Column; right: Column; initial: AtlasTestColumnWidths }
interface ResizeControls {
  geometry: string;
  drag: { current: ResizeDrag | null };
  update: (widths: AtlasTestColumnWidths) => void;
}

/** The prototype changes presentation only; provenance filtering stays in the shared query layer. */
export function AtlasTestDashboard(props: AtlasTestDashboardProps): React.JSX.Element {
  const excursion = Boolean(props.inspector || (props.operationalExcursion ?? "list") !== "list");
  const geometry = `${Math.floor(props.width)}:${Math.floor(props.height ?? 40)}`;
  const [sizing, setSizing] = React.useState<{ geometry: string; widths: AtlasTestColumnWidths } | null>(null);
  const drag = React.useRef<ResizeDrag | null>(null);
  React.useLayoutEffect(() => { drag.current = null; setSizing(null); }, [geometry]);
  const frame = React.useMemo(() => buildFrame(props, sizing?.geometry === geometry ? sizing.widths : undefined, {
    geometry, drag, update: (widths) => setSizing({ geometry, widths }),
  }), [geometry, props, sizing]);
  React.useLayoutEffect(() => {
    if (!excursion) props.onInteractionZones?.(frame.zones);
  }, [excursion, frame.zones, props.onInteractionZones]);
  if (excursion) {
    const identityRows = (props.height ?? 40) > 8 ? 1 : 0;
    return <Box flexDirection="column">
      {identityRows > 0 ? <Text color="cyan">{fixed(" ATLAS TEST | cyan = changed | detail view", Math.max(1, props.width))}</Text> : null}
      <UltraDenseDashboard {...props} height={Math.max(8, (props.height ?? 40) - identityRows)}
        onInteractionZones={(zones) => props.onInteractionZones?.(zones.map((zone) => ({ ...zone, rect: { ...zone.rect, y: zone.rect.y + identityRows } })))} />
    </Box>;
  }
  return <Text>{frame.text}</Text>;
}

/** Exact projection-row budget, including month headings, shared with the shell viewport. */
export function atlasTestDashboardLineBudget(width: number, height: number, filter: ListFilter = {}, pendingLiveCount = 0, peekOpen = false): number {
  return atlasTestLayout(width, height, filter, pendingLiveCount, peekOpen).dataRows;
}

export function renderAtlasTestDashboardFrame(props: AtlasTestDashboardProps, columnWidths?: AtlasTestColumnWidths): string {
  return buildFrame(props, columnWidths).text;
}

function atlasTestLayout(width: number, height: number, filter: ListFilter, pendingLiveCount: number, peekOpen: boolean, columnWidths?: AtlasTestColumnWidths): Layout {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const filterRows = filterChips(filter).length > 0 ? 1 : 0;
  const previewEnabled = safeWidth >= 180;
  const listWidth = previewEnabled ? Math.min(156, Math.floor(safeWidth * 0.7)) : safeWidth;
  const previewWidth = previewEnabled ? safeWidth - listWidth - 3 : 0;
  const headerY = 3 + filterRows;
  const dataY = headerY + 1;
  const footerY = safeHeight - 1;
  const bottomPreviewRows = peekOpen && !previewEnabled ? Math.max(0, Math.min(10, Math.floor(safeHeight / 3), footerY - dataY - 2)) : 0;
  const bottomPreviewY = bottomPreviewRows > 0 ? footerY - bottomPreviewRows : null;
  const listEnd = bottomPreviewY ?? footerY;
  const liveY = pendingLiveCount > 0 && listEnd > dataY ? listEnd - 1 : null;
  const dataRows = Math.max(0, (liveY ?? listEnd) - dataY);
  const sizes: Array<[Column["key"], number]> = [["markers", Math.min(4, listWidth)]];
  if (listWidth >= 110) sizes.push(["group", 12]);
  sizes.push(["topic", 0]);
  if (listWidth >= 90) sizes.push(["project", listWidth >= 140 ? 26 : 20]);
  if (listWidth >= 70) sizes.push(["source", 11]);
  if (listWidth >= 50) sizes.push(["active", 11]);
  const topic = sizes.find(([key]) => key === "topic")!;
  topic[1] = Math.max(0, listWidth - sizes.reduce((sum, [, size]) => sum + size, 0) - (sizes.length - 1));
  // Keep the list topic compact even on very wide terminals. The full stored
  // text remains visible in the fixed preview, not a wrapping result row.
  if (topic[1] > 80 && sizes.some(([key]) => key === "project")) {
    const project = sizes.find(([key]) => key === "project")!;
    project[1] += topic[1] - 80;
    topic[1] = 80;
  }
  applyColumnWidths(sizes, columnWidths);
  let x = 0;
  const columns = sizes.filter(([, size]) => size > 0).map(([key, size]) => {
    const column = { key, x, width: size };
    x += size + 1;
    return column;
  });
  return { width: safeWidth, height: safeHeight, listWidth, previewWidth, filterRows, headerY, dataY, dataRows, footerY, liveY, bottomPreviewY, bottomPreviewRows, columns };
}

function buildFrame(props: AtlasTestDashboardProps, columnWidths?: AtlasTestColumnWidths, resize?: ResizeControls): Frame {
  const filter = props.filter ?? {};
  const layout = atlasTestLayout(props.width, props.height ?? 40, filter, props.pendingLiveCount ?? 0, Boolean(props.peek), columnWidths);
  const visible = props.projections.slice(0, layout.dataRows);
  const focusedIndex = focusedProjectionIndex(visible, props);
  const focused = visible[focusedIndex];
  const peekProjection = props.peek ? props.projections.find((row) => row.kind !== "cluster" && sessionKey(projectionSession(row)) === props.peek!.key) : undefined;
  const previewProjection = peekProjection?.kind !== "cluster" && peekProjection ? peekProjection : focused?.kind !== "cluster" ? focused : undefined;
  const preview = previewLines(previewProjection, props.preview, layout.previewWidth, layout.dataRows);
  const rows = Array.from({ length: layout.height }, () => " ".repeat(layout.width));
  const zones: InteractionZone[] = [];
  const paint = (y: number, text: string, color = ""): void => {
    if (y >= 0 && y < layout.height) rows[y] = colored(fixed(text, layout.width), color);
  };
  const addControls = (controls: readonly Control[]): void => {
    for (const control of controls) {
      const width = Math.min(displayWidth(control.text), layout.width - control.x);
      if (width <= 0 || control.y >= layout.height || !control.run) continue;
      zones.push({
        id: control.id,
        rect: { x: control.x, y: control.y, width, height: 1 },
        focusable: true,
        onEvent: activation(control.run),
      });
    }
  };

  const issueText = props.analytics.errorCount > 0 ? ` (${formatCount(props.analytics.errorCount)} issues)` : "";
  const archiveText = `[Archive status${issueText}]`;
  const archiveX = Math.max(0, layout.width - displayWidth(archiveText) - 1);
  const title = " ATLAS TEST | cyan = changed";
  if (archiveX >= displayWidth(title) + 2) {
    paint(0, fixed(title, archiveX) + archiveText, CYAN);
    addControls([{ id: "atlas-test:archive-status", x: archiveX, y: 0, text: archiveText, run: props.actions?.onProcessing }]);
  } else {
    paint(0, title, CYAN);
  }

  const agentText = `[g] Agent conversations: ${props.showAgentConversations ? "shown" : "hidden"}`;
  const controls = headerControls(props, layout, agentText);
  let controlLine = ` ${agentText}`;
  for (const control of controls) controlLine = fixed(controlLine, control.x) + control.text;
  paint(1, controlLine, CYAN);
  addControls([{ id: "atlas-test:agent-toggle", x: 1, y: 1, text: agentText, run: props.onToggleAgentConversations }, ...controls]);

  const displayRows = visible.filter((row) => row.kind !== "cluster").length;
  const matching = props.matchingCountKnown === false ? "counting matches" : `${formatCount(props.analytics.visibleSessionCount)} matching conversations`;
  const countText = layout.width < 65
    ? `${formatCount(displayRows)} rows | ${props.matchingCountKnown === false ? "counting" : `${formatCount(props.analytics.visibleSessionCount)} matches`}`
    : layout.width < 110 ? `${formatCount(displayRows)} rows shown | ${matching}`
      : `${formatCount(displayRows)} display rows shown | ${matching}`;
  const searchText = "[/ Search]";
  const searchX = Math.max(0, layout.width - displayWidth(searchText) - 1);
  const sort = filter.query ? " | Sort: relevance" : " | Sort: last active";
  const countWidth = Math.max(0, searchX - 1);
  paint(2, fixed(` ${countText}${sort}`, countWidth) + " " + searchText, CYAN);
  addControls([{ id: "atlas-test:search", x: searchX, y: 2, text: searchText, run: props.actions?.onSearch }]);

  if (layout.filterRows) {
    const chips = filterChips(filter);
    let line = " Filters: ";
    for (const chip of chips) {
      const text = `[${chip.label} x]`;
      const x = displayWidth(line);
      if (x >= layout.width) break;
      addControls([{ id: `atlas-test:filter:${chip.kind}`, x, y: 3, text, run: () => props.actions?.onRemoveFilter?.(chip.kind) }]);
      line += `${text} `;
    }
    paint(3, line, CYAN);
  }

  const heading = columnLine(layout, {
    markers: "", group: "GROUP", topic: layout.listWidth >= 110 ? "CONVERSATION / EXISTING TOPIC" : "CONVERSATION",
    project: "PROJECT", source: "SOURCE", active: "LAST ACTIVE",
  });
  paint(layout.headerY, heading + (layout.previewWidth > 0 ? " | " + fixed("CONVERSATION PREVIEW", layout.previewWidth) : ""), CYAN);
  if (resize && layout.headerY < layout.height) zones.push(columnResizeZone(layout, resize));

  for (let index = 0; index < layout.dataRows; index++) {
    const projection = visible[index];
    let listText = " ".repeat(layout.listWidth);
    let color = "";
    if (projection?.kind === "cluster") {
      listText = fixed(` ${projection.label.toLocaleLowerCase().replace(/\b\w/gu, (char) => char.toUpperCase())}`, layout.listWidth);
      color = DIM;
      zones.push({ id: `atlas-test:${projection.key}`, rect: { x: 0, y: layout.dataY + index, width: layout.listWidth, height: 1 }, focusable: true,
        onEvent: activation(() => props.actions?.onFilter?.(dateFilterForCluster(projection, props.now))) });
    } else if (projection) {
      listText = conversationLine(projection, layout, index === focusedIndex, props);
      color = index === focusedIndex ? FOCUS : "";
      zones.push(conversationZone(projection, layout, layout.dataY + index, props));
    } else if (index === 1 && visible.length === 0) {
      listText = fixed(props.analytics.corpusSessionCount === 0 ? " No conversations indexed" : " No conversations match", layout.listWidth);
    } else if (index === 2 && visible.length === 0) {
      listText = fixed(props.analytics.corpusSessionCount === 0 ? props.onboardingHint ?? " Configure sources, then run atlas index" : " Adjust the filters or show agent conversations", layout.listWidth);
      color = DIM;
    }
    rows[layout.dataY + index] = colored(listText, color)
      + (layout.previewWidth > 0 ? colored(" | ", CYAN) + colored(fixed(preview[index]?.text ?? "", layout.previewWidth), preview[index]?.label ? CYAN : "") : "");
  }

  if (layout.liveY !== null) {
    const text = `[${formatCount(props.pendingLiveCount ?? 0)} new conversations - apply]`;
    paint(layout.liveY, ` ${text}`, CYAN);
    addControls([{ id: "atlas-test:live-apply", x: 1, y: layout.liveY, text, run: props.actions?.onApplyLive }]);
  }
  if (layout.bottomPreviewY !== null) {
    paint(layout.bottomPreviewY, " CONVERSATION PREVIEW | Esc close", CYAN);
    const bottomLines = previewLines(previewProjection, props.preview, Math.max(1, layout.width - 2), layout.bottomPreviewRows - 1);
    bottomLines.forEach((line, index) => paint(layout.bottomPreviewY! + 1 + index, ` ${line.text}`, line.label ? CYAN : ""));
  }
  const freshness = freshnessLabel(props);
  const narrowStatus = archiveX < displayWidth(title) + 2 ? ` | ${props.analytics.errorCount} issues` : "";
  const hints = layout.width >= 70 ? "Enter open | Space preview | ? help" : "? help | Archive status";
  const leftFooter = props.commandInput != null ? `> ${props.commandInput}` : props.message ? props.message : hints;
  const rightFooter = `${freshness}${narrowStatus}`;
  paint(layout.footerY, justify(` ${leftFooter}`, rightFooter, layout.width), DIM);
  if (archiveX < displayWidth(title) + 2) {
    addControls([{ id: "atlas-test:archive-status", x: 0, y: layout.footerY, text: fixed("", layout.width), run: props.actions?.onProcessing }]);
  }
  return { text: rows.join("\n"), zones };
}

function isResizable(key: Column["key"]): key is ResizableColumnKey {
  return key !== "markers" && key !== "group";
}

function columnMinimum(key: Column["key"]): number {
  return key === "topic" ? 20 : key === "source" ? 11 : 8;
}

/** Preserve the list's total cell budget even for partially supplied test sizing. */
function applyColumnWidths(sizes: Array<[Column["key"], number]>, supplied?: AtlasTestColumnWidths): void {
  if (!supplied) return;
  const columns = sizes.filter(([key]) => isResizable(key));
  const total = columns.reduce((sum, [, width]) => sum + width, 0);
  const minima = columns.map(([key, width]) => Math.min(width, columnMinimum(key)));
  const widths = columns.map(([key, width], index) => {
    const requested = supplied[key as ResizableColumnKey];
    return requested !== undefined && Number.isFinite(requested) ? Math.max(minima[index]!, Math.floor(requested)) : width;
  });
  let excess = widths.reduce((sum, width) => sum + width, 0) - total;
  if (excess < 0 && widths.length) widths[0]! -= excess;
  for (let index = 0; excess > 0 && index < widths.length; index++) {
    const removed = Math.min(excess, widths[index]! - minima[index]!);
    widths[index]! -= removed;
    excess -= removed;
  }
  columns.forEach((column, index) => { column[1] = widths[index]!; });
}

function columnResizeZone(layout: Layout, resize: ResizeControls): InteractionZone {
  return {
    id: "atlas-test:column-resize",
    rect: { x: 0, y: layout.headerY, width: layout.listWidth, height: 1 },
    zIndex: 2,
    onEvent: (event) => {
      if (event.event.type !== "mouse") return false;
      if (event.event.action === "press" && event.event.button === "left") {
        const x = event.localX ?? event.event.x;
        const index = layout.columns.findIndex((column, index) => isResizable(column.key)
          && isResizable(layout.columns[index + 1]?.key ?? "markers")
          && Math.abs(column.x + column.width - x) <= 1);
        if (index < 0) return false;
        resize.drag.current = {
          geometry: resize.geometry, startX: event.event.x, left: layout.columns[index]!, right: layout.columns[index + 1]!,
          initial: Object.fromEntries(layout.columns.filter((column) => isResizable(column.key)).map((column) => [column.key, column.width])),
        };
      } else {
        const drag = resize.drag.current;
        if (!drag || drag.geometry !== resize.geometry) return false;
        if (event.event.action === "release") resize.drag.current = null;
        else if (event.event.action === "move") {
          const delta = Math.max(columnMinimum(drag.left.key) - drag.left.width,
            Math.min(drag.right.width - columnMinimum(drag.right.key), Math.round(event.event.x - drag.startX)));
          resize.update({ ...drag.initial, [drag.left.key]: drag.left.width + delta, [drag.right.key]: drag.right.width - delta });
        } else return false;
      }
      event.stopPropagation();
      return true;
    },
  };
}

function focusedProjectionIndex(projections: readonly ProjectedListRow[], props: AtlasTestDashboardProps): number {
  if (props.focusProjectionKey) {
    const index = projections.findIndex((row) => row.kind !== "cluster" && row.key === props.focusProjectionKey);
    if (index >= 0) return index;
  }
  if (!props.focusKey) return -1;
  return projections.findIndex((row) => row.kind !== "cluster" && sessionKey(projectionSession(row)) === props.focusKey);
}

function headerControls(props: AtlasTestDashboardProps, layout: Layout, agentText: string): Control[] {
  let x = displayWidth(agentText) + 3;
  const result: Control[] = [];
  const add = (id: string, text: string, run: () => void): boolean => {
    if (x + displayWidth(text) > layout.width - 1) return false;
    result.push({ id, text, x, y: 1, run });
    x += displayWidth(text) + 1;
    return true;
  };
  const filter = props.filter ?? {};
  const favorites = Boolean(filter.favorite ?? filter.favoritesOnly);
  add("atlas-test:favorites", favorites ? "[Favorites: on]" : "[Favorites]", () => favorites ? props.actions?.onRemoveFilter?.("favorite") : props.actions?.onFilter?.({ kind: "favorite", value: true }));
  for (const source of props.analytics.sources) {
    const active = (filter.source ?? filter.harness) === source.source;
    if (!add(`atlas-test:source:${source.source}`, `[${sourceName(source.source)}${active ? " *" : ""}]`, () => active ? props.actions?.onRemoveFilter?.("source") : props.actions?.onFilter?.({ kind: "source", value: source.source }))) break;
  }
  return result;
}

function conversationLine(projection: ConversationProjection, layout: Layout, focused: boolean, props: AtlasTestDashboardProps): string {
  const row = projectionSession(projection);
  const selected = props.selectedKeys?.has(sessionKey(row)) ?? false;
  const favorite = projection.kind === "chain" ? projection.aggregate.favoriteCount > 0 : row.favorite > 0;
  const group = projection.kind === "chain" ? `${projection.expanded ? "v" : ">"} ${projection.aggregate.memberCount} conv.` : projection.nested ? "  member" : "";
  const groupInTopic = !layout.columns.some((column) => column.key === "group") && projection.kind === "chain"
    ? `${projection.expanded ? "v" : ">"} ${projection.aggregate.memberCount} conv. | ` : projection.kind === "session" && projection.nested ? "  " : "";
  const activity = projection.kind === "chain" ? projection.aggregate.lastActivity : row.last_activity;
  return columnLine(layout, {
    markers: `${focused ? ">" : " "}${selected ? "+" : " "}${favorite ? "*" : " "}`,
    group,
    topic: groupInTopic + clean(row.title || row.firstUser || "Topic unavailable"),
    project: projectName(row),
    source: sourceName(row.harness),
    active: activityLabel(activity, props.now ?? Date.now()),
  });
}

function conversationZone(projection: ConversationProjection, layout: Layout, y: number, props: AtlasTestDashboardProps): InteractionZone {
  const row = projectionSession(projection);
  const key = sessionKey(row);
  return {
    id: `atlas-test:row:${projection.key}`,
    rect: { x: 0, y, width: layout.listWidth, height: 1 },
    focusable: true,
    onEvent: (event) => {
      const actions = props.actions;
      if (event.event.type === "key") {
        if (event.event.key === "enter") { actions?.onOpenSession?.(key); return true; }
        if (event.event.key === " ") { actions?.onPeekSession?.(key); return true; }
        return false;
      }
      if (event.event.type !== "mouse" || event.event.action !== "press" || event.event.button !== "left") return false;
      const x = event.localX ?? event.event.x;
      const column = layout.columns.find((entry) => x >= entry.x && x < entry.x + entry.width);
      if (column?.key === "markers" && x === column.x + 2) actions?.onToggleFavorite?.(key);
      else if (column?.key === "project" && (row.project || row.cwd)) actions?.onFilter?.({ kind: "path", value: row.project || row.cwd! });
      else if (column?.key === "source") actions?.onFilter?.({ kind: "source", value: row.harness });
      else if (projection.kind === "chain" && (column?.key === "group" || column?.key === "topic" && !layout.columns.some((entry) => entry.key === "group") && x < column.x + 2)) actions?.onToggleChain?.(projection.chainId);
      else actions?.onOpenSession?.(key, { extendSelection: Boolean(event.event.shift) });
      event.stopPropagation();
      return true;
    },
  };
}

function previewLines(projection: ConversationProjection | undefined, preview: AtlasTestPreview | null | undefined, width: number, height: number): Array<{ text: string; label?: boolean }> {
  if (!width) return [];
  if (!projection && !preview) return [{ text: "Focus a conversation to preview it." }];
  const row = projection ? projectionSession(projection) : null;
  const lines: Array<{ text: string; label?: boolean }> = [];
  const add = (label: string, value: string | null | undefined, maximum: number): void => {
    if (!value) return;
    lines.push({ text: label, label: true });
    const wrapped = wrapDisplayText(clean(value), width);
    for (const text of wrapped.slice(0, maximum)) lines.push({ text });
    if (wrapped.length > maximum) lines.push({ text: "… Open the conversation for the rest." });
    if (height >= 12) lines.push({ text: "" });
  };
  const title = preview?.sourceTitle || row?.title;
  add(preview?.sourceTitle ? "SOURCE TITLE" : "EXISTING TOPIC", title, height < 12 ? 1 : 4);
  if (preview?.summary) add(preview.summaryLabel || "STORED SUMMARY", preview.summary, Math.max(1, height - lines.length - (height < 12 ? 1 : 6)));
  else if (row?.firstUser && clean(row.firstUser) !== clean(title ?? "")) add("FIRST USER MESSAGE", row.firstUser, Math.max(1, height - lines.length - (height < 12 ? 1 : 6)));
  else lines.push({ text: "No expanded summary available." }, { text: "" });
  if (row) {
    add("PROJECT", row.project || row.cwd || "No project recorded", 2);
    lines.push({ text: `Source: ${sourceName(row.harness)}` });
  }
  if (projection?.kind === "chain") lines.push({ text: `Group: ${projection.aggregate.memberCount} conversations` });
  return lines.slice(0, height);
}

function columnLine(layout: Layout, values: Record<Column["key"], string>): string {
  return fixed(layout.columns.map((column) => fixed(column.key === "project" ? preserveTail(values[column.key], column.width) : values[column.key], column.width)).join(" "), layout.listWidth);
}

function preserveTail(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  const segments = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value), (entry) => entry.segment);
  let tail = "";
  for (let index = segments.length - 1; index >= 0; index--) {
    const next = segments[index]! + tail;
    if (displayWidth(next) > width - 1) break;
    tail = next;
  }
  return `…${tail}`;
}

function sourceName(source: string): string {
  const names: Record<string, string> = { claude: "Claude Code", codex: "Codex", kilo: "Kilo Code", kimi: "Kimi CLI", prime: "Prime", zcode: "ZCode", hermes: "Hermes" };
  return names[source.toLowerCase()] ?? source;
}

function projectName(row: SessionRow): string {
  const path = clean(row.project || row.cwd || "—").replace(/[\\/]+$/u, "");
  return path.split(/[\\/]/u).at(-1) || path || "/";
}

function activityLabel(timestamp: number | null, now: number): string {
  if (timestamp === null) return "Unknown";
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "Now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`;
  if (elapsed < 7 * 86_400_000) {
    const days = Math.floor(elapsed / 86_400_000);
    return `${days} ${days === 1 ? "day" : "days"} ago`;
  }
  return new Date(timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(new Date(timestamp).getFullYear() !== new Date(now).getFullYear() ? { year: "2-digit" as const } : {}) });
}

function freshnessLabel(props: AtlasTestDashboardProps): string {
  const known = props.analytics.sources.map((source) => source.ageMs).filter((age): age is number => age !== null);
  if (!known.length) return "Update time unknown";
  const latest = Math.min(...known);
  const age = activityLabel((props.now ?? Date.now()) - latest, props.now ?? Date.now()).toLowerCase();
  const incomplete = known.length < props.analytics.sources.length;
  return `Latest source update: ${age}${incomplete ? " (partial)" : ""}`;
}

function filterChips(filter: ListFilter): Array<{ kind: FilterTerm["kind"]; label: string }> {
  return dashboardFilterChips(filter).map((chip) => {
    if (chip.kind === "source") return { ...chip, label: `Source: ${sourceName(filter.source ?? filter.harness ?? "")}` };
    if (chip.kind === "path") return { ...chip, label: `Project: ${clean(filter.path ?? "").split(/[\\/]/u).at(-1) || filter.path}` };
    if (chip.kind === "query") return { ...chip, label: `Search: ${filter.query}` };
    if (chip.kind === "favorite") return { ...chip, label: "Favorites" };
    if (chip.kind === "origin") return { ...chip, label: `Classification: ${filter.origin}` };
    return { ...chip, label: chip.label.replace(/^state:/u, "State: ").replace(/^model:/u, "Model: ").replace(/^chain:/u, "Group: ") };
  });
}

function activation(run: () => void): NonNullable<InteractionZone["onEvent"]> {
  return (event) => {
    if (!(event.event.type === "mouse" && event.event.action === "press" && event.event.button === "left")
      && !(event.event.type === "key" && event.event.key === "enter")) return false;
    run();
    event.stopPropagation();
    return true;
  };
}

function clean(value: string): string {
  // Stored source text is data, never terminal control sequences or extra rows.
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function fixed(value: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateDisplayText(value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").replace(/[\x00-\x1f\x7f-\x9f]/gu, " "), width);
  return clipped + " ".repeat(Math.max(0, width - displayWidth(clipped)));
}

function justify(left: string, right: string, width: number): string {
  if (displayWidth(right) + 3 >= width) return fixed(left, width);
  return fixed(left, width - displayWidth(right) - 1) + " " + right;
}

function colored(text: string, color: string): string { return color ? color + text + RESET : text; }
function formatCount(value: number): string { return value.toLocaleString("en-US"); }
