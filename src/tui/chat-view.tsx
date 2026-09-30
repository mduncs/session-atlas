import React from "react";
import { Box, Text } from "ink";
import type { ChatTurn, Citation } from "../chat.js";
import type { InteractionZone } from "./interaction.js";

export type ChatSurfaceStatus = "idle" | "running" | "ready" | "grounding-failed" | "provider-down" | "error";

export interface ChatViewProps {
  width: number;
  height?: number;
  input: string;
  status: ChatSurfaceStatus;
  turns: readonly ChatTurn[];
  provider?: string | null;
  model?: string | null;
  reason?: string | null;
  inputDisabled?: boolean;
  scrollTop?: number;
  focusedCitation?: number | null;
  onCitationActivate?: (sessionId: number, ordinal: number | null) => void;
  onInteractionZones?: (zones: readonly InteractionZone[]) => void;
}

export interface CitationOccurrence {
  id: string;
  turnIndex: number;
  occurrence: number;
  citation: Citation;
  valid: boolean;
  x: number;
  y: number;
  width: number;
}

interface ChatRenderLine {
  key: string;
  label?: string;
  text: string;
  citations: Array<{ start: number; width: number; citation: Citation; valid: boolean; occurrence: number }>;
  tone?: "normal" | "muted" | "error" | "status";
}

export interface ChatLayoutModel {
  width: number;
  height: number;
  bodyHeight: number;
  contentWidth: number;
  lines: readonly ChatRenderLine[];
  visibleLines: readonly ChatRenderLine[];
  occurrences: readonly CitationOccurrence[];
  zones: readonly InteractionZone[];
  grounded: boolean;
  inputEnabled: boolean;
}

export function chatInputEnabled(props: Pick<ChatViewProps, "status" | "inputDisabled">): boolean {
  return props.inputDisabled !== true && props.status !== "provider-down" && props.status !== "error";
}

export function chatLayoutModel(props: ChatViewProps): ChatLayoutModel {
  const width = Math.max(40, Math.floor(props.width));
  const height = Math.max(10, Math.floor(props.height ?? 24));
  const bodyHeight = Math.max(3, height - 7);
  const contentWidth = Math.max(8, width - 4);
  const lines: ChatRenderLine[] = [];
  let globalOccurrence = 0;
  props.turns.forEach((turn, turnIndex) => {
    lines.push({ key: `${turnIndex}:label`, label: turn.role === "user" ? "QUERY" : "ANSWER", text: "", citations: [], tone: "muted" });
    const wrapped = citedLines(turn.text, turn.citations, turn.invalidCitations ?? [], contentWidth, globalOccurrence);
    globalOccurrence += wrapped.reduce((sum, line) => sum + line.citations.length, 0);
    wrapped.forEach((line, lineIndex) => lines.push({ ...line, key: `${turnIndex}:text:${lineIndex}` }));
    if (turn.role === "assistant" && turn.citations.length === 0) lines.push({ key: `${turnIndex}:uncited`, text: "grounding degraded · no validated citation", citations: [], tone: "error" });
    if ((turn.invalidCitations?.length ?? 0) > 0) lines.push({ key: `${turnIndex}:invalid`, text: `rejected invented citation(s): ${turn.invalidCitations!.map(formatCitation).join(" ")}`, citations: [], tone: "error" });
  });
  if (props.turns.length === 0) lines.push({ key: "empty", text: "Ask across the archive. Answers cite retrieved sessions and spans.", citations: [], tone: "muted" });
  if (props.status === "running") lines.push({ key: "running", text: "retrieving · bounded round loop ▰▱▱▱", citations: [], tone: "status" });
  const maxTop = Math.max(0, lines.length - Math.max(1, bodyHeight - 2));
  const scrollTop = Math.min(maxTop, Math.max(0, props.scrollTop ?? maxTop));
  const visibleLines = lines.slice(scrollTop, scrollTop + Math.max(1, bodyHeight - 2));
  const occurrences: CitationOccurrence[] = [];
  visibleLines.forEach((line, lineIndex) => line.citations.forEach((citation) => {
    const turnIndex = Number(line.key.split(":")[0]);
    occurrences.push({
      id: citationZoneId(citation.citation, citation.occurrence),
      turnIndex,
      occurrence: citation.occurrence,
      citation: citation.citation,
      valid: citation.valid,
      x: 2 + citation.start,
      y: 4 + lineIndex,
      width: citation.width,
    });
  }));
  const zones = occurrences.map((occurrence): InteractionZone => ({
    id: occurrence.id,
    rect: { x: occurrence.x, y: occurrence.y, width: occurrence.width, height: 1 },
    focusable: occurrence.valid,
    onEvent: occurrence.valid ? activation(() => props.onCitationActivate?.(occurrence.citation.sessionId, occurrence.citation.ordinal)) : undefined,
  }));
  const assistantTurns = props.turns.filter((turn) => turn.role === "assistant");
  const grounded = assistantTurns.every((turn) => turn.citations.length > 0 && (turn.invalidCitations?.length ?? 0) === 0);
  return { width, height, bodyHeight, contentWidth, lines, visibleLines, occurrences, zones, grounded, inputEnabled: chatInputEnabled(props) };
}

export function ChatView(props: ChatViewProps): React.JSX.Element {
  const layout = React.useMemo(() => chatLayoutModel(props), [props]);
  React.useLayoutEffect(() => { props.onInteractionZones?.(layout.zones); }, [layout.zones, props.onInteractionZones]);
  const degradedReady = (props.status === "ready" && !layout.grounded) || props.status === "grounding-failed";
  const shownStatus = degradedReady ? "DEGRADED" : props.status.toUpperCase();
  const doctorLine = props.status === "provider-down" ? `all providers failing — see atlas doctor${props.reason ? ` · ${props.reason}` : ""}`
    : props.status === "grounding-failed" ? `grounding failed — evidence kept, answer not trusted${props.reason ? ` · ${props.reason}` : ""}` : null;
  return <Box flexDirection="column" width={layout.width} height={layout.height} overflow="hidden">
    <Box height={3} borderStyle="single" borderColor="#ff9800" paddingX={1} justifyContent="space-between">
      <Text bold color="#ff9800">ATLAS · GROUNDED CHAT</Text>
      <Text color={props.status === "running" ? "yellow" : degradedReady ? "red" : "#888888"}>{shownStatus} · {props.provider ?? "—"}{props.model ? `/${props.model}` : ""}</Text>
    </Box>
    <Box height={layout.bodyHeight} overflow="hidden" flexDirection="column" borderStyle="single" borderColor="#4d4d4d" paddingX={1}>
      {layout.visibleLines.map((line) => <ChatLine key={line.key} line={line} focusedCitation={props.focusedCitation ?? null} />)}
    </Box>
    <Box height={3} borderStyle="single" borderColor={layout.inputEnabled ? "#ff9800" : "#555555"} paddingX={1}>
      <Text color={layout.inputEnabled ? "#ff9800" : "#777777"}>{layout.inputEnabled ? ">" : "×"} </Text>
      <Text dimColor={!layout.inputEnabled}>{doctorLine ?? (props.input || (layout.inputEnabled ? "Ask about your session history…" : "input disabled"))}</Text>
    </Box>
    <Box height={1} paddingX={1} justifyContent="space-between" overflow="hidden"><Text color="#777777" wrap="truncate-end">fts_search · get_summary · read_span≤40 · max 4 rounds</Text><Text color="#ff9800">click [n] opens · Esc back</Text></Box>
  </Box>;
}

function ChatLine({ line, focusedCitation }: { line: ChatRenderLine; focusedCitation: number | null }): React.JSX.Element {
  if (line.label) return <Text bold color={line.label === "QUERY" ? "#ff9800" : "#b8b8b8"}>{line.label}</Text>;
  const segments = segmentCitations(line.text, line.citations.filter((item) => item.valid).map((item) => item.citation), line.citations.filter((item) => !item.valid).map((item) => item.citation));
  let seen = -1;
  return <Text color={line.tone === "error" ? "red" : line.tone === "status" ? "yellow" : line.tone === "muted" ? "#777777" : undefined}>
    {segments.map((segment, index) => {
      if (!segment.citation) return <Text key={index}>{segment.text}</Text>;
      seen += 1;
      const occurrence = line.citations[seen];
      return <Text key={index} inverse={occurrence?.occurrence === focusedCitation} bold color={segment.valid ? "cyan" : "red"}>{segment.text}</Text>;
    })}
  </Text>;
}

function citedLines(text: string, valid: readonly Citation[], invalid: readonly Citation[], width: number, startOccurrence: number): ChatRenderLine[] {
  const rawLines = hardWrap(text, width);
  let occurrence = startOccurrence;
  return rawLines.map((line, index) => {
    const citations: ChatRenderLine["citations"] = [];
    for (const match of line.matchAll(/\[(\d+)(?::(\d+))?\]/g)) {
      const citation = { sessionId: Number(match[1]), ordinal: match[2] ? Number(match[2]) : null };
      const isValid = valid.some((item) => sameCitation(item, citation)) && !invalid.some((item) => sameCitation(item, citation));
      citations.push({ start: Bun.stringWidth(line.slice(0, match.index)), width: Bun.stringWidth(match[0]), citation, valid: isValid, occurrence: occurrence++ });
    }
    return { key: `wrapped:${index}`, text: line, citations };
  });
}

function hardWrap(value: string, width: number): string[] {
  const out: string[] = [];
  for (const sourceLine of value.split("\n")) {
    if (!sourceLine) { out.push(""); continue; }
    let current = "";
    const tokens = sourceLine.match(/\[\d+(?::\d+)?\]|./gu) ?? [];
    for (const token of tokens) {
      if (current && Bun.stringWidth(current + token) > width) { out.push(current); current = ""; }
      if (Bun.stringWidth(token) <= width) current += token;
      else for (const char of token) {
        if (current && Bun.stringWidth(current + char) > width) { out.push(current); current = ""; }
        current += char;
      }
    }
    out.push(current);
  }
  return out.length ? out : [""];
}

function activation(run: () => void): NonNullable<InteractionZone["onEvent"]> { return (event) => { const active = event.event.type === "mouse" && event.event.action === "press" || event.event.type === "key" && event.event.key === "enter"; if (!active) return false; run(); return true; }; }

export interface CitationSegment { text: string; citation: Citation | null; valid: boolean }
export function segmentCitations(text: string, validCitations: readonly Citation[], invalidCitations: readonly Citation[] = []): CitationSegment[] {
  const re = /\[(\d+)(?::(\d+))?\]/g;
  const segments: CitationSegment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) segments.push({ text: text.slice(cursor, match.index), citation: null, valid: false });
    const citation = { sessionId: Number(match[1]), ordinal: match[2] ? Number(match[2]) : null };
    const valid = validCitations.some((item) => sameCitation(item, citation));
    const explicitlyInvalid = invalidCitations.some((item) => sameCitation(item, citation));
    segments.push({ text: match[0], citation, valid: valid && !explicitlyInvalid });
    cursor = re.lastIndex;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), citation: null, valid: false });
  return segments.length ? segments : [{ text, citation: null, valid: false }];
}

export function activateCitation(citation: Citation, callback?: (sessionId: number, ordinal: number | null) => void): void { callback?.(citation.sessionId, citation.ordinal); }
export function citationZoneId(citation: Citation, occurrence: number): string { return `chat:citation:${citation.sessionId}:${citation.ordinal ?? "session"}:${occurrence}`; }
function sameCitation(left: Citation, right: Citation): boolean { return left.sessionId === right.sessionId && left.ordinal === right.ordinal; }
function formatCitation(citation: Citation): string { return `[${citation.sessionId}${citation.ordinal === null ? "" : `:${citation.ordinal}`}]`; }
