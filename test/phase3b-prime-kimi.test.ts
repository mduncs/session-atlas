import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { primeAdapter } from "../src/adapters/prime.js";
import { kimiAdapter } from "../src/adapters/kimi.js";
import type { IngestRecord } from "../src/adapters/types.js";

const owned: string[] = [];
afterEach(() => { while (owned.length) rmSync(owned.pop()!, { recursive: true, force: true }); });
function fixtureRoot(label: string): string { const path = mkdtempSync(join(tmpdir(), `atlas-phase3b-${label}-`)); owned.push(path); return path; }
function jsonl(...rows: unknown[]): string { return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""); }
function vector(record: IngestRecord): { G: number[]; X: number } {
  const rows = record.messages;
  const tools = rows.reduce((total, row) => total + (row.toolActivities?.length ?? 0), 0);
  const prose = rows.filter((row) => typeof row.prose === "string" && row.prose.length > 0).length;
  const user = rows.filter((row) => row.dialogueSide === "user").length;
  const assistant = rows.filter((row) => row.dialogueSide === "assistant").length;
  const unknown = rows.filter((row) => row.sourceIdentityKind === "none" || !row.sourceRecordId || row.sourceRecordTs === null || row.sourceRecordTs === undefined).length;
  return { G: [rows.length, rows.length, tools, tools, prose, prose, user + assistant, user, assistant, 0], X: unknown };
}
function expectVector(record: IngestRecord, G: number[], X: number): void { expect(vector(record)).toEqual({ G, X }); }
function primeRoot(base: string, name: string, rows: unknown[]): string {
  const dir = join(base, "sessions"); mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`); writeFileSync(path, jsonl(...rows)); return path;
}
const header = (id: string) => ({ type: "session", version: 3, id, rlmDepth: 0 });
const inner = (role: string, id: string, timestamp: number | undefined, content: unknown) => ({ type: "message", id, message: { role, ...(timestamp === undefined ? {} : { timestamp }), content } });

// F21
 test("F21 Prime admits canonical layout before electing the embedded identity", () => {
  const root = fixtureRoot("f21");
  primeRoot(root, "fixture-filename-id", [header("fixture-embedded-id"), inner("user", "fixture-r1", 101, [{ type: "text", text: "fixture task prose" }])]);
  const discovered = primeAdapter.discover([root]);
  expect(discovered).toHaveLength(1);
  expect(discovered[0]?.nativeId).toBe("fixture-embedded-id");
  const admitted = primeAdapter.admit!(discovered[0]!);
  expect(admitted.admitted).toBe(true);
  if (!admitted.admitted) return;
  expect(admitted.record).toMatchObject({ nativeId: "fixture-embedded-id", origin: "human", title: "fixture task prose" });
  expectVector(admitted.record, [1, 1, 0, 0, 1, 1, 1, 1, 0, 0], 0);
 });

// F22
 test("F22 Prime resolves only official child parentSession headers", () => {
  const root = fixtureRoot("f22");
  const parent = primeRoot(root, "fixture-parent-filename", [header("fixture-parent")]);
  const childDir = join(root, "session-artifacts", "fixture-parent-folder", "sub-fixture"); mkdirSync(childDir, { recursive: true });
  writeFileSync(join(childDir, "fixture-child-name.jsonl"), jsonl(
    { type: "session", version: 3, id: "fixture-child", rlmDepth: 1, parentSession: parent },
    { type: "custom_message", id: "fixture-task", timestamp: 201, customType: "agent_message", content: "fixture delegated prose", details: { fromRelationship: "parent" } },
    inner("assistant", "fixture-answer", 202, [{ type: "text", text: "fixture result prose" }]),
  ));
  const discovered = primeAdapter.discover([root]);
  const parentRecord = primeAdapter.parse(discovered.find((row) => row.nativeId === "fixture-parent")!).record;
  const childRecord = primeAdapter.parse(discovered.find((row) => row.nativeId === "fixture-child")!).record;
  expectVector(parentRecord, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0);
  expectVector(childRecord, [2, 2, 0, 0, 2, 2, 2, 1, 1, 0], 0);
  expect(childRecord).toMatchObject({ parentNativeId: "fixture-parent", origin: "agent", originDetail: "prime:rlm-child:depth-1" });
 });

// F23
 test("F23 Prime rejects tmux and noncanonical external supervision artifacts", () => {
  const root = fixtureRoot("f23");
  const tmuxDir = join(root, "tmux-panes", "fixture", "sessions"); mkdirSync(tmuxDir, { recursive: true });
  writeFileSync(join(tmuxDir, "external.jsonl"), jsonl({ type: "session", version: 3, id: "fixture-external", rlmDepth: 1, parentSession: "fixture-parent" }));
  const artifactDir = join(root, "session-artifacts", "fixture", "sub-fixture", "nested"); mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "worker.jsonl"), jsonl({ type: "worker_event", parentSession: "fixture-parent", runtime: "external/claude" }));
  const rejected = primeAdapter.discover([root]).map((source) => primeAdapter.admit!(source));
  expect(rejected.every((result) => !result.admitted)).toBe(true);
  expect(rejected.map((result) => result.admitted ? null : result.reason).sort()).toEqual(["auxiliary_agent_artifact", "auxiliary_agent_artifact"]);
 });

// F24
 test("F24 Prime retains agent_status as telemetry without dialogue or title pollution", () => {
  const root = fixtureRoot("f24");
  primeRoot(root, "status", [
    header("fixture-status"),
    inner("user", "fixture-u", 301, [{ type: "text", text: "fixture status task" }]),
    { type: "agent_status", id: "fixture-s1", timestamp: 302, status: { taskState: "fixture-running", summary: "fixture summary one" } },
    { type: "agent_status", id: "fixture-s2", timestamp: 303, status: { taskState: "fixture-done", summary: "fixture summary two" } },
    inner("assistant", "fixture-a", 304, [{ type: "text", text: "fixture status result" }]),
  ]);
  const record = primeAdapter.parse(primeAdapter.discover([root])[0]!).record;
  expectVector(record, [4, 4, 0, 0, 4, 4, 2, 1, 1, 0], 0);
  expect(record.messages.slice(1, 3).map((row) => row.recordKind)).toEqual(["telemetry", "telemetry"]);
  expect(record.title).toBe("fixture status task");
 });

// F25
 test("F25 Prime keeps tool-only and mixed assistant boundaries exact", () => {
  const root = fixtureRoot("f25");
  primeRoot(root, "tools", [
    header("fixture-tools"),
    inner("user", "fixture-u", 401, [{ type: "text", text: "fixture tool task" }]),
    inner("assistant", "fixture-c", 402, [{ type: "toolCall", id: "fixture-call-1", name: "fixture-tool", arguments: { fixture: true } }]),
    inner("tool", "fixture-r", 403, [{ type: "toolResult", toolUseId: "fixture-call-1", content: "fixture tool result" }]),
    inner("assistant", "fixture-a", 404, [{ type: "text", text: "fixture prose result" }, { type: "tool_use", id: "fixture-call-2", name: "fixture-tool", input: { fixture: 2 } }]),
  ]);
  const record = primeAdapter.parse(primeAdapter.discover([root])[0]!).record;
  expectVector(record, [4, 4, 3, 3, 2, 2, 2, 1, 1, 0], 0);
  expect(record.messages.map((row) => row.recordKind)).toEqual(["real_user", "tool", "tool", "assistant_dialogue_prose"]);
  expect(record.messages.at(-1)?.toolActivities).toHaveLength(1);
 });

// F26
 test("F26 Prime distinguishes inbound parent and sibling custom messages from child outbound", () => {
  const root = fixtureRoot("f26");
  primeRoot(root, "custom", [
    header("fixture-custom"),
    { type: "custom_message", id: "fixture-p", timestamp: 501, customType: "agent_message", content: "fixture parent task", details: { fromRelationship: "parent" } },
    { type: "custom_message", id: "fixture-s", timestamp: 502, customType: "agent_message", content: "fixture sibling task", details: { fromRelationship: "sibling" } },
    { type: "custom_message", id: "fixture-c", timestamp: 503, customType: "agent_message", content: "fixture child outbound", details: { fromRelationship: "child", toRelationship: "child" } },
    inner("assistant", "fixture-a", 504, [{ type: "text", text: "fixture custom result" }]),
  ]);
  const record = primeAdapter.parse(primeAdapter.discover([root])[0]!).record;
  expectVector(record, [4, 4, 0, 0, 4, 4, 3, 2, 1, 0], 0);
  expect(record.messages.map((row) => row.recordKind)).toEqual(["real_user", "real_user", "control_context", "assistant_dialogue_prose"]);
 });

// F27
 test("F27 Prime metadata stub stays hidden, titled null, and prose-bearing telemetry", () => {
  const root = fixtureRoot("f27");
  primeRoot(root, "stub", [
    header("fixture-stub"),
    { type: "model_change", id: "fixture-m", timestamp: 601, modelId: "fixture-model", prose: "fixture model state" },
    { type: "session_state", id: "fixture-s", timestamp: 602, state: { status: "fixture" }, prose: "fixture session state" },
  ]);
  const record = primeAdapter.parse(primeAdapter.discover([root])[0]!).record;
  expectVector(record, [2, 2, 0, 0, 2, 2, 0, 0, 0, 0], 0);
  expect(record).toMatchObject({ title: null, construction: { artifactKind: "metadata_shell", defaultSessionVisible: false } });
 });

// F28
 test("F28 Prime keeps source order, backward inner time, and missing inner time null", () => {
  const root = fixtureRoot("f28");
  primeRoot(root, "time", [
    header("fixture-time"),
    { type: "control_context", id: "fixture-r1", timestamp: 702, prose: "fixture control prose" },
    inner("user", "fixture-r2", 701, [{ type: "text", text: "fixture rewind task" }]),
    { type: "message", id: "fixture-r3", timestamp: 999, message: { role: "assistant", content: [{ type: "text", text: "fixture timeless result" }] } },
  ]);
  const record = primeAdapter.parse(primeAdapter.discover([root])[0]!).record;
  expectVector(record, [3, 3, 0, 0, 3, 3, 2, 1, 1, 0], 1);
  expect(record.messages.map((row) => row.sourceRecordTs)).toEqual([702000, 701000, null]);
  expect(record.messages.map((row) => row.sourceOrdinal)).toEqual([1, 2, 3]);
  expect(record).toMatchObject({ startTs: 701000, endTs: 702000 });
 });

function kimiContext(root: string, id: string, content: string): string {
  const dir = join(root, "workspace", id); mkdirSync(dir, { recursive: true });
  const path = join(dir, "context.jsonl"); writeFileSync(path, content); return path;
}

// F31
 test("F31 Kimi admits a zero-byte canonical context without invented state", () => {
  const root = fixtureRoot("f31"); kimiContext(root, "fixture-empty", "");
  const record = kimiAdapter.parse(kimiAdapter.discover([root])[0]!).record;
  expectVector(record, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0);
  expect(record).toMatchObject({ title: null, startTs: null, endTs: null, transcriptBytes: 0, construction: { artifactKind: "current_context_projection", historyCompleteness: "current_context_only" } });
 });

// F32
 test("F32 Kimi retains system, tool, usage, and checkpoint as timestamp-free current context", () => {
  const root = fixtureRoot("f32");
  kimiContext(root, "fixture-activity", jsonl(
    { role: "_system_prompt", content: "fixture system prose" },
    { role: "tool", id: "fixture-tool", content: "fixture tool output", tool_name: "fixture-tool" },
    { role: "_usage", usage: { fixture: 1 } },
    { role: "_checkpoint", id: "fixture-checkpoint", checkpoint: { fixture: true } },
  ));
  const record = kimiAdapter.parse(kimiAdapter.discover([root])[0]!).record;
  expectVector(record, [4, 4, 1, 1, 1, 1, 0, 0, 0, 0], 4);
  expect(record.messages.map((row) => row.recordKind)).toEqual(["developer_system", "tool", "telemetry", "control_context"]);
  expect(record.continuityEvents).toHaveLength(1);
 });

// F33
 test("F33 Kimi dialogue remains timestamp-free and ordered", () => {
  const root = fixtureRoot("f33");
  kimiContext(root, "fixture-dialogue", jsonl({ role: "user", content: "fixture kimi task" }, { role: "assistant", content: [{ type: "think", think: "fixture excluded" }, { type: "text", text: "fixture kimi result" }] }));
  const record = kimiAdapter.parse(kimiAdapter.discover([root])[0]!).record;
  expectVector(record, [2, 2, 0, 0, 2, 2, 2, 1, 1, 0], 2);
  expect(record).toMatchObject({ title: "fixture kimi task", startTs: null, endTs: null });
  expect(record.messages.every((row) => row.eventTs === null && row.sourceRecordTs === null)).toBe(true);
 });

// F34
 test("F34 Kimi paired state custom title outranks the first real user", () => {
  const root = fixtureRoot("f34"); const context = kimiContext(root, "fixture-title", jsonl({ role: "user", content: "fixture fallback" }, { role: "assistant", content: "fixture answer" }));
  writeFileSync(join(context, "..", "state.json"), JSON.stringify({ custom_title: "Fixture Custom Title" }));
  const record = kimiAdapter.parse(kimiAdapter.discover([root])[0]!).record;
  expectVector(record, [2, 2, 0, 0, 2, 2, 2, 1, 1, 0], 2);
  expect(record.title).toBe("Fixture Custom Title");
  expect(record.construction?.titleCandidates.map((candidate) => candidate.authority)).toEqual(["source_explicit", "real_user_fallback"]);
 });

// F35
 test("F35 Kimi subagent path resolves parent and checkpoint continuity", () => {
  const root = fixtureRoot("f35"); const parent = kimiContext(root, "fixture-parent", "");
  const childDir = join(parent, "..", "subagents", "fixture-child"); mkdirSync(childDir, { recursive: true });
  writeFileSync(join(childDir, "context.jsonl"), jsonl({ role: "user", content: "fixture child task" }, { role: "_checkpoint", id: "fixture-cp" }, { role: "assistant", content: "fixture child result" }));
  const found = kimiAdapter.discover([root]);
  const parentRecord = kimiAdapter.parse(found.find((row) => row.nativeId === "fixture-parent")!).record;
  const childRecord = kimiAdapter.parse(found.find((row) => row.nativeId.includes("subagent"))!).record;
  expectVector(parentRecord, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0);
  expectVector(childRecord, [3, 3, 0, 0, 2, 2, 2, 1, 1, 0], 3);
  expect(childRecord).toMatchObject({ nativeId: "fixture-parent/subagent/fixture-child", parentNativeId: "fixture-parent", origin: "agent" });
 });

// F36
 test("F36 Kimi excludes wire, user-history, and stale user_history authority", () => {
  const root = fixtureRoot("f36"); const context = kimiContext(root, "fixture-boundary", jsonl({ role: "_system_prompt", content: "fixture system" }));
  writeFileSync(join(context, "..", "wire.jsonl"), jsonl({ role: "user", content: "fixture auxiliary" }));
  writeFileSync(join(context, "..", "user-history"), jsonl({ role: "user", content: "fixture auxiliary" }));
  const stale = join(root, "user_history", "fixture-stale"); mkdirSync(stale, { recursive: true }); writeFileSync(join(stale, "context.jsonl"), jsonl({ role: "user", content: "fixture stale" }));
  const found = kimiAdapter.discover([root]);
  expect(found.map((row) => row.nativeId)).toEqual(["fixture-boundary"]);
  const record = kimiAdapter.parse(found[0]!).record;
  expectVector(record, [1, 1, 0, 0, 1, 1, 0, 0, 0, 0], 1);
  expect(record.construction?.historyCompleteness).toBe("current_context_only");
 });
