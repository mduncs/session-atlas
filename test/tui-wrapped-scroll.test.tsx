import { expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import type { Tier2ViewState } from "../src/tier2.js";
import type { ReaderDisplayRow } from "../src/tui/reader.js";
import { SessionView, sessionLayoutModel, type SessionFacts, type SessionViewController, type TranscriptRow } from "../src/tui/session-view.js";
import { layoutTranscript, transcriptViewport } from "../src/tui/transcript-layout.js";
import { InteractionRegistry } from "../src/tui/interaction.js";

const facts: SessionFacts = { id: 11, harness: "claude", nativeId: "scroll", title: "scroll", path: null, models: [], tags: [], chainMembers: 1, durationMs: null, tokens: { user: 0, assistant: 0, tool: 0 } };
const summary: Tier2ViewState = { sessionId: 11, status: "unavailable", reason: "fixture" };

function row(ordinal: number, display: string): ReaderDisplayRow {
  return { logicalRecordId: ordinal + 1, ordinal, role: "user", recordKind: "real_user", prose: display,
    toolActivities: [], display, dimmed: false, gutter: "◆", constructionGeneration: "fixture", author: "human" };
}

const long = Array.from({ length: 200 }, (_, i) => `word${i.toString().padStart(3, "0")}`).join(" ");
const transcript: TranscriptRow[] = [
  { ordinal: 0, role: "user", text: "DO NOT JUMP BACK", toolText: null, hasTool: false },
  { ordinal: 1, role: "assistant", text: long, toolText: null, hasTool: false },
  { ordinal: 2, role: "user", text: "FINAL MESSAGE", toolText: null, hasTool: false },
];

function tick(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 10)); }

test("line offsets walk through a long message to the next one without blank overscroll", () => {
  const layout = layoutTranscript([row(0, long), row(1, "NEXT MESSAGE")], { width: 25, wrap: true, mode: "dialogue" });
  const seen: string[] = [];
  for (let offset = 0; offset < layout.lines.length + 20; offset += 3) {
    const view = transcriptViewport(layout, offset, 6);
    expect(view.lines).toHaveLength(6);
    seen.push(...view.lines.map((line) => line.text));
  }
  expect(seen.join(" ")).toContain("word199");
  expect(seen.join(" ")).toContain("NEXT MESSAGE");
});

test("the controller scrolls lines and pages; home and end reach both edges", async () => {
  const controllerRef: { current: SessionViewController | null } = { current: null };
  const props = { facts, summary, transcript, mode: "dialogue" as const, wrap: true, roleToggle: "all" as const, width: 80, height: 14, aboutOpen: false, controllerRef };
  const view = render(<SessionView {...props} />);
  await tick();
  expect(view.lastFrame()).toContain("DO NOT JUMP BACK");
  controllerRef.current!.scroll("page-down");
  await tick();
  expect(view.lastFrame()).not.toContain("DO NOT JUMP BACK");
  controllerRef.current!.scroll("end");
  await tick();
  expect(view.lastFrame()).toContain("FINAL MESSAGE");
  expect(controllerRef.current!.visibleOrdinals().last).toBe(2);
  controllerRef.current!.scroll("line-up");
  await tick();
  controllerRef.current!.scroll("home");
  await tick();
  expect(view.lastFrame()).toContain("DO NOT JUMP BACK");
  expect(controllerRef.current!.visibleOrdinals().first).toBe(0);
  view.unmount();
});

test("scrolling stays where it is when the active message is re-rendered; a new session starts at the top", async () => {
  const controllerRef: { current: SessionViewController | null } = { current: null };
  const props = { facts, summary, transcript, mode: "dialogue" as const, wrap: true, roleToggle: "all" as const, width: 80, height: 14, aboutOpen: false, controllerRef, landingOrdinal: 1 };
  const view = render(<SessionView {...props} />);
  await tick();
  controllerRef.current!.scroll("line-down");
  await tick();
  const before = view.lastFrame();
  expect(before).not.toContain("DO NOT JUMP BACK");
  view.rerender(<SessionView {...props} message="status" />);
  await tick();
  expect(view.lastFrame()).not.toContain("DO NOT JUMP BACK");
  view.rerender(<SessionView {...props} facts={{ ...facts, id: 12 }} landingOrdinal={null} />);
  await tick();
  expect(view.lastFrame()).toContain("DO NOT JUMP BACK");
  view.unmount();
});

test("the transcript wheel scrolls lines and never bubbles to the list", () => {
  const deltas: number[] = [];
  let bubbled = 0;
  const model = sessionLayoutModel({ facts, summary, transcript, mode: "dialogue", wrap: true, roleToggle: "all", width: 80, height: 14, aboutOpen: false, onScroll: (delta) => deltas.push(delta) });
  const registry = new InteractionRegistry();
  registry.register({ id: "root", rect: { x: 0, y: 0, width: 80, height: 14 }, zIndex: -100, onEvent: () => { bubbled++; return true; } });
  model.zones.forEach((zone) => registry.register(zone));
  const transcriptZone = model.zones.find((zone) => zone.id.endsWith(":transcript"))!;
  registry.dispatchPointer({ type: "mouse", x: transcriptZone.rect.x + 2, y: transcriptZone.rect.y + 1, action: "scroll", button: "wheel-down" });
  registry.dispatchPointer({ type: "mouse", x: transcriptZone.rect.x + 2, y: transcriptZone.rect.y + 1, action: "scroll", button: "wheel-up" });
  registry.dispatchPointer({ type: "mouse", x: 1, y: 13, action: "scroll", button: "wheel-down" });
  expect(deltas).toEqual([1, -1]);
  expect(bubbled).toBe(0);
});
