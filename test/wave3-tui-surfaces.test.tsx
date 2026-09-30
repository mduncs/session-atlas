import { expect, test } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import type { ChatTurn } from "../src/chat.js";
import type { Tier2ViewState } from "../src/tier2.js";
import { projectListRows, type SessionRow } from "../src/tui/domain.js";
import { dashboardColumnBoundaries, dashboardListInteractionZones, dashboardListViewport, dashboardRowLayout, resizeDashboardColumnPair } from "../src/tui/list-view.js";
import { dashboardRailInteractionZones, dashboardSurfaceLayout, UltraDenseDashboard } from "../src/tui/dashboard.js";
import { InteractionRegistry } from "../src/tui/interaction.js";
import { chatLayoutModel, ChatView } from "../src/tui/chat-view.js";
import { blockIndexForOrdinal } from "../src/tui/transcript-layout.js";
import { projectTranscript, projectedTranscriptIndexForOrdinal, sessionLayoutModel, SessionView, yankActiveMessagePayload, yankProsePayload, type SessionFacts, type TranscriptRow } from "../src/tui/session-view.js";
import { tagLayoutModel, TagView } from "../src/tui/tag-view.js";
import type { DashboardAnalytics } from "../src/tui/analytics.js";

const NOW = 1_800_000_000_000;
const baseRow: SessionRow = {
  id: 1, harness: "claude", native_id: "one", title: "one", firstUser: null,
  cwd: "/tmp/one", project: "/tmp/one", last_activity: NOW - 1_000,
  duration_ms: 10_000, tok_user: 10, tok_assistant: 20, tok_tool: 0, tok_total: 30,
  msg_count: 2, models: '["claude-opus-4-6"]', chain_id: null, favorite: 0,
  sizePct: 0.5, engagement: 0.3, origin: "human",
};
const analytics: DashboardAnalytics = {
  corpusSessionCount: 2, visibleSessionCount: 2, hasEverIngested: true,
  sources: [{ label: "claude", source: "claude", count: 2, ageMs: 1_000, reachable: true }],
  origins: [{ label: "human", count: 1 }, { label: "agent", count: 1 }, { label: "mixed", count: 0 }, { label: "unknown", count: 0 }],
  states: { summarized: 1, pending: 1, orphaned: 0, favorite: 0 },
  tags: [{ label: "atlas", count: 2 }], models: [{ label: "claude-opus-4-6", count: 2 }],
  sizes: [], ingest: { sessionsPerSecond: null, hourlySessions: [] },
  summarizer: { queue: 1, completedLastHour: 0, ratePerMinute: 0, failures: 0, provider: null },
  errorCount: 0, events: [],
};

test("dashboard column boundaries resize adjacent cells and preserve total width", () => {
  const layout = dashboardRowLayout(120, false);
  const boundary = dashboardColumnBoundaries(layout).find((item) => item.left === "topic" && item.right === "path")!;
  const resized = resizeDashboardColumnPair(layout, boundary, 6);
  expect(resized.topic).toBe(layout.topic + 6);
  expect(resized.path).toBe(layout.path - 6);
  expect(resized.topic + resized.path).toBe(layout.topic + layout.path);
  const clamped = resizeDashboardColumnPair(layout, boundary, 10_000);
  expect(clamped.path).toBe(4);
});

test("dashboard list obeys the line budget and keeps the live pill at the viewport edge", () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ ...baseRow, id: index + 1, native_id: `n${index}`, title: `row ${index}`, last_activity: NOW - 40 * 86_400_000 - index * 1_000 }));
  const projections = projectListRows(rows, new Set(), NOW);
  const viewport = dashboardListViewport(projections, 8, 4);
  expect(viewport.projections.length).toBe(5);
  expect(viewport.livePillRow).toBe(7);
  const actions: string[] = [];
  const zones = dashboardListInteractionZones({ width: 100, height: 8, projections, pendingLiveCount: 4, actions: { onApplyLive: () => actions.push("live") } });
  const live = zones.find((zone) => zone.id === "dashboard:live-apply")!;
  expect(live.rect.y).toBe(7);
  const registry = new InteractionRegistry();
  zones.forEach((zone) => registry.register(zone));
  registry.dispatchPointer({ type: "mouse", x: live.rect.x, y: live.rect.y, action: "press" });
  expect(actions).toEqual(["live"]);
});

test("dashboard publishes distinct source/model, creator, date, favorite, state and tag controls", () => {
  const projections = projectListRows([baseRow], new Set(), NOW);
  const list = dashboardListInteractionZones({ width: 100, projections, actions: {} });
  expect(list.some((zone) => zone.id.endsWith(":source"))).toBe(true);
  expect(list.some((zone) => zone.id.endsWith(":model"))).toBe(true);
  expect(list.some((zone) => zone.id.startsWith("dashboard:cluster:"))).toBe(true);
  const surface = dashboardSurfaceLayout(160, 24, false, false);
  const rails = dashboardRailInteractionZones({ layout: surface, analytics, actions: {} });
  expect(rails.map((zone) => zone.id)).toEqual(expect.arrayContaining([
    "dashboard:rail:source:claude", "dashboard:rail:state:pending", "dashboard:rail:favorites", "dashboard:rail:origin:human", "dashboard:rail:origin:agent", "dashboard:rail:tag:atlas", "dashboard:rail:model:claude-opus-4-6",
  ]));
  const favorite = rails.find((zone) => zone.id === "dashboard:rail:favorites")!;
  const allOrigin = rails.find((zone) => zone.id === "dashboard:rail:origin:all")!;
  const human = rails.find((zone) => zone.id === "dashboard:rail:origin:human")!;
  const agent = rails.find((zone) => zone.id === "dashboard:rail:origin:agent")!;
  const lastOrigin = rails.filter((zone) => zone.id.startsWith("dashboard:rail:origin:")).at(-1)!;
  const tag = rails.find((zone) => zone.id === "dashboard:rail:tag:atlas")!;
  expect(allOrigin.rect.y).toBe(favorite.rect.y + 3);
  expect(human.rect.y).toBe(allOrigin.rect.y + 1);
  expect(agent.rect.y).toBe(human.rect.y + 1);
  expect(tag.rect.y).toBe(lastOrigin.rect.y + 3);
  const frame = renderToString(<UltraDenseDashboard width={160} height={12} projections={projections} analytics={analytics} pendingLiveCount={2} now={NOW} />, { columns: 160, rows: 12 });
  expect(frame.split("\n").length).toBeLessThanOrEqual(12);
  expect(frame).toContain("2 new ▲ Enter");
  expect(renderToString(<UltraDenseDashboard width={100} height={24} projections={projections} analytics={analytics} now={NOW} />, { columns: 100, rows: 24 })).toContain("H/CL");
});

const facts: SessionFacts = { id: 7, harness: "claude", nativeId: "n7", title: "work", path: "/tmp/work", models: ["opus", "sonnet"], tags: ["one", "two"], chainMembers: 1, durationMs: 60_000, tokens: { user: 1, assistant: 2, tool: 3 } };
const transcript: TranscriptRow[] = [
  { ordinal: 2, role: "user", text: "alpha", toolText: null, hasTool: false },
  { ordinal: 5, role: "tool", text: null, toolText: "tool", hasTool: true },
  { ordinal: 8, role: "assistant", text: "omega", toolText: null, hasTool: false },
];
const summary: Tier2ViewState = { sessionId: 7, status: "ready", result: { body: "summary", anchors: [{ topic: "A", fromOrdinal: 2, toOrdinal: 8 }] }, provider: "cache", model: "opus" };

test("session uses projected ordinal landing, highlights spans, publishes exact fact zones and yank payloads", () => {
  const prose = [transcript[0]!, transcript[2]!];
  expect(projectedTranscriptIndexForOrdinal(prose, 5, "earlier")).toBe(0);
  expect(projectedTranscriptIndexForOrdinal(prose, 5, "later")).toBe(1);
  const props = { facts, summary, transcript, mode: "prose" as const, roleToggle: "all" as const, landingOrdinal: 5, landingBias: "later" as const, spanRange: { fromOrdinal: 2, toOrdinal: 8 }, aboutOpen: true, width: 100, height: 24 };
  const model = sessionLayoutModel(props);
  expect(model.projected.map((row) => row.ordinal)).toEqual([2, 8]);
  expect(model.transcript.blocks[blockIndexForOrdinal(model.transcript, 5, "later")]?.row.ordinal).toBe(8);
  const frame = renderToString(<SessionView {...props} />, { columns: 100, rows: 24 });
  expect(frame.split("\n").length).toBeLessThanOrEqual(24);
  expect(frame).toContain("omega");
  expect(model.zones.some((zone) => zone.id.includes(":anchor:"))).toBe(true);
  for (const zone of model.zones) {
    const line = frame.split("\n")[zone.rect.y] ?? "";
    if (zone.id.includes(":anchor:")) expect(line).toContain("2-8");
    if (zone.id.includes(":model:")) expect(line).toContain(facts.models[Number(zone.id.split(":").at(-1))]!);
    if (zone.id.endsWith(":path")) expect(line).toContain(facts.path!);
    if (zone.id.includes(":tag:")) expect(line).toContain(facts.tags[Number(zone.id.split(":").at(-1))]!);
  }
  const shortFrame = renderToString(<SessionView {...props} height={12} />, { columns: 100, rows: 12 });
  expect(shortFrame.split("\n").length).toBeLessThanOrEqual(12);
  expect(yankActiveMessagePayload(transcript, 8)).toBe("omega");
  expect(yankProsePayload(transcript)).toBe("user: alpha\n\nassistant: omega");
});

test("dialogue is a direct exchange, modes differ, and wrapping is visible state", () => {
  const mixed: TranscriptRow[] = [
    { ordinal: 1, role: "system", text: "machine preamble", toolText: null, hasTool: false },
    { ordinal: 2, role: "user", text: "human question", toolText: null, hasTool: false },
    { ordinal: 3, role: "assistant", text: "direct answer", toolText: "large tool result", hasTool: true },
    { ordinal: 4, role: "tool", text: null, toolText: "raw output", hasTool: true },
  ];
  expect(projectTranscript(mixed, "dialogue", "all").map((row) => row.ordinal)).toEqual([2, 3]);
  expect(projectTranscript(mixed, "dialogue", "all").map((row) => row.display).join(" ")).not.toContain("tool");
  expect(projectTranscript(mixed, "full", "all").find((row) => row.ordinal === 3)?.display).toContain("large tool result");
  expect(projectTranscript(mixed, "stubs", "all").find((row) => row.ordinal === 3)?.display).toContain("tool activity");
  const frame = renderToString(<SessionView facts={facts} summary={summary} transcript={mixed} mode="dialogue" wrap roleToggle="all" onToggleWrap={() => {}} width={100} height={24} />, { columns: 100, rows: 24 });
  expect(frame).toContain(" dialogue ");
  expect(frame).toContain(" no wrap ");
  expect(frame).toContain("human question");
  const unwrapped = renderToString(<SessionView facts={facts} summary={summary} transcript={mixed} mode="dialogue" wrap={false} roleToggle="all" onToggleWrap={() => {}} width={100} height={24} />, { columns: 100, rows: 24 });
  expect(unwrapped).toContain(" wrap ");
  expect(unwrapped).not.toContain(" no wrap ");
  expect(frame).not.toContain("machine preamble");
});

test("chat is finite, input disablement is logical, and every wrapped citation occurrence owns an exact zone", () => {
  const turns: ChatTurn[] = [{ role: "assistant", text: `${"word ".repeat(12)}[7:8] middle ${"more ".repeat(10)}[7:8] and [9]`, citations: [{ sessionId: 7, ordinal: 8 }, { sessionId: 9, ordinal: null }] }];
  const props = { width: 60, height: 12, input: "", status: "ready" as const, turns };
  const model = chatLayoutModel(props);
  expect(model.occurrences).toHaveLength(3);
  expect(new Set(model.occurrences.map((item) => item.id)).size).toBe(3);
  const frame = renderToString(<ChatView {...props} />, { columns: 60, rows: 12 });
  expect(frame.split("\n").length).toBeLessThanOrEqual(12);
  for (const occurrence of model.occurrences) expect(frame.split("\n")[occurrence.y]?.slice(occurrence.x, occurrence.x + occurrence.width)).toBe(`[${occurrence.citation.sessionId}${occurrence.citation.ordinal == null ? "" : `:${occurrence.citation.ordinal}`}]`);
  expect(chatLayoutModel({ ...props, status: "provider-down", inputDisabled: true }).inputEnabled).toBe(false);
});

test("tag surface clips both panes, publishes all synthesis citations, and never advertises inert resynthesis", () => {
  const sessions = Array.from({ length: 20 }, (_, index) => ({ id: index, harness: "claude", nativeId: `n${index}`, topic: `topic ${index}`, lastActivity: NOW, model: "opus", favorite: false }));
  const synthesis = { status: "ready" as const, result: { tag: "atlas", body: `[1:2] and [2:3] ${"arc ".repeat(20)}`, sessionIds: [1, 2], citations: [{ sessionId: 1, ordinal: 2 }, { sessionId: 2, ordinal: 3 }], provider: "zai", model: "glm", generatedAt: NOW }, description: "arc", provider: "zai" };
  const props = { tag: "atlas", sessions, synthesis, width: 80, height: 12, focus: 10 };
  const model = tagLayoutModel(props);
  expect(model.visibleSessions.length).toBeLessThan(sessions.length);
  expect(model.citations).toHaveLength(2);
  const frame = renderToString(<TagView {...props} />, { columns: 80, rows: 12 });
  expect(frame.split("\n").length).toBeLessThanOrEqual(12);
  for (const citation of model.citations) expect(frame.split("\n")[citation.y]?.slice(citation.x, citation.x + citation.width)).toBe(`[${citation.citation.sessionId}:${citation.citation.ordinal}]`);
  expect(frame).not.toContain("r resynthesize");
  expect(renderToString(<TagView {...props} onResynthesize={() => {}} />, { columns: 80, rows: 12 })).toContain("r resynthesize");
});
