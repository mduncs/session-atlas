import type { ToolActivityDto } from "../contracts/construction.js";
import { kindLabel, type ReaderDisplayRow } from "./reader.js";
import type { TranscriptMode } from "./store.js";

/**
 * The reader's layout: every message becomes display lines that already fit
 * the reading measure, so the renderer paints lines and never asks Ink to
 * wrap. Structure in the text survives: paragraphs, headings, lists with a
 * hanging indent, quotes, and code. Tool records and harness injections fold
 * to one line; md's messages and the assistant's read as a conversation.
 */
export type TranscriptLineKind =
  | "header" | "prose" | "heading" | "code" | "quote" | "list" | "fold" | "tool" | "note" | "blank" | "episode";

export interface TranscriptLine {
  kind: TranscriptLineKind;
  /** Plain text, fitted to the layout width. */
  text: string;
  /** Index of the owning block, or -1 for separators (blank or episode divider) between blocks. */
  block: number;
  /** Header lines: dim text shown after the label. */
  meta?: string;
  /** Fold lines: the id Enter or a click toggles. */
  fold?: string;
  open?: boolean;
}

export interface TranscriptBlock {
  row: ReaderDisplayRow;
  /** First line of the block (its header or fold line). */
  start: number;
  /** One past the last line of the block, excluding the separator. */
  end: number;
  folds: readonly string[];
}

export interface TranscriptLayout {
  lines: readonly TranscriptLine[];
  blocks: readonly TranscriptBlock[];
  width: number;
}

export interface TranscriptLayoutOptions {
  width: number;
  wrap: boolean;
  mode: TranscriptMode;
  /** Fold ids whose state is flipped from the mode's default. */
  toggled?: ReadonlySet<string>;
  modelLabel?: string | null;
  /** Episode starts in logical-ordinal order; a divider precedes each one's first block. */
  episodes?: readonly TranscriptEpisode[];
}

export interface TranscriptEpisode {
  ordinal: number;
  index: number;
  title: string;
}

/** Same-speaker messages closer than this share one header. */
const CONTINUATION_MS = 5 * 60_000;
/** Agent relays longer than this fold behind their first lines. */
const AGENT_PREVIEW_LINES = 3;
/** An expanded tool shows at most this many lines; `y` copies the whole record. */
const TOOL_EXPANDED_LINES = 400;

export function layoutTranscript(rows: readonly ReaderDisplayRow[], options: TranscriptLayoutOptions): TranscriptLayout {
  const width = Math.max(8, Math.floor(options.width));
  const toggled = options.toggled ?? EMPTY;
  const lines: TranscriptLine[] = [];
  const blocks: TranscriptBlock[] = [];
  let previousDay: string | null = null;
  const episodes = options.episodes ?? [];
  let nextEpisode = 0;
  rows.forEach((row, index) => {
    if (index > 0) lines.push({ kind: "blank", text: "", block: -1 });
    let divided = false;
    while (nextEpisode < episodes.length && episodes[nextEpisode]!.ordinal <= row.ordinal) {
      const episode = episodes[nextEpisode++]!;
      // Several episodes can land on one message; only the last one names it.
      if (nextEpisode < episodes.length && episodes[nextEpisode]!.ordinal <= row.ordinal) continue;
      lines.push({ kind: "episode", text: episodeRule(episode, width), block: -1 });
      divided = true;
    }
    const start = lines.length;
    const folds: string[] = [];
    const push = (line: Omit<TranscriptLine, "block">): void => { lines.push({ ...line, block: index }); };
    const open = (id: string, byDefault: boolean): boolean => {
      folds.push(id);
      return toggled.has(id) ? !byDefault : byDefault;
    };
    const stamp = timeLabel(row.eventTs ?? null, previousDay);
    if (stamp.day) previousDay = stamp.day;

    if (row.author === "harness") {
      const id = `${row.ordinal}`;
      const expanded = open(id, false);
      const body = structuredLines(row.display, width - 2, options.wrap);
      push({ kind: "fold", text: fitText(`${expanded ? "-" : "+"} ${harnessChip(row)} . ${plural(countLines(row.display), "line")}`, width), fold: id, open: expanded, meta: stamp.text });
      if (expanded) for (const line of body) push({ ...line, kind: line.kind === "blank" ? "blank" : "note", text: `  ${line.text}` });
    } else {
      const body = row.display ? structuredLines(row.display, width, options.wrap) : [];
      // A run of messages from one speaker reads as one voice: repeat the
      // header only when the speaker changes, time jumps, or tools ran.
      const previous = rows[index - 1];
      const tools = options.mode === "dialogue" || options.mode === "prose" ? row.toolActivities.length : 0;
      const continued = previous !== undefined && !divided && body.length > 0 && tools === 0
        && previous.role === row.role && previous.author === row.author && previous.recordKind === row.recordKind
        && row.eventTs != null && previous.eventTs != null && row.eventTs - previous.eventTs < CONTINUATION_MS;
      if (!continued) push({ kind: "header", ...headerFor(row, options, stamp.text) });
      if (row.author === "agent" && body.length > AGENT_PREVIEW_LINES + 1) {
        const id = `${row.ordinal}`;
        const expanded = open(id, false);
        for (const line of expanded ? body : body.slice(0, AGENT_PREVIEW_LINES)) push(line);
        push({ kind: "fold", text: fitText(expanded ? "- fold" : `+ ${plural(body.length - AGENT_PREVIEW_LINES, "more line")}`, width), fold: id, open: expanded });
      } else for (const line of body) push(line);
      if (options.mode === "stubs" || options.mode === "full") {
        for (const tool of row.toolActivities) {
          const id = `${row.ordinal}:${tool.activityOrdinal}`;
          const expanded = open(id, options.mode === "full");
          push({ kind: "fold", text: fitText(`${expanded ? "-" : "+"} ${toolSummary(tool)}`, width), fold: id, open: expanded });
          if (expanded) {
            const text = (tool.toolText ?? "").replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
            const source = text.split("\n");
            for (const raw of source.slice(0, TOOL_EXPANDED_LINES)) {
              for (const piece of options.wrap ? splitByDisplayWidth(raw, width - 2) : [clipText(raw, width - 2)]) push({ kind: "tool", text: `  ${piece}` });
            }
            if (source.length > TOOL_EXPANDED_LINES) push({ kind: "note", text: fitText(`  ... ${plural(source.length - TOOL_EXPANDED_LINES, "more line")} . y copies the record`, width) });
          }
        }
      }
    }
    blocks.push({ row, start, end: lines.length, folds });
  });
  return { lines, blocks, width };
}

const EMPTY: ReadonlySet<string> = new Set();

/** `-- 3 . Wrigley building massing -----`, filled to the measure. */
function episodeRule(episode: TranscriptEpisode, width: number): string {
  const head = fitText(`-- ${episode.index} . ${episode.title.replace(/\s+/g, " ").trim()} `, Math.max(8, width - 2));
  return `${head}${"-".repeat(Math.max(2, width - displayWidth(head)))}`;
}

function headerFor(row: ReaderDisplayRow, options: TranscriptLayoutOptions, time: string): { text: string; meta: string } {
  const tools = options.mode === "dialogue" || options.mode === "prose" ? row.toolActivities.length : 0;
  const toolNote = tools > 0 ? `${time ? " . " : ""}${plural(tools, "tool")}` : "";
  if (row.role === "user") return { text: row.author === "agent" ? "agent ->" : "you", meta: `${time}${toolNote}` };
  if (row.role === "assistant") return { text: options.modelLabel || "assistant", meta: `${time}${toolNote}` };
  return { text: kindLabel(row.recordKind), meta: time };
}

function harnessChip(row: ReaderDisplayRow): string {
  const rule = row.authorRule ?? "harness";
  if (rule === "harness:envelope") {
    const tag = /^\s*<([A-Za-z][\w-]*)/.exec(row.display)?.[1];
    if (tag) return `[${tag.replace(/[_-]+/g, " ").toLowerCase()}]`;
  }
  return `[${HARNESS_LABELS[rule] ?? rule.replace(/^harness:/, "").replace(/-/g, " ")}]`;
}

const HARNESS_LABELS: Record<string, string> = {
  "harness:agents-md": "AGENTS.md",
  "harness:skill-body": "skill loaded",
  "harness:hook": "hook output",
  "harness:tool-loaded": "tools loaded",
  "harness:caveat": "harness caveat",
  "harness:compaction": "compaction summary",
  "harness:inherited-history": "inherited history",
  "harness:resume": "resumed session",
  "harness:command-output": "command output",
  "harness:command-expansion": "command expansion",
  "harness:loop": "loop prompt",
  "harness:agents-stopped": "agents stopped",
  "harness:empty": "empty message",
};

/** "bash . bun test ... . 40 lines" */
export function toolSummary(tool: ToolActivityDto): string {
  const text = (tool.toolText ?? "").trim();
  const first = text.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  const name = tool.toolName?.trim() || tool.activityKind;
  const count = text ? countLines(text) : 0;
  return [name, first && clipText(first, 60) + (first.length > 60 ? "..." : ""), count > 1 ? plural(count, "line") : ""].filter(Boolean).join(" . ");
}

interface BodyLine { kind: Exclude<TranscriptLineKind, "header" | "fold">; text: string }

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const LIST = /^(\s*)([-*+\u2022]|\d{1,3}[.)])\s+(.*)$/;
const TABLE = /^\s*\|.*\|\s*$/;
/** A line that is only **bold** text reads as a heading. */
const STRONG_LINE = /^\s*\*\*([^*]+?)\*\*:?\s*$/;
/** Paired markdown emphasis markers, dropped for display. */
const STRONG = /\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g;

/** Lay out message text, keeping the structure its author typed. */
export function structuredLines(text: string, width: number, wrap: boolean): BodyLine[] {
  const safe = Math.max(4, Math.floor(width));
  const out: BodyLine[] = [];
  let fence = false;
  let previousBlank = true;
  const emit = (kind: BodyLine["kind"], first: string, rest: string, body: string): void => {
    if (!wrap) { out.push({ kind, text: clipText(first + body, safe) }); return; }
    const pieces = wrapDisplayText(body, Math.max(1, safe - displayWidth(first)));
    pieces.forEach((piece, index) => out.push({ kind, text: `${index === 0 ? first : rest}${piece}` }));
  };
  for (const raw of text.split("\n")) {
    if (FENCE.test(raw)) {
      fence = !fence;
      out.push({ kind: "code", text: clipText(raw.trimEnd(), safe) });
      previousBlank = false;
      continue;
    }
    if (fence) {
      for (const piece of wrap ? splitByDisplayWidth(raw, safe) : [clipText(raw, safe)]) out.push({ kind: "code", text: piece });
      continue;
    }
    if (!raw.trim()) {
      if (!previousBlank) out.push({ kind: "blank", text: "" });
      previousBlank = true;
      continue;
    }
    const strong = STRONG_LINE.exec(raw);
    const heading = HEADING.exec(raw) ?? (strong ? [raw, "", strong[1]!] as unknown as RegExpExecArray : null);
    const list = heading ? null : LIST.exec(raw);
    const quote = heading || list ? null : QUOTE.exec(raw);
    if (heading) emit("heading", "", "", unmark(heading[2]!.trim()));
    else if (list) {
      const marker = `${list[1]!.slice(0, 8)}${list[2]!.replace("\u2022", "-")} `;
      emit("list", marker, " ".repeat(displayWidth(marker)), unmark(list[3]!));
    } else if (quote) emit("quote", "| ", "| ", unmark(quote[1]!));
    else if (TABLE.test(raw)) out.push({ kind: "code", text: clipText(raw.trimEnd(), safe) });
    else if (previousBlank && /^ {4,}\S/.test(raw) || out.at(-1)?.kind === "code" && /^ {4,}\S/.test(raw)) {
      for (const piece of wrap ? splitByDisplayWidth(raw, safe) : [clipText(raw, safe)]) out.push({ kind: "code", text: piece });
    } else {
      const indent = /^ */.exec(raw)![0].slice(0, 12);
      emit("prose", indent, indent, unmark(raw.trim()));
    }
    previousBlank = false;
  }
  while (out.at(-1)?.kind === "blank") out.pop();
  return out;
}

export interface TranscriptViewport {
  lines: readonly TranscriptLine[];
  /** Resolved absolute line offset after clamping. */
  offset: number;
  /** Block indexes that have at least one visible line. */
  firstBlock: number;
  lastBlock: number;
  maxOffset: number;
}

export function transcriptViewport(layout: TranscriptLayout, offset: number, rows: number): TranscriptViewport {
  const budget = Math.max(1, Math.floor(rows));
  const maxOffset = Math.max(0, layout.lines.length - budget);
  const start = Math.max(0, Math.min(maxOffset, Math.floor(offset)));
  const lines = layout.lines.slice(start, start + budget);
  const firstBlock = blockAtLine(layout, start);
  const lastBlock = blockAtLine(layout, Math.max(start, start + lines.length - 1));
  return { lines, offset: start, firstBlock, lastBlock, maxOffset };
}

/** Block owning `line`; a separator belongs to the block after it. */
export function blockAtLine(layout: TranscriptLayout, line: number): number {
  const { blocks } = layout;
  if (blocks.length === 0) return -1;
  let probe = line;
  while (layout.lines[probe]?.block === -1) probe++;
  let low = 0;
  let high = blocks.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (blocks[mid]!.start <= probe) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Offset that shows block `index`: unchanged when it is already fully in
 * view, otherwise its header one line below the top (the header of a block
 * taller than the viewport goes to the top).
 */
export function offsetToReveal(layout: TranscriptLayout, index: number, offset: number, rows: number): number {
  const block = layout.blocks[index];
  if (!block) return offset;
  const budget = Math.max(1, rows);
  if (block.start >= offset && block.end <= offset + budget) return offset;
  if (block.end - block.start >= budget || block.start < offset) return Math.max(0, block.start - (block.start > 0 ? 1 : 0));
  return Math.max(0, block.end - budget);
}

export function blockIndexForOrdinal(layout: TranscriptLayout, ordinal: number, bias: "earlier" | "later" | "nearest" = "nearest"): number {
  const rows = layout.blocks.map((block) => block.row);
  return projectedIndex(rows, ordinal, bias);
}

function projectedIndex(rows: readonly { ordinal: number }[], ordinal: number, bias: "earlier" | "later" | "nearest"): number {
  if (rows.length === 0) return -1;
  const exact = rows.findIndex((row) => row.ordinal === ordinal);
  if (exact >= 0) return exact;
  const later = rows.findIndex((row) => row.ordinal > ordinal);
  const earlier = later < 0 ? rows.length - 1 : Math.max(0, later - 1);
  if (bias === "later") return later >= 0 ? later : rows.length - 1;
  if (bias === "earlier") return earlier;
  if (later < 0) return rows.length - 1;
  return ordinal - rows[earlier]!.ordinal <= rows[later]!.ordinal - ordinal ? earlier : later;
}

function timeLabel(ts: number | null, previousDay: string | null): { text: string; day: string | null } {
  if (ts === null || !Number.isFinite(ts)) return { text: "", day: null };
  const date = new Date(ts);
  const day = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return { text: day === previousDay ? clock : `${MONTHS[date.getMonth()]} ${date.getDate()}  ${clock}`, day };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function unmark(text: string): string { return text.includes("**") ? text.replace(STRONG, "$1") : text; }
function countLines(text: string): number { return text ? text.split("\n").length : 0; }
function plural(count: number, noun: string): string { return `${count} ${noun}${count === 1 ? "" : "s"}`; }
function fitText(value: string, width: number): string { return clipText(value, width); }

/** Hard cut to a display width. */
export function clipText(value: string, width: number): string {
  const safe = Math.max(0, Math.floor(width));
  if (displayWidth(value) <= safe) return value;
  return takeDisplayWidth(value, safe);
}

export function wrapDisplayText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const words = value.replace(/\s+/gu, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      const chunks = splitByDisplayWidth(word, safeWidth);
      if (chunks.length === 1) line = chunks[0]!;
      else {
        lines.push(...chunks.slice(0, -1));
        line = chunks.at(-1)!;
      }
      continue;
    }
    const candidate = `${line} ${word}`;
    if (displayWidth(candidate) <= safeWidth) {
      line = candidate;
      continue;
    }
    lines.push(line);
    const chunks = splitByDisplayWidth(word, safeWidth);
    lines.push(...chunks.slice(0, -1));
    line = chunks.at(-1)!;
  }
  if (line || lines.length === 0) lines.push(line);
  return lines;
}

export function truncateDisplayText(value: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  if (displayWidth(value) <= safeWidth) return value;
  if (safeWidth === 1) return "…";
  return `${takeDisplayWidth(value, safeWidth - 1)}…`;
}

export function fitDisplayText(value: string, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));
  const clipped = truncateDisplayText(value, safeWidth || 1);
  const remaining = safeWidth - displayWidth(clipped);
  return remaining > 0 ? `${clipped}${" ".repeat(remaining)}` : clipped;
}

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function displayWidth(value: string): number {
  return Bun.stringWidth(value);
}

export function splitByDisplayWidth(value: string, width: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const { segment } of SEGMENTER.segment(value)) {
    if (chunk && displayWidth(chunk + segment) > width) {
      chunks.push(chunk);
      chunk = "";
    }
    if (!chunk && displayWidth(segment) > width) {
      // An individual grapheme wider than a one-cell emergency viewport is
      // represented rather than dropped. Ink clips the one exceptional cell.
      chunks.push(segment);
      continue;
    }
    chunk += segment;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

function takeDisplayWidth(value: string, width: number): string {
  let out = "";
  for (const { segment } of SEGMENTER.segment(value)) {
    if (displayWidth(out + segment) > width) break;
    out += segment;
  }
  return out;
}
