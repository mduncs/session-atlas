import { expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { ChatView, activateCitation, segmentCitations } from "../src/tui/chat-view.js";
import {
  SessionView,
  activateAnchor,
  projectTranscript,
  transcriptIndexForOrdinal,
  type SessionFacts,
  type TranscriptRow,
} from "../src/tui/session-view.js";
import { TagView } from "../src/tui/tag-view.js";
import type { Tier2ViewState } from "../src/tier2.js";

const facts: SessionFacts = {
  id: 7,
  harness: "claude",
  nativeId: "native-7",
  title: "anchored work",
  path: "/Users/tester/code/session-atlas",
  models: ["opus", "fable"],
  tags: ["archives"],
  chainMembers: 2,
  durationMs: 3_600_000,
  tokens: { user: 100, assistant: 200, tool: 50 },
};

const transcript: TranscriptRow[] = [
  { ordinal: 2, role: "user", text: "start the analysis", toolText: null, hasTool: false },
  { ordinal: 8, role: "assistant", text: "analysis complete", toolText: null, hasTool: false },
  { ordinal: 9, role: "tool", text: null, toolText: "ran command with lots of output", hasTool: true },
];

test("Wave 1 intelligence view — session skeleton does not hide the ordinal transcript", () => {
  const loading: Tier2ViewState = { sessionId: 7, status: "loading" };
  const { lastFrame } = render(
    <SessionView
      facts={facts}
      summary={loading}
      transcript={transcript}
      mode="stubs"
      roleToggle="all"
      scrollTop={0}
      visibleRows={10}
      width={100}
      aboutOpen
      activeOrdinal={8}
      traversalPosition={1}
      traversalTotal={4}
    />,
  );
  const frame = lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "");
  expect(frame).toContain("summarizing via provider");
  expect(frame).toContain("start the analysis");
  expect(frame).toContain("analysis complete");
  expect(frame).toMatch(/< +2\/4 +>/);
});

test("Wave 1 intelligence view — anchors render, activate, and malformed output degrades", () => {
  const ready: Tier2ViewState = {
    sessionId: 7,
    status: "ready",
    provider: "cache",
    model: "opus",
    result: { body: "body", anchors: [{ topic: "Decision", fromOrdinal: 8, toOrdinal: 12, body: "land here" }] },
  };
  const { lastFrame } = render(
    <SessionView facts={facts} summary={ready} transcript={transcript} mode="full" roleToggle="all" scrollTop={0} visibleRows={5} width={100} aboutOpen focusedAnchor={0} />,
  );
  expect(lastFrame()!.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/> Decision +8-12/);
  let landed: [number, number] | null = null;
  expect(activateAnchor(ready.result!.anchors, 0, (from, to) => { landed = [from, to]; })).toBe(true);
  expect(landed).toEqual([8, 12]);

  const degraded: Tier2ViewState = { sessionId: 7, status: "degraded", result: { body: "usable prose", anchors: [] }, reason: "malformed anchors" };
  const degradedFrame = render(
    <SessionView facts={facts} summary={degraded} transcript={transcript} mode="prose" roleToggle="all" scrollTop={0} visibleRows={5} width={80} aboutOpen />,
  ).lastFrame()!;
  expect(degradedFrame).toContain("outline degraded");
  expect(degradedFrame).toContain("malformed anchors");
  expect(degradedFrame).toContain("usable prose");
});

test("Wave 1 intelligence view — transcript modes and ordinal landing are stable", () => {
  expect(projectTranscript(transcript, "stubs", "all").at(-1)?.display).toBe("tool ran command with lots of output");
  expect(projectTranscript(transcript, "prose", "all")).toHaveLength(2);
  expect(projectTranscript(transcript, "full", "user")[1]?.dimmed).toBe(true);
  expect(transcriptIndexForOrdinal(transcript, 8)).toBe(1);
  expect(transcriptIndexForOrdinal(transcript, 7)).toBe(1);
  expect(transcriptIndexForOrdinal(transcript, 99)).toBe(2);
});

test("Wave 1 intelligence view — provider-down chat keeps a disabled input carrying the doctor line", () => {
  const frame = render(
    <ChatView width={100} input="still visible" status="provider-down" reason="auth 401" turns={[]} />,
  ).lastFrame()!;
  expect(frame).toContain("all providers failing — see atlas doctor");
  expect(frame).toContain("fts_search");
});

test("Wave 1 intelligence view — cited chat marks valid/invented references and activates landing", () => {
  const valid = { sessionId: 7, ordinal: 8 };
  const invalid = { sessionId: 99, ordinal: 1 };
  const turns = [{
    role: "assistant" as const,
    text: "The decision landed here [7:8], not there [99:1].",
    citations: [valid],
    invalidCitations: [invalid],
  }];
  const frame = render(<ChatView width={100} input="" status="ready" turns={turns} />).lastFrame()!;
  expect(frame).toContain("[7:8]");
  expect(frame).toContain("rejected invented citation");
  const segments = segmentCitations(turns[0]!.text, [valid], [invalid]);
  expect(segments.find((segment) => segment.text === "[7:8]")?.valid).toBe(true);
  expect(segments.find((segment) => segment.text === "[99:1]")?.valid).toBe(false);
  let landed: [number, number | null] | null = null;
  activateCitation(valid, (sessionId, ordinal) => { landed = [sessionId, ordinal]; });
  expect(landed).toEqual([7, 8]);
});

test("Wave 1 intelligence view — tag page keeps filtered sessions during synthesis and has a designed degraded state", () => {
  const sessions = [{ id: 7, harness: "claude", nativeId: "native-7", topic: "archive design", lastActivity: Date.now(), model: "opus", favorite: true }];
  const loading = render(<TagView tag="archives" sessions={sessions} synthesis={{ status: "loading" }} width={120} focus={0} />).lastFrame()!;
  expect(loading).toContain("archive design");
  expect(loading).toContain("SYNTHESIZING");
  const degraded = render(
    <TagView tag="archives" sessions={sessions} synthesis={{ status: "provider-down", reason: "timeout" }} width={120} focus={0} />,
  ).lastFrame()!;
  expect(degraded).toContain("all providers failing — see atlas");
  expect(degraded).toContain("doctor · timeout");
});
