import { expect, test } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { render } from "ink-testing-library";
import type { DashboardAnalytics } from "../src/tui/analytics.js";
import { dashboardSurfaceLayout } from "../src/tui/dashboard.js";
import { FlatDashboard, contextLine, flatRowLayout } from "../src/tui/flat-dashboard.js";
import { projectListRows, sessionKey, type SessionRow } from "../src/tui/domain.js";
import { InteractionRegistry, type InteractionZone } from "../src/tui/interaction.js";

const NOW = 1_800_000_000_000;
const row: SessionRow = {
  id: 1,
  harness: "claude",
  native_id: "unicode-session",
  title: "星の観測 🛰️ Unicode title",
  firstUser: null,
  cwd: "/Users/tester/code/session-atlas",
  project: "/Users/tester/code/session-atlas",
  last_activity: NOW - 60_000,
  duration_ms: 600_000,
  tok_user: 2_000,
  tok_assistant: 4_000,
  tok_tool: 100,
  tok_total: 6_100,
  msg_count: 12,
  models: '["claude-opus-4-6"]',
  chain_id: null,
  favorite: 1,
  sizePct: 0.5,
  engagement: 0.4,
};

const analytics: DashboardAnalytics = {
  corpusSessionCount: 1,
  visibleSessionCount: 1,
  hasEverIngested: true,
  sources: [{ label: "claude", source: "claude", count: 1, ageMs: 60_000, reachable: true }],
  origins: [{ label: "human", count: 1 }, { label: "agent", count: 0 }],
  states: { summarized: 1, pending: 0, orphaned: 0, favorite: 1 },
  tags: [{ label: "astronomy", count: 1 }],
  models: [{ label: "opus-4-6", count: 1 }],
  sizes: [
    { key: "lt8k", label: "<8k", count: 1 },
    { key: "8k-32k", label: "8–32k", count: 0 },
    { key: "32k-96k", label: "32–96k", count: 0 },
    { key: "96k+", label: "96k+", count: 0 },
  ],
  ingest: { sessionsPerSecond: 1, hourlySessions: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  summarizer: { queue: 0, completedLastHour: 1, ratePerMinute: 1 / 60, failures: 0, provider: null },
  errorCount: 0,
  events: [{ id: "ingest:1", at: NOW, kind: "ingest", label: "ingest claude +1" }],
};

const projections = projectListRows([row], new Set(), NOW);

for (const width of [160, 120, 100, 80, 60] as const) {
  test(`flat dashboard owns a bounded ${width}x24 frame`, () => {
    const frame = renderToString(
      <FlatDashboard width={width} height={24} projections={projections} analytics={analytics}
        focusKey={sessionKey(row)} selectedKeys={new Set([sessionKey(row)])} now={NOW} />,
      { columns: width, rows: 24 },
    );
    expect(frame).toContain("ATLAS");
    expect(frame).toContain("星の観測");
    expect(frame.split("\n")).toHaveLength(24);
    expect(Math.max(...frame.split("\n").map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(width);
  });
}

test("flat dashboard paints single-cell chrome as SGR spans", () => {
  const frame = renderToString(
    <FlatDashboard width={160} height={24} projections={projections} analytics={analytics}
      focusKey={sessionKey(row)} selectedKeys={new Set([sessionKey(row)])} now={NOW} />,
    { columns: 160, rows: 24 },
  );
  expect(frame).toContain("星の観測 🛰️");
  // Color lives in 256-color SGR spans; nothing else may reach the terminal.
  const escapes = frame.match(/\x1b\[[0-9;]*[A-Za-z]/g) ?? [];
  for (const escape of escapes) expect(escape).toMatch(/^\x1b\[[0-9;]*m$/);
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  // Atlas-owned chrome is restricted to glyphs every terminal draws in one cell.
  const chrome = new Set([..."│─━█▏▎▍▌▋▊▉▁▂▃▄▅▆▇●○◌★◆✕▸▾└›⌃↔·…"]);
  const title = new Set([..."星の観測 🛰️ Unicode title", "–"]); // fixture data, including "8–32k"
  for (const glyph of new Set([...plain])) {
    if (glyph.charCodeAt(0) < 0x80 || title.has(glyph)) continue;
    expect(`${glyph} ${chrome.has(glyph)}`).toBe(`${glyph} true`);
    expect(Bun.stringWidth(glyph)).toBe(1);
  }
});

test("flat dashboard publishes row, search, and column-resize hit zones", async () => {
  let zones: readonly InteractionZone[] = [];
  const opened: string[] = [];
  const favorites: string[] = [];
  const filters: string[] = [];
  const view = render(
    <FlatDashboard width={100} height={24} projections={projections} analytics={analytics} now={NOW}
      actions={{
        onOpenSession: (key) => opened.push(key),
        onToggleFavorite: (key) => favorites.push(key),
        onFilter: (term) => filters.push(`${term.kind}:${"value" in term ? term.value : "complex"}`),
        onSearch: () => {},
      }}
      onInteractionZones={(next) => { zones = next; }} />,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rowZone = zones.find((zone) => zone.id === `dashboard:row:${sessionKey(row)}`)!;
  expect(rowZone).toBeDefined();
  expect(zones.some((zone) => zone.id === "dashboard:search")).toBe(true);
  expect(zones.some((zone) => zone.id === "dashboard:column-resize")).toBe(true);

  const registry = new InteractionRegistry();
  for (const zone of zones) registry.register(zone);
  const surface = dashboardSurfaceLayout(100, 24, false, false);
  const layout = flatRowLayout(surface.centerWidth, surface.tier === "essential" || surface.tier === "minimum");
  const favoriteX = layout.focus + layout.gap;
  const topicX = favoriteX + layout.favorite + layout.gap;
  const pathX = topicX + layout.topic + layout.gap;
  const sourceX = pathX + layout.path + layout.gap;
  const click = (localX: number) => registry.dispatchPointer({
    type: "mouse", action: "press", button: "left", x: rowZone.rect.x + localX, y: rowZone.rect.y,
  });
  // Only the link cells (path, model name) filter. Hidden regions are gone:
  // the favorite cell, the source code, and the topic all open the row.
  click(favoriteX);
  click(pathX);
  click(sourceX);
  click(sourceX + 3);
  click(topicX + Math.min(4, Math.max(0, layout.topic - 1)));
  expect(favorites).toEqual([]);
  expect(filters).toEqual(["path:/Users/tester/code/session-atlas", "model:claude-opus-4-6"]);
  expect(opened).toEqual([sessionKey(row), sessionKey(row), sessionKey(row)]);
  view.unmount();
});

test("relevance order that revisits a month drops date headers; chronological lists keep them", () => {
  const at = (iso: string) => new Date(iso).getTime();
  const interleaved = projectListRows([
    { ...row, id: 11, native_id: "jan-first", title: "January first", last_activity: at("2026-01-20T12:00:00Z") },
    { ...row, id: 12, native_id: "feb", title: "February", last_activity: at("2026-02-20T12:00:00Z") },
    { ...row, id: 13, native_id: "jan-second", title: "January second", last_activity: at("2026-01-10T12:00:00Z") },
    { ...row, id: 14, native_id: "dec", title: "December", last_activity: at("2025-12-20T12:00:00Z") },
  ], new Set(), NOW);
  expect(interleaved.map((projection) => projection.kind)).toEqual(["session", "session", "session", "session"]);
  const ordered = projectListRows([
    { ...row, id: 21, native_id: "feb", title: "February", last_activity: at("2026-02-20T12:00:00Z") },
    { ...row, id: 22, native_id: "jan", title: "January", last_activity: at("2026-01-20T12:00:00Z") },
    { ...row, id: 23, native_id: "jan-2", title: "January again", last_activity: at("2026-01-10T12:00:00Z") },
  ], new Set(), NOW);
  expect(ordered.filter((projection) => projection.kind === "cluster").map((projection) => projection.key)).toEqual([
    "cluster:month:2026-02",
    "cluster:month:2026-01",
  ]);
});

test("hovering a row publishes its key and scrolling clears it", async () => {
  let zones: readonly InteractionZone[] = [];
  const hovers: (string | null)[] = [];
  const view = render(
    <FlatDashboard width={100} height={24} projections={projections} analytics={analytics} now={NOW}
      actions={{ onOpenSession: () => {}, onHoverSession: (key) => hovers.push(key) }}
      onInteractionZones={(next) => { zones = next; }} />,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const rowZone = zones.find((zone) => zone.id === `dashboard:row:${sessionKey(row)}`)!;
  const registry = new InteractionRegistry();
  for (const zone of zones) registry.register(zone);
  registry.updateHover(rowZone.rect.x + 2, rowZone.rect.y);
  registry.dispatchPointer({ type: "mouse", action: "scroll", button: "wheel-down", x: rowZone.rect.x + 2, y: rowZone.rect.y });
  registry.updateHover(0, 0);
  expect(hovers).toEqual([sessionKey(row), null, null]);
  view.unmount();
});

test("the context line previews the hovered title, a clipped focused title, or the event log", () => {
  const long = { ...row, native_id: "long-title", title: `line one\n\tline two ${"é".repeat(300)}` };
  const rows = projectListRows([row, long], new Set(), NOW);
  const surface = dashboardSurfaceLayout(160, 24, false, false);
  const layout = flatRowLayout(surface.centerWidth, false);
  const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
  const base = { projections: rows, analytics, hoverKey: null, focusKey: null };

  const hovered = plain(contextLine({ ...base, hoverKey: sessionKey(row) }, 160, layout));
  expect(hovered).toContain("TITLE");
  expect(hovered).toContain("Unicode title");
  expect(hovered).toContain("ingest claude +1");

  const focusedLong = plain(contextLine({ ...base, focusKey: sessionKey(long) }, 160, layout));
  expect(focusedLong).toContain("line one line two");
  expect(focusedLong).toContain("...");
  expect(focusedLong).not.toMatch(/[\n\t]/);
  expect(Bun.stringWidth(focusedLong)).toBeLessThanOrEqual(160);

  // A focused title that already fits its column adds nothing; the log stays.
  const focusedShort = plain(contextLine({ ...base, focusKey: sessionKey(row) }, 160, layout));
  expect(focusedShort).not.toContain("TITLE");
  expect(plain(contextLine(base, 160, layout))).not.toContain("TITLE");
});
