import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  codexAdapter,
  readCodexModelHistory,
  loadCodexTitleIndex,
  resetCodexCache,
} from "../src/adapters/codex.js";
import type { DiscoveredSource, NormalizedMessage } from "../src/adapters/types.js";

const roots: string[] = [];
afterEach(() => {
  resetCodexCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(name: string): string {
  const value = mkdtempSync(join(tmpdir(), `atlas-phase3a-codex-${name}-`));
  roots.push(value);
  return value;
}

function uuid(index: number): string {
  return `e${index.toString(16).padStart(7, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function stamp(index: number): string {
  return new Date(index * 1_000).toISOString();
}

function source(base: string, id: string): DiscoveredSource {
  const relPath = join("sessions", "fixture", `rollout-fixture-${id}.jsonl`);
  return { root: base, relPath, fullPath: join(base, relPath), nativeId: id };
}

function write(source: DiscoveredSource, records: unknown[], tail = ""): void {
  mkdirSync(join(source.fullPath, ".."), { recursive: true });
  const complete = records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
  writeFileSync(source.fullPath, complete + tail);
}

function meta(id: string, index = 1, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "session_meta",
    timestamp: stamp(index),
    payload: { id, cwd: "/fixture/project", source: "cli", ...extra },
  };
}

function response(
  type: string,
  index: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "response_item",
    timestamp: stamp(index),
    payload: { type, id: `FIXTURE_ITEM_${index}`, ...extra },
  };
}

function responseMessage(
  role: string,
  text: string,
  index: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return response("message", index, {
    role,
    content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
    ...extra,
  });
}

function event(type: string, index: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "event_msg", timestamp: stamp(index), payload: { type, ...extra } };
}

function gx(messages: NormalizedMessage[]): number[] {
  const tools = messages.reduce((sum, item) => sum + (item.toolActivities?.length ?? 0), 0);
  const prose = messages.filter((item) => typeof item.prose === "string" && item.prose.trim()).length;
  const users = messages.filter((item) => item.recordKind === "real_user" && item.prose?.trim()).length;
  const assistants = messages.filter((item) => item.recordKind === "assistant_dialogue_prose" && item.prose?.trim()).length;
  const unknown = messages.filter((item) => item.sourceIdentityKind === "none" || item.sourceRecordTs === null).length;
  return [messages.length, messages.length, tools, tools, prose, prose, users + assistants, users, assistants, 0, unknown];
}

function parsed(base: string, id: string, records: unknown[]) {
  const src = source(base, id);
  write(src, records);
  return codexAdapter.parse(src).record;
}

function writeIndex(base: string, rows: unknown[], tail = ""): void {
  writeFileSync(join(base, "session_index.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}${rows.length ? "\n" : ""}${tail}`);
  loadCodexTitleIndex(base);
}

test("F13 response items own legacy content/tools and first real user is fallback title", () => {
  const base = root("legacy");
  const id = uuid(1301);
  const record = parsed(base, id, [
    meta(id),
    responseMessage("user", "FIXTURE_CODEX_USER_ALPHA", 2),
    responseMessage("assistant", "FIXTURE_CODEX_ASSISTANT_ALPHA", 3),
    response("function_call", 4, { name: "FIXTURE_TOOL", call_id: "FIXTURE_CALL_A", arguments: "{\"fixture\":1}" }),
    response("function_call_output", 5, { call_id: "FIXTURE_CALL_A", output: "FIXTURE_TOOL_OUTPUT_A" }),
  ]);
  expect(gx(record.messages)).toEqual([4, 4, 2, 2, 2, 2, 2, 1, 1, 0, 0]);
  expect(record.messages.map((item) => item.recordKind)).toEqual([
    "real_user", "assistant_dialogue_prose", "tool", "tool",
  ]);
  expect(record.messages.slice(2).flatMap((item) => item.toolActivities ?? []).map((activity) => activity.activityKind)).toEqual([
    "call", "result",
  ]);
  expect(record.title).toBe("FIXTURE_CODEX_USER_ALPHA");
  expect(record.construction?.defaultSessionVisible).toBe(true);
});

test("F14 thread_name is root+identity scoped, later complete duplicate wins, and root fallback is ordered", () => {
  const first = root("index-first");
  const second = root("index-second");
  const id = uuid(1401);
  const dialogue = [
    meta(id),
    responseMessage("user", "FIXTURE_INDEX_USER", 11),
    responseMessage("assistant", "FIXTURE_INDEX_ASSISTANT", 12),
  ];
  const firstSource = source(first, id);
  const secondSource = source(second, id);
  write(firstSource, dialogue);
  write(secondSource, dialogue);
  writeIndex(first, [
    { id, thread_name: "FIXTURE_THREAD_FIRST_OLD" },
    { id, thread_name: "  FIXTURE_THREAD_FIRST_NEW  " },
  ]);
  writeIndex(second, [{ id, thread_name: "FIXTURE_THREAD_SECOND" }]);

  const firstRecord = codexAdapter.parse(firstSource).record;
  const secondRecord = codexAdapter.parse(secondSource).record;
  expect(gx(firstRecord.messages)).toEqual([2, 2, 0, 0, 2, 2, 2, 1, 1, 0, 0]);
  expect(firstRecord.title).toBe("  FIXTURE_THREAD_FIRST_NEW  ");
  expect(firstRecord.construction?.titleCandidates[0]).toMatchObject({
    authority: "source_explicit",
    harnessSourceClass: "session_index.thread_name",
    sourceOrdinal: 1,
  });
  expect(secondRecord.title).toBe("FIXTURE_THREAD_SECOND");

  writeIndex(second, []);
  expect(codexAdapter.parse(secondSource).record.title).toBe("  FIXTURE_THREAD_FIRST_NEW  ");

  const other = uuid(1402);
  const otherRecord = parsed(second, other, [meta(other), responseMessage("user", "FIXTURE_OTHER_USER", 13)]);
  expect(otherRecord.title).toBe("FIXTURE_OTHER_USER");
});

test("Codex title index ignores torn tails and malformed complete rows cannot advance cache", () => {
  const base = root("index-bounded");
  const id = uuid(1451);
  const src = source(base, id);
  write(src, [meta(id), responseMessage("user", "FIXTURE_FALLBACK", 14)]);
  const complete = JSON.stringify({ id, thread_name: "FIXTURE_INDEX_COMPLETE" });
  writeFileSync(join(base, "session_index.jsonl"), `${complete}\n{"id":`);
  loadCodexTitleIndex(base);
  expect(codexAdapter.parse(src).record.title).toBe("FIXTURE_INDEX_COMPLETE");

  writeFileSync(join(base, "session_index.jsonl"), `${complete}\n{"id":}\n`);
  expect(() => loadCodexTitleIndex(base)).toThrow("malformed complete JSONL line");
  expect(codexAdapter.parse(src).record.title).toBe("FIXTURE_INDEX_COMPLETE");
});

test("F15 current control/context and item completion emit seven raw records without duplicates", () => {
  const base = root("current-controls");
  const id = uuid(1501);
  const realItem = "FIXTURE_ITEM_25";
  const records: unknown[] = [
    meta(id, 20),
    { type: "turn_context", timestamp: stamp(21), payload: { fixture: "FIXTURE_TURN" } },
    responseMessage("developer", "FIXTURE_DEVELOPER_ALPHA", 22),
    responseMessage("developer", "FIXTURE_DEVELOPER_BETA", 23),
    responseMessage("user", "# AGENTS.md instructions for /fixture/project\nFIXTURE_INJECTED", 24),
    responseMessage("user", "FIXTURE_REAL_USER", 25),
    responseMessage("user", "<turn_aborted>FIXTURE_ABORT</turn_aborted>", 26),
    { type: "world_state", timestamp: stamp(27), payload: { fixture: "FIXTURE_WORLD" } },
    event("item_completed", 28, { item: { type: "user_message", response_item_id: realItem, content: [{ text: "FIXTURE_REAL_USER" }] } }),
    event("token_count", 29, { total: 1 }),
    event("task_complete", 30),
    event("lifecycle", 31),
  ];
  expect(records).toHaveLength(12);
  const record = parsed(base, id, records);
  expect(gx(record.messages)).toEqual([7, 7, 0, 0, 5, 5, 1, 1, 0, 0, 2]);
  expect(record.messages.map((item) => item.recordKind)).toEqual([
    "control_context",
    "developer_system",
    "developer_system",
    "control_context",
    "real_user",
    "control_context",
    "control_context",
  ]);
  expect(record.messages.map((item) => item.sourceOrdinal)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(record.title).toBe("FIXTURE_REAL_USER");
  expect(record.messages[0]).toMatchObject({ eventTs: 21_000, sourceRecordTs: 21_000, sourceIdentityKind: "none" });
  expect(record.messages.at(-1)).toMatchObject({ eventTs: 27_000, sourceIdentityKind: "none" });
});

test("F16 response-item authority keeps 0.147 association/lifecycle/token streams nonduplicating", () => {
  const base = root("current-tools");
  const id = uuid(1601);
  const records: unknown[] = [meta(id, 100)];
  records.push({ type: "turn_context", timestamp: stamp(101), payload: { fixture: "FIXTURE_TURN" } });
  for (let index = 0; index < 4; index++) {
    records.push(responseMessage("developer", `FIXTURE_DEVELOPER_${index}`, 102 + index));
  }
  records.push(responseMessage("user", "<environment_context>FIXTURE_CONTEXT</environment_context>", 106));
  records.push(responseMessage("user", "FIXTURE_REAL_USER", 107));
  records.push(responseMessage("assistant", "FIXTURE_ASSISTANT_ALPHA", 108));
  records.push(responseMessage("assistant", "FIXTURE_ASSISTANT_BETA", 109));
  for (let index = 0; index < 6; index++) {
    records.push(response("reasoning", 110 + index, { summary: `FIXTURE_REASONING_${index}` }));
  }
  for (let index = 0; index < 5; index++) {
    records.push(response("custom_tool_call", 120 + index, {
      name: "FIXTURE_TOOL",
      call_id: `FIXTURE_CALL_${index}`,
      input: `FIXTURE_TOOL_INPUT_${index}`,
    }));
  }
  for (let index = 0; index < 5; index++) {
    records.push(response("custom_tool_call_output", 130 + index, {
      call_id: `FIXTURE_CALL_${index}`,
      output: `FIXTURE_TOOL_OUTPUT_${index}`,
    }));
  }
  records.push({ type: "world_state", timestamp: stamp(140), payload: { fixture: "FIXTURE_WORLD" } });
  for (let index = 0; index < 14; index++) {
    const item = index === 0
      ? { type: "user_message", response_item_id: "FIXTURE_ITEM_107", content: [{ text: "FIXTURE_REAL_USER" }] }
      : index === 1
        ? { type: "agent_message", response_item_id: "FIXTURE_ITEM_108", content: [{ text: "FIXTURE_ASSISTANT_ALPHA" }] }
        : index === 2
          ? { type: "agent_message", response_item_id: "FIXTURE_ITEM_109", content: [{ text: "FIXTURE_ASSISTANT_BETA" }] }
          : index === 3
            ? { type: "user_message", content: [{ text: "FIXTURE_CONTEXT_ASSOCIATION" }] }
            : { type: index < 10 ? "reasoning" : "extension", id: `FIXTURE_ASSOC_${index}` };
    records.push(event("item_completed", 150 + index, { item }));
  }
  records.push(event("task_started", 170));
  records.push(event("task_complete", 171));
  for (let index = 0; index < 6; index++) records.push(event("token_count", 180 + index, { total: index }));

  expect(records).toHaveLength(49);
  const record = parsed(base, id, records);
  expect(gx(record.messages)).toEqual([26, 26, 10, 10, 8, 8, 3, 1, 2, 0, 2]);
  expect(record.messages.filter((item) => item.recordKind === "developer_system")).toHaveLength(4);
  expect(record.messages.filter((item) => item.recordKind === "control_context")).toHaveLength(9);
  expect(record.messages.filter((item) => item.recordKind === "tool")).toHaveLength(10);
  expect(record.messages.flatMap((item) => item.toolActivities ?? [])).toHaveLength(10);
  expect(record.messages.filter((item) => item.recordKind === "real_user").map((item) => item.prose)).toEqual([
    "FIXTURE_REAL_USER",
  ]);
});

test("F17/F18 retain metadata-only shells; lifecycle cannot become title or raw prose", () => {
  const base = root("shells");
  const id = uuid(1701);
  const shellSource = source(base, id);
  write(shellSource, [meta(id, 200)]);
  const admitted = codexAdapter.admit?.(shellSource);
  expect(admitted?.admitted).toBe(true);
  if (!admitted?.admitted) throw new Error("F17 must admit");
  expect(gx(admitted.record.messages)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(admitted.record).toMatchObject({ title: null, startTs: 200_000, endTs: null });
  expect(admitted.record.construction).toMatchObject({ artifactKind: "metadata_shell", defaultSessionVisible: false });

  const shellRecords = [];
  for (let index = 0; index < 3; index++) {
    const shellId = uuid(1801 + index);
    if (index === 2) writeIndex(base, [{ id: shellId, thread_name: "FIXTURE_SHELL_TITLE" }]);
    const record = parsed(base, shellId, [meta(shellId, 210 + index), event("task_started", 220 + index, { task: "FIXTURE_TASK" })]);
    shellRecords.push(record);
    expect(gx(record.messages)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  }
  expect(shellRecords.map((record) => record.title)).toEqual([null, null, "FIXTURE_SHELL_TITLE"]);
});

test("F19 exact current controls remain inspectable but never become dialogue/title", () => {
  const base = root("control-only");
  const id = uuid(1901);
  const record = parsed(base, id, [
    responseMessage("developer", "FIXTURE_DEVELOPER", 230),
    responseMessage("user", "<project_context>FIXTURE_PROJECT</project_context>", 231),
    responseMessage("user", "<turn_aborted>FIXTURE_ABORT</turn_aborted>", 232),
  ]);
  expect(gx(record.messages)).toEqual([3, 3, 0, 0, 3, 3, 0, 0, 0, 0, 0]);
  expect(record.messages.map((item) => item.recordKind)).toEqual([
    "developer_system", "control_context", "control_context",
  ]);
  expect(record.title).toBeNull();
  expect(record.construction?.defaultSessionVisible).toBe(false);
});

test("F20 tool-saturated user-only state reports one dialogue turn, not raw volume", () => {
  const base = root("saturated");
  const id = uuid(2001);
  const records: unknown[] = [meta(id, 240), responseMessage("user", "FIXTURE_USER_ONLY", 241)];
  for (let index = 0; index < 9; index++) {
    const type = index % 2 === 0 ? "function_call" : "function_call_output";
    records.push(response(type, 242 + index, type === "function_call"
      ? { name: "FIXTURE_TOOL", call_id: `FIXTURE_CALL_${index}`, arguments: `FIXTURE_ARGS_${index}` }
      : { call_id: `FIXTURE_CALL_${index}`, output: `FIXTURE_OUTPUT_${index}` }));
  }
  const record = parsed(base, id, records);
  expect(gx(record.messages)).toEqual([10, 10, 9, 9, 1, 1, 1, 1, 0, 0, 0]);
  expect(record.construction?.defaultSessionVisible).toBe(true);
  expect(record.title).toBe("FIXTURE_USER_ONLY");
});

test("Codex admission rekeys from embedded identity and quarantines filename mismatch", () => {
  const base = root("identity");
  const filenameId = uuid(2101);
  const embeddedId = uuid(2102);
  const src = source(base, filenameId);
  write(src, [meta(embeddedId), responseMessage("user", "FIXTURE_USER", 251)]);
  expect(codexAdapter.parse(src).record.nativeId).toBe(embeddedId);
  expect(codexAdapter.admit?.(src)).toMatchObject({ admitted: false, reason: "identity_mismatch" });
});

test("Codex bounded parsing retries torn tails and rejects malformed complete records", () => {
  const base = root("bounded");
  const id = uuid(2201);
  const src = source(base, id);
  const complete = [meta(id, 260), responseMessage("user", "FIXTURE_USER", 261)];
  write(src, complete, '{"type":"response_item"');
  const torn = codexAdapter.parse(src);
  expect(torn.record.messages).toHaveLength(1);
  expect(torn.consumed).toBe(Buffer.byteLength(`${complete.map((item) => JSON.stringify(item)).join("\n")}\n`));
  write(src, complete, '{"type":}\n');
  expect(codexAdapter.admit?.(src)).toMatchObject({ admitted: false, reason: "malformed_complete_record" });
});

test("Codex preserves null response time without borrowing session metadata or neighbors", () => {
  const base = root("null-time");
  const id = uuid(2251);
  const src = source(base, id);
  write(src, [
    meta(id, 265),
    {
      type: "response_item",
      payload: {
        type: "message",
        id: "FIXTURE_NULL_TIME_ITEM",
        role: "user",
        content: [{ type: "input_text", text: "FIXTURE_NULL_TIME_USER" }],
      },
    },
  ]);
  const record = codexAdapter.parse(src).record;
  expect(record.messages[0]).toMatchObject({
    sourceOrdinal: 1,
    eventTs: null,
    sourceRecordTs: null,
    sourceIdentityKind: "record-id",
  });
  expect(record).toMatchObject({ startTs: 265_000, endTs: null, title: "FIXTURE_NULL_TIME_USER" });
});

test("Codex candidate bytes count semantic response/control bytes, not lifecycle metadata", () => {
  const base = root("semantic-bytes");
  const firstId = uuid(2301);
  const secondId = uuid(2302);
  const semantic = responseMessage("user", "FIXTURE_EQUAL_SEMANTIC", 271);
  const first = parsed(base, firstId, [meta(firstId, 270), event("token_count", 272, { total: 1 }), semantic]);
  const second = parsed(base, secondId, [
    meta(secondId, 270),
    event("token_count", 272, { total: "FIXTURE_LARGER_NONCONTENT_TRANSPORT_VALUE" }),
    semantic,
  ]);
  expect(first.transcriptBytes).toBe(second.transcriptBytes);
  expect(first.transcriptBytes).toBeGreaterThan(0);
});


test("native fork ancestry elects current identity without inheriting parent launch metadata", () => {
  const src = source(root("fork"), uuid(81));
  const child = meta(uuid(81), 3, { forked_from_id: uuid(80), parent_thread_id: uuid(80), cwd: "/fixture/child", source: { subagent: { thread_spawn: { parent_thread_id: uuid(80) } } } });
  const parent = meta(uuid(80), 2, { forked_from_id: uuid(79) });
  const ancestor = meta(uuid(79), 1);
  write(src, [child, parent, ancestor, response("message", 4, { role: "user", content: [{ type: "input_text", text: "inherited fixture" }] })]);
  const result = codexAdapter.admit!(src);
  expect(result.admitted).toBe(true);
  if (!result.admitted) throw new Error(result.reason);
  expect(result.record.nativeId).toBe(uuid(81));
  expect(result.record.cwd).toBe("/fixture/child");
  expect(result.record.origin).toBe("agent");
  expect(result.record.messages.some(message => message.prose === "inherited fixture")).toBe(true);
  for (const records of [
    [child, meta(uuid(82))],
    [child, parent, meta(uuid(79), 1, { forked_from_id: uuid(81) })],
    [child, parent, ancestor, meta(uuid(80), 5, { forked_from_id: uuid(82) })],
    [meta(uuid(82), 3, { forked_from_id: uuid(80) }), parent, ancestor],
  ]) {
    write(src, records);
    const rejected = codexAdapter.admit!(src);
    expect(rejected.admitted).toBe(false);
    if (!rejected.admitted) expect(rejected.reason).toBe("identity_mismatch");
  }
});


test("Codex model history preserves explicit current and inherited observations without a current-model claim", () => {
  const src = source(root("models"), uuid(91));
  write(src, [
    meta(uuid(91), 2, { forked_from_id: uuid(90), model: "child-model", model_provider: "not-a-model" }),
    meta(uuid(90), 1, { model: "ancestor-model" }),
    { type: "turn_context", payload: { model: "child-model" } },
    { type: "turn_context", payload: { model: " later-model " } },
    { type: "turn_context", payload: { model: "   " } },
    { type: "turn_context", payload: { model: { name: "unsupported-shape" }, model_provider: "provider-only" } },
    { type: "event_msg", payload: { model: "not-model-authority" } },
  ], '{"type":"turn_context","payload":{"model":"torn-model"}}');
  const expected = ["child-model", "ancestor-model", "later-model"];
  expect(readCodexModelHistory(src.fullPath)).toEqual(expected);
  const parsed = codexAdapter.admit!(src);
  if (!parsed.admitted) throw new Error(`${parsed.reason}: ${parsed.detail}`);
  expect(parsed.admitted).toBe(true);
  if (parsed.admitted) expect(parsed.record.models).toEqual(expected);
  write(src, [meta(uuid(91), 1, { model_provider: "provider-only" }), { type: "turn_context", payload: {} }]);
  expect(readCodexModelHistory(src.fullPath)).toEqual([]);
  expect(codexAdapter.parse(src).record.models).toEqual([]);
});
