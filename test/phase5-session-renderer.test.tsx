import { expect, test } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import type { Tier2ViewState } from "../src/tier2.js";
import { applyParagraphBreaks, projectReaderTranscript, readableText, type ReaderDisplayRow } from "../src/tui/reader.js";
import { READING_MEASURE, SessionView, sessionLayoutModel, sessionSurfaceLayout, type SessionFacts } from "../src/tui/session-view.js";
import { displayWidth, layoutTranscript, structuredLines, transcriptViewport } from "../src/tui/transcript-layout.js";
import { phase5TranscriptFixture } from "./phase5-fixtures.js";

const facts: SessionFacts = {
  id: 6260,
  harness: "claude",
  nativeId: "fixture-phase5-dialogue",
  title: "Synthetic measured dialogue fixture",
  path: null,
  models: ["claude-opus-4-6"],
  tags: ["fixture-tag"],
  chainMembers: 1,
  durationMs: null,
  tokens: { user: 0, assistant: 0, tool: 0 },
};
const summary: Tier2ViewState = { sessionId: 6260, status: "unavailable", reason: "synthetic fixture · provider-free" };
const T0 = new Date(2026, 8, 28, 14, 5).getTime();

function frame(width: number, mode: "dialogue" | "full" | "stubs" | "prose" = "dialogue", height = 24) {
  return renderToString(
    <SessionView facts={facts} summary={summary} readerTranscript={phase5TranscriptFixture()}
      mode={mode} wrap roleToggle="all" width={width} height={height} traversalPosition={0} traversalTotal={2} />,
    { columns: width, rows: height },
  );
}

function plain(value: string): string { return value.replace(/\x1b\[[0-9;]*m/g, ""); }

function row(ordinal: number, display: string, overrides: Partial<ReaderDisplayRow> = {}): ReaderDisplayRow {
  return {
    logicalRecordId: ordinal + 1, ordinal, role: "user", recordKind: "real_user", prose: display,
    toolActivities: [], display, dimmed: false, gutter: "◆", constructionGeneration: "fixture",
    author: "human", eventTs: T0 + ordinal * 60_000, ...overrides,
  };
}

test("every frame fits its width and is plain ASCII chrome", () => {
  for (const width of [60, 80, 100, 160]) {
    for (const mode of ["dialogue", "full", "stubs", "prose"] as const) {
      const value = plain(frame(width, mode));
      expect(value.split("\n").every((line) => displayWidth(line) <= width)).toBe(true);
      expect(value.split("\n").length).toBeLessThanOrEqual(24);
    }
  }
});

test("the reading measure caps text width however wide the terminal is", () => {
  expect(sessionSurfaceLayout(300, 40, { aboutOpen: false }).measure).toBe(READING_MEASURE);
  expect(sessionSurfaceLayout(100, 40, { aboutOpen: false }).measure).toBeLessThanOrEqual(READING_MEASURE);
  const model = sessionLayoutModel({ facts, summary, readerTranscript: phase5TranscriptFixture(), mode: "dialogue", wrap: true, roleToggle: "all", width: 240, height: 30, aboutOpen: false });
  expect(model.transcript.width).toBe(READING_MEASURE);
  expect(model.transcript.lines.every((line) => displayWidth(line.text) <= READING_MEASURE)).toBe(true);
});

test("role headers say you and the model, not ordinals or gutters", () => {
  const value = plain(frame(100));
  expect(value).toMatch(/^\s+you\s*$/m);
  expect(value).toContain("opus-4-6");
  expect(value).not.toContain("◆");
  expect(value).not.toContain("│");
});

test("a harness injection folds to a chip and an agent message is labeled", () => {
  const rows = [
    row(1, "<system-reminder>\nbe careful\nline three\n</system-reminder>", { author: "harness", authorRule: "harness:envelope" }),
    row(2, "[from parent] run the tests", { author: "agent", authorRule: "agent:relay" }),
    row(3, "thanks, looks right"),
  ];
  const layout = layoutTranscript(rows, { width: 60, wrap: true, mode: "dialogue" });
  const text = layout.lines.map((line) => line.text);
  expect(text[0]).toBe("+ [system reminder] . 4 lines");
  expect(layout.lines[0]?.fold).toBe("1");
  expect(text).not.toContain("be careful");
  expect(text).toContain("agent ->");
  expect(text).toContain("you");
  const open = layoutTranscript(rows, { width: 60, wrap: true, mode: "dialogue", toggled: new Set(["1"]) });
  expect(open.lines[0]?.text.startsWith("- ")).toBe(true);
  expect(open.lines.some((line) => line.kind === "note" && line.text.includes("be careful"))).toBe(true);
});

test("tool records fold to one line and open on request", () => {
  const tool = { toolActivityId: 1, rawRecordId: 1, activityOrdinal: 0, activityKind: "result" as const, toolName: "bash", toolText: "bun test\n12 pass\n0 fail", sourceActivityId: null };
  const rows = [row(4, "ran it", { role: "assistant", recordKind: "assistant_dialogue_prose", author: null, toolActivities: [tool] })];
  const dialogue = layoutTranscript(rows, { width: 60, wrap: true, mode: "dialogue", modelLabel: "opus" });
  expect(dialogue.lines[0]).toMatchObject({ kind: "header", text: "opus" });
  expect(dialogue.lines[0]?.meta).toContain("1 tool");
  expect(dialogue.lines.some((line) => line.kind === "fold")).toBe(false);
  const stubs = layoutTranscript(rows, { width: 60, wrap: true, mode: "stubs", modelLabel: "opus" });
  const fold = stubs.lines.find((line) => line.kind === "fold")!;
  expect(fold.text).toBe("+ bash . bun test . 3 lines");
  expect(stubs.lines.some((line) => line.kind === "tool")).toBe(false);
  const full = layoutTranscript(rows, { width: 60, wrap: true, mode: "full", modelLabel: "opus" });
  expect(full.lines.filter((line) => line.kind === "tool").map((line) => line.text.trim())).toEqual(["bun test", "12 pass", "0 fail"]);
  const closed = layoutTranscript(rows, { width: 60, wrap: true, mode: "full", toggled: new Set([fold.fold!]) });
  expect(closed.lines.some((line) => line.kind === "tool")).toBe(false);
});

test("one speaker within five minutes shares a header; a day change shows the date", () => {
  const rows = [
    row(1, "first thought"),
    row(2, "second thought", { eventTs: T0 + 2 * 60_000 }),
    row(3, "much later", { eventTs: T0 + 26 * 60 * 60_000 }),
  ];
  const layout = layoutTranscript(rows, { width: 60, wrap: true, mode: "dialogue" });
  const headers = layout.lines.filter((line) => line.kind === "header");
  expect(headers).toHaveLength(2);
  expect(headers[0]?.meta).toBe("Sep 28  14:06");
  expect(headers[1]?.meta).toBe("Sep 29  16:05");
});

test("structure survives: headings, lists with hanging indent, quotes, code and paragraphs", () => {
  const text = "## Plan\n\n- first item that is long enough to wrap onto a second line here\n- second\n\n> quoted\n\n```ts\nconst x = 1;\n```\n\n**Bold heading**\nplain **strong** words";
  const lines = structuredLines(text, 30, true);
  expect(lines[0]).toEqual({ kind: "heading", text: "Plan" });
  expect(lines[1]?.kind).toBe("blank");
  expect(lines[2]?.text.startsWith("- first")).toBe(true);
  expect(lines[3]?.kind).toBe("list");
  expect(lines[3]?.text.startsWith("  ")).toBe(true);
  expect(lines.find((line) => line.kind === "quote")?.text).toBe("| quoted");
  expect(lines.filter((line) => line.kind === "code").map((line) => line.text)).toEqual(["```ts", "const x = 1;", "```"]);
  expect(lines.find((line) => line.text === "Bold heading")?.kind).toBe("heading");
  expect(lines.at(-1)?.text).toBe("plain strong words");
  expect(lines.every((line) => displayWidth(line.text) <= 30)).toBe(true);
  expect(structuredLines("a\n\n\n\nb", 20, true).map((line) => line.kind)).toEqual(["prose", "blank", "prose"]);
});

test("readable text normalizes control noise without flattening structure", () => {
  expect(readableText("a\r\nb\tc\u0007  \n\n\n\nd\n")).toBe("a\nb    c\n\nd");
});

test("paragraph breaks cut at offsets, fold whitespace, and ignore bad offsets", () => {
  const text = "One idea. Another idea. A third.";
  expect(applyParagraphBreaks(text, [10, 24])).toBe("One idea.\n\nAnother idea.\n\nA third.");
  expect(applyParagraphBreaks(text, [0, text.length, -3, 2.5, 10, 10])).toBe("One idea.\n\nAnother idea. A third.");
  const surrogate = "a😀b";
  expect(applyParagraphBreaks(surrogate, [2])).toBe(surrogate);
  expect(applyParagraphBreaks(text, [])).toBe(text);
});

test("paragraph breaks apply only to md's messages in the projection", () => {
  const dto = phase5TranscriptFixture();
  const breaks = new Map([[1, [26]], [2, [30]]]);
  const rows = projectReaderTranscript(dto, "dialogue", "all", undefined, breaks);
  expect(rows[0]?.display).toContain("\n\n");
  expect(rows[1]?.display).not.toContain("\n\n");
  expect(rows[0]?.prose).not.toContain("\n\n");
});

test("the viewport clamps and never overscrolls past the last line", () => {
  const rows = [row(0, Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ")), row(1, "NEXT MESSAGE", { eventTs: T0 + 3_600_000 })];
  const layout = layoutTranscript(rows, { width: 25, wrap: true, mode: "dialogue" });
  const end = transcriptViewport(layout, 10_000, 6);
  expect(end.offset).toBe(layout.lines.length - 6);
  expect(end.lines.at(-1)?.text).toBe("NEXT MESSAGE");
  expect(end.lastBlock).toBe(1);
  expect(transcriptViewport(layout, -5, 6).offset).toBe(0);
});
