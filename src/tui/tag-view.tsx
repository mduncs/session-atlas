import React from "react";
import { Box, Text } from "ink";
import type { Citation } from "../chat.js";
import type { TagSynthesisOutcome } from "../tier2.js";
import type { InteractionZone } from "./interaction.js";
import { citationZoneId, segmentCitations } from "./chat-view.js";

export interface TagSessionRow {
  id: number;
  harness: string;
  nativeId: string;
  topic: string | null;
  lastActivity: number | null;
  model: string | null;
  favorite: boolean;
}

export interface TagViewProps {
  tag: string;
  sessions: readonly TagSessionRow[];
  synthesis: TagSynthesisOutcome | { status: "loading" } | { status: "provider-down"; reason: string };
  width: number;
  height?: number;
  focus: number;
  sessionScrollTop?: number;
  synthesisScrollTop?: number;
  focusedCitation?: number | null;
  onSessionActivate?: (sessionId: number, ordinal: number | null) => void;
  onCitationActivate?: (sessionId: number, ordinal: number | null) => void;
  onResynthesize?: () => void;
  onInteractionZones?: (zones: readonly InteractionZone[]) => void;
}

export interface TagCitationOccurrence {
  id: string;
  occurrence: number;
  citation: Citation;
  valid: boolean;
  x: number;
  y: number;
  width: number;
}

export interface TagLayoutModel {
  width: number;
  height: number;
  wide: boolean;
  bodyHeight: number;
  sessionWidth: number;
  synthesisWidth: number;
  synthesisX: number;
  synthesisY: number;
  synthesisHeight: number;
  visibleSessions: readonly TagSessionRow[];
  synthesisLines: readonly string[];
  visibleSynthesisLines: readonly string[];
  citations: readonly TagCitationOccurrence[];
  zones: readonly InteractionZone[];
}

export function tagLayoutModel(props: TagViewProps): TagLayoutModel {
  const width = Math.max(40, Math.floor(props.width));
  const height = Math.max(10, Math.floor(props.height ?? 24));
  const bodyHeight = height - 4;
  const wide = width >= 100;
  const synthesisWidth = wide ? Math.max(34, Math.floor(width * 0.36)) : width;
  const sessionWidth = wide ? width - synthesisWidth : width;
  const sessionHeight = wide ? bodyHeight : Math.max(4, Math.floor(bodyHeight * 0.48));
  const synthesisX = wide ? sessionWidth : 0;
  const synthesisY = wide ? 3 : 3 + sessionHeight;
  const synthesisHeight = wide ? bodyHeight : Math.max(3, bodyHeight - sessionHeight);
  const sessionCapacity = Math.max(1, sessionHeight - 3);
  const sessionStart = Math.max(0, Math.min(props.sessionScrollTop ?? Math.max(0, props.focus - sessionCapacity + 1), Math.max(0, props.sessions.length - sessionCapacity)));
  const visibleSessions = props.sessions.slice(sessionStart, sessionStart + sessionCapacity);
  const normalized = normalizeSynthesis(props.synthesis);
  const synthesisLines = normalized.body ? hardWrap(normalized.body, Math.max(8, synthesisWidth - 4)) : [];
  const synthesisCapacity = Math.max(1, synthesisHeight - 3);
  const synthesisTop = Math.max(0, Math.min(props.synthesisScrollTop ?? 0, Math.max(0, synthesisLines.length - synthesisCapacity)));
  const visibleSynthesisLines = synthesisLines.slice(synthesisTop, synthesisTop + synthesisCapacity);
  const zones: InteractionZone[] = [];
  visibleSessions.forEach((session, index) => zones.push({
    id: tagSessionZoneId(props.tag, session),
    rect: { x: 2, y: 5 + index, width: Math.max(1, sessionWidth - 4), height: 1 },
    focusable: true,
    onEvent: activate(() => props.onSessionActivate?.(session.id, null)),
  }));
  const citations: TagCitationOccurrence[] = [];
  let occurrence = countCitations(synthesisLines.slice(0, synthesisTop));
  visibleSynthesisLines.forEach((line, lineIndex) => {
    for (const match of line.matchAll(/\[(\d+)(?::(\d+))?\]/g)) {
      const citation = { sessionId: Number(match[1]), ordinal: match[2] ? Number(match[2]) : null };
      const valid = normalized.citations.some((item) => item.sessionId === citation.sessionId && item.ordinal === citation.ordinal);
      const item: TagCitationOccurrence = {
        id: `tag:${encodeURIComponent(props.tag)}:${citationZoneId(citation, occurrence)}`,
        occurrence,
        citation,
        valid,
        x: synthesisX + 2 + Bun.stringWidth(line.slice(0, match.index)),
        y: synthesisY + 2 + lineIndex,
        width: Bun.stringWidth(match[0]),
      };
      citations.push(item);
      zones.push({ id: item.id, rect: { x: item.x, y: item.y, width: item.width, height: 1 }, focusable: valid, onEvent: valid ? activate(() => props.onCitationActivate?.(citation.sessionId, citation.ordinal)) : undefined });
      occurrence += 1;
    }
  });
  if (props.onResynthesize) zones.push({ id: `tag:${encodeURIComponent(props.tag)}:resynthesize`, rect: { x: 1, y: height - 1, width: Math.min(16, width - 2), height: 1 }, focusable: true, onEvent: activate(props.onResynthesize) });
  return { width, height, wide, bodyHeight, sessionWidth, synthesisWidth, synthesisX, synthesisY, synthesisHeight, visibleSessions, synthesisLines, visibleSynthesisLines, citations, zones };
}

export function TagView(props: TagViewProps): React.JSX.Element {
  const layout = React.useMemo(() => tagLayoutModel(props), [props]);
  React.useLayoutEffect(() => { props.onInteractionZones?.(layout.zones); }, [layout.zones, props.onInteractionZones]);
  const synthesis = normalizeSynthesis(props.synthesis);
  const synthesisContentRows = Math.max(0, layout.synthesisHeight - 2);
  const remainingAfterBody = synthesisContentRows - 1 - layout.visibleSynthesisLines.length;
  const showReason = Boolean(synthesis.reason) && remainingAfterBody > 0;
  const showModel = Boolean(synthesis.model) && remainingAfterBody - (showReason ? 1 : 0) > 0;
  return <Box flexDirection="column" width={layout.width} height={layout.height} overflow="hidden">
    <Box height={3} borderStyle="single" borderColor="#ff9800" paddingX={1} justifyContent="space-between"><Text bold color="#ff9800">ATLAS · TAG #{props.tag}</Text><Text color="#888888">{props.sessions.length} SESSIONS · LONGITUDINAL</Text></Box>
    <Box height={layout.bodyHeight} overflow="hidden" flexDirection={layout.wide ? "row" : "column"}>
      <Box width={layout.sessionWidth} height={layout.wide ? layout.bodyHeight : layout.synthesisY - 3} overflow="hidden" flexDirection="column" borderStyle="single" borderColor="#4d4d4d" paddingX={1}>
        <Text bold color="#8f8f8f">FILTERED SESSION ORDER</Text>
        {props.sessions.length === 0 ? <Text dimColor>(no sessions currently carry this tag)</Text> : layout.visibleSessions.map((session) => {
          const index = props.sessions.indexOf(session);
          return <Box key={`${session.harness}:${session.nativeId}`}>
            <Text color={index === props.focus ? "#ff9800" : "#555555"}>{index === props.focus ? "▌" : " "}</Text><Text color={session.favorite ? "yellow" : "#555555"}>{session.favorite ? "★" : "·"} </Text><Text color={harnessColor(session.harness)}>{sourceGlyph(session.harness)} </Text><Text bold={index === props.focus} wrap="truncate-end">{session.topic ?? "(unsummarized)"}</Text><Text color="#777777"> · {relativeTime(session.lastActivity)} · {session.model ?? "—"}</Text>
          </Box>;
        })}
      </Box>
      <Box width={layout.synthesisWidth} height={layout.synthesisHeight} overflow="hidden" flexDirection="column" borderStyle="single" borderColor="#4d4d4d" paddingX={1}>
        <Box height={1}><Text bold color="#ff9800">ARC · {synthesis.label}</Text></Box>
        {layout.visibleSynthesisLines.map((line, index) => <Box height={1} key={index}><SynthesisLine line={line} citations={synthesis.citations} focused={props.focusedCitation ?? null} occurrenceBase={countCitations(layout.visibleSynthesisLines.slice(0, index))} /></Box>)}
        {showReason ? <Box height={1}><Text color={synthesis.degraded ? "yellow" : "#777777"}>{synthesis.reason}</Text></Box> : null}
        {showModel ? <Box height={1}><Text dimColor>{synthesis.provider ?? "—"}/{synthesis.model}</Text></Box> : null}
      </Box>
    </Box>
    <Box height={1} paddingX={1} justifyContent="space-between"><Text color="#777777">j/k · Enter · e export{props.onResynthesize ? " · r resynthesize" : ""}</Text><Text color="#ff9800">click opens · Esc back</Text></Box>
  </Box>;
}

function SynthesisLine({ line, citations, focused, occurrenceBase }: { line: string; citations: Citation[]; focused: number | null; occurrenceBase: number }): React.JSX.Element {
  const segments = segmentCitations(line, citations);
  let seen = 0;
  return <Text>{segments.map((segment, index) => segment.citation
    ? <Text key={index} inverse={focused === occurrenceBase + seen++} color={segment.valid ? "cyan" : "red"} bold>{segment.text}</Text>
    : <Text key={index}>{segment.text}</Text>)}</Text>;
}

function normalizeSynthesis(synthesis: TagViewProps["synthesis"]): { label: string; body: string | null; citations: Citation[]; model: string | null; provider: string | null; reason: string | null; degraded: boolean } {
  if (synthesis.status === "loading") return { label: "SYNTHESIZING", body: null, citations: [], model: null, provider: null, reason: "summarizing the arc without blocking the list…", degraded: false };
  if (synthesis.status === "provider-down") return { label: "DEGRADED", body: null, citations: [], model: null, provider: null, reason: `all providers failing — see atlas doctor · ${synthesis.reason}`, degraded: true };
  if (synthesis.status === "ready" || synthesis.status === "cached") return { label: synthesis.status === "cached" ? "CACHED" : "SYNTHESIZED", body: synthesis.result.body, citations: synthesis.result.citations, model: synthesis.result.model, provider: synthesis.result.provider, reason: null, degraded: false };
  if ("reason" in synthesis) return { label: synthesis.status.toUpperCase(), body: synthesis.result?.body ?? null, citations: synthesis.result?.citations ?? [], model: synthesis.result?.model ?? null, provider: synthesis.result?.provider ?? null, reason: synthesis.reason, degraded: true };
  return { label: "UNKNOWN", body: null, citations: [], model: null, provider: null, reason: "unknown synthesis state", degraded: true };
}

function hardWrap(value: string, width: number): string[] { const out: string[] = []; for (const source of value.split("\n")) { let current = ""; const tokens = source.match(/\[\d+(?::\d+)?\]|./gu) ?? []; for (const token of tokens) { if (current && Bun.stringWidth(current + token) > width) { out.push(current); current = ""; } if (Bun.stringWidth(token) <= width) current += token; else for (const char of token) { if (current && Bun.stringWidth(current + char) > width) { out.push(current); current = ""; } current += char; } } out.push(current); } return out.length ? out : [""]; }
function countCitations(lines: readonly string[]): number { return lines.reduce((sum, line) => sum + [...line.matchAll(/\[(\d+)(?::(\d+))?\]/g)].length, 0); }
function activate(run: () => void): NonNullable<InteractionZone["onEvent"]> { return (event) => { const active = event.event.type === "mouse" && event.event.action === "press" || event.event.type === "key" && event.event.key === "enter"; if (!active) return false; run(); return true; }; }
export function activateTagCitation(citation: Citation, callback?: (sessionId: number, ordinal: number | null) => void): void { callback?.(citation.sessionId, citation.ordinal); }
export function tagSessionZoneId(tag: string, session: TagSessionRow): string { return `tag:${encodeURIComponent(tag)}:session:${session.harness}:${encodeURIComponent(session.nativeId)}`; }
function sourceGlyph(harness: string): string { return harness === "codex" ? "C" : harness === "kilo" ? "K" : "A"; }
function harnessColor(harness: string): string { return harness === "codex" ? "cyan" : harness === "kilo" ? "#a970ff" : "#ff9800"; }
function relativeTime(timestamp: number | null): string { if (timestamp === null) return "—"; const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000)); return days === 0 ? "today" : days === 1 ? "1d" : days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`; }
