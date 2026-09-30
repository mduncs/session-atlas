import { expect, test } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import type { Tier2ViewState } from "../src/tier2.js";
import { SessionView, type SessionFacts } from "../src/tui/session-view.js";
import { validateTranscriptDto } from "../src/tui/reader.js";
import { phase5TranscriptFixture } from "./phase5-fixtures.js";

const facts: SessionFacts = { id: 7001, harness: "claude", nativeId: "fixture-phase5-dialogue", title: null, path: null, models: [], tags: [], chainMembers: 1, durationMs: null, tokens: { user: 0, assistant: 0, tool: 0 } };
const summary: Tier2ViewState = { sessionId: 7001, status: "unavailable", reason: "provider-free fixture" };

function renderDto(dto: ReturnType<typeof phase5TranscriptFixture>, mode: "dialogue" | "full" = "dialogue") {
  return renderToString(<SessionView facts={facts} summary={summary} readerTranscript={dto} mode={mode} wrap roleToggle="all" width={80} height={24} />, { columns: 80, rows: 24 });
}

test("default transcript accepts only one internally consistent current generation", () => {
  const valid = phase5TranscriptFixture();
  expect(validateTranscriptDto(valid)).toMatchObject({ readable: true, diagnostic: null });
  const invalid = phase5TranscriptFixture({ generationMismatch: true });
  expect(validateTranscriptDto(invalid).readable).toBe(false);
  const value = renderDto(invalid);
  expect(value).toContain("PROJECTION INVALID");
  expect(value).toContain("TRANSCRIPT BLOCKED");
  expect(value).not.toContain("Synthetic user turn alpha");
});

test("a service diagnostic fails closed without raw-role/count fallback", () => {
  const value = renderDto(phase5TranscriptFixture({ diagnostic: "fixture generation is invalid" }));
  expect(value).toContain("TRANSCRIPT BLOCKED");
  expect(value).toContain("fixture generation is invalid");
  expect(value).not.toContain("Synthetic user turn alpha");
  expect(value).not.toContain("messages");
});

test("legacy-invalid state is named and remains fail-closed", () => {
  const value = renderDto(phase5TranscriptFixture({ sourceValidationStatus: "legacy_unverified", diagnostic: "fixture legacy generation invalid" }));
  expect(value).toContain("LEGACY INVALID");
  expect(value).toContain("TRANSCRIPT BLOCKED");
  expect(value).not.toContain("Synthetic user turn alpha");
});

test("metadata shells and zero-dialogue projections are labeled honestly", () => {
  const value = renderDto(phase5TranscriptFixture({ artifactKind: "metadata_shell", historyCompleteness: "unknown", empty: true }));
  expect(value).toContain("METADATA SHELL");
  expect(value).toContain("no dialogue in source");
  expect(value).toContain("0/0");
  expect(value).not.toContain("Synthetic user turn");
});

test("current-context and snapshot-only states remain visible but never claim lifetime history", () => {
  const currentContext = renderDto(phase5TranscriptFixture({ artifactKind: "current_context_projection", historyCompleteness: "current_context_only" }));
  expect(currentContext).toContain("CURRENT CONTEXT ONLY");
  expect(currentContext).toContain("not lifetime history");
  expect(currentContext).toContain("Synthetic user turn alpha");
  const snapshot = renderDto(phase5TranscriptFixture({ sourceValidationStatus: "snapshot_only" }));
  expect(snapshot).toContain("SNAPSHOT ONLY");
  expect(snapshot).toContain("source is not currently reachable");
});

test("one-sided dialogue is preserved and explicitly diagnosed", () => {
  const value = renderDto(phase5TranscriptFixture({ oneSided: "user" }));
  expect(value).toContain("ONE-SIDED DIALOGUE - 2 user / 0 assistant");
  expect(value).toContain("Synthetic user turn alpha");
  expect(value).not.toContain("Synthetic assistant turn beta");
});

test("activity full is explicit and contains non-dialogue evidence only on request", () => {
  const dto = phase5TranscriptFixture();
  const dialogue = renderDto(dto, "dialogue");
  expect(dialogue).not.toContain("synthetic tool payload");
  expect(dialogue).not.toContain("telemetry event");
  const full = renderDto(dto, "full");
  // The active mode tab is the only highlighted header chip.
  expect(full).toMatch(/\x1b\[48;5;\d+m\x1b\[38;5;\d+m full output /);
  expect(dialogue).not.toMatch(/\x1b\[48;5;\d+m\x1b\[38;5;\d+m full output /);
  expect(full).toContain("synthetic tool payload");
  expect(full).toContain("telemetry event");
});
