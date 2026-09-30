import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  Adapter,
  AdapterConstructionDraft,
  AdapterTitleCandidate,
  ContinuityEventEvidence,
  DiscoveredSource,
  NormalizedMessage,
  NormalizedToolActivity,
  ParseResult,
  Role,
} from "./types.js";
import { visitCompleteJsonlFile } from "./types.js";

const KIMI_CLASSIFICATION_VERSION = "kimi-current-context-v1";
const KIMI_REPLAY_VERSION = "kimi-id-and-original-time-v1";
const KIMI_TITLE_VERSION = "kimi-title-v1";
const AUXILIARY_DIRECTORY_NAMES = new Set(["user-history", "user_history", "wire"]);

/** Kimi canonical current-context projection adapter. Auxiliary histories never enter discovery. */
export const kimiAdapter: Adapter = {
  source: "kimi",
  continuitySupport: "supported",
  sidecarVersion: `${KIMI_CLASSIFICATION_VERSION}:${KIMI_REPLAY_VERSION}:${KIMI_TITLE_VERSION}:compact-v1`,
  sidecarContextFingerprint(src) {
    return readState(dirname(src.fullPath));
  },

  discover(roots: string[]): DiscoveredSource[] {
    const out: DiscoveredSource[] = [];
    roots.forEach((configured, rootOrdinal) => {
      const root = resolve(configured);
      const files: string[] = [];
      walkContexts(root, files); // top-level reachability is authoritative
      for (const fullPath of files.sort()) {
        const identity = contextIdentity(fullPath);
        if (!identity) continue;
        const statePath = join(dirname(fullPath), "state.json");
        const contextStat = statSync(fullPath);
        let stateSize = 0;
        let stateMtime = 0;
        try { const state = statSync(statePath); stateSize = state.size; stateMtime = Math.floor(state.mtimeMs); } catch {}
        out.push({
          root,
          relPath: relative(root, fullPath),
          fullPath,
          nativeId: identity.nativeId,
          rootOrdinal,
          candidateKind: "kimi:current-context",
          freshness: { mtime: Math.max(Math.floor(contextStat.mtimeMs), stateMtime), size: contextStat.size + stateSize },
        });
      }
    });
    return out;
  },

  parse(src: DiscoveredSource): ParseResult {
    const identity = contextIdentity(src.fullPath);
    if (!identity || identity.nativeId !== src.nativeId) throw new Error(`kimi: noncanonical or changed context identity for ${src.relPath}`);
    const messages: NormalizedMessage[] = [];
    const continuityEvents: ContinuityEventEvidence[] = [];
    const state = readState(dirname(src.fullPath));
    let fallback: { value: string; ordinal: number; id: string | null } | null = null;
    let sourceOrdinal = -1;

    const consumed = visitCompleteJsonlFile(src.fullPath, ({ value }) => {
      sourceOrdinal++;
      const row = objectValue(value);
      const sourceRole = stringValue(row?.role) ?? "unknown";
      const eventTs = null; // current Kimi contexts expose no proved event-time field
      const sourceRecordId = row?.id === undefined || row.id === null ? null : String(row.id);
      const identityKind = sourceRecordId ? "record-id" as const : "none" as const;
      const activities = kimiActivities(row, sourceRole);
      const extracted = extractContent(row?.content);
      let role: Role = "tool";
      let recordKind: NonNullable<NormalizedMessage["recordKind"]> = "unclassified";
      let dialogueSide: NormalizedMessage["dialogueSide"] = null;
      let prose: string | null = extracted.prose;

      if (sourceRole === "_system_prompt") { role = "system"; recordKind = "developer_system"; }
      else if (sourceRole === "_usage") { role = "system"; recordKind = "telemetry"; prose = null; }
      else if (sourceRole === "_checkpoint") {
        role = "system";
        recordKind = "control_context";
        prose = null;
        continuityEvents.push({
          kind: "checkpoint",
          sourceOrdinal,
          sourceRecordId,
          sourceRecordUuid: null,
          sourceRecordTs: null,
          sourceIdentityKind: identityKind,
          detail: "kimi:_checkpoint",
        });
      } else if (sourceRole === "user" && prose) { role = "user"; recordKind = "real_user"; dialogueSide = "user"; }
      else if (sourceRole === "assistant" && prose) { role = "assistant"; recordKind = "assistant_dialogue_prose"; dialogueSide = "assistant"; }
      else if (sourceRole === "tool" || activities.length > 0) { role = "tool"; recordKind = "tool"; prose = null; }
      else if (sourceRole === "assistant" && extracted.hasThinking) { role = "assistant"; recordKind = "control_context"; prose = null; }
      else if (sourceRole === "system" || sourceRole === "developer") { role = "system"; recordKind = "developer_system"; }

      const toolText = activities.map((activity) => activity.toolText).filter((text): text is string => text !== null).join("\n") || null;
      messages.push({
        ordinal: messages.length,
        sourceOrdinal,
        role,
        ts: null,
        text: prose,
        toolText,
        hasTool: activities.length > 0,
        recordKind,
        dialogueSide,
        prose,
        eventTs,
        toolActivities: activities,
        sourceRecordId,
        sourceRecordUuid: null,
        sourceRecordTs: null,
        sourceIdentityKind: identityKind,
      });
      if (recordKind === "real_user" && prose && !fallback) fallback = { value: truncateTitle(prose), ordinal: sourceOrdinal, id: sourceRecordId };
    });

    const fallbackValue = fallback as { value: string; ordinal: number; id: string | null } | null;
    const explicit = state.title ? { value: truncateTitle(state.title), ordinal: null, id: null } : null;
    const titleCandidates: AdapterTitleCandidate[] = [];
    if (explicit) titleCandidates.push({ value: explicit.value, authority: "source_explicit", harnessSourceClass: "state.json.custom_title", sourceRecordId: null, sourceReference: relative(src.root, state.path), sourceOrdinal: null, eligibilityRuleVersion: KIMI_TITLE_VERSION });
    if (fallbackValue) titleCandidates.push({ value: fallbackValue.value, authority: "real_user_fallback", harnessSourceClass: "context.real_user", sourceRecordId: fallbackValue.id, sourceReference: src.relPath, sourceOrdinal: fallbackValue.ordinal, eligibilityRuleVersion: KIMI_TITLE_VERSION });
    const construction: AdapterConstructionDraft = {
      artifactKind: "current_context_projection",
      historyCompleteness: "current_context_only",
      defaultSessionVisible: messages.some((message) => message.dialogueSide !== null),
      sourceValidationStatus: "current",
      sourceObservedTs: sourceObserved(src.fullPath, state.exists ? state.path : null),
      project: { originalProjectKey: null, canonicalProjectKey: null, canonicalizationRuleVersion: null },
      titleCandidates,
      classificationRuleVersion: KIMI_CLASSIFICATION_VERSION,
      replayRuleVersion: KIMI_REPLAY_VERSION,
    };
    const semanticBytes = semanticProjectionBytes(messages);
    return {
      record: {
        nativeId: src.nativeId,
        cwd: null,
        project: null,
        title: explicit?.value ?? fallbackValue?.value ?? null,
        startTs: null,
        endTs: null,
        models: [],
        messages,
        transcriptBytes: semanticBytes,
        parentNativeId: identity.parentNativeId,
        origin: identity.parentNativeId ? "agent" : "human",
        originDetail: identity.parentNativeId ? "kimi:subagent-path" : "kimi:direct-session",
        continuityEvents,
        continuitySupport: "supported",
        construction,
      },
      consumed,
    };
  },
};

function kimiActivities(row: Record<string, any> | null, sourceRole: string): NormalizedToolActivity[] {
  const activities: NormalizedToolActivity[] = [];
  if (sourceRole === "tool") {
    activities.push({
      activityOrdinal: 0,
      activityKind: "result",
      toolName: stringValue(row?.name) ?? stringValue(row?.tool_name),
      toolText: safeBounded(row?.content ?? row?.result ?? row?.output),
      sourceActivityId: stringValue(row?.tool_call_id) ?? stringValue(row?.id),
    });
  }
  if (Array.isArray(row?.tool_calls)) {
    for (const value of row.tool_calls) {
      const call = objectValue(value);
      const fn = objectValue(call?.function);
      activities.push({
        activityOrdinal: activities.length,
        activityKind: "call",
        toolName: stringValue(fn?.name) ?? stringValue(call?.name),
        toolText: safeBounded(fn?.arguments ?? call?.arguments ?? call?.input),
        sourceActivityId: stringValue(call?.id),
      });
    }
  }
  return activities;
}

function walkContexts(root: string, out: string[]): void {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!AUXILIARY_DIRECTORY_NAMES.has(entry.name)) walkContextsSafe(path, out);
    } else if (entry.isFile() && entry.name === "context.jsonl") out.push(path);
  }
}
function walkContextsSafe(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!AUXILIARY_DIRECTORY_NAMES.has(entry.name)) walkContextsSafe(path, out);
    } else if (entry.isFile() && entry.name === "context.jsonl") out.push(path);
  }
}
function contextIdentity(path: string): { nativeId: string; parentNativeId: string | null } | null {
  const absolute = resolve(path);
  if (basename(absolute) !== "context.jsonl") return null;
  const dir = dirname(absolute);
  const parentDir = dirname(dir);
  if (basename(parentDir) === "subagents") {
    const parent = basename(dirname(parentDir));
    const child = basename(dir);
    if (!parent || !child) return null;
    return { nativeId: `${parent}/subagent/${child}`, parentNativeId: parent };
  }
  const parts = absolute.split(sep);
  if (parts.some((part) => AUXILIARY_DIRECTORY_NAMES.has(part))) return null;
  return { nativeId: basename(dir), parentNativeId: null };
}
function readState(dir: string): { title: string | null; path: string; exists: boolean } {
  const path = join(dir, "state.json");
  try {
    const parsed = objectValue(JSON.parse(readFileSync(path, "utf8")));
    return { title: stringValue(parsed?.custom_title), path, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { title: null, path, exists: false };
    throw new Error(`kimi: malformed or unreadable paired state.json for ${basename(dir)}`);
  }
}
function extractContent(value: unknown): { prose: string | null; hasThinking: boolean } {
  if (typeof value === "string") return { prose: value.trim() || null, hasThinking: false };
  if (!Array.isArray(value)) return { prose: null, hasThinking: false };
  const parts: string[] = [];
  let hasThinking = false;
  for (const item of value) {
    const row = objectValue(item);
    if (!row) continue;
    if (row.type === "text" && typeof row.text === "string") parts.push(row.text);
    else if (row.type === "think" || row.type === "thinking" || row.type === "reasoning") hasThinking = true;
  }
  return { prose: parts.join("\n").trim() || null, hasThinking };
}
function semanticProjectionBytes(messages: NormalizedMessage[]): number {
  if (messages.length === 0) return 0;
  return Buffer.byteLength(JSON.stringify(messages.map((message) => [message.recordKind, message.dialogueSide, message.prose, message.sourceRecordId, message.toolActivities])), "utf8");
}
function sourceObserved(contextPath: string, statePath: string | null): number | null {
  let observed: number | null = null;
  for (const path of [contextPath, statePath]) {
    if (!path) continue;
    try { const mtime = Math.floor(statSync(path).mtimeMs); observed = observed === null ? mtime : Math.max(observed, mtime); } catch {}
  }
  return observed;
}
function safeBounded(value: unknown): string | null { if (value === undefined || value === null) return null; let text: string; if (typeof value === "string") text = value; else { try { text = JSON.stringify(value); } catch { text = String(value); } } return text.slice(0, 8000) || null; }
function objectValue(value: unknown): Record<string, any> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function truncateTitle(value: string): string { const one = value.replace(/\s+/g, " ").trim(); return one.length > 120 ? `${one.slice(0, 119)}…` : one; }
