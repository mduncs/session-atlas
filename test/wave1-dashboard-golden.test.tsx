import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { UltraDenseDashboard } from "../src/tui/dashboard.js";
import type { DashboardAnalytics, DashboardRowState } from "../src/tui/analytics.js";
import { projectListRows, sessionKey, type SessionRow } from "../src/tui/domain.js";
import { dashboardListInteractionZones } from "../src/tui/list-view.js";
import { InteractionRegistry } from "../src/tui/interaction.js";

const NOW = 1_800_000_000_000;

function row(input: Partial<SessionRow> & Pick<SessionRow, "id" | "harness" | "native_id" | "title" | "last_activity">): SessionRow {
  return {
    firstUser: null,
    cwd: "/Users/tester/code/session-atlas",
    project: "/Users/tester/code/session-atlas",
    duration_ms: 840_000,
    tok_user: 12_000,
    tok_assistant: 32_000,
    tok_tool: 4_000,
    tok_total: 48_000,
    msg_count: 62,
    models: '["claude-opus-4-6"]',
    chain_id: null,
    favorite: 0,
    sizePct: 0.62,
    engagement: 0.38,
    ...input,
  };
}

const rows = [
  row({ id: 1, harness: "claude", native_id: "cl-1", title: "astronomy: variable stars, Cepheids · harness-clock hook · dinner", last_activity: NOW - 7_200_000, favorite: 1 }),
  row({ id: 2, harness: "codex", native_id: "cx-1", title: "codex rollout parser, dedupe live/archive", last_activity: NOW - 10_800_000, models: '["gpt-5.3-codex"]', chain_id: 9, sizePct: 0.84, engagement: 0.22 }),
  row({ id: 3, harness: "codex", native_id: "cx-2", title: "continuation: keyset restoration under live inserts", last_activity: NOW - 11_000_000, models: '["gpt-5.3-codex"]', chain_id: 9, sizePct: 0.73, engagement: 0.2 }),
  row({ id: 4, harness: "kilo", native_id: "ki-1", title: "kilo WAL read-only, busy timeout", last_activity: NOW - 86_500_000, models: '["glm-air"]', sizePct: 0.28, engagement: 0.08 }),
  row({ id: 5, harness: "claude", native_id: "cl-2", title: "keyset pagination, no OFFSET walks", last_activity: NOW - 2_000_000_000, models: '["claude-sonnet-4-5"]', sizePct: 0.55, engagement: 0.2 }),
];

const analytics: DashboardAnalytics = {
  corpusSessionCount: 5,
  visibleSessionCount: 5,
  hasEverIngested: true,
  sources: [
    { label: "claude", source: "claude", count: 2, ageMs: 120_000, reachable: true },
    { label: "codex", source: "codex", count: 2, ageMs: 180_000, reachable: true },
    { label: "kilo", source: "kilo", count: 1, ageMs: 1_800_000, reachable: true },
  ],
  states: { summarized: 3, pending: 2, orphaned: 1, favorite: 1 },
  tags: [{ label: "atlas-tui", count: 3 }, { label: "sqlite", count: 2 }],
  models: [{ label: "opus-4-6", count: 2 }, { label: "gpt-5.3-codex", count: 2 }, { label: "glm-air", count: 1 }],
  sizes: [
    { key: "lt8k", label: "<8k", count: 1 },
    { key: "8k-32k", label: "8–32k", count: 1 },
    { key: "32k-96k", label: "32–96k", count: 2 },
    { key: "96k+", label: "96k+", count: 1 },
  ],
  ingest: { sessionsPerSecond: 4.2, hourlySessions: [0, 1, 0, 2, 2, 1, 3, 5, 2, 1, 4, 2] },
  summarizer: { queue: 2, completedLastHour: 8, ratePerMinute: 8 / 60, failures: 1, provider: "zai-glm-air" },
  errorCount: 1,
  events: [
    { id: "job:1", at: NOW - 60_000, kind: "error", label: "tier1 timeout" },
    { id: "ingest:1", at: NOW - 120_000, kind: "ingest", label: "ingest codex +2" },
  ],
};

const states = new Map<string, DashboardRowState>([
  [sessionKey(rows[0]!), { orphaned: false, summary: "summarized", failed: false }],
  [sessionKey(rows[1]!), { orphaned: false, summary: "summarized", failed: false }],
  [sessionKey(rows[2]!), { orphaned: false, summary: "summarized", failed: false }],
  [sessionKey(rows[3]!), { orphaned: false, summary: "pending", failed: true }],
  [sessionKey(rows[4]!), { orphaned: true, summary: "pending", failed: false }],
]);

const GOLDEN_SHA256: Record<number, string> = {
  160: "de60d336918bd473a0fcbbd0b8f0c71b48db502215dec26a17e54777ee88ede0",
  120: "ff82a029531d58f6213c9596bf5017fc25724f5c48f681b5b1d4f411edf9bb7a",
  100: "b43eace809abe5c44f2b75cb9868c5f22d6203a9216e775e856f68dcbffe4e17",
  80: "0ee2eb901d673de493f1a15a40b1e1db98003a3c95529688cd9558c99cfb282f",
  60: "2cd30f95f7d7e21819f0b75f92b942b64a8ea4dc456c51c1cd7029696fc8fbd1",
};

function frameAt(width: number): string {
  return renderToString(
    <UltraDenseDashboard
      width={width}
      height={24}
      projections={projectListRows(rows, new Set(), NOW)}
      analytics={analytics}
      focusKey={sessionKey(rows[0]!)}
      selectedKeys={new Set([sessionKey(rows[1]!)])}
      rowStates={states}
      filterSummary="source:all"
      pendingLiveCount={3}
      message="ready"
      now={NOW}
    />,
    { columns: width, rows: 24 },
  );
}

for (const width of [160, 120, 100, 80, 60] as const) {
  test(`Ultra-Dense dashboard golden frame at ${width} columns`, () => {
    const frame = frameAt(width);
    const digest = createHash("sha256").update(frame).digest("hex");
    if (process.env.DUMP_GOLDENS === "1") console.log(`GOLDEN ${width} ${digest}\n${frame}`);
    expect(digest).toBe(GOLDEN_SHA256[width]);
    expect(frame).toContain("ATLAS");
    expect(frame).toContain("astronomy:");
    expect(Math.max(...frame.split("\n").map((line) => Bun.stringWidth(line)))).toBeLessThanOrEqual(width);
  });
}

test("provider-free production telemetry never presents historical provenance as active", () => {
  const frame = renderToString(
    <UltraDenseDashboard
      width={160}
      height={24}
      projections={projectListRows(rows, new Set(), NOW)}
      analytics={analytics}
      activeProvider={null}
      now={NOW}
    />,
    { columns: 160, rows: 24 },
  );
  expect(frame).toContain("SUM off ○");
  expect(frame).not.toContain("SUM zai-glm-air ●");
});

test("production telemetry names the currently configured provider", () => {
  const frame = renderToString(
    <UltraDenseDashboard
      width={160}
      height={24}
      projections={projectListRows(rows, new Set(), NOW)}
      analytics={analytics}
      activeProvider="current-provider"
      now={NOW}
    />,
    { columns: 160, rows: 24 },
  );
  expect(frame).toContain("SUM current-provider ●");
});

test("responsive tiers expose the promised instruments and drop order", () => {
  const full = frameAt(160);
  expect(full).toContain("SRC");
  expect(full).toContain("STATE");
  expect(full).toContain("MODEL");
  expect(full).toContain("SIZE DIST · TOK");
  expect(full).toContain("SUMMARIZER");

  const operational = frameAt(120);
  expect(operational).toContain("SRC");
  expect(operational).not.toContain("SIZE DIST · TOK");

  const center = frameAt(80);
  expect(center).not.toContain("STATE");
  expect(center).toContain("DUR");
  expect(center).toContain("MSG");
  expect(center).toContain("SIZE");

  const essential = frameAt(60);
  expect(essential).not.toContain("DUR");
  expect(essential).not.toContain("MSG");
  expect(essential).not.toContain("SIZE");
  expect(essential).not.toContain("gpt-5.3-codex");
  expect(essential).toContain("session-a…");

  const minimum = frameAt(50);
  expect(minimum).toContain("▌");
  expect(minimum).toContain("astronomy:");
  expect(minimum).toContain(" C ");
});

test("inspector and peek are explicit excursions, never fabricated permanent panes", () => {
  const inspector = {
    key: sessionKey(rows[0]!),
    title: rows[0]!.title!,
    source: "claude",
    model: "opus-4-6",
    path: "/Users/tester/code/session-atlas",
    started: "today 06:00",
    duration: "14m",
    tokens: 48_000,
    messages: 62,
    state: "summarized ✓",
    tags: ["astronomy", "hooks"],
    origin: "agent",
    originDetail: "Not promoted by the conservative human-only classifier.",
    classificationConfidence: 0.88,
    classificationMethod: "conservative-default",
    rawOrigin: "agent",
    rawOriginDetail: "codex:subagent.thread_spawn",
  };
  const full = renderToString(
    <UltraDenseDashboard
      width={160}
      projections={projectListRows(rows, new Set(), NOW)}
      analytics={analytics}
      inspector={inspector}
      now={NOW}
    />,
    { columns: 160 },
  );
  expect(full).toContain("INSPECTOR");
  expect(full).toContain("astronomy · hooks");
  expect(full).toContain("class   agent");
  expect(full).toContain("prov    agent");
  expect(full).toContain("evidence codex:subagent");
  expect(full).not.toContain("SIZE DIST · TOK");

  const peek = renderToString(
    <UltraDenseDashboard
      width={80}
      projections={projectListRows(rows, new Set(), NOW)}
      analytics={analytics}
      peek={{ key: sessionKey(rows[0]!), title: "variable stars", lines: ["first real excerpt", "second real excerpt"] }}
      now={NOW}
    />,
    { columns: 80 },
  );
  expect(peek).toContain("PEEK · variable stars");
  expect(peek).toContain("first real excerpt");
});

test("list zones expose narrow callbacks for command-registry integration", () => {
  const opened: string[] = [];
  const favored: string[] = [];
  const filters: string[] = [];
  const zones = dashboardListInteractionZones({
    width: 80,
    projections: projectListRows(rows, new Set(), NOW),
    actions: {
      onOpenSession: (key) => opened.push(key),
      onToggleFavorite: (key) => favored.push(key),
      onFilter: (term) => filters.push(`${term.kind}:${term.kind === "date" || term.kind === "chain" ? "complex" : term.value}`),
    },
  });
  const registry = new InteractionRegistry();
  for (const zone of zones) registry.register(zone);

  const firstKey = sessionKey(rows[0]!);
  const rowZone = zones.find((zone) => zone.id === `dashboard:row:${firstKey}`)!;
  registry.dispatchPointer({ type: "mouse", action: "press", x: rowZone.rect.x + 5, y: rowZone.rect.y });
  expect(opened).toEqual([firstKey]);

  const favorite = zones.find((zone) => zone.id === `dashboard:row:${firstKey}:favorite`)!;
  registry.dispatchPointer({ type: "mouse", action: "press", x: favorite.rect.x, y: favorite.rect.y });
  expect(favored).toEqual([firstKey]);
  expect(opened).toHaveLength(1);

  const source = zones.find((zone) => zone.id === `dashboard:row:${firstKey}:source`)!;
  registry.dispatchPointer({ type: "mouse", action: "press", x: source.rect.x, y: source.rect.y });
  expect(filters).toContain("source:claude");
});

test("first run and filtered-empty states never invent corpus activity", () => {
  const emptyAnalytics: DashboardAnalytics = {
    ...analytics,
    corpusSessionCount: 0,
    visibleSessionCount: 0,
    hasEverIngested: false,
    sources: [],
    states: { summarized: 0, pending: 0, orphaned: 0, favorite: 0 },
    tags: [], models: [],
    sizes: analytics.sizes.map((bucket) => ({ ...bucket, count: 0 })),
    ingest: { sessionsPerSecond: null, hourlySessions: Array.from({ length: 12 }, () => 0) },
    summarizer: { queue: 0, completedLastHour: 0, ratePerMinute: 0, failures: 0, provider: null },
    errorCount: 0,
    events: [],
  };
  const frame = renderToString(
    <UltraDenseDashboard width={80} projections={[]} analytics={emptyAnalytics} now={NOW} />,
    { columns: 80 },
  );
  expect(frame).toContain("NO SESSIONS INDEXED");
  expect(frame).toContain("configure source roots, then run atlas index");
  expect(frame).toContain("— no ingest or summary events");
  expect(frame).not.toContain("847/s");
});
