import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { runMigrations } from "../src/db/index.js";
import { attachLayers } from "../src/layers/db.js";
import type { Tier2ViewState } from "../src/tier2.js";
import { readDashboardAnalytics, readDashboardAnalyticsPlaceholder, readDashboardRowStates } from "../src/tui/analytics.js";
import { dashboardRailInteractionZones, dashboardSurfaceLayout } from "../src/tui/dashboard.js";
import { operationalRailLines } from "../src/tui/flat-dashboard.js";
import { episodeAnchors, episodeStep, readSessionLayers, railTagEntries, type SessionLayers } from "../src/tui/layer-tags.js";
import { fetchPage } from "../src/tui/queries.js";
import type { ReaderDisplayRow } from "../src/tui/reader.js";
import { sessionKey } from "../src/tui/domain.js";
import { SessionView, sessionLayoutModel, type SessionFacts, type SessionViewController, type TranscriptRow } from "../src/tui/session-view.js";
import { blockAtLine, layoutTranscript } from "../src/tui/transcript-layout.js";
import { applyFilterTerm, removeFilterTerm, type FilterTerm } from "../src/search/compiler.js";
import type { DashboardAnalytics } from "../src/tui/analytics.js";
import type { InteractionZone } from "../src/tui/interaction.js";

const NOW = 1_800_000_000_000;
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/** Four sessions; layer tags exercise merge, nest (with a merged parent), and demote. */
function fixture(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  attachLayers(db, ":memory:");
  const insert = db.prepare(
    `INSERT INTO sessions(harness,native_id,source_path,title,last_activity,duration_ms,models,
      tok_user,tok_assistant,tok_tool,msg_count,engagement,orphaned,ingested_at) VALUES (?,?,?,?,?,0,'[]',0,0,0,4,0,0,?)`,
  );
  for (const [native, title] of [["a", "alpha"], ["b", "bravo"], ["c", "charlie"], ["d", "delta"]] as const) insert.run("claude", native, `/src/${native}`, title, NOW, NOW);
  const tag = db.prepare(`INSERT INTO layers.episode_tags(harness,native_id,episode,tag,source,model,created_at) VALUES ('claude',?,?,?,'model','glm',?)`);
  // a: design episode with tmux (parent) and a nested child; a raw variant merges into tmux.
  tag.run("a", 0, "facet:design", NOW); tag.run("a", 0, "tmux", NOW); tag.run("a", 0, "tmux-scrolling", NOW);
  tag.run("a", 1, "facet:code", NOW); tag.run("a", 1, "opus-5-5", NOW);
  // b: only the nested child, recorded under a raw variant of the child's parent name.
  tag.run("b", 0, "facet:design", NOW); tag.run("b", 0, "tmux-scrolling", NOW);
  // c: a variant that merges into tmux, plus a detail tag demoted into facet:ops.
  tag.run("c", 0, "facet:design", NOW); tag.run("c", 0, "Tmux", NOW); tag.run("c", 0, "v100", NOW);
  // d: tiny session, whole-session tags.
  tag.run("d", -1, "facet:research", NOW); tag.run("d", -1, "sip", NOW);
  const merge = db.prepare(`INSERT INTO layers.tag_merges(from_tag,to_tag,action,reason,source,model,created_at) VALUES (?,?,?,'fixture','model','glm',?)`);
  merge.run("Tmux", "tmux", "merge", NOW);
  merge.run("tmux-scrolling", "terminal", "nest", NOW - 10); // superseded by the newer row
  merge.run("tmux-scrolling", "tmux", "nest", NOW);
  merge.run("v100", "facet:ops", "demote", NOW);
  merge.run("opus-5-5", "noise", "demote", NOW);
  db.prepare(`INSERT INTO layers.session_shape(harness,native_id,session_id,shape,topic,human_turns,tool_calls,total_tokens,compactions,episodes,rule_version,computed_at)
    VALUES ('claude','a',1,'marathon','tmux',12,40,1000,0,2,1,?)`).run(NOW);
  const episode = db.prepare(`INSERT INTO layers.session_episodes(harness,native_id,episode,start_ordinal,end_ordinal,start_ts,end_ts,human_turns,boundary,keywords,label)
    VALUES ('claude','a',?,?,?,?,?,3,'gap',?,?)`);
  episode.run(0, 0, 9, NOW, NOW + 600_000, '["tmux","scroll"]', "Tmux scrollback repair");
  episode.run(1, 10, 20, NOW + 3_600_000, NOW + 4_000_000, '["opus","parity"]', null);
  return db;
}

test("facet and layer-tag filters honor merges, demotions, and one-level nesting", () => {
  const db = fixture();
  const titles = (filter: Parameters<typeof fetchPage>[1]): string[] => fetchPage(db, filter, null, 50).rows.map((row) => row.title ?? "").sort();
  expect(titles({ facet: "design" })).toEqual(["alpha", "bravo", "charlie"]);
  // Demoted v100 counts under its facet.
  expect(titles({ facet: "ops" })).toEqual(["charlie"]);
  // The parent includes its nested child and its merged variant.
  expect(titles({ facet: "design", layerTag: "tmux" })).toEqual(["alpha", "bravo", "charlie"]);
  // The child shows only the child.
  expect(titles({ facet: "design", layerTag: "tmux-scrolling" })).toEqual(["alpha", "bravo"]);
  // A tag demoted to a non-facet target is hidden from display, not from raw matching.
  expect(titles({ layerTag: "noise" })).toEqual([]);
});

test("merge chains resolve to their final survivor, and a merge into a demoted tag follows the demote", () => {
  const db = fixture();
  const titles = (filter: Parameters<typeof fetchPage>[1]): string[] => fetchPage(db, filter, null, 50).rows.map((row) => row.title ?? "").sort();
  const tag = db.prepare(`INSERT INTO layers.episode_tags(harness,native_id,episode,tag,source,model,created_at) VALUES ('claude',?,?,?,'model','glm',?)`);
  tag.run("b", 1, "session-handoff", NOW); tag.run("c", 1, "context-handoff", NOW); tag.run("d", -1, "cleanup-pass", NOW);
  const merge = db.prepare(`INSERT INTO layers.tag_merges(from_tag,to_tag,action,reason,source,model,created_at) VALUES (?,?,?,'fixture','rubric','sonnet',?)`);
  merge.run("session-handoff", "context-handoff", "merge", NOW);
  merge.run("context-handoff", "codebase-handoff", "merge", NOW);
  merge.run("cleanup-pass", "cleanup", "merge", NOW);
  merge.run("cleanup", "facet:ops", "demote", NOW);
  expect(titles({ layerTag: "codebase-handoff" })).toEqual(["bravo", "charlie"]);
  expect(titles({ layerTag: "context-handoff" })).toEqual([]);
  expect(titles({ layerTag: "cleanup" })).toEqual([]);
  expect(titles({ facet: "ops" })).toEqual(["charlie", "delta"]);
});

test("filter terms: a facet resets the detail tag and removing it clears both", () => {
  let filter = applyFilterTerm({}, { kind: "facet", value: "design" } satisfies FilterTerm);
  filter = applyFilterTerm(filter, { kind: "layerTag", value: "tmux" });
  expect(filter).toMatchObject({ facet: "design", layerTag: "tmux" });
  expect(applyFilterTerm(filter, { kind: "facet", value: "code" }).layerTag).toBeNull();
  expect(removeFilterTerm(filter, "layerTag")).toEqual({ facet: "design" });
  expect(removeFilterTerm(filter, "facet")).toEqual({});
});

test("analytics count facets under the other filters and list the facet's detail tags with nesting", () => {
  const db = fixture();
  const all = readDashboardAnalytics(db, {}, NOW);
  expect(all.facets).toEqual([
    { label: "design", count: 3 },
    { label: "code", count: 1 },
    { label: "ops", count: 1 },
    { label: "research", count: 1 },
  ]);
  expect(all.layerTags).toEqual([]);
  const design = readDashboardAnalytics(db, { facet: "design" }, NOW);
  // The facet list stays a choice while a facet is active.
  expect(design.facets?.[0]).toEqual({ label: "design", count: 3 });
  // tmux counts a, b (nested child) and c (merged variant); demoted tags never appear.
  expect(design.layerTags).toEqual([{ label: "tmux", count: 3, parent: null }]);
  const focused = readDashboardAnalytics(db, { facet: "design", layerTag: "tmux" }, NOW);
  expect(focused.layerTags).toEqual([
    { label: "tmux", count: 3, parent: null },
    { label: "tmux-scrolling", count: 2, parent: "tmux" },
  ]);
  // Every rail count is the list count its click produces.
  for (const tag of focused.layerTags ?? []) {
    expect(fetchPage(db, { facet: "design", layerTag: tag.label }, null, 50).rows.length).toBe(tag.count);
  }
  expect(readDashboardAnalyticsPlaceholder(db).facets).toEqual([]);
});

test("viewport row states carry each session's most frequent facet", () => {
  const db = fixture();
  const rows = (db.prepare("SELECT id, harness, native_id FROM sessions ORDER BY native_id").all() as Array<{ id: number; harness: string; native_id: string }>);
  const states = readDashboardRowStates(db, rows);
  // a ties design/code one episode each; the tie breaks alphabetically.
  expect(rows.map((row) => states.get(sessionKey(row))?.facet)).toEqual(["code", "design", "design", "research"]);
});

test("analytics without layer tables read facets as empty", () => {
  const db = new Database(":memory:");
  runMigrations(db);
  attachLayers(db, ":memory:");
  db.exec("DROP TABLE layers.episode_tags");
  const analytics = readDashboardAnalytics(db, {}, NOW);
  expect(analytics.facets).toEqual([]);
  expect(analytics.layerTags).toEqual([]);
});

test("session layers read shape, labels or keywords, and display tags", () => {
  const db = fixture();
  const layers = readSessionLayers(db, "claude", "a");
  expect(layers.shape).toBe("marathon");
  expect(layers.episodes.map((episode) => [episode.label, episode.keywords, episode.facet, episode.tags])).toEqual([
    ["Tmux scrollback repair", ["tmux", "scroll"], "design", ["tmux", "tmux/scrolling"]],
    [null, ["opus", "parity"], "code", []],
  ]);
  const tiny = readSessionLayers(db, "claude", "d");
  expect(tiny).toMatchObject({ shape: null, episodes: [], sessionFacet: "research", sessionTags: ["sip"] });
  expect(readSessionLayers(new Database(":memory:"), "claude", "a")).toEqual({ shape: null, episodes: [], sessionFacet: null, sessionTags: [] });
});

const LAYERS: SessionLayers = {
  shape: "marathon",
  sessionFacet: null,
  sessionTags: [],
  episodes: [
    { episode: 0, startOrdinal: 0, endOrdinal: 9, startTs: NOW, endTs: NOW + 600_000, label: "Tmux scrollback repair", keywords: [], facet: "design", tags: ["tmux"] },
    { episode: 1, startOrdinal: 10, endOrdinal: 19, startTs: NOW + 3_600_000, endTs: NOW + 4_000_000, label: null, keywords: ["opus", "parity"], facet: "code", tags: [] },
    { episode: 2, startOrdinal: 20, endOrdinal: 29, startTs: null, endTs: null, label: "Wrigley building massing", keywords: [], facet: null, tags: [] },
  ],
};

test("episode anchors map raw starts through each turn's raw representative ordinal", () => {
  const turns = [
    { logicalOrdinal: 0, rawRepresentativeOrdinal: 1 },
    { logicalOrdinal: 1, rawRepresentativeOrdinal: 12 },
    { logicalOrdinal: 2, rawRepresentativeOrdinal: 14 },
  ];
  const anchors = episodeAnchors(LAYERS, turns);
  expect(anchors.map((anchor) => [anchor.index, anchor.ordinal, anchor.title, anchor.labelled])).toEqual([
    [1, 0, "Tmux scrollback repair", true],
    [2, 1, "opus . parity", false],
    // No dialogue inside episode 3's raw span: listed, not jumpable.
    [3, null, "Wrigley building massing", true],
  ]);
  expect(episodeStep(anchors, 0, 1)?.index).toBe(2);
  expect(episodeStep(anchors, 1, 1)).toBeNull();
  expect(episodeStep(anchors, 2, -1)?.index).toBe(2);
  expect(episodeStep(anchors, 1, -1)?.index).toBe(1);
});

function row(ordinal: number, display: string): ReaderDisplayRow {
  return { logicalRecordId: ordinal + 1, ordinal, role: "user", recordKind: "real_user", prose: display,
    toolActivities: [], display, dimmed: false, gutter: "", constructionGeneration: "fixture", author: "human" };
}

test("transcript dividers precede each episode's first message and belong to it", () => {
  const rows = [row(0, "first"), row(5, "second"), row(10, "third"), row(12, "fourth")];
  const layout = layoutTranscript(rows, { width: 40, wrap: true, mode: "dialogue", episodes: [
    { ordinal: 0, index: 1, title: "Opening" },
    { ordinal: 10, index: 2, title: "Wrigley building massing" },
  ] });
  const dividers = layout.lines.map((line, index) => [line, index] as const).filter(([line]) => line.kind === "episode");
  expect(dividers.map(([line]) => line.text)).toEqual([
    `-- 1 . Opening ${"-".repeat(40 - 15)}`,
    `-- 2 . Wrigley building massing ${"-".repeat(40 - 32)}`,
  ]);
  expect(/^[\x20-\x7e]+$/.test(dividers[1]![0].text)).toBe(true);
  // Separator blank + divider both belong to the episode's first block.
  const third = layout.blocks[2]!;
  expect(layout.lines[third.start - 1]!.kind).toBe("episode");
  expect(blockAtLine(layout, third.start - 2)).toBe(2);
  expect(blockAtLine(layout, third.start - 1)).toBe(2);
  // A single episode draws no divider.
  const single = layoutTranscript(rows, { width: 40, wrap: true, mode: "dialogue", episodes: [] });
  expect(single.lines.some((line) => line.kind === "episode")).toBe(false);
});

const facts: SessionFacts = { id: 7, harness: "claude", nativeId: "a", title: "alpha", path: null, models: [], tags: [], chainMembers: 1, durationMs: null, tokens: { user: 0, assistant: 0, tool: 0 } };
const summary: Tier2ViewState = { sessionId: 7, status: "unavailable", reason: "fixture" };
const transcript: TranscriptRow[] = Array.from({ length: 30 }, (_, ordinal) => ({ ordinal, role: ordinal % 2 ? "assistant" : "user", text: `message ${ordinal}`, toolText: null, hasTool: false }));

test("the about pane shows shape and episodes; clicking one jumps the transcript", async () => {
  const jumps: number[] = [];
  const controllerRef: { current: SessionViewController | null } = { current: null };
  let zones: readonly InteractionZone[] = [];
  const props = {
    facts, summary, transcript, layers: LAYERS, mode: "dialogue" as const, wrap: true, roleToggle: "all" as const,
    width: 160, height: 30, aboutOpen: true, controllerRef,
    onEpisodeJump: (ordinal: number) => jumps.push(ordinal),
    onInteractionZones: (next: readonly InteractionZone[]) => { zones = next; },
  };
  const model = sessionLayoutModel(props);
  const frame = plain(model.lines.join("\n"));
  expect(frame).toContain("marathon . 3 episodes");
  expect(frame).toContain("[ ] step");
  expect(frame).toMatch(/>1 Tmux scrollback repair/);
  expect(frame).toMatch(/dsgn +\d\d:\d\d-\d\d:\d\d +tmux/);
  expect(frame).toMatch(/ 2 opus \. parity/);
  expect(frame).toMatch(/code +\d\d:\d\d-\d\d:\d\d /);
  expect(frame).toContain("-- 1 . Tmux scrollback repair --");
  const rules = model.transcript.lines.filter((line) => line.kind === "episode").map((line) => line.text);
  expect(rules.map((rule) => rule.slice(0, 34))).toEqual(["-- 1 . Tmux scrollback repair ----", "-- 2 . opus . parity -------------", "-- 3 . Wrigley building massing --"]);

  const view = render(<SessionView {...props} />);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const zone = zones.find((entry) => entry.id === "session:7:episode:3")!;
  expect(zone).toBeDefined();
  zone.onEvent!({ event: { type: "mouse", action: "press", button: "left", x: zone.rect.x, y: zone.rect.y }, stopPropagation() {} } as never);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(jumps).toEqual([20]);
  // The episode divider sits at the top of the transcript.
  const lines = plain(view.lastFrame() ?? "").split("\n");
  const firstBody = lines.slice(1).find((line) => /message|--/.test(line.slice(0, 120)))!;
  expect(firstBody).toContain("-- 3 . Wrigley building massing");
  expect(controllerRef.current!.visibleOrdinals().first).toBe(20);
  view.unmount();
});

function analyticsWith(overrides: Partial<DashboardAnalytics>): DashboardAnalytics {
  return {
    corpusSessionCount: 4, visibleSessionCount: 4, hasEverIngested: true, sources: [], origins: [],
    states: { summarized: 0, pending: 0, orphaned: 0, favorite: 0 }, tags: [], models: [], sizes: [],
    ingest: { sessionsPerSecond: null, hourlySessions: [] },
    summarizer: { queue: 0, completedLastHour: 0, ratePerMinute: 0, failures: 0, provider: null },
    errorCount: 0, events: [], ...overrides,
  };
}

test("the TAGS rail lists facets, then the active facet's tags; rows and zones agree", () => {
  const analytics = analyticsWith({ facets: [{ label: "design", count: 8 }, { label: "ops", count: 5 }] });
  const lines = operationalRailLines(analytics, 23, 30, {}).map(plain);
  const at = lines.findIndex((line) => line.includes("FACETS"));
  expect(lines[at + 1]).toMatch(/^ +design +8 +$/);
  expect(lines[at + 2]).toMatch(/^ +ops +5 +$/);
  const layout = dashboardSurfaceLayout(160, 40, false, false);
  const applied: FilterTerm[] = [];
  const removed: string[] = [];
  const actions = { onFilter: (term: FilterTerm) => applied.push(term), onRemoveFilter: (kind: FilterTerm["kind"]) => removed.push(kind) };
  const zones = dashboardRailInteractionZones({ layout, analytics, actions, filter: {} });
  const design = zones.find((zone) => zone.id === "dashboard:rail:facet:design")!;
  // The zone row is the rendered facet row (rail lines start at bodyY).
  expect(design.rect.y - layout.bodyY).toBe(at + 1);
  design.onEvent!({ event: { type: "mouse", action: "press", button: "left", x: 1, y: design.rect.y }, stopPropagation() {} } as never);
  expect(applied).toEqual([{ kind: "facet", value: "design" }]);

  const scoped = analyticsWith({
    facets: analytics.facets,
    layerTags: [{ label: "tmux", count: 3, parent: null }, { label: "tmux-scrolling", count: 2, parent: "tmux" }],
  });
  const filter = { facet: "design", layerTag: "tmux" };
  expect(railTagEntries(scoped, filter, 2).map((entry) => [entry.kind, entry.label, entry.active, entry.nested])).toEqual([
    ["all", "< all facets", false, false],
    ["facet", "design", true, false],
    ["layerTag", "tmux", true, false],
    ["layerTag", "tmux-scrolling", false, true],
  ]);
  const scopedLines = operationalRailLines(scoped, 23, 30, filter).map(plain);
  const top = scopedLines.findIndex((line) => line.includes("TAGS"));
  expect(scopedLines.slice(top + 1, top + 5).map((line) => line.trim())).toEqual([
    "< all facets",
    expect.stringMatching(/^> design +8$/),
    expect.stringMatching(/^> +tmux +3$/),
    expect.stringMatching(/^\/scrolling +2$/),
  ]);
  const scopedZones = dashboardRailInteractionZones({ layout, analytics: scoped, actions, filter });
  scopedZones.find((zone) => zone.id === "dashboard:rail:all")!.onEvent!({ event: { type: "mouse", action: "press", button: "left", x: 1, y: 0 }, stopPropagation() {} } as never);
  scopedZones.find((zone) => zone.id === "dashboard:rail:layer:tmux/tmux-scrolling")!.onEvent!({ event: { type: "mouse", action: "press", button: "left", x: 1, y: 0 }, stopPropagation() {} } as never);
  expect(removed).toEqual(["facet"]);
  expect(applied.at(-1)).toEqual({ kind: "layerTag", value: "tmux-scrolling" });
});
