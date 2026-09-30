import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { homedir } from "node:os";
import type {
  Adapter,
  AdapterTitleCandidate,
  AdmissionResult,
  ContinuityEventEvidence,
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

// v2: a prompt typed after a local command stays dialogue (only responses
// inherit a control link). Bumping this reparses every Claude sidecar.
const CLAUDE_CLASSIFICATION_RULE = "claude-record-v2";
const CLAUDE_REPLAY_RULE = "claude-uuid+timestamp-v1";
const CLAUDE_TITLE_RULE = "claude-title-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LineByteEvidence {
  offset: number;
  semantic: boolean;
}

interface ClaudeUnitAnalysis {
  result: ParseResult;
  completeRecordCount: number;
  workflowRecordCount: number;
  recognizedSessionEvidence: boolean;
  byteEmpty: boolean;
  sessionIds: Set<string>;
  /** Records carrying each embedded sessionId. */
  sessionIdCounts: Map<string, number>;
  agentIds: Set<string>;
  sidechainTrue: boolean;
  sidechainFalse: boolean;
}

interface ExtractedClaudeContent {
  prose: string | null;
  toolText: string | null;
  toolActivities: NormalizedToolActivity[];
  hasThinking: boolean;
}

interface ExplicitTitleEvidence extends AdapterTitleCandidate {
  sourceOrdinal: number;
}

/**
 * Claude Code adapter.
 *
 * Discovery deliberately reports physical JSONL candidates. Admission then
 * applies the session-envelope law, so auxiliary journals remain visible as
 * rejected physical evidence without becoming sessions. Parsing is bounded,
 * complete-line-only, and read-only.
 */
export const claudeAdapter: Adapter = {
  source: "claude",
  continuitySupport: "supported",
  sidecarVersion: `${CLAUDE_CLASSIFICATION_RULE}:${CLAUDE_REPLAY_RULE}:${CLAUDE_TITLE_RULE}:compact-v1`,
  admissionVersion: "claude-admission-v2-dominant-own-id",

  discover(roots: string[]): DiscoveredSource[] {
    const out: DiscoveredSource[] = [];
    for (let rootOrdinal = 0; rootOrdinal < roots.length; rootOrdinal++) {
      const root = roots[rootOrdinal]!;
      const top = readdirSync(root, { withFileTypes: true });
      const paths: string[] = [];
      for (const entry of top) {
        const full = join(root, entry.name);
        if (entry.isDirectory()) walkJsonl(full, paths);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(full);
      }
      paths.sort();
      for (const fullPath of paths) {
        const relPath = relative(root, fullPath);
        out.push({
          root,
          rootOrdinal,
          relPath,
          fullPath,
          nativeId: basename(fullPath).replace(/\.jsonl$/, ""),
          candidateKind: "claude-jsonl",
        });
      }
    }
    return out;
  },

  parse(src: DiscoveredSource): ParseResult {
    return parseClaudeUnit(src).result;
  },

  admit(src: DiscoveredSource): AdmissionResult {
    let analysis: ClaudeUnitAnalysis;
    try {
      analysis = parseClaudeUnit(src);
    } catch (error) {
      if (error instanceof MalformedJsonlLineError) {
        return reject(src, "malformed_complete_record", `byte_offset=${error.byteOffset}`);
      }
      throw error;
    }

    const journalPath = isWorkflowJournalPath(src.relPath);
    const workflowOnly = analysis.completeRecordCount > 0
      && analysis.workflowRecordCount === analysis.completeRecordCount;
    if (journalPath || workflowOnly) {
      return reject(src, "auxiliary_workflow", "claude-workflow-journal");
    }

    // Native subagent files carry the parent sessionId, not their own filename
    // identity. Require agreement among the canonical path and both envelopes;
    // never collapse the worker into its parent's session.
    const parts = src.fullPath.split(/[\\/]/);
    const parentId = parts.at(-3) ?? "";
    const nestedWorker = parts.at(-2) === "subagents" && UUID.test(parentId)
      && analysis.sessionIds.has(parentId);
    // Older Claude builds kept worker transcripts directly beside project
    // sessions. There is no directory-level parent claim in that layout.
    const flatWorker = src.relPath.split(/[\\/]/).length === 2 && parts.at(-2) !== "subagents"
      && [...analysis.sessionIds].every(id => UUID.test(id));
    const canonicalWorker = (nestedWorker || flatWorker)
      && /^agent-[a-z0-9][a-z0-9-]*$/i.test(src.nativeId)
      && analysis.sessionIds.size === 1
      && analysis.agentIds.size === 1 && analysis.agentIds.has(src.nativeId.slice(6))
      && analysis.sidechainTrue && !analysis.sidechainFalse;
    // Plan handoffs: Claude starts the new session's file with a record or two
    // stamped with the planning session's id, then everything else is the new
    // session's own. The file is that session when its own id owns the records.
    const ownRecords = analysis.sessionIdCounts.get(src.nativeId) ?? 0;
    const idRecords = [...analysis.sessionIdCounts.values()].reduce((sum, n) => sum + n, 0);
    const dominantOwn = UUID.test(src.nativeId) && ownRecords > 0 && ownRecords >= 0.95 * idRecords;
    if (!canonicalWorker && !dominantOwn && [...analysis.sessionIds].some((id) => id !== src.nativeId)) {
      return reject(src, "identity_mismatch", "filename-sessionId-mismatch");
    }

    // A zero-byte UUID locator has independent canonical identity. A torn-only
    // or arbitrary empty side file does not.
    const canonicalEmpty = analysis.byteEmpty && UUID.test(src.nativeId);
    if (!canonicalEmpty && !analysis.recognizedSessionEvidence) {
      return reject(src, "no_session_envelope", "no-recognized-claude-envelope");
    }
    return { admitted: true, ...analysis.result };
  },
};

function parseClaudeUnit(src: DiscoveredSource): ClaudeUnitAnalysis {
  let cwd: string | null = null;
  const models = new Set<string>();
  const messages: NormalizedMessage[] = [];
  const agentSignals = new Set<string>();
  const humanSignals = new Set<string>();
  const continuityEvents: ContinuityEventEvidence[] = [];
  const sessionIds = new Set<string>();
  const sessionIdCounts = new Map<string, number>();
  const agentIds = new Set<string>();
  let sidechainTrue = false;
  let sidechainFalse = false;
  const lineBytes: LineByteEvidence[] = [];
  const customTitles: ExplicitTitleEvidence[] = [];
  const aiTitles: ExplicitTitleEvidence[] = [];
  const utilityRequestIds = new Set<string>();
  const nonDialogueRequestIds = new Set<string>();
  const subagentPath = src.relPath.split(/[\\/]/).includes("subagents");
  if (subagentPath) agentSignals.add("claude:subagents-path");

  let completeRecordCount = 0;
  let workflowRecordCount = 0;
  let recognizedSessionEvidence = false;
  let physicalOrdinal = 0;

  const consumed = visitCompleteJsonlFile(src.fullPath, (line) => {
    const sourceOrdinal = physicalOrdinal++;
    completeRecordCount++;
    const byteEvidence: LineByteEvidence = { offset: line.byteOffset, semantic: false };
    lineBytes.push(byteEvidence);

    if (!isRecord(line.value)) return;
    const rec = line.value;
    const type = stringValue(rec.type);
    if (type === "started" || type === "result") workflowRecordCount++;
    if (isRecognizedClaudeEvidenceType(type)) recognizedSessionEvidence = true;

    const embeddedSessionId = stringValue(rec.sessionId);
    if (embeddedSessionId) {
      sessionIds.add(embeddedSessionId);
      sessionIdCounts.set(embeddedSessionId, (sessionIdCounts.get(embeddedSessionId) ?? 0) + 1);
    }
    const embeddedAgentId = stringValue(rec.agentId);
    if (embeddedAgentId) agentIds.add(embeddedAgentId);
    if (rec.isSidechain === true) sidechainTrue = true;
    if (rec.isSidechain === false) sidechainFalse = true;

    const continuity = claudeContinuityEvidence(rec, sourceOrdinal);
    if (continuity) continuityEvents.push(continuity);

    collectClaudeOrigin(rec, subagentPath, agentSignals, humanSignals);
    if (!cwd && typeof rec.cwd === "string") cwd = rec.cwd;

    if (type === "custom-title" && typeof rec.customTitle === "string" && nonblank(rec.customTitle)) {
      customTitles.push(titleCandidate(
        rec.customTitle,
        "custom-title",
        recordIdentity(rec, parseTs(rec.timestamp)).sourceRecordId,
        sourceOrdinal,
        "custom-title.customTitle",
      ));
      return;
    }
    if (type === "ai-title" && typeof rec.aiTitle === "string" && nonblank(rec.aiTitle)) {
      aiTitles.push(titleCandidate(
        rec.aiTitle,
        "ai-title",
        recordIdentity(rec, parseTs(rec.timestamp)).sourceRecordId,
        sourceOrdinal,
        "ai-title.aiTitle",
      ));
      return;
    }

    if (type !== "user" && type !== "assistant") return;
    const msg = isRecord(rec.message) ? rec.message : null;
    if (!msg) return;
    recognizedSessionEvidence = true;

    const role = normalizeRole(msg.role);
    if (typeof msg.model === "string" && nonblank(msg.model)) models.add(msg.model);
    const ts = parseTs(rec.timestamp);
    const identity = recordIdentity(rec, ts);
    const content = extractClaudeContent(msg.content);
    const explicitUtility = claudeUtilityDiscriminator(rec, msg, content.prose);
    const linkedParent = stringValue(rec.parentUuid);
    // Only a response inherits utility from its request (contract: assistant
    // text "source-linked to a proved utility"). A person's next prompt chains
    // to the previous record too, e.g. the stdout of /model or /compact, and it
    // stays dialogue on its own evidence.
    const linkedUtility = role === "assistant" && linkedParent !== null
      && (utilityRequestIds.has(linkedParent) || nonDialogueRequestIds.has(linkedParent));
    const control = role === "user" && isClaudeControl(content.prose);
    const recordKind = classifyClaudeRecord(
      role,
      content.prose,
      content.toolActivities.length > 0,
      content.hasThinking,
      control,
      explicitUtility || linkedUtility,
    );

    const sourceUuid = stringValue(rec.uuid);
    if (role === "user" && sourceUuid) {
      if (recordKind === "automatic_utility") utilityRequestIds.add(sourceUuid);
      if (recordKind === "control_context") nonDialogueRequestIds.add(sourceUuid);
    }

    const dialogueSide = recordKind === "real_user"
      ? "user" as const
      : recordKind === "assistant_dialogue_prose"
        ? "assistant" as const
        : null;
    const toolText = content.toolText;
    const normalizedRole = compatibilityRole(role, recordKind);
    messages.push({
      ordinal: messages.length,
      sourceOrdinal,
      role: normalizedRole,
      ts,
      text: content.prose,
      toolText,
      hasTool: content.toolActivities.length > 0,
      recordKind,
      dialogueSide,
      prose: content.prose,
      eventTs: ts,
      toolActivities: content.toolActivities,
      ...identity,
    });
    byteEvidence.semantic = true;
  });

  const firstRealUser = messages.find((message) =>
    message.recordKind === "real_user" && nonblank(message.prose));
  const titleCandidates: AdapterTitleCandidate[] = [];
  const custom = customTitles.at(-1);
  const ai = aiTitles.at(-1);
  if (custom) titleCandidates.push(custom);
  if (ai) titleCandidates.push(ai);
  if (firstRealUser?.prose !== null && firstRealUser?.prose !== undefined) {
    titleCandidates.push({
      value: firstRealUser.prose,
      authority: "real_user_fallback",
      harnessSourceClass: "claude-real-user",
      sourceRecordId: firstRealUser.sourceRecordId ?? null,
      sourceReference: "message.content",
      sourceOrdinal: firstRealUser.sourceOrdinal ?? null,
      eligibilityRuleVersion: CLAUDE_TITLE_RULE,
    });
  }

  const effectiveTitle = titleCandidates[0]?.value ?? null;
  const dialogueVisible = messages.some((message) =>
    (message.recordKind === "real_user" || message.recordKind === "assistant_dialogue_prose")
      && nonblank(message.prose));
  const times = messages
    .map((message) => message.eventTs ?? null)
    .filter((value): value is number => value !== null);
  const project = cwd ? gitRoot(cwd) : null;
  const originalProjectKey = claudeProjectDirectory(src.relPath);
  const provenance = resolveSessionOrigin(agentSignals, humanSignals);
  const transcriptBytes = semanticBytes(lineBytes, consumed);
  const record: IngestRecord = {
    nativeId: src.nativeId,
    cwd,
    project,
    title: effectiveTitle,
    startTs: times.length > 0 ? Math.min(...times) : null,
    endTs: times.length > 0 ? Math.max(...times) : null,
    models: [...models],
    messages,
    transcriptBytes,
    origin: provenance.origin,
    originDetail: provenance.detail,
    continuityEvents,
    continuitySupport: "supported",
    construction: {
      artifactKind: messages.length === 0 ? "metadata_shell" : "dialogue_history",
      historyCompleteness: "complete",
      defaultSessionVisible: dialogueVisible,
      sourceValidationStatus: "current",
      sourceObservedTs: null,
      project: {
        originalProjectKey,
        canonicalProjectKey: project,
        canonicalizationRuleVersion: project ? "claude-project-v1" : null,
      },
      titleCandidates,
      classificationRuleVersion: CLAUDE_CLASSIFICATION_RULE,
      replayRuleVersion: CLAUDE_REPLAY_RULE,
    },
  };

  return {
    result: { record, consumed },
    completeRecordCount,
    workflowRecordCount,
    recognizedSessionEvidence,
    byteEmpty: statSync(src.fullPath).size === 0,
    sessionIds,
    sessionIdCounts,
    agentIds,
    sidechainTrue,
    sidechainFalse,
  };
}

function collectClaudeOrigin(
  rec: Record<string, unknown>,
  subagentPath: boolean,
  agentSignals: Set<string>,
  humanSignals: Set<string>,
): void {
  const promptSource = stringValue(rec.promptSource)?.trim().toLowerCase() ?? null;
  const entrypoint = stringValue(rec.entrypoint)?.trim().toLowerCase() ?? null;
  const hasAgentId = nonblank(stringValue(rec.agentId));
  if (rec.isSidechain === true) agentSignals.add("claude:isSidechain");
  if (hasAgentId) agentSignals.add("claude:agentId");
  if (promptSource?.includes("sdk")) agentSignals.add(`claude:promptSource:${promptSource}`);
  if (entrypoint?.includes("sdk")) agentSignals.add(`claude:entrypoint:${entrypoint}`);
  if (
    !subagentPath
    && rec.isSidechain === false
    && !hasAgentId
    && entrypoint === "cli"
    && (promptSource === null || promptSource === "typed")
  ) {
    humanSignals.add("claude:direct-cli");
  }
}

function classifyClaudeRecord(
  role: Role,
  prose: string | null,
  hasTool: boolean,
  hasThinking: boolean,
  control: boolean,
  automaticUtility: boolean,
): RecordKind {
  if (role === "system") return "developer_system";
  if (control) return "control_context";
  if (automaticUtility) return "automatic_utility";
  if (role === "user" && nonblank(prose)) return "real_user";
  if (role === "assistant" && nonblank(prose)) return "assistant_dialogue_prose";
  if (hasTool) return "tool";
  if (hasThinking) return "control_context";
  return "unclassified";
}

function compatibilityRole(sourceRole: Role, recordKind: RecordKind): Role {
  if (recordKind === "tool") return "tool";
  if (recordKind === "developer_system" || recordKind === "control_context") return "system";
  return sourceRole;
}

function extractClaudeContent(content: unknown): ExtractedClaudeContent {
  if (typeof content === "string") {
    return { prose: content, toolText: null, toolActivities: [], hasThinking: false };
  }
  if (!Array.isArray(content)) {
    return { prose: null, toolText: null, toolActivities: [], hasThinking: false };
  }

  const proseParts: string[] = [];
  const toolActivities: NormalizedToolActivity[] = [];
  let hasThinking = false;
  for (const block of content) {
    if (typeof block === "string") {
      proseParts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    const type = stringValue(block.type);
    if (type === "text" && typeof block.text === "string") {
      proseParts.push(block.text);
    } else if (type === "tool_use") {
      toolActivities.push({
        activityOrdinal: toolActivities.length,
        activityKind: "call",
        toolName: stringValue(block.name),
        toolText: sourceBackedScalar(block.input),
        sourceActivityId: stringValue(block.id),
      });
    } else if (type === "tool_result") {
      toolActivities.push({
        activityOrdinal: toolActivities.length,
        activityKind: "result",
        toolName: null,
        toolText: stringifyToolResult(block.content),
        sourceActivityId: stringValue(block.tool_use_id),
      });
    } else if (type === "thinking") {
      hasThinking = true;
    }
  }
  const prose = proseParts.length > 0 ? proseParts.join("\n") : null;
  const toolTextParts = toolActivities
    .map((activity) => activity.toolText)
    .filter((value): value is string => value !== null && value.length > 0);
  return {
    prose,
    toolText: toolTextParts.length > 0 ? toolTextParts.join("\n") : null,
    toolActivities,
    hasThinking,
  };
}

function claudeUtilityDiscriminator(
  rec: Record<string, unknown>,
  msg: Record<string, unknown>,
  prose: string | null,
): boolean {
  if (rec.isCompactSummary === true || rec.isSuggestion === true) return true;
  const metadata = isRecord(msg.metadata) ? msg.metadata : null;
  const discriminators = [
    stringValue(rec.utilityMode),
    stringValue(rec.automaticMode),
    metadata ? stringValue(metadata.type) : null,
    metadata ? stringValue(metadata.mode) : null,
  ].filter((value): value is string => value !== null);
  if (discriminators.some((value) => [
    "automatic-utility",
    "compact-summary",
    "compact-summary-v1",
    "suggestion",
    "suggestion-v1",
    "warmup-v1",
  ].includes(value))) return true;

  // This is the complete versioned Claude compaction wrapper, not a loose
  // keyword check. Quoted or later prose containing the words is unaffected.
  return typeof prose === "string"
    && prose.startsWith(
      "This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\n\n<summary>",
    );
}

function isClaudeControl(prose: string | null): boolean {
  if (prose === null) return false;
  const trimmed = prose.trim();
  if (/^<local-command-caveat>[\s\S]*<\/local-command-caveat>$/.test(trimmed)) return true;
  if (/^Caveat: The messages below were generated by the user while running local commands\.(?:\s|$)/.test(trimmed)) return true;
  if (/^<command-message>[\s\S]*<\/command-message>(?:\s*<command-(?:name|args)>[\s\S]*<\/command-(?:name|args)>)*$/.test(trimmed)) return true;
  if (/^<local-command-(?:stdout|stderr)>[\s\S]*<\/local-command-(?:stdout|stderr)>$/.test(trimmed)) return true;
  if (trimmed === "/clear" || /^<command-name>\/clear<\/command-name>$/.test(trimmed)) return true;
  if (trimmed === "[Request interrupted by user for tool use]" || trimmed === "[Request interrupted by user]") return true;
  return trimmed === "<turn_aborted>" || /^<turn_aborted>[\s\S]*<\/turn_aborted>$/.test(trimmed);
}

function titleCandidate(
  value: string,
  harnessSourceClass: string,
  sourceRecordId: string | null,
  sourceOrdinal: number,
  sourceReference: string,
): ExplicitTitleEvidence {
  return {
    value,
    authority: "source_explicit",
    harnessSourceClass,
    sourceRecordId,
    sourceReference,
    sourceOrdinal,
    eligibilityRuleVersion: CLAUDE_TITLE_RULE,
  };
}

function claudeContinuityEvidence(
  rec: Record<string, unknown>,
  sourceOrdinal: number,
): ContinuityEventEvidence | null {
  if (rec.type !== "system" || rec.subtype !== "compact_boundary") return null;
  const timestamp = parseTs(rec.timestamp);
  const identity = recordIdentity(rec, timestamp);
  const detailValue = isRecord(rec.compactMetadata) ? rec.compactMetadata : null;
  let detail: string | null = null;
  if (detailValue) {
    try { detail = JSON.stringify(detailValue); } catch { detail = null; }
  }
  return {
    kind: "compaction",
    sourceOrdinal,
    sourceRecordId: identity.sourceRecordId,
    sourceRecordUuid: identity.sourceRecordUuid,
    sourceRecordTs: identity.sourceRecordTs,
    sourceIdentityKind: identity.sourceIdentityKind,
    detail,
  };
}

function recordIdentity(rec: Record<string, unknown>, ts: number | null): {
  sourceRecordId: string | null;
  sourceRecordUuid: string | null;
  sourceRecordTs: number | null;
  sourceIdentityKind: "uuid" | "record-id" | "none";
} {
  const id = stringValue(rec.uuid);
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

function normalizeRole(value: unknown): Role {
  if (value === "user") return "user";
  if (value === "assistant") return "assistant";
  if (value === "system" || value === "developer") return "system";
  return "tool";
}

function stringifyToolResult(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const values = content.map((block) => {
      if (typeof block === "string") return block;
      if (isRecord(block) && block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    });
    return values.join("\n");
  }
  return sourceBackedScalar(content);
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

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRecognizedClaudeEvidenceType(type: string | null): boolean {
  return type !== null && new Set([
    "user",
    "assistant",
    "custom-title",
    "ai-title",
    "file-history-snapshot",
    "progress",
    "summary",
    "system",
    "mode",
    "permission-mode",
    "attachment",
    "last-prompt",
  ]).has(type);
}

function isWorkflowJournalPath(relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/");
  return /(?:^|\/)subagents\/workflows\/.+\/journal\.jsonl$/.test(normalized);
}

function claudeProjectDirectory(relPath: string): string | null {
  const dir = dirname(relPath).replaceAll("\\", "/");
  return dir === "." ? null : dir.split("/")[0] ?? null;
}

function reject(
  source: DiscoveredSource,
  reason: "no_session_envelope" | "auxiliary_workflow" | "malformed_complete_record" | "identity_mismatch",
  detail: string,
): AdmissionResult {
  return { admitted: false, source, reason, detail };
}

/** Walk nested project/archive roots without turning suffix into admission. */
function walkJsonl(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
}

/**
 * Project identity via git root of cwd. A worktree .git file is authoritative
 * just like a directory; a non-repository cwd remains its own scope.
 */
export function gitRoot(cwd: string): string {
  const home = homedir();
  const abs = cwd.startsWith("~") ? join(home, cwd.slice(1)) : cwd;
  const parts = abs.split(sep);
  for (let index = parts.length; index >= 1; index--) {
    const candidate = parts.slice(0, index).join(sep) || sep;
    try {
      void statSync(join(candidate, ".git"));
      return candidate;
    } catch {
      // Keep walking.
    }
  }
  return abs;
}

export { statSync };
