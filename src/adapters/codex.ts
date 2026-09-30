import { readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type {
  Adapter,
  AdapterTitleCandidate,
  AdmissionResult,
  DiscoveredSource,
  IngestRecord,
  NormalizedMessage,
  NormalizedToolActivity,
  ParseResult,
  Role,
} from "./types.js";
import {
  MalformedJsonlLineError,
  resolveSessionOrigin,
  visitCompleteJsonlFile,
} from "./types.js";
import type { RecordKind } from "../contracts/construction.js";
import { gitRoot } from "./claude.js";

const CODEX_CLASSIFICATION_RULE = "codex-response-item-v1";
const CODEX_REPLAY_RULE = "codex-response-id+timestamp-v1";
const CODEX_TITLE_RULE = "codex-title-v1";
const CODEX_MODEL_HISTORY_RULE = "codex-model-history-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LineByteEvidence {
  offset: number;
  semantic: boolean;
}

interface TitleIndexEntry {
  value: string;
  sourceOrdinal: number;
}

interface CompletionEvidence {
  sourceOrdinal: number;
  turnOrdinal: number;
  responseId: string | null;
  role: "user" | "assistant" | null;
  prose: string | null;
}

interface PendingCodexRecord {
  sourceOrdinal: number;
  turnOrdinal: number;
  role: Role;
  ts: number | null;
  prose: string | null;
  toolText: string | null;
  toolActivities: NormalizedToolActivity[];
  responseId: string | null;
  responseRole: "user" | "assistant" | "developer" | "system" | null;
  fixedKind: RecordKind | null;
  identity: ReturnType<typeof recordIdentity>;
}

interface CodexUnitAnalysis {
  result: ParseResult;
  embeddedIds: Set<string>;
  forkIdentity: string | null;
  hasSessionMeta: boolean;
  hasResponseEvidence: boolean;
}

/**
 * Codex legacy and current-rollout adapter. `response_item` is the sole
 * content/tool authority; event/lifecycle association records can classify an
 * existing response item but never emit a duplicate raw record or activity.
 */
export const codexAdapter: Adapter = {
  source: "codex",
  continuitySupport: "unknown",
  sidecarVersion: `${CODEX_CLASSIFICATION_RULE}:${CODEX_REPLAY_RULE}:${CODEX_TITLE_RULE}:${CODEX_MODEL_HISTORY_RULE}:compact-v1`,
  sidecarContextFingerprint(src) {
    return codexTitleCandidates(src.nativeId, src.root);
  },

  discover(roots: string[]): DiscoveredSource[] {
    const out: DiscoveredSource[] = [];
    for (let rootOrdinal = 0; rootOrdinal < roots.length; rootOrdinal++) {
      const root = roots[rootOrdinal]!;
      registerCodexRoot(root);
      loadCodexTitleIndex(root);
      const top = readdirSync(root, { withFileTypes: true });
      const paths: string[] = [];
      for (const entry of top) {
        const full = join(root, entry.name);
        if (entry.isDirectory()) walkRollout(full, paths);
        else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) paths.push(full);
      }
      paths.sort();
      for (const fullPath of paths) {
        const relPath = relative(root, fullPath);
        const name = basename(fullPath);
        out.push({
          root,
          rootOrdinal,
          relPath,
          fullPath,
          nativeId: uuidFromName(name) ?? name.replace(/\.jsonl$/, ""),
          candidateKind: "codex-rollout-jsonl",
        });
      }
    }
    return out;
  },

  parse(src: DiscoveredSource): ParseResult {
    return parseCodexUnit(src).result;
  },

  admit(src: DiscoveredSource): AdmissionResult {
    let analysis: CodexUnitAnalysis;
    try {
      analysis = parseCodexUnit(src);
    } catch (error) {
      if (error instanceof MalformedJsonlLineError) {
        return reject(src, "malformed_complete_record", `byte_offset=${error.byteOffset}`);
      }
      throw error;
    }

    const embedded = [...analysis.embeddedIds];
    if (embedded.length > 1 && !analysis.forkIdentity) {
      return reject(src, "identity_mismatch", "conflicting-session-meta-identities");
    }
    const filenameId = uuidFromName(basename(src.fullPath));
    if (embedded[0] && filenameId && embedded[0] !== filenameId) {
      return reject(src, "identity_mismatch", "filename-session-meta-mismatch");
    }
    const hasAuthoritativeIdentity = embedded.length === 1 || analysis.forkIdentity !== null || (filenameId !== null && analysis.hasResponseEvidence);
    if (!hasAuthoritativeIdentity || (!analysis.hasSessionMeta && !analysis.hasResponseEvidence)) {
      return reject(src, "no_session_envelope", "no-canonical-codex-envelope");
    }
    return { admitted: true, ...analysis.result };
  },

  cleanup(): void {
    resetCodexCache();
  },
};

function parseCodexUnit(src: DiscoveredSource): CodexUnitAnalysis {
  let cwd: string | null = null;
  let explicitStartTs: number | null = null;
  let parentNativeId: string | null = null;
  let hasSessionMeta = false;
  let hasResponseEvidence = false;
  let physicalOrdinal = 0;
  let turnOrdinal = -1;
  const embeddedIds = new Set<string>();
  const models = new Set<string>();
  const metadataParents = new Map<string, Set<string | null>>();
  let currentIdentity: string | null = null;
  const pending: PendingCodexRecord[] = [];
  const completions: CompletionEvidence[] = [];
  const lineBytes: LineByteEvidence[] = [];
  const agentSignals = new Set<string>();
  const humanSignals = new Set<string>();

  const consumed = visitCompleteJsonlFile(src.fullPath, (line) => {
    const sourceOrdinal = physicalOrdinal++;
    const byteEvidence: LineByteEvidence = { offset: line.byteOffset, semantic: false };
    lineBytes.push(byteEvidence);
    if (!isRecord(line.value)) return;
    const rec = line.value;
    const type = stringValue(rec.type);
    const payload = isRecord(rec.payload) ? rec.payload : null;
    const ts = parseTs(rec.timestamp);
    // Observed history, not a current-model election: forked rollouts can retain
    // ancestor turn/header models after the current thread's opening header.
    const model = recordedModel(type, payload);
    if (model) models.add(model);

    if (type === "session_meta" && payload) {
      hasSessionMeta = true;
      const embeddedId = stringValue(payload.id);
      if (embeddedId) {
        embeddedIds.add(embeddedId);
        currentIdentity ??= embeddedId;
        const parents = metadataParents.get(embeddedId) ?? new Set<string | null>();
        parents.add(stringValue(payload.forked_from_id));
        metadataParents.set(embeddedId, parents);
      }
      // Native fork rollouts replay ancestor metadata after the current header.
      // Preserve the current thread's origin/cwd; inherited dialogue stays intact.
      if (currentIdentity && embeddedId !== currentIdentity) return;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      if (explicitStartTs === null && ts !== null) explicitStartTs = ts;
      const origin = payload.source;
      if (typeof origin === "string") {
        const normalized = origin.trim().toLowerCase();
        if (normalized === "cli" || normalized === "vscode") {
          humanSignals.add(`codex:source:${normalized}`);
        } else if (normalized === "exec" || normalized === "sdk" || normalized === "api") {
          agentSignals.add(`codex:source:${normalized}`);
        }
      } else if (isRecord(origin)) {
        const subagent = isRecord(origin.subagent) ? origin.subagent : null;
        const spawn = subagent && isRecord(subagent.thread_spawn) ? subagent.thread_spawn : null;
        if (spawn) {
          agentSignals.add("codex:subagent.thread_spawn");
          const parent = stringValue(spawn.parent_thread_id);
          if (parent) parentNativeId = parent;
        }
      }
      const directParent = stringValue(payload.parent_thread_id);
      if (directParent) parentNativeId = directParent;
      return;
    }

    if (type === "turn_context") {
      turnOrdinal++;
      pending.push(controlRecord(rec, payload, sourceOrdinal, turnOrdinal, ts));
      byteEvidence.semantic = true;
      return;
    }
    if (type === "world_state") {
      pending.push(controlRecord(rec, payload, sourceOrdinal, turnOrdinal, ts));
      byteEvidence.semantic = true;
      return;
    }

    if (type === "event_msg" && payload) {
      const eventType = stringValue(payload.type);
      if (eventType === "task_started") turnOrdinal++;
      if (eventType === "item_completed") {
        completions.push(completionEvidence(payload, sourceOrdinal, turnOrdinal));
      }
      // task lifecycle, token_count, and item completion are dedicated
      // evidence/census records and never canonical raw provenance.
      return;
    }

    if (type !== "response_item" || !payload) return;
    hasResponseEvidence = true;
    const payloadType = stringValue(payload.type);
    const identity = recordIdentity(rec, payload, ts);
    const responseId = identity.sourceRecordId;

    if (payloadType === "message") {
      const responseRole = codexResponseRole(payload.role);
      const extracted = extractCodexMessage(payload.content);
      const fixedKind = responseRole === "developer" || responseRole === "system"
        ? "developer_system" as const
        : responseRole === "user" && isCodexControlUser(payload, extracted.prose)
          ? "control_context" as const
          : extracted.toolActivities.length > 0 && !nonblank(extracted.prose)
            ? "tool" as const
            : null;
      pending.push({
        sourceOrdinal,
        turnOrdinal,
        role: responseRole === "assistant" ? "assistant" : responseRole === "user" ? "user" : "system",
        ts,
        prose: extracted.prose,
        toolText: extracted.toolText,
        toolActivities: extracted.toolActivities,
        responseId,
        responseRole,
        fixedKind,
        identity,
      });
      byteEvidence.semantic = true;
      return;
    }

    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const activity = codexToolActivity(payload, "call");
      pending.push({
        sourceOrdinal,
        turnOrdinal,
        role: "tool",
        ts,
        prose: null,
        toolText: activity.toolText,
        toolActivities: [activity],
        responseId,
        responseRole: null,
        fixedKind: "tool",
        identity,
      });
      byteEvidence.semantic = true;
      return;
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const activity = codexToolActivity(payload, "result");
      pending.push({
        sourceOrdinal,
        turnOrdinal,
        role: "tool",
        ts,
        prose: null,
        toolText: activity.toolText,
        toolActivities: [activity],
        responseId,
        responseRole: null,
        fixedKind: "tool",
        identity,
      });
      byteEvidence.semantic = true;
      return;
    }

    if (payloadType === "reasoning") {
      pending.push({
        sourceOrdinal,
        turnOrdinal,
        role: "system",
        ts,
        prose: null,
        toolText: null,
        toolActivities: [],
        responseId,
        responseRole: null,
        fixedKind: "control_context",
        identity,
      });
      byteEvidence.semantic = true;
    }
  });

  const associated = associateCompletions(pending, completions);
  const messages: NormalizedMessage[] = pending.map((item, index) => {
    const recordKind = item.fixedKind ?? classifyCodexMessage(item, associated);
    const dialogueSide = recordKind === "real_user"
      ? "user" as const
      : recordKind === "assistant_dialogue_prose"
        ? "assistant" as const
        : null;
    return {
      ordinal: index,
      sourceOrdinal: item.sourceOrdinal,
      role: compatibilityRole(item.role, recordKind),
      ts: item.ts,
      text: item.prose,
      toolText: item.toolText,
      hasTool: item.toolActivities.length > 0,
      recordKind,
      dialogueSide,
      prose: item.prose,
      eventTs: item.ts,
      toolActivities: item.toolActivities,
      ...item.identity,
    };
  });

  const forkIdentity = verifiedForkIdentity(currentIdentity, metadataParents);
  const nativeId = embeddedIds.size === 1 ? [...embeddedIds][0]! : forkIdentity ?? src.nativeId;
  const firstRealUser = messages.find((message) =>
    message.recordKind === "real_user" && nonblank(message.prose));
  const titleCandidates = codexTitleCandidates(nativeId, src.root);
  if (firstRealUser?.prose !== null && firstRealUser?.prose !== undefined) {
    titleCandidates.push({
      value: firstRealUser.prose,
      authority: "real_user_fallback",
      harnessSourceClass: "codex-real-user",
      sourceRecordId: firstRealUser.sourceRecordId ?? null,
      sourceReference: "response_item.message.content",
      sourceOrdinal: firstRealUser.sourceOrdinal ?? null,
      eligibilityRuleVersion: CODEX_TITLE_RULE,
    });
  }

  const rawTimes = messages
    .map((message) => message.eventTs ?? null)
    .filter((value): value is number => value !== null);
  const startTs = explicitStartTs ?? (rawTimes.length > 0 ? Math.min(...rawTimes) : null);
  const endTs = rawTimes.length > 0 ? Math.max(...rawTimes) : null;
  const dialogueVisible = messages.some((message) =>
    (message.recordKind === "real_user" || message.recordKind === "assistant_dialogue_prose")
      && nonblank(message.prose));
  const project = cwd ? gitRoot(cwd) : null;
  const provenance = resolveSessionOrigin(agentSignals, humanSignals);
  const record: IngestRecord = {
    nativeId,
    cwd,
    project,
    title: titleCandidates[0]?.value ?? null,
    startTs,
    endTs,
    models: [...models],
    messages,
    transcriptBytes: semanticBytes(lineBytes, consumed),
    parentNativeId,
    origin: provenance.origin,
    originDetail: provenance.detail,
    continuityEvents: [],
    continuitySupport: "unknown",
    construction: {
      artifactKind: messages.length === 0 ? "metadata_shell" : "dialogue_history",
      historyCompleteness: "complete",
      defaultSessionVisible: dialogueVisible,
      sourceValidationStatus: "current",
      sourceObservedTs: null,
      project: {
        originalProjectKey: cwd,
        canonicalProjectKey: project,
        canonicalizationRuleVersion: project ? "codex-project-v1" : null,
      },
      titleCandidates,
      classificationRuleVersion: CODEX_CLASSIFICATION_RULE,
      replayRuleVersion: CODEX_REPLAY_RULE,
    },
  };

  return {
    result: { record, consumed },
    embeddedIds,
    forkIdentity,
    hasSessionMeta,
    hasResponseEvidence,
  };
}

function recordedModel(type: string | null, payload: Record<string, unknown> | null): string | null {
  if ((type !== "session_meta" && type !== "turn_context") || !payload) return null;
  return stringValue(payload.model)?.trim() || null;
}

/** Bounded metadata-only refresh; no transcript construction or provider access. */
export function readCodexModelHistory(path: string): string[] {
  const models = new Set<string>();
  visitCompleteJsonlFile(path, ({ value }) => {
    if (!isRecord(value)) return;
    const model = recordedModel(stringValue(value.type), isRecord(value.payload) ? value.payload : null);
    if (model) models.add(model);
  });
  return [...models];
}

/** Every foreign metadata identity must be an explicitly linked fork ancestor. */
function verifiedForkIdentity(current: string | null, parents: Map<string, Set<string | null>>): string | null {
  if (!current || parents.size < 2) return null;
  const visited = new Set<string>();
  let cursor: string | null = current;
  while (cursor && parents.has(cursor)) {
    if (visited.has(cursor)) return null;
    visited.add(cursor);
    const links: Set<string | null> = parents.get(cursor)!;
    if (links.size !== 1) return null;
    cursor = [...links][0]!;
  }
  return visited.size === parents.size ? current : null;
}

function controlRecord(
  rec: Record<string, unknown>,
  payload: Record<string, unknown> | null,
  sourceOrdinal: number,
  turnOrdinal: number,
  ts: number | null,
): PendingCodexRecord {
  return {
    sourceOrdinal,
    turnOrdinal,
    role: "system",
    ts,
    prose: null,
    toolText: null,
    toolActivities: [],
    responseId: null,
    responseRole: null,
    fixedKind: "control_context",
    identity: recordIdentity(rec, payload ?? {}, ts),
  };
}

function classifyCodexMessage(
  item: PendingCodexRecord,
  associated: Set<PendingCodexRecord>,
): RecordKind {
  if (item.responseRole === "user" && nonblank(item.prose)) {
    // Completion association is positive intent evidence. Legacy response-item
    // users without such an event remain eligible after exact exclusions.
    void associated.has(item);
    return "real_user";
  }
  if (item.responseRole === "assistant" && nonblank(item.prose)) {
    return "assistant_dialogue_prose";
  }
  if (item.toolActivities.length > 0) return "tool";
  return "unclassified";
}

function completionEvidence(
  payload: Record<string, unknown>,
  sourceOrdinal: number,
  turnOrdinal: number,
): CompletionEvidence {
  const item = isRecord(payload.item) ? payload.item : null;
  const itemType = item ? stringValue(item.type) : stringValue(payload.item_type);
  const normalizedType = itemType?.replaceAll("_", "").toLowerCase() ?? null;
  const role = normalizedType === "usermessage"
    ? "user" as const
    : normalizedType === "agentmessage"
      ? "assistant" as const
      : null;
  const responseId = firstString(
    item?.response_item_id,
    item?.responseItemId,
    payload.response_item_id,
    payload.item_id,
    item?.id,
  );
  const content = item?.content ?? item?.text ?? payload.content;
  return { sourceOrdinal, turnOrdinal, responseId, role, prose: joinTextBlocks(content) };
}

function associateCompletions(
  pending: PendingCodexRecord[],
  completions: CompletionEvidence[],
): Set<PendingCodexRecord> {
  const associated = new Set<PendingCodexRecord>();
  for (const completion of completions) {
    if (!completion.role) continue;
    let match: PendingCodexRecord | undefined;
    if (completion.responseId) {
      match = pending.find((candidate) =>
        candidate.responseId === completion.responseId
        && candidate.responseRole === completion.role);
    }
    if (!match && completion.turnOrdinal >= 0 && completion.prose !== null) {
      match = [...pending].reverse().find((candidate) =>
        candidate.sourceOrdinal < completion.sourceOrdinal
        && candidate.turnOrdinal === completion.turnOrdinal
        && candidate.responseRole === completion.role
        && candidate.prose === completion.prose
        && !associated.has(candidate));
    }
    if (match) associated.add(match);
  }
  return associated;
}

function extractCodexMessage(content: unknown): {
  prose: string | null;
  toolText: string | null;
  toolActivities: NormalizedToolActivity[];
} {
  if (typeof content === "string") return { prose: content, toolText: null, toolActivities: [] };
  if (!Array.isArray(content)) return { prose: null, toolText: null, toolActivities: [] };
  const proseParts: string[] = [];
  const toolActivities: NormalizedToolActivity[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      proseParts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    const type = stringValue(block.type);
    if (typeof block.text === "string" && !isToolOutputBlock(type)) {
      proseParts.push(block.text);
    } else if (isToolOutputBlock(type)) {
      const text = typeof block.text === "string" ? block.text : sourceBackedScalar(block.content);
      toolActivities.push({
        activityOrdinal: toolActivities.length,
        activityKind: "result",
        toolName: stringValue(block.name),
        toolText: text,
        sourceActivityId: firstString(block.call_id, block.id),
      });
    }
  }
  const prose = proseParts.length > 0 ? proseParts.join("\n") : null;
  const toolParts = toolActivities
    .map((activity) => activity.toolText)
    .filter((value): value is string => value !== null);
  return {
    prose,
    toolText: toolParts.length > 0 ? toolParts.join("\n") : null,
    toolActivities,
  };
}

function codexToolActivity(
  payload: Record<string, unknown>,
  activityKind: "call" | "result",
): NormalizedToolActivity {
  const value = activityKind === "call"
    ? payload.arguments ?? payload.input
    : payload.output;
  return {
    activityOrdinal: 0,
    activityKind,
    toolName: activityKind === "call" ? stringValue(payload.name) : null,
    toolText: sourceBackedScalar(value),
    sourceActivityId: firstString(payload.call_id, payload.id),
  };
}

function isCodexControlUser(payload: Record<string, unknown>, prose: string | null): boolean {
  const metadata = isRecord(payload.metadata) ? payload.metadata : null;
  const structural = firstString(payload.context_kind, metadata?.kind, metadata?.source);
  if (structural && [
    "agents_instructions",
    "environment_context",
    "project_context",
    "injected_context",
    "turn_abort",
  ].includes(structural)) return true;
  if (prose === null) return false;
  const trimmed = prose.trim();
  if (/^# AGENTS\.md instructions for [^\n]+(?:\n|$)/.test(trimmed)) return true;
  if (/^<(?:environment_context|project_context|developer_instructions)>[\s\S]*<\/(?:environment_context|project_context|developer_instructions)>$/.test(trimmed)) return true;
  return trimmed === "<turn_aborted>" || /^<turn_aborted>[\s\S]*<\/turn_aborted>$/.test(trimmed);
}

function codexResponseRole(value: unknown): PendingCodexRecord["responseRole"] {
  if (value === "user") return "user";
  if (value === "assistant") return "assistant";
  if (value === "developer") return "developer";
  if (value === "system") return "system";
  return null;
}

function compatibilityRole(sourceRole: Role, recordKind: RecordKind): Role {
  if (recordKind === "tool") return "tool";
  if (recordKind === "developer_system" || recordKind === "control_context") return "system";
  return sourceRole;
}

function recordIdentity(
  rec: Record<string, unknown>,
  payload: Record<string, unknown>,
  ts: number | null,
): {
  sourceRecordId: string | null;
  sourceRecordUuid: string | null;
  sourceRecordTs: number | null;
  sourceIdentityKind: "uuid" | "record-id" | "none";
} {
  const id = firstString(rec.id, payload.id, payload.item_id);
  if (!id) {
    return { sourceRecordId: null, sourceRecordUuid: null, sourceRecordTs: ts, sourceIdentityKind: "none" };
  }
  const uuid = UUID.test(id) ? id : null;
  return {
    sourceRecordId: id,
    sourceRecordUuid: uuid,
    sourceRecordTs: ts,
    sourceIdentityKind: uuid ? "uuid" : "record-id",
  };
}

function semanticBytes(lines: LineByteEvidence[], consumed: number): number {
  let total = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.semantic) continue;
    const next = lines[index + 1]?.offset ?? consumed;
    total += Math.max(0, next - line.offset);
  }
  return total;
}

function joinTextBlocks(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function isToolOutputBlock(type: string | null): boolean {
  return type === "tool_result" || type === "tool_output" || type === "function_call_output";
}

function sourceBackedScalar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return null;
  try { return JSON.stringify(value); } catch { return null; }
}

function parseTs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const string = stringValue(value);
    if (string) return string;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uuidFromName(name: string): string | null {
  return name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] ?? null;
}

function walkRollout(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkRollout(full, out);
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) out.push(full);
  }
}

const titleIndexes = new Map<string, Map<string, TitleIndexEntry>>();
const discoveredRootOrder: string[] = [];

function registerCodexRoot(root: string): void {
  if (!discoveredRootOrder.includes(root)) discoveredRootOrder.push(root);
}

/**
 * Refresh one root-local title index. A later complete duplicate wins within
 * that stream. The map is installed only after a successful bounded visit, so
 * malformed complete rows cannot advance cached state.
 */
export function loadCodexTitleIndex(root: string): void {
  registerCodexRoot(root);
  const next = new Map<string, TitleIndexEntry>();
  let sourceOrdinal = 0;
  try {
    visitCompleteJsonlFile(join(root, "session_index.jsonl"), (line) => {
      const ordinal = sourceOrdinal++;
      if (!isRecord(line.value)) return;
      const id = stringValue(line.value.id);
      const value = typeof line.value.thread_name === "string" ? line.value.thread_name : null;
      if (id && value !== null && nonblank(value)) next.set(id, { value, sourceOrdinal: ordinal });
    });
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code === "string") {
      titleIndexes.set(root, new Map());
      return;
    }
    throw error;
  }
  titleIndexes.set(root, next);
}

function codexTitleCandidates(nativeId: string, electedRoot: string): AdapterTitleCandidate[] {
  const roots = [electedRoot, ...discoveredRootOrder.filter((root) => root !== electedRoot)];
  for (const root of roots) {
    const entry = titleIndexes.get(root)?.get(nativeId);
    if (!entry) continue;
    return [{
      value: entry.value,
      authority: "source_explicit",
      harnessSourceClass: "session_index.thread_name",
      sourceRecordId: nativeId,
      sourceReference: "session_index.jsonl",
      sourceOrdinal: entry.sourceOrdinal,
      eligibilityRuleVersion: CODEX_TITLE_RULE,
    }];
  }
  return [];
}

/** Test/run boundary: no root or identity title state survives cleanup. */
export function resetCodexCache(): void {
  titleIndexes.clear();
  discoveredRootOrder.splice(0);
}

function reject(
  source: DiscoveredSource,
  reason: "no_session_envelope" | "malformed_complete_record" | "identity_mismatch",
  detail: string,
): AdmissionResult {
  return { admitted: false, source, reason, detail };
}

export { gitRoot };
