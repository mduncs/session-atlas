import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claudeAdapter } from "../src/adapters/claude.js";
import type { DiscoveredSource, NormalizedMessage } from "../src/adapters/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(name: string): string {
  const value = mkdtempSync(join(tmpdir(), `atlas-phase3a-claude-${name}-`));
  roots.push(value);
  return value;
}

function uuid(index: number): string {
  return `f${index.toString(16).padStart(7, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function stamp(index: number): string {
  return new Date(index * 1_000).toISOString();
}

function source(base: string, id: string, relPath = `project/${id}.jsonl`): DiscoveredSource {
  return { root: base, relPath, fullPath: join(base, relPath), nativeId: id };
}

function write(source: DiscoveredSource, records: unknown[], tail = ""): void {
  mkdirSync(join(source.fullPath, ".."), { recursive: true });
  const complete = records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
  writeFileSync(source.fullPath, complete + tail);
}

function message(
  type: "user" | "assistant",
  content: unknown,
  index: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type,
    uuid: uuid(index),
    timestamp: stamp(index),
    message: { role: type, content },
    ...extra,
  };
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
  return claudeAdapter.parse(src).record;
}

function toolCall(index: number): Record<string, unknown> {
  return { type: "tool_use", id: `FIXTURE_TOOL_${index}`, name: "FIXTURE_TOOL", input: { fixture: index } };
}

function toolResult(index: number): Record<string, unknown> {
  return { type: "tool_result", tool_use_id: `FIXTURE_TOOL_${index}`, content: [{ type: "text", text: `FIXTURE_TOOL_OUTPUT_${index}` }] };
}

test("F01/F05 classify mixed prose and exact tool-child cardinality", () => {
  const base = root("tools");
  const f01 = parsed(base, uuid(101), [
    message("user", "FIXTURE_USER_ALPHA", 1),
    message("assistant", [{ type: "text", text: "FIXTURE_ASSISTANT_ALPHA" }], 2),
    message("assistant", [{ type: "text", text: "FIXTURE_ASSISTANT_BETA" }, toolCall(1)], 3),
    message("user", [toolResult(1)], 4),
  ]);
  expect(gx(f01.messages)).toEqual([4, 4, 2, 2, 3, 3, 3, 1, 2, 0, 0]);
  expect(f01.messages.map((item) => item.recordKind)).toEqual([
    "real_user", "assistant_dialogue_prose", "assistant_dialogue_prose", "tool",
  ]);
  expect(f01.messages[2]?.toolActivities).toEqual([{
    activityOrdinal: 0,
    activityKind: "call",
    toolName: "FIXTURE_TOOL",
    toolText: JSON.stringify({ fixture: 1 }),
    sourceActivityId: "FIXTURE_TOOL_1",
  }]);
  expect(f01.title).toBe("FIXTURE_USER_ALPHA");

  const f05 = parsed(base, uuid(102), [
    message("user", "FIXTURE_USER_BETA", 11),
    message("assistant", [toolCall(2)], 12),
    message("user", [toolResult(2)], 13),
    message("assistant", [{ type: "text", text: "FIXTURE_ASSISTANT_GAMMA" }, toolCall(3)], 14),
  ]);
  expect(gx(f05.messages)).toEqual([4, 4, 3, 3, 2, 2, 2, 1, 1, 0, 0]);
  expect(f05.messages.map((item) => item.recordKind)).toEqual([
    "real_user", "tool", "tool", "assistant_dialogue_prose",
  ]);
  expect(f05.title).toBe("FIXTURE_USER_BETA");
});

test("F02 excludes exact caveat/command controls and chooses title in source order", () => {
  const base = root("controls");
  const id = uuid(201);
  const record = parsed(base, id, [
    message("user", "<local-command-caveat>Caveat: FIXTURE_CONTROL_ALPHA</local-command-caveat>", 24),
    message("user", "<command-message>FIXTURE_COMMAND</command-message>", 23),
    message("user", "FIXTURE_REAL_REQUEST", 22),
    message("assistant", "FIXTURE_REAL_RESPONSE", 21),
  ]);
  expect(gx(record.messages)).toEqual([4, 4, 0, 0, 4, 4, 2, 1, 1, 0, 0]);
  expect(record.messages.map((item) => item.recordKind)).toEqual([
    "control_context", "control_context", "real_user", "assistant_dialogue_prose",
  ]);
  expect(record.messages.map((item) => item.sourceOrdinal)).toEqual([0, 1, 2, 3]);
  expect(record.messages.map((item) => item.eventTs)).toEqual([24_000, 23_000, 22_000, 21_000]);
  expect(record.title).toBe("FIXTURE_REAL_REQUEST");
  expect(record.construction?.titleCandidates[0]).toMatchObject({
    value: "FIXTURE_REAL_REQUEST",
    authority: "real_user_fallback",
    sourceOrdinal: 2,
  });
});

test("F03/F04 retain lossless explicit title evidence and exact Claude precedence", () => {
  const base = root("titles");
  const titleScalar = "  FIXTURE_TITLE_ALPHA\nFIXTURE_TITLE_BETA  ";
  const f03 = parsed(base, uuid(301), [{ type: "ai-title", aiTitle: titleScalar }]);
  expect(gx(f03.messages)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(f03.construction).toMatchObject({ artifactKind: "metadata_shell", defaultSessionVisible: false });
  expect(f03.title).toBe(titleScalar);
  expect(f03.construction?.titleCandidates[0]).toEqual({
    value: titleScalar,
    authority: "source_explicit",
    harnessSourceClass: "ai-title",
    sourceRecordId: null,
    sourceReference: "ai-title.aiTitle",
    sourceOrdinal: 0,
    eligibilityRuleVersion: "claude-title-v1",
  });

  const variants = [
    [
      { type: "custom-title", customTitle: "FIXTURE_CUSTOM_A" },
      { type: "ai-title", aiTitle: "FIXTURE_AI_A" },
    ],
    [
      { type: "ai-title", aiTitle: "FIXTURE_AI_B" },
      { type: "custom-title", customTitle: "FIXTURE_CUSTOM_B" },
    ],
    [
      { type: "custom-title", customTitle: "FIXTURE_CUSTOM_C1" },
      { type: "ai-title", aiTitle: "FIXTURE_AI_C1" },
      { type: "custom-title", customTitle: "  FIXTURE_CUSTOM_C2  " },
      { type: "ai-title", aiTitle: "FIXTURE_AI_C2" },
    ],
    [
      { type: "ai-title", aiTitle: "FIXTURE_AI_D1" },
      { type: "ai-title", aiTitle: "FIXTURE_AI_D2" },
    ],
    [
      { type: "custom-title", customTitle: "FIXTURE_CUSTOM_E1" },
      { type: "ai-title", aiTitle: "FIXTURE_AI_E1" },
      { type: "custom-title", customTitle: "FIXTURE_CUSTOM_E2" },
      { type: "ai-title", aiTitle: "FIXTURE_AI_E2" },
    ],
  ];
  const expected = [
    "FIXTURE_CUSTOM_A",
    "FIXTURE_CUSTOM_B",
    "  FIXTURE_CUSTOM_C2  ",
    "FIXTURE_AI_D2",
    "FIXTURE_CUSTOM_E2",
  ];
  const records = variants.map((titles, index) => parsed(base, uuid(310 + index), [
    ...titles,
    message("user", `FIXTURE_USER_TITLE_${index}`, 40 + index * 2),
    message("assistant", `FIXTURE_ASSISTANT_TITLE_${index}`, 41 + index * 2),
  ]));
  for (let index = 0; index < records.length; index++) {
    expect(gx(records[index]!.messages)).toEqual([2, 2, 0, 0, 2, 2, 2, 1, 1, 0, 0]);
    expect(records[index]!.title).toBe(expected[index]);
  }
  expect(records[2]?.construction?.titleCandidates.map((candidate) => candidate.harnessSourceClass)).toEqual([
    "custom-title", "ai-title", "claude-real-user",
  ]);
  expect(records[3]?.construction?.titleCandidates[0]).toMatchObject({ value: "FIXTURE_AI_D2", sourceOrdinal: 1 });
  expect(gx(records.flatMap((record) => record.messages))).toEqual([10, 10, 0, 0, 10, 10, 10, 5, 5, 0, 0]);
});

test("F06/F07/F08 reject workflow journals and retain canonical empty/metadata shells", () => {
  const base = root("shells");
  const journal = source(base, "journal", "project/subagents/workflows/FIXTURE_FLOW/journal.jsonl");
  write(journal, Array.from({ length: 20 }, (_, index) => ({
    type: index % 2 === 0 ? "started" : "result",
    workflowId: `FIXTURE_WORKFLOW_${index}`,
  })));
  expect(claudeAdapter.admit?.(journal)).toMatchObject({
    admitted: false,
    reason: "auxiliary_workflow",
  });

  const empty = source(base, uuid(701));
  write(empty, []);
  const admittedEmpty = claudeAdapter.admit?.(empty);
  expect(admittedEmpty?.admitted).toBe(true);
  if (!admittedEmpty?.admitted) throw new Error("F07 must admit");
  expect(gx(admittedEmpty.record.messages)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(admittedEmpty.record).toMatchObject({ title: null, startTs: null, endTs: null, transcriptBytes: 0 });
  expect(admittedEmpty.record.construction).toMatchObject({
    artifactKind: "metadata_shell",
    historyCompleteness: "complete",
    defaultSessionVisible: false,
  });

  const families = ["file-history-snapshot", "progress", "summary", "system"];
  for (let index = 0; index < families.length; index++) {
    const id = uuid(801 + index);
    const shell = source(base, id);
    write(shell, [{ type: families[index], fixture: `FIXTURE_METADATA_${index}` }]);
    const admitted = claudeAdapter.admit?.(shell);
    expect(admitted?.admitted).toBe(true);
    if (!admitted?.admitted) throw new Error("F08 must admit");
    expect(gx(admitted.record.messages)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(admitted.record.continuityEvents).toEqual([]);
  }
});

test("F09/F10 classify only structured utilities and preserve linked responses", () => {
  const base = root("utility");
  const compactId = uuid(901);
  const compact = parsed(base, uuid(900), [
    message("user", "FIXTURE_COMPACT_REQUEST", 91, { isCompactSummary: true, uuid: compactId }),
    message("assistant", "FIXTURE_COMPACT_RESPONSE", 92, { parentUuid: compactId }),
  ]);
  expect(gx(compact.messages)).toEqual([2, 2, 0, 0, 2, 2, 0, 0, 0, 0, 0]);
  expect(compact.messages.map((item) => item.recordKind)).toEqual(["automatic_utility", "automatic_utility"]);
  expect(compact.title).toBeNull();

  const suggestion = parsed(base, uuid(902), [
    message("user", "FIXTURE_SUGGESTION", 93, { isSuggestion: true }),
  ]);
  expect(gx(suggestion.messages)).toEqual([1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]);

  const interruptedId = uuid(903);
  const interrupted = parsed(base, uuid(904), [
    message("user", "[Request interrupted by user for tool use]", 94, { uuid: interruptedId }),
    message("assistant", "FIXTURE_CONTROLLER_RESPONSE", 95, { parentUuid: interruptedId }),
  ]);
  expect(gx(interrupted.messages)).toEqual([2, 2, 0, 0, 2, 2, 0, 0, 0, 0, 0]);
  expect(interrupted.messages.map((item) => item.recordKind)).toEqual(["control_context", "automatic_utility"]);
  expect(gx([...suggestion.messages, ...interrupted.messages])).toEqual([3, 3, 0, 0, 3, 3, 0, 0, 0, 0, 0]);
});

test("a prompt typed after a local command stays dialogue; only responses inherit a control link", () => {
  const base = root("after-command");
  const stdoutId = uuid(1051);
  const compactId = uuid(1053);
  const session = parsed(base, uuid(1050), [
    message("user", "<local-command-stdout>Set model to opus</local-command-stdout>", 101, { uuid: stdoutId }),
    message("user", "FIXTURE_PROMPT_AFTER_MODEL", 102, { uuid: uuid(1052), parentUuid: stdoutId }),
    message("user", "FIXTURE_COMPACT_SUMMARY", 103, { isCompactSummary: true, uuid: compactId }),
    message("user", "FIXTURE_PROMPT_AFTER_COMPACT", 104, { uuid: uuid(1054), parentUuid: compactId }),
    message("assistant", "FIXTURE_REPLY_TO_CONTROL", 105, { parentUuid: stdoutId }),
  ]);
  expect(session.messages.map((item) => item.recordKind)).toEqual([
    "control_context", "real_user", "automatic_utility", "real_user", "automatic_utility",
  ]);
  expect(session.title).toBe("FIXTURE_PROMPT_AFTER_MODEL");
});

test("F11 Warmup text never decides utility without structured evidence", () => {
  const base = root("warmup");
  const s1 = parsed(base, uuid(1101), [message("user", "Warmup", 111, { utilityMode: "warmup-v1" })]);
  expect(gx(s1.messages)).toEqual([1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]);

  const s2 = parsed(base, uuid(1102), [
    message("user", "Warmup", 112, { isSidechain: true }),
    message("assistant", "FIXTURE_AGENT_HANDSHAKE", 113, { isSidechain: true }),
  ]);
  expect(gx(s2.messages)).toEqual([2, 2, 0, 0, 2, 2, 2, 1, 1, 0, 0]);
  expect(s2.title).toBe("Warmup");

  const utilityId = uuid(114);
  const s3 = parsed(base, uuid(1103), [
    message("user", "Warmup", 114, { utilityMode: "warmup-v1", uuid: utilityId }),
    message("assistant", "FIXTURE_UTILITY_RESPONSE", 115, { parentUuid: utilityId }),
    message("assistant", [toolCall(11)], 116, { utilityMode: "warmup-v1" }),
  ]);
  expect(gx(s3.messages)).toEqual([3, 3, 1, 1, 2, 2, 0, 0, 0, 0, 0]);
  expect(s3.messages.every((item) => item.recordKind === "automatic_utility")).toBe(true);
  expect(gx([...s1.messages, ...s2.messages, ...s3.messages])).toEqual([6, 6, 1, 1, 5, 5, 2, 1, 1, 0, 0]);
});

test("F12 retains one-sided dialogue and excludes tool-result-only title fallback", () => {
  const base = root("one-sided");
  const user = parsed(base, uuid(1201), [message("user", "FIXTURE_USER_ONLY", 121)]);
  expect(gx(user.messages)).toEqual([1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0]);
  expect(user.construction?.defaultSessionVisible).toBe(true);
  expect(user.title).toBe("FIXTURE_USER_ONLY");

  const assistant = parsed(base, uuid(1202), [message("assistant", "FIXTURE_ASSISTANT_ONLY", 122)]);
  expect(gx(assistant.messages)).toEqual([1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 0]);
  expect(assistant.construction?.defaultSessionVisible).toBe(true);
  expect(assistant.title).toBeNull();

  const tool = parsed(base, uuid(1203), [message("user", [toolResult(12)], 123)]);
  expect(gx(tool.messages)).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
  expect(tool.construction?.defaultSessionVisible).toBe(false);
  expect(tool.title).toBeNull();
  expect(gx([...user.messages, ...assistant.messages, ...tool.messages])).toEqual([3, 3, 1, 1, 2, 2, 2, 1, 1, 0, 0]);
});

test("Claude bounded parsing retries torn tails and rejects malformed complete records", () => {
  const base = root("bounded");
  const id = uuid(1301);
  const src = source(base, id);
  const complete = [
    message("user", "<command-message>FIXTURE_COMMAND</command-message>", 131),
    message("user", "FIXTURE_REAL", 132),
  ];
  write(src, complete, '{"type":"assistant"');
  const torn = claudeAdapter.parse(src);
  expect(torn.record.messages).toHaveLength(2);
  expect(torn.consumed).toBe(Buffer.byteLength(`${complete.map((item) => JSON.stringify(item)).join("\n")}\n`));

  write(src, complete, '{"type":}\n');
  expect(claudeAdapter.admit?.(src)).toMatchObject({
    admitted: false,
    reason: "malformed_complete_record",
  });
});

test("Claude preserves null event time without borrowing metadata, order, or mtime", () => {
  const base = root("null-time");
  const id = uuid(1351);
  const src = source(base, id);
  write(src, [{
    type: "user",
    uuid: uuid(1352),
    message: { role: "user", content: "FIXTURE_NULL_TIME_USER" },
  }]);
  const record = claudeAdapter.parse(src).record;
  expect(record.messages[0]).toMatchObject({
    sourceOrdinal: 0,
    eventTs: null,
    sourceRecordTs: null,
    sourceIdentityKind: "uuid",
  });
  expect(record).toMatchObject({ startTs: null, endTs: null, title: "FIXTURE_NULL_TIME_USER" });
});

test("Claude candidate bytes count semantic envelopes, not metadata volume", () => {
  const base = root("semantic-bytes");
  const idA = uuid(1401);
  const idB = uuid(1402);
  const a = parsed(base, idA, [
    { type: "progress", fixture: "FIXTURE_METADATA_SHORT" },
    message("user", "FIXTURE_EQUAL_SEMANTIC", 141),
  ]);
  const b = parsed(base, idB, [
    { type: "progress", fixture: "FIXTURE_METADATA_WITH_MORE_TRANSPORT_VOLUME_NOT_TRANSCRIPT" },
    message("user", "FIXTURE_EQUAL_SEMANTIC", 141),
  ]);
  expect(a.transcriptBytes).toBe(b.transcriptBytes);
  expect(a.transcriptBytes).toBeGreaterThan(0);
});


test("legacy flat project workers require matching structured agent and sole parent identity", () => {
  const base = root("flat-worker");
  const src = source(base, "agent-a9c8151", "project/agent-a9c8151.jsonl");
  const worker = message("user", "worker fixture", 1, { sessionId: uuid(90), agentId: "a9c8151", isSidechain: true });
  write(src, [worker]);
  const admitted = claudeAdapter.admit!(src);
  expect(admitted.admitted).toBe(true);
  if (admitted.admitted) {
    expect(admitted.record.nativeId).toBe("agent-a9c8151");
    expect(admitted.record.origin).toBe("agent");
  }
  for (const records of [
    [{ ...worker, agentId: "wrong" }],
    [{ ...worker, isSidechain: false }],
    [worker, { ...worker, sessionId: uuid(91) }],
    [{ ...worker, sessionId: "noncanonical" }],
  ]) {
    write(src, records);
    const rejected = claudeAdapter.admit!(src);
    expect(rejected.admitted).toBe(false);
    if (!rejected.admitted) expect(rejected.reason).toBe("identity_mismatch");
  }
});

test("a plan-handoff file whose own id owns its records is that session; a fork or copy is not", () => {
  const base = root("plan-handoff");
  const own = uuid(200), planner = uuid(201);
  const src = source(base, own);
  const handoff = message("user", "Implement the following plan: ...", 1, { sessionId: planner });
  const turns = Array.from({ length: 40 }, (_, i) => message(i % 2 ? "assistant" : "user", `turn ${i}`, 10 + i, { sessionId: own }));
  write(src, [handoff, ...turns]);
  const admitted = claudeAdapter.admit!(src);
  expect(admitted.admitted).toBe(true);
  if (admitted.admitted) expect(admitted.record.nativeId).toBe(own);

  // A copy of another session under a new filename, or an even mix, stays rejected.
  for (const records of [
    turns.map((turn) => ({ ...turn, sessionId: planner })),
    turns.map((turn, i) => ({ ...turn, sessionId: i % 2 ? planner : own })),
  ]) {
    write(src, records);
    const rejected = claudeAdapter.admit!(src);
    expect(rejected.admitted).toBe(false);
    if (!rejected.admitted) expect(rejected.reason).toBe("identity_mismatch");
  }
});
