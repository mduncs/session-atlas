import { expect, test } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { render } from "ink-testing-library";
import type { DashboardAnalytics } from "../src/tui/analytics.js";
import { AtlasTestDashboard, atlasTestDashboardLineBudget, renderAtlasTestDashboardFrame, type AtlasTestDashboardProps } from "../src/tui/atlas-test-dashboard.js";
import { projectListRows, sessionKey, type SessionRow } from "../src/tui/domain.js";
import { InteractionRegistry, type InteractionZone } from "../src/tui/interaction.js";

const NOW = new Date("2026-09-10T21:00:00Z").getTime();
const row: SessionRow = {
  id: 1, harness: "claude", native_id: "human-led-coding", title: "Fix tmux resume restoration 星の観測 🛰️",
  firstUser: "Investigate why resume fails for paths containing spaces.",
  cwd: "/Users/tester/code/session-atlas", project: "/Users/tester/code/session-atlas", last_activity: NOW - 60_000,
  duration_ms: 600_000, tok_user: 2_000, tok_assistant: 4_000, tok_tool: 100, tok_total: 6_100,
  msg_count: 12, models: '["claude-opus-4-6"]', chain_id: null, favorite: 1, sizePct: 0.5, engagement: 0.4,
  origin: "human", effective_origin: "agent",
};
const analytics: DashboardAnalytics = {
  corpusSessionCount: 7898, visibleSessionCount: 5000, hasEverIngested: true,
  sources: [{ label: "claude", source: "claude", count: 4000, ageMs: 60_000, reachable: true }, { label: "codex", source: "codex", count: 1000, ageMs: null, reachable: null }],
  origins: [{ label: "human", count: 24 }, { label: "agent", count: 4976 }],
  states: { summarized: 2700, pending: 2300, orphaned: 10, favorite: 1 }, tags: [], models: [], sizes: [],
  ingest: { sessionsPerSecond: null, hourlySessions: [] },
  summarizer: { queue: 2300, completedLastHour: 0, ratePerMinute: 0, failures: 2, provider: null },
  errorCount: 4, events: [{ id: "event:1", at: NOW, kind: "error", label: "Internal processing event" }],
};
function props(overrides: Partial<AtlasTestDashboardProps> = {}): AtlasTestDashboardProps {
  return { width: 120, height: 24, projections: projectListRows([row], new Set(), NOW), analytics, now: NOW,
    focusKey: sessionKey(row), showAgentConversations: false, onToggleAgentConversations: () => {}, ...overrides };
}
function plain(text: string): string { return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, ""); }

for (const width of [20, 40, 60, 80, 120, 160, 240]) {
  test(`comparison frame stays within ${width}x24 including Unicode source text`, () => {
    const frame = renderToString(<AtlasTestDashboard {...props({ width })} />, { columns: width, rows: 24 });
    expect(frame.split("\n")).toHaveLength(24);
    expect(Math.max(...frame.split("\n").map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(width);
    expect(frame).toContain("ATLAS TEST");
    if (width >= 80) expect(frame).toContain("Sort: last active");
  });
}

test("comparison uses readable labels, truthful counts and no operational rails", () => {
  const frame = plain(renderAtlasTestDashboardFrame(props()));
  expect(frame).toContain("Agent conversations: hidden");
  expect(frame).toContain("1 display rows shown | 5,000 matching conversations");
  expect(frame).toContain("Sort: last active");
  expect(frame).toContain("Claude Code");
  expect(frame).toContain("session-atlas");
  expect(frame).toContain("Archive status (4 issues)");
  expect(frame).toContain("Latest source update: 1 min ago (partial)");
  expect(frame).not.toContain("Internal processing event");
  expect(frame).not.toContain("SUMMARIZER");
  expect(frame).not.toContain("CREATOR");
  // The renderer must not apply the unrelated effective_origin classifier.
  expect(frame).toContain("Fix tmux resume");
});

test("expanded group head and disclosure glyph do not create extra focused rows", () => {
  const rows = [{ ...row, chain_id: 9 }, { ...row, id: 2, native_id: "second", chain_id: 9, title: "> Another conversation" }];
  const projections = projectListRows(rows, new Set([9]), NOW);
  const frame = renderAtlasTestDashboardFrame(props({ width: 240, projections, focusProjectionKey: sessionKey(row) }));
  expect(frame.match(/\x1b\[48;5;24m/gu)).toHaveLength(1);
  const highlighted = frame.split("\n").filter((line) => line.includes("\x1b[48;5;24m"))[0]!;
  expect(plain(highlighted)).toContain("member");
  // The preview is separated after resetting the list's focus background.
  expect(highlighted).toContain("\x1b[49m\x1b[38;5;81m | ");
  expect(plain(frame)).toContain("2 conv.");
  expect(plain(frame)).toContain("3 display rows shown");
});

test("wide preview labels saved text honestly and retains the source title separately", () => {
  const frame = plain(renderAtlasTestDashboardFrame(props({ width: 240,
    preview: { sourceTitle: "Original title from the transcript", summary: "Existing saved summary; no new processing ran.", summaryLabel: "Saved summary (coverage unverified)" },
  })));
  expect(frame).toContain("SOURCE TITLE");
  expect(frame).toContain("Original title from the transcript");
  expect(frame).toContain("Saved summary (coverage unverified)");
  expect(frame).toContain("Existing saved summary; no new processing ran.");
  expect(frame).toContain("Fix tmux resume restoration");
});

test("narrow Space preview consumes an exact fixed budget without the old status dashboard", () => {
  const base = props({ width: 100, height: 24, filter: { source: "claude" }, pendingLiveCount: 2,
    peek: { key: sessionKey(row), title: row.title!, lines: ["OLD PEEK TEXT MUST NOT APPEAR"] },
    preview: { sourceTitle: "Original source title", summary: "Investigated quoting. A fix was proposed, not verified.", summaryLabel: "Saved summary" },
  });
  const budget = atlasTestDashboardLineBudget(100, 24, base.filter, 2, true);
  expect(budget).toBeLessThan(atlasTestDashboardLineBudget(100, 24, base.filter, 2, false));
  const manyRows = projectListRows(Array.from({ length: 40 }, (_, index) => ({ ...row, id: index + 1, native_id: `row-${index}`, title: `Conversation ${index}` })), new Set(), NOW);
  const frame = plain(renderAtlasTestDashboardFrame({ ...base, projections: manyRows, focusKey: sessionKey({ ...row, native_id: "row-0" }), peek: null }));
  expect(frame.split("\n")).toHaveLength(24);
  const peekFrame = plain(renderAtlasTestDashboardFrame({ ...base, projections: manyRows }));
  expect(peekFrame).toContain("CONVERSATION PREVIEW | Esc close");
  expect(peekFrame).toContain("Investigated quoting. A fix was proposed, not verified.");
  expect(peekFrame).not.toContain("OLD PEEK TEXT");
  expect(peekFrame).toContain("2 new conversations - apply");
  expect(peekFrame.match(/Conversation \d+/gu)).toHaveLength(budget - 1); // One month/day heading also consumes a row.
  expect(Math.max(...peekFrame.split("\n").map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(100);
});

test("comparison publishes working toggle, row, group, source, project, favorite, date and status actions", async () => {
  let zones: readonly InteractionZone[] = [];
  const calls: string[] = [];
  const chainRow = { ...row, chain_id: 9 };
  const view = render(<AtlasTestDashboard {...props({ width: 240,
    projections: projectListRows([chainRow, { ...chainRow, id: 2, native_id: "child" }], new Set(), NOW),
    onToggleAgentConversations: () => calls.push("agents"),
    onInteractionZones: (next) => { zones = next; },
    actions: {
      onOpenSession: (key) => calls.push(`open:${key}`), onPeekSession: (key) => calls.push(`peek:${key}`),
      onToggleFavorite: (key) => calls.push(`favorite:${key}`), onToggleChain: (id) => calls.push(`group:${id}`),
      onFilter: (term) => calls.push(`filter:${term.kind}`), onSearch: () => calls.push("search"),
      onProcessing: () => calls.push("status"),
    },
  })} />);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const registry = new InteractionRegistry();
  for (const zone of zones) registry.register(zone);
  const clickZone = (id: string, localX = 0): void => {
    const zone = zones.find((candidate) => candidate.id === id)!;
    expect(zone).toBeDefined();
    registry.dispatchPointer({ type: "mouse", action: "press", button: "left", x: zone.rect.x + localX, y: zone.rect.y });
  };
  for (const id of ["atlas-test:agent-toggle", "atlas-test:search", "atlas-test:archive-status", "atlas-test:favorites", "atlas-test:source:claude"]) clickZone(id);
  const cluster = zones.find((zone) => zone.id.startsWith("atlas-test:cluster:"))!;
  clickZone(cluster.id);
  const rowZone = zones.find((zone) => zone.id.startsWith("atlas-test:row:"))!;
  const plainFrame = plain(renderAtlasTestDashboardFrame(props({ width: 240 })));
  const header = plainFrame.split("\n").find((line) => line.includes("LAST ACTIVE"))!;
  clickZone(rowZone.id, 2);
  clickZone(rowZone.id, header.indexOf("GROUP"));
  clickZone(rowZone.id, header.indexOf("CONVERSATION"));
  clickZone(rowZone.id, header.indexOf("PROJECT"));
  clickZone(rowZone.id, header.indexOf("SOURCE"));
  expect(calls).toEqual(["agents", "search", "status", "filter:favorite", "filter:source", "filter:date",
    `favorite:${sessionKey(row)}`, "group:9", `open:${sessionKey(row)}`, "filter:path", "filter:source"]);
  expect(zones.every((zone) => zone.rect.x + zone.rect.width <= 240 && zone.rect.y + zone.rect.height <= 24)).toBe(true);
  view.unmount();
});

test("unknown freshness is not reported as never ingested or a complete archive", () => {
  const frame = plain(renderAtlasTestDashboardFrame(props({ analytics: { ...analytics, sources: analytics.sources.map((source) => ({ ...source, ageMs: null })) } })));
  expect(frame).toContain("Update time unknown");
  expect(frame).not.toContain("never");
});

test("dragging adjacent column edges moves rendered cells and hit targets, clamps minima, and resets on resize", async () => {
  let zones: readonly InteractionZone[] = [];
  const calls: string[] = [];
  const registry = new InteractionRegistry();
  const base = props({ width: 120, actions: {
    onOpenSession: () => calls.push("open"), onFilter: (term) => calls.push(term.kind),
  }, onInteractionZones: (next) => {
    zones = next;
    registry.reset();
    for (const zone of next) registry.register(zone);
  } });
  const view = render(<AtlasTestDashboard {...base} />);
  Object.defineProperty(view.stdout, "columns", { value: 240 });
  view.rerender(<AtlasTestDashboard {...base} />);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const heading = (): string => plain(view.lastFrame()!).split("\n").find((line) => line.includes("LAST ACTIVE"))!;
  const originalProjectX = heading().indexOf("PROJECT");
  const resizeZone = zones.find((zone) => zone.id === "atlas-test:column-resize")!;
  expect(resizeZone).toBeDefined();
  const pointer = (action: "press" | "move" | "release", x: number, y = resizeZone.rect.y): void => {
    registry.dispatchPointer({ type: "mouse", action, button: "left", x, y });
  };
  pointer("press", originalProjectX - 1);
  pointer("move", originalProjectX + 7);
  await new Promise((resolve) => setTimeout(resolve, 0));
  pointer("release", originalProjectX + 7);
  expect(heading().indexOf("PROJECT")).toBe(originalProjectX + 8);
  const rowZone = zones.find((zone) => zone.id.startsWith("atlas-test:row:"))!;
  pointer("press", originalProjectX + 1, rowZone.rect.y);
  pointer("press", originalProjectX + 8, rowZone.rect.y);
  expect(calls).toEqual(["open", "path"]);

  // Over-dragging cannot consume the project column or move later columns.
  const sourceX = heading().indexOf("SOURCE");
  pointer("press", originalProjectX + 7);
  pointer("move", 119);
  await new Promise((resolve) => setTimeout(resolve, 0));
  pointer("release", 119);
  expect(heading().indexOf("SOURCE")).toBe(sourceX);
  expect(heading().indexOf("SOURCE") - heading().indexOf("PROJECT")).toBe(9); // Eight cells plus the gap.
  expect(Math.max(...plain(view.lastFrame()!).split("\n").map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(120);

  view.rerender(<AtlasTestDashboard {...base} width={130} />);
  await new Promise((resolve) => setTimeout(resolve, 0));
  view.rerender(<AtlasTestDashboard {...base} />);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(heading().indexOf("PROJECT")).toBe(originalProjectX);
  view.unmount();
});
