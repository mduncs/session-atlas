import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import type {
  Adapter,
  AdapterConstructionDraft,
  AdapterTitleCandidate,
  AdmissionResult,
  ContinuityEventEvidence,
  DiscoveredSource,
  NormalizedMessage,
  NormalizedToolActivity,
  ParseResult,
  RecordIdentityKind,
  Role,
} from "./types.js";
import { gitRoot } from "./claude.js";
import { visitCompleteJsonlFile } from "./types.js";

const PRIME_CLASSIFICATION_VERSION = "prime-v11-contract-1";
const PRIME_REPLAY_VERSION = "prime-id-inner-time-v1";
const PRIME_TITLE_VERSION = "prime-title-v1";

type PrimeLayout = "root" | "child" | "artifact" | "external";
interface PrimeHeader {
  id: string;
  depth: number;
  parentSession: string | null;
}

/** Prime source adapter. Canonical path admission always precedes embedded-id election. */
export const primeAdapter: Adapter = {
  source: "prime",
  continuitySupport: "supported",
  sidecarVersion: `${PRIME_CLASSIFICATION_VERSION}:${PRIME_REPLAY_VERSION}:${PRIME_TITLE_VERSION}:compact-v1:root-fork-v1`,
  sidecarContextFingerprint(src) {
    const header = readSessionHeader(src.fullPath);
    if (!header?.parentSession) return header;
    const parentPath = resolveParentPath(src.fullPath, header.parentSession);
    return { header, parentPath, parent: readSessionHeader(parentPath) };
  },

  discover(roots: string[]): DiscoveredSource[] {
    const out: DiscoveredSource[] = [];
    roots.forEach((configured, rootOrdinal) => {
      const root = resolve(configured);
      const candidates = discoverPrimeCandidates(root);
      for (const candidate of candidates) {
        // Layout is classified without reading the envelope. Only candidates
        // at a canonical session location may contribute an embedded id.
        const header = candidate.layout === "root" || candidate.layout === "child"
          ? readSessionHeader(candidate.fullPath)
          : null;
        out.push({
          root,
          relPath: relative(root, candidate.fullPath) || basename(candidate.fullPath),
          fullPath: candidate.fullPath,
          nativeId: header?.id ?? basename(candidate.fullPath, ".jsonl"),
          rootOrdinal,
          candidateKind: `prime:${candidate.layout}`,
        });
      }
    });
    return out;
  },

  admit(src: DiscoveredSource): AdmissionResult {
    const layout = sourceLayout(src);
    if (layout === "external") return reject(src, "auxiliary_agent_artifact", "nonofficial Prime supervision artifact");
    if (layout === "artifact") {
      return reject(src, looksLikeAgentArtifact(src.fullPath) ? "auxiliary_agent_artifact" : "no_session_envelope", "noncanonical Prime child artifact");
    }
    const header = readSessionHeader(src.fullPath);
    if (!header) return reject(src, "no_session_envelope", "missing complete supported Prime session header");
    if (layout === "root") {
      // A root session may name the session it was forked from; only a
      // positive rlmDepth marks an RLM child, and those belong in the child layout.
      if (header.depth > 0) {
        return reject(src, "unsupported_unit_shape", "RLM child envelope outside the official child layout");
      }
    } else {
      if (header.depth <= 0 || !header.parentSession) {
        return reject(src, "no_session_envelope", "official child layout lacks positive rlmDepth or parentSession");
      }
      const parentPath = resolveParentPath(src.fullPath, header.parentSession);
      if (!readSessionHeader(parentPath)) {
        return reject(src, "no_session_envelope", "parentSession does not resolve to a complete Prime header");
      }
    }
    return { admitted: true, ...parsePrime(src, layout, header) };
  },

  parse(src: DiscoveredSource): ParseResult {
    const admitted = primeAdapter.admit!(src);
    if (!admitted.admitted) throw new Error(`prime: rejected ${src.relPath}: ${admitted.reason}`);
    return { record: admitted.record, consumed: admitted.consumed };
  },
};

function parsePrime(src: DiscoveredSource, layout: PrimeLayout, admittedHeader: PrimeHeader): ParseResult {
  let nativeId: string | null = null;
  let cwd: string | null = null;
  let parentNativeId: string | null = null;
  let depth = 0;
  let explicitTitle: { value: string; ordinal: number; id: string | null } | null = null;
  let fallbackTitle: { value: string; ordinal: number; id: string | null } | null = null;
  let startTs: number | null = null;
  let endTs: number | null = null;
  let sourceOrdinal = -1;
  const models = new Set<string>();
  const messages: NormalizedMessage[] = [];
  const continuityEvents: ContinuityEventEvidence[] = [];

  const consumed = visitCompleteJsonlFile(src.fullPath, ({ value }) => {
    sourceOrdinal++;
    const rec = objectValue(value);
    if (!rec) {
      appendPrime(messages, sourceOrdinal, "tool", "unclassified", null, null, [], {}, null);
      return;
    }
    const type = stringValue(rec.type);
    if (type === "session") {
      const id = stringValue(rec.id);
      if (!id || (nativeId !== null && nativeId !== id)) throw new Error(`prime: missing or changing embedded identity in ${src.relPath}`);
      nativeId = id;
      cwd = stringValue(rec.cwd) ?? cwd;
      depth = numberValue(rec.rlmDepth) ?? 0;
      const parentPath = stringValue(rec.parentSession);
      // Only an official RLM child resolves a parent edge; a root fork stays top-level.
      if (parentPath && layout === "child") parentNativeId = readSessionHeader(resolveParentPath(src.fullPath, parentPath))?.id ?? null;
      return;
    }
    if (type === "session_info") {
      const name = stringValue(rec.name);
      if (name) explicitTitle = { value: truncateTitle(name), ordinal: sourceOrdinal, id: stringValue(rec.id) };
      return;
    }

    if (type === "message") {
      const message = objectValue(rec.message);
      if (!message) {
        appendPrime(messages, sourceOrdinal, "tool", "unclassified", null, null, [], rec, null);
        return;
      }
      const role = primeRole(message.role);
      const eventTs = parseTimestamp(message.timestamp); // never outer-envelope fallback
      const content = extractPrimeContent(message.content, role);
      const identity = recordIdentity(rec, eventTs);
      const model = stringValue(message.model);
      if (model) models.add(model);
      let recordKind: NormalizedMessage["recordKind"];
      let dialogueSide: NormalizedMessage["dialogueSide"] = null;
      if (role === "user" && content.prose) { recordKind = "real_user"; dialogueSide = "user"; }
      else if (role === "assistant" && content.prose) { recordKind = "assistant_dialogue_prose"; dialogueSide = "assistant"; }
      else if (content.activities.length > 0 || role === "tool") recordKind = "tool";
      else if (role === "system") recordKind = "developer_system";
      else if (content.hasReasoning) recordKind = "control_context";
      else recordKind = "unclassified";
      appendPrime(messages, sourceOrdinal, role, recordKind, dialogueSide, content.prose, content.activities, rec, eventTs, identity);
      if (recordKind === "real_user" && content.prose && !fallbackTitle) {
        fallbackTitle = { value: truncateTitle(content.prose), ordinal: sourceOrdinal, id: identity.sourceRecordId };
      }
      return;
    }

    const eventTs = parseTimestamp(rec.timestamp);
    const identity = recordIdentity(rec, eventTs);
    if (type === "model_change" || type === "service_tier_change" || type === "thinking_level_change") {
      const model = type === "model_change" ? stringValue(rec.modelId) : null;
      if (model) models.add(model);
      appendPrime(messages, sourceOrdinal, "system", "telemetry", null, stringValue(rec.prose), [], rec, eventTs, identity);
    } else if (type === "agent_status") {
      const status = objectValue(rec.status);
      const prose = stringValue(rec.prose) ?? ([stringValue(status?.taskState), stringValue(status?.summary)].filter(Boolean).join(" · ") || null);
      appendPrime(messages, sourceOrdinal, "system", "telemetry", null, prose, [], rec, eventTs, identity);
    } else if (type === "session_state" || type === "child_usage" || type === "subagent_usage") {
      appendPrime(messages, sourceOrdinal, "system", "telemetry", null, stringValue(rec.prose), [], rec, eventTs, identity);
    } else if (type === "compaction") {
      const summary = stringValue(rec.summary);
      appendPrime(messages, sourceOrdinal, "system", "automatic_utility", null, summary, [], rec, eventTs, identity);
      continuityEvents.push({
        kind: "compaction",
        sourceOrdinal,
        sourceRecordId: identity.sourceRecordId,
        sourceRecordUuid: identity.sourceRecordUuid,
        sourceRecordTs: identity.sourceRecordTs,
        sourceIdentityKind: identity.sourceIdentityKind,
        detail: summary ? "prime:compaction-summary-present" : "prime:compaction",
      });
    } else if (type === "custom_message") {
      const details = objectValue(rec.details);
      const relationship = stringValue(details?.fromRelationship) ?? stringValue(rec.fromRelationship);
      const outbound = stringValue(details?.toRelationship) === "child" || stringValue(rec.direction) === "outbound";
      const inbound = stringValue(rec.customType) === "agent_message" && !outbound && (relationship === "parent" || relationship === "sibling");
      const prose = stringValue(rec.content);
      appendPrime(messages, sourceOrdinal, inbound ? "user" : "system", inbound ? "real_user" : "control_context", inbound ? "user" : null, prose, [], rec, eventTs, identity);
      if (inbound && prose && !fallbackTitle) fallbackTitle = { value: truncateTitle(prose), ordinal: sourceOrdinal, id: identity.sourceRecordId };
    } else if (type === "policy" || type === "native_policy" || type === "system_policy") {
      appendPrime(messages, sourceOrdinal, "system", "developer_system", null, sourceProse(rec), [], rec, eventTs, identity);
    } else if (type && /(context|lifecycle|control)/i.test(type)) {
      appendPrime(messages, sourceOrdinal, "system", "control_context", null, sourceProse(rec), [], rec, eventTs, identity);
    } else {
      appendPrime(messages, sourceOrdinal, "tool", "unclassified", null, sourceProse(rec), [], rec, eventTs, identity);
    }
  });

  if (!nativeId || nativeId !== admittedHeader.id) throw new Error(`prime: embedded session id changed during ingest for ${src.relPath}`);
  if (layout === "child" && (depth <= 0 || parentNativeId === null)) throw new Error(`prime: official child envelope became invalid for ${src.relPath}`);

  for (const message of messages) {
    const eventTs = message.eventTs ?? null;
    if (eventTs === null) continue;
    startTs = startTs === null ? eventTs : Math.min(startTs, eventTs);
    endTs = endTs === null ? eventTs : Math.max(endTs, eventTs);
  }
  const explicit = explicitTitle as { value: string; ordinal: number; id: string | null } | null;
  const fallback = fallbackTitle as { value: string; ordinal: number; id: string | null } | null;
  const effectiveTitle = explicit?.value ?? fallback?.value ?? null;
  const titleCandidates: AdapterTitleCandidate[] = [];
  if (explicit) titleCandidates.push(titleCandidate(explicit, "source_explicit", "session_info.name", src.relPath));
  if (fallback) titleCandidates.push(titleCandidate(fallback, "real_user_fallback", "prime.real_user", src.relPath));
  const hasDialogue = messages.some((message) => message.dialogueSide !== null);
  const contentBearing = messages.some((message) => message.recordKind !== "telemetry");
  const observed = statSync(src.fullPath);
  const construction: AdapterConstructionDraft = {
    artifactKind: contentBearing ? "dialogue_history" : "metadata_shell",
    historyCompleteness: "complete",
    defaultSessionVisible: hasDialogue,
    sourceValidationStatus: "current",
    sourceObservedTs: Math.floor(observed.mtimeMs),
    project: { originalProjectKey: cwd, canonicalProjectKey: cwd ? gitRoot(cwd) : null, canonicalizationRuleVersion: cwd ? "git-root-v1" : null },
    titleCandidates,
    classificationRuleVersion: PRIME_CLASSIFICATION_VERSION,
    replayRuleVersion: PRIME_REPLAY_VERSION,
  };
  return {
    record: {
      nativeId,
      cwd,
      project: cwd ? gitRoot(cwd) : null,
      title: effectiveTitle,
      startTs,
      endTs,
      models: [...models],
      messages,
      transcriptBytes: semanticProjectionBytes(messages),
      parentNativeId,
      origin: layout === "child" ? "agent" : "human",
      originDetail: layout === "child" ? `prime:rlm-child:depth-${depth}` : admittedHeader.parentSession ? "prime:root-fork" : "prime:root-session",
      continuityEvents,
      continuitySupport: "supported",
      construction,
    },
    consumed,
  };
}

function appendPrime(
  messages: NormalizedMessage[],
  sourceOrdinal: number,
  role: Role,
  recordKind: NonNullable<NormalizedMessage["recordKind"]>,
  dialogueSide: NormalizedMessage["dialogueSide"],
  prose: string | null,
  toolActivities: NormalizedToolActivity[],
  rec: Record<string, unknown>,
  eventTs: number | null,
  suppliedIdentity?: ReturnType<typeof recordIdentity>,
): void {
  const identity = suppliedIdentity ?? recordIdentity(rec, eventTs);
  const toolText = toolActivities.map((activity) => activity.toolText).filter((value): value is string => value !== null).join("\n") || null;
  messages.push({
    ordinal: messages.length,
    sourceOrdinal,
    role,
    ts: eventTs,
    text: prose,
    toolText,
    hasTool: toolActivities.length > 0,
    recordKind,
    dialogueSide,
    prose,
    eventTs,
    toolActivities,
    ...identity,
  });
}

function extractPrimeContent(value: unknown, role: Role): { prose: string | null; activities: NormalizedToolActivity[]; hasReasoning: boolean } {
  const prose: string[] = [];
  const activities: NormalizedToolActivity[] = [];
  let hasReasoning = false;
  if (typeof value === "string") {
    if (role === "user" || role === "system") prose.push(value);
    else if (role === "tool") activities.push(activity("result", null, value, null, 0));
  } else if (Array.isArray(value)) {
    for (const block of value) {
      const row = objectValue(block);
      if (!row) continue;
      const type = stringValue(row.type);
      if (type === "text" && typeof row.text === "string") prose.push(row.text);
      else if (type === "toolCall" || type === "tool_call" || type === "tool_use") {
        activities.push(activity("call", stringValue(row.name) ?? stringValue(row.toolName), safeBounded(row.arguments ?? row.input), stringValue(row.id) ?? stringValue(row.toolUseId), activities.length));
      } else if (type === "toolResult" || type === "tool_result") {
        activities.push(activity("result", stringValue(row.name) ?? stringValue(row.toolName), safeBounded(row.content ?? row.result ?? row.output), stringValue(row.toolUseId) ?? stringValue(row.tool_use_id) ?? stringValue(row.id), activities.length));
      } else if (type === "thinking" || type === "reasoning" || type === "think") hasReasoning = true;
    }
  }
  return { prose: prose.join("\n").trim() || null, activities, hasReasoning };
}

function activity(kind: NormalizedToolActivity["activityKind"], name: string | null, text: string | null, id: string | null, ordinal: number): NormalizedToolActivity {
  return { activityOrdinal: ordinal, activityKind: kind, toolName: name, toolText: text, sourceActivityId: id };
}

function discoverPrimeCandidates(root: string): Array<{ fullPath: string; layout: PrimeLayout }> {
  const stat = statSync(root);
  if (stat.isFile()) return root.endsWith(".jsonl") ? [{ fullPath: root, layout: "root" }] : [];
  const top = readdirSync(root, { withFileTypes: true });
  const hasKnownRoot = top.some((entry) => ["sessions", "session-artifacts", "tmux-panes"].includes(entry.name));
  const out: Array<{ fullPath: string; layout: PrimeLayout }> = [];
  if (!hasKnownRoot) {
    const files: string[] = [];
    walkJsonl(root, files);
    return files.sort().map((fullPath) => ({ fullPath, layout: "root" as const }));
  }
  const rootFiles: string[] = [];
  walkJsonl(join(root, "sessions"), rootFiles);
  out.push(...rootFiles.map((fullPath) => ({ fullPath, layout: "root" as const })));
  const artifactFiles: string[] = [];
  walkJsonl(join(root, "session-artifacts"), artifactFiles);
  for (const fullPath of artifactFiles) out.push({ fullPath, layout: officialChildPath(root, fullPath) ? "child" : "artifact" });
  const externalFiles: string[] = [];
  walkJsonl(join(root, "tmux-panes"), externalFiles);
  out.push(...externalFiles.map((fullPath) => ({ fullPath, layout: "external" as const })));
  return out.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
}

function officialChildPath(root: string, fullPath: string): boolean {
  const parts = relative(root, fullPath).split(sep);
  return parts.length === 4 && parts[0] === "session-artifacts" && !!parts[1] && /^sub-[^/\\]+$/.test(parts[2] ?? "") && (parts[3] ?? "").endsWith(".jsonl");
}
function sourceLayout(src: DiscoveredSource): PrimeLayout {
  const kind = src.candidateKind?.replace(/^prime:/, "");
  if (kind === "root" || kind === "child" || kind === "artifact" || kind === "external") return kind;
  return officialChildPath(src.root, src.fullPath) ? "child" : "root";
}
function walkJsonl(dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
}

function readSessionHeader(path: string): PrimeHeader | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const chunks: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(4096);
    let total = 0;
    let complete = false;
    while (total < 1024 * 1024) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      const view = Buffer.from(chunk.subarray(0, count));
      const newline = view.indexOf(0x0a);
      if (newline >= 0) { chunks.push(view.subarray(0, newline)); complete = true; break; }
      chunks.push(view); total += count;
    }
    if (!complete) return null;
    const first = objectValue(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (!first || first.type !== "session") return null;
    const id = stringValue(first.id);
    const depth = numberValue(first.rlmDepth);
    if (!id || depth === null || !Number.isInteger(depth) || depth < 0) return null;
    return { id, depth, parentSession: stringValue(first.parentSession) };
  } catch { return null; }
  finally { if (fd !== null) closeSync(fd); }
}
function resolveParentPath(childPath: string, parentPath: string): string {
  return resolve(parentPath.startsWith(sep) ? parentPath : join(dirname(childPath), parentPath));
}
function looksLikeAgentArtifact(path: string): boolean {
  let firstType: string | null = null;
  try { visitCompleteJsonlFile(path, ({ value }) => { if (firstType === null) firstType = stringValue(objectValue(value)?.type); }); } catch { return false; }
  return firstType !== "session";
}
function reject(src: DiscoveredSource, reason: "no_session_envelope" | "auxiliary_agent_artifact" | "unsupported_unit_shape", detail: string): AdmissionResult {
  return { admitted: false, source: src, reason, detail };
}
function sourceProse(rec: Record<string, unknown>): string | null {
  return stringValue(rec.prose) ?? stringValue(rec.content) ?? stringValue(rec.message);
}
function titleCandidate(candidate: { value: string; ordinal: number; id: string | null }, authority: "source_explicit" | "real_user_fallback", sourceClass: string, reference: string): AdapterTitleCandidate {
  return { value: candidate.value, authority, harnessSourceClass: sourceClass, sourceRecordId: candidate.id, sourceReference: reference, sourceOrdinal: candidate.ordinal, eligibilityRuleVersion: PRIME_TITLE_VERSION };
}
function recordIdentity(rec: Record<string, unknown>, ts: number | null): { sourceRecordId: string | null; sourceRecordUuid: string | null; sourceRecordTs: number | null; sourceIdentityKind: RecordIdentityKind } {
  const id = stringValue(rec.id);
  const uuid = id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
  return { sourceRecordId: id, sourceRecordUuid: uuid, sourceRecordTs: ts, sourceIdentityKind: id ? (uuid ? "uuid" : "record-id") : "none" };
}
function semanticProjectionBytes(messages: NormalizedMessage[]): number {
  if (messages.length === 0) return 0;
  return Buffer.byteLength(JSON.stringify(messages.map((message) => [message.recordKind, message.dialogueSide, message.prose, message.eventTs, message.sourceRecordId, message.toolActivities])), "utf8");
}
function primeRole(value: unknown): Role {
  if (value === "user") return "user";
  if (value === "assistant") return "assistant";
  if (value === "system" || value === "developer") return "system";
  return "tool";
}
function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function safeBounded(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  if (typeof value === "string") text = value;
  else { try { text = JSON.stringify(value); } catch { text = String(value); } }
  return text.slice(0, 8000) || null;
}
function objectValue(value: unknown): Record<string, any> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function truncateTitle(value: string): string { const one = value.replace(/\s+/g, " ").trim(); return one.length > 120 ? `${one.slice(0, 119)}…` : one; }
