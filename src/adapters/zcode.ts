import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import type { Database as SourceDB } from "bun:sqlite";
import type {
  Adapter,
  AdapterConstructionDraft,
  AdapterTitleCandidate,
  DiscoveredSource,
  NormalizedMessage,
  NormalizedToolActivity,
  ParseResult,
  Role,
} from "./types.js";
import { gitRoot } from "./claude.js";
import { visitCompleteJsonlFile } from "./types.js";

const ZCODE_CLASSIFICATION_VERSION = "zcode-v11-contract-1";
const ZCODE_REPLAY_VERSION = "zcode-native-id-original-time-v1";
const ZCODE_TITLE_VERSION = "zcode-title-v1";

/** Read-only ZCode adapter for SQLite and retained external-agent candidates. */
export const zcodeAdapter: Adapter = {
  source: "zcode",
  continuitySupport: "unsupported",
  sidecarVersion: `${ZCODE_CLASSIFICATION_VERSION}:${ZCODE_REPLAY_VERSION}:${ZCODE_TITLE_VERSION}:compact-v1`,

  discover(roots: string[]): DiscoveredSource[] {
    const out: DiscoveredSource[] = [];
    roots.forEach((configured, rootOrdinal) => {
      const root = resolve(configured);
      const paths = locateSources(root);
      if (paths.length === 0) throw new Error(`zcode: no readable archive source under ${root}`);
      for (const path of paths) {
        if (path.endsWith(".sqlite") || path.endsWith(".db")) {
          try { out.push(...discoverDatabase(root, path, rootOrdinal)); }
          catch (error) { closeSource(path); throw error; }
        } else {
          const nativeId = externalIdentity(path);
          if (!nativeId) continue;
          out.push({ root, relPath: relative(root, path), fullPath: path, nativeId, rootOrdinal, candidateKind: "zcode:external-agent" });
        }
      }
    });
    return out;
  },

  parse(src: DiscoveredSource): ParseResult {
    return src.fullPath.endsWith(".jsonl") ? parseAgentTranscript(src) : parseDatabaseSession(src);
  },

  cleanup(): void { resetZcodeCache(); },
};

function locateSources(root: string): string[] {
  const stat = statSync(root);
  if (stat.isFile()) return [root];
  const candidates = [join(root, "cli", "db", "db.sqlite"), join(root, "db", "db.sqlite"), join(root, "db.sqlite")];
  const out = candidates.filter((path) => { try { return statSync(path).isFile(); } catch { return false; } });
  const agents = root.endsWith(`${sep}cli`) ? join(root, "agents") : join(root, "cli", "agents");
  walkNamed(agents, "transcript.jsonl", out);
  return [...new Set(out)].sort();
}
function walkNamed(dir: string, name: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkNamed(path, name, out);
    else if (entry.isFile() && entry.name === name) out.push(path);
  }
}

function discoverDatabase(root: string, path: string, rootOrdinal: number): DiscoveredSource[] {
  const db = openSource(path);
  beginSnapshot(db);
  const rows = db.prepare(`SELECT rowid AS source_rowid,id,project_id,workspace_id,parent_id,slug,directory,path,title,version,time_created,time_updated,time_compacting,time_archived,task_type FROM session ORDER BY source_rowid`).all() as Array<Record<string, unknown>>;
  const hashes = new Map<string, ReturnType<typeof createHash>>();
  const highwater = new Map<string, number>();
  for (const row of rows) {
    const id = requiredId(row.id, "session.id");
    if (hashes.has(id)) throw new Error(`zcode: duplicate session.id ${id}`);
    hashes.set(id, createHash("sha256").update(stableJson(row)));
    highwater.set(id, Math.max(sourceTimestamp(row.time_created) ?? 0, sourceTimestamp(row.time_updated) ?? 0));
  }
  const messageRows = db.prepare(`SELECT rowid AS source_rowid,session_id,id,time_created,time_updated,data FROM message ORDER BY source_rowid`).iterate() as Iterable<Record<string, unknown>>;
  for (const row of messageRows) {
    const id = String(row.session_id);
    hashes.get(id)?.update(stableJson(row));
    highwater.set(id, Math.max(highwater.get(id) ?? 0, sourceTimestamp(row.time_created) ?? 0, sourceTimestamp(row.time_updated) ?? 0));
  }
  const partRows = db.prepare(`SELECT rowid AS source_rowid,session_id,id,message_id,time_created,time_updated,data FROM part ORDER BY source_rowid`).iterate() as Iterable<Record<string, unknown>>;
  for (const row of partRows) {
    const id = String(row.session_id);
    hashes.get(id)?.update(stableJson(row));
    highwater.set(id, Math.max(highwater.get(id) ?? 0, sourceTimestamp(row.time_created) ?? 0, sourceTimestamp(row.time_updated) ?? 0));
  }
  return rows.map((row) => {
    const id = String(row.id);
    return {
      root,
      relPath: `${relative(root, path)}#session/${id}`,
      fullPath: path,
      nativeId: id,
      rootOrdinal,
      candidateKind: "zcode:sqlite-session",
      freshness: { mtime: highwater.get(id) ?? 0, size: digestNumber(hashes.get(id)!) },
    };
  });
}

function parseDatabaseSession(src: DiscoveredSource): ParseResult {
  const db = openSource(src.fullPath);
  beginSnapshot(db);
  const session = db.prepare(`SELECT rowid AS source_rowid,id,parent_id,directory,title,time_created,time_updated,task_type FROM session WHERE id=?`).get(src.nativeId) as Record<string, unknown> | null;
  if (!session) throw new Error(`zcode: session ${src.nativeId} disappeared during ingest`);
  const messageRows = db.prepare(`SELECT rowid AS source_rowid,id,time_created,data FROM message WHERE session_id=? ORDER BY source_rowid`).all(src.nativeId) as Array<Record<string, unknown>>;
  const partRows = db.prepare(`SELECT rowid AS source_rowid,id,message_id,time_created,data FROM part WHERE session_id=? ORDER BY source_rowid`).all(src.nativeId) as Array<Record<string, unknown>>;
  const parts = new Map<string, Array<Record<string, unknown>>>();
  for (const part of partRows) {
    const messageId = String(part.message_id);
    const bucket = parts.get(messageId) ?? [];
    bucket.push(part);
    parts.set(messageId, bucket);
  }
  const messages: NormalizedMessage[] = [];
  const models = new Set<string>();
  let fallback: { value: string; ordinal: number; id: string | null } | null = null;

  for (const [sourceOrdinal, row] of messageRows.entries()) {
    const metadata = objectValue(safeJson(stringValue(row.data) ?? ""));
    const sourceRole = stringValue(metadata?.role)?.toLowerCase() ?? "unknown";
    const role = normalizedRole(sourceRole);
    const model = stringValue(metadata?.modelID) ?? stringValue(objectValue(metadata?.model)?.modelID);
    if (model) models.add(model);
    const proseParts: string[] = [];
    const activities: NormalizedToolActivity[] = [];
    let hasControl = false;
    let hasUnknown = false;
    for (const part of parts.get(String(row.id)) ?? []) {
      const data = objectValue(safeJson(stringValue(part.data) ?? ""));
      const type = stringValue(data?.type);
      if (type === "text" && typeof data?.text === "string") proseParts.push(data.text);
      else if (type === "tool") activities.push(genericToolActivity(data!, activities.length, String(part.id)));
      else if (type === "file") activities.push({ activityOrdinal: activities.length, activityKind: "attachment", toolName: stringValue(data?.filename) ?? "attachment", toolText: safeBounded(data), sourceActivityId: String(part.id) });
      else if (type && /(reasoning|thinking|control)/i.test(type)) hasControl = true;
      else if (data && Object.keys(data).length > 0) hasUnknown = true;
    }
    const prose = proseParts.join("\n").trim() || null;
    let recordKind: NonNullable<NormalizedMessage["recordKind"]>;
    let dialogueSide: NormalizedMessage["dialogueSide"] = null;
    if (sourceRole === "user" && prose) { recordKind = "real_user"; dialogueSide = "user"; }
    else if (sourceRole === "assistant" && prose) { recordKind = "assistant_dialogue_prose"; dialogueSide = "assistant"; }
    else if (sourceRole === "system" || sourceRole === "developer") recordKind = "developer_system";
    else if (activities.length > 0) recordKind = "tool";
    else if (hasControl) recordKind = "control_context";
    else recordKind = hasUnknown || !prose ? "unclassified" : "unclassified";
    const eventTs = sourceTimestamp(row.time_created);
    const id = stringValue(row.id);
    const toolText = activities.map((activity) => activity.toolText).filter((text): text is string => text !== null).join("\n") || null;
    messages.push({
      ordinal: messages.length,
      sourceOrdinal,
      role,
      ts: eventTs,
      text: prose,
      toolText,
      hasTool: activities.length > 0,
      recordKind,
      dialogueSide,
      prose,
      eventTs,
      toolActivities: activities,
      sourceRecordId: id,
      sourceRecordUuid: uuidValue(id),
      sourceRecordTs: eventTs,
      sourceIdentityKind: id ? "message-id" : "none",
    });
    if (recordKind === "real_user" && prose && !fallback) fallback = { value: truncateTitle(prose), ordinal: sourceOrdinal, id };
  }

  const explicitValue = eligibleTitle(session.title);
  const explicit = explicitValue ? { value: truncateTitle(explicitValue), ordinal: 0, id: src.nativeId } : null;
  const fallbackValue = fallback as { value: string; ordinal: number; id: string | null } | null;
  const titleCandidates = dbTitleCandidates(explicit, fallbackValue, src.relPath);
  const cwd = stringValue(session.directory);
  const parent = stringValue(session.parent_id);
  const child = parent !== null || stringValue(session.task_type) === "subagent_child";
  const construction = zcodeConstruction(src, messages, titleCandidates, cwd, messageRows.length === 0);
  const semanticBytes = semanticProjectionBytes(messages);
  return {
    record: {
      nativeId: src.nativeId,
      cwd,
      project: cwd ? gitRoot(cwd) : null,
      title: explicit?.value ?? fallbackValue?.value ?? null,
      startTs: sourceTimestamp(session.time_created),
      endTs: sourceTimestamp(session.time_updated),
      models: [...models],
      messages,
      transcriptBytes: semanticBytes,
      parentNativeId: parent,
      origin: child ? "agent" : "human",
      originDetail: child ? "zcode:subagent_child" : "zcode:interactive-root",
      continuityEvents: [],
      continuitySupport: "unsupported",
      construction,
    },
    consumed: semanticBytes,
  };
}

function parseAgentTranscript(src: DiscoveredSource): ParseResult {
  const messages: NormalizedMessage[] = [];
  const models = new Set<string>();
  let embeddedId: string | null = null;
  let fallback: { value: string; ordinal: number; id: string | null } | null = null;
  let startTs: number | null = null;
  let endTs: number | null = null;
  let sourceOrdinal = -1;
  let lastStreamingEvidence: { rec: Record<string, any>; sourceOrdinal: number } | null = null;
  const appendExternal = (rec: Record<string, any>, ordinal: number): void => {
    const type = stringValue(rec.type);
    const payload = objectValue(rec.payload);
    const eventTs = sourceTimestamp(rec.timestamp);
    if (eventTs !== null) {
      startTs = startTs === null ? eventTs : Math.min(startTs, eventTs);
      endTs = endTs === null ? eventTs : Math.max(endTs, eventTs);
    }
    const recordId = stringValue(rec.id);
    let role: Role = "tool";
    let recordKind: NonNullable<NormalizedMessage["recordKind"]> = "unclassified";
    let dialogueSide: NormalizedMessage["dialogueSide"] = null;
    let prose: string | null = null;
    if (type === "turn_started") {
      prose = stringValue(payload?.input);
      role = "user";
      if (prose) { recordKind = "real_user"; dialogueSide = "user"; }
      else recordKind = "control_context";
    } else if (type === "turn_complete") {
      prose = stringValue(payload?.response);
      role = "assistant";
      if (prose) { recordKind = "assistant_dialogue_prose"; dialogueSide = "assistant"; }
      else recordKind = "control_context";
    } else {
      role = "system";
      recordKind = "control_context";
      if (type === "model_request") {
        const model = stringValue(objectValue(payload?.model)?.modelId) ?? stringValue(payload?.model);
        if (model) models.add(model);
      }
    }
    messages.push({
      ordinal: messages.length,
      sourceOrdinal: ordinal,
      role,
      ts: eventTs,
      text: prose,
      toolText: null,
      hasTool: false,
      recordKind,
      dialogueSide,
      prose,
      eventTs,
      toolActivities: [],
      sourceRecordId: recordId,
      sourceRecordUuid: uuidValue(recordId),
      sourceRecordTs: eventTs,
      sourceIdentityKind: recordId ? "record-id" : "none",
    });
    if (recordKind === "real_user" && prose && !fallback) fallback = { value: truncateTitle(prose), ordinal, id: recordId };
  };
  const consumed = visitCompleteJsonlFile(src.fullPath, ({ value }) => {
    sourceOrdinal++;
    const rec = objectValue(value);
    const id = stringValue(rec?.sessionId);
    if (id) {
      if (embeddedId && embeddedId !== id) throw new Error(`zcode: changing external sessionId in ${src.relPath}`);
      embeddedId = id;
    }
    const type = stringValue(rec?.type);
    if (!rec || !type) return;
    if (type === "model_streaming") {
      // Thousands of deltas are one bounded streaming-protocol control unit;
      // only the final complete envelope is retained as representative evidence.
      lastStreamingEvidence = { rec, sourceOrdinal };
      return;
    }
    if (lastStreamingEvidence) {
      appendExternal(lastStreamingEvidence.rec, lastStreamingEvidence.sourceOrdinal);
      lastStreamingEvidence = null;
    }
    if (type === "turn_started" || type === "turn_complete" || type === "model_request" || /(stream|protocol|delta|turn_|model_)/i.test(type)) {
      appendExternal(rec, sourceOrdinal);
    }
  });
  const trailingStreaming = lastStreamingEvidence as { rec: Record<string, any>; sourceOrdinal: number } | null;
  if (trailingStreaming) appendExternal(trailingStreaming.rec, trailingStreaming.sourceOrdinal);
  if (!embeddedId || embeddedId !== src.nativeId) throw new Error(`zcode: embedded external-agent id changed during ingest for ${src.relPath}`);
  const fallbackValue = fallback as { value: string; ordinal: number; id: string | null } | null;
  const titleCandidates: AdapterTitleCandidate[] = fallbackValue ? [{ value: fallbackValue.value, authority: "real_user_fallback", harnessSourceClass: "external.turn_started", sourceRecordId: fallbackValue.id, sourceReference: src.relPath, sourceOrdinal: fallbackValue.ordinal, eligibilityRuleVersion: ZCODE_TITLE_VERSION }] : [];
  const parentNativeId = basename(dirname(dirname(src.fullPath)));
  const construction = zcodeConstruction(src, messages, titleCandidates, null, messages.length === 0);
  const semanticBytes = semanticProjectionBytes(messages);
  return {
    record: {
      nativeId: embeddedId,
      cwd: null,
      project: null,
      title: fallbackValue?.value ?? null,
      startTs,
      endTs,
      models: [...models],
      messages,
      transcriptBytes: semanticBytes,
      parentNativeId: parentNativeId.startsWith("sess_") ? parentNativeId : null,
      origin: "agent",
      originDetail: "zcode:external-agent-transcript",
      continuityEvents: [],
      continuitySupport: "unsupported",
      construction,
    },
    consumed,
  };
}

function zcodeConstruction(src: DiscoveredSource, messages: NormalizedMessage[], titleCandidates: AdapterTitleCandidate[], cwd: string | null, shell: boolean): AdapterConstructionDraft {
  return {
    artifactKind: shell ? "metadata_shell" : "dialogue_history",
    historyCompleteness: "complete",
    defaultSessionVisible: messages.some((message) => message.dialogueSide !== null),
    sourceValidationStatus: "current",
    sourceObservedTs: sourceObservedTs(src.fullPath),
    project: { originalProjectKey: cwd, canonicalProjectKey: cwd ? gitRoot(cwd) : null, canonicalizationRuleVersion: cwd ? "git-root-v1" : null },
    titleCandidates,
    classificationRuleVersion: ZCODE_CLASSIFICATION_VERSION,
    replayRuleVersion: ZCODE_REPLAY_VERSION,
  };
}
function dbTitleCandidates(explicit: { value: string; ordinal: number; id: string | null } | null, fallback: { value: string; ordinal: number; id: string | null } | null, reference: string): AdapterTitleCandidate[] {
  const out: AdapterTitleCandidate[] = [];
  if (explicit) out.push({ value: explicit.value, authority: "source_explicit", harnessSourceClass: "session.title", sourceRecordId: explicit.id, sourceReference: reference, sourceOrdinal: explicit.ordinal, eligibilityRuleVersion: ZCODE_TITLE_VERSION });
  if (fallback) out.push({ value: fallback.value, authority: "real_user_fallback", harnessSourceClass: "message.real_user", sourceRecordId: fallback.id, sourceReference: reference, sourceOrdinal: fallback.ordinal, eligibilityRuleVersion: ZCODE_TITLE_VERSION });
  return out;
}
function genericToolActivity(data: Record<string, any>, ordinal: number, partId: string): NormalizedToolActivity {
  const state = objectValue(data.state);
  return {
    activityOrdinal: ordinal,
    activityKind: state && (state.output !== undefined || state.result !== undefined || state.error !== undefined) ? "result" : "call",
    toolName: stringValue(data.tool) ?? stringValue(data.name),
    toolText: safeBounded({ status: state?.status ?? data.status, input: state?.input ?? data.input, output: state?.output ?? state?.result ?? state?.error ?? data.output }),
    sourceActivityId: stringValue(data.callID) ?? stringValue(data.id) ?? partId,
  };
}

const connections = new Map<string, SourceDB>();
function openSource(path: string): SourceDB {
  const cached = connections.get(path);
  if (cached) return cached;
  const db: SourceDB = new (require("bun:sqlite").Database)(path, { readonly: true, strict: true });
  try { db.exec("PRAGMA query_only=ON;"); db.exec("PRAGMA busy_timeout=5000;"); }
  catch (error) { db.close(); throw error; }
  connections.set(path, db);
  return db;
}
function beginSnapshot(db: SourceDB): void { if (!db.inTransaction) db.exec("BEGIN DEFERRED TRANSACTION;"); }
function closeSource(path: string): void { const db = connections.get(path); if (!db) return; try { if (db.inTransaction) db.exec("ROLLBACK;"); } catch {} try { db.close(); } catch {} connections.delete(path); }
export function resetZcodeCache(): void { for (const path of [...connections.keys()]) closeSource(path); }
export function zcodeOpenSnapshotCount(): number { return connections.size; }

function externalIdentity(path: string): string | null {
  let identity: string | null = null;
  try {
    visitCompleteJsonlFile(path, ({ value }) => {
      const id = stringValue(objectValue(value)?.sessionId);
      if (!id) return;
      if (identity && identity !== id) throw new Error(`zcode: changing external sessionId in ${path}`);
      identity = id;
    });
    return identity;
  } catch { return null; }
}
function sourceObservedTs(path: string): number | null {
  let observed: number | null = null;
  for (const candidate of [path, `${path}-wal`]) { try { const mtime = Math.floor(statSync(candidate).mtimeMs); observed = observed === null ? mtime : Math.max(observed, mtime); } catch {} }
  return observed;
}
function semanticProjectionBytes(messages: NormalizedMessage[]): number {
  if (messages.length === 0) return 0;
  return Buffer.byteLength(JSON.stringify(messages.map((message) => [message.recordKind, message.dialogueSide, message.prose, message.eventTs, message.sourceRecordId, message.toolActivities])), "utf8");
}
function digestNumber(hash: ReturnType<typeof createHash>): number { return Number.parseInt(hash.digest("hex").slice(0, 13), 16); }
function stableJson(value: unknown): string { return JSON.stringify(value); }
function normalizedRole(value: string): Role { return value === "user" ? "user" : value === "assistant" ? "assistant" : value === "system" || value === "developer" ? "system" : "tool"; }
function sourceTimestamp(value: unknown): number | null { if (typeof value === "number" && Number.isFinite(value)) return Math.round(value); if (typeof value === "string" && value.trim()) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; } return null; }
function requiredId(value: unknown, field: string): string { const id = stringValue(value); if (!id) throw new Error(`zcode: missing ${field}`); return id; }
function eligibleTitle(value: unknown): string | null { return stringValue(value); }
function objectValue(value: unknown): Record<string, any> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function uuidValue(value: string | null): string | null { return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null; }
function safeJson(value: string): unknown { try { return JSON.parse(value); } catch { return null; } }
function safeBounded(value: unknown): string | null { if (value === undefined || value === null) return null; let text: string; if (typeof value === "string") text = value; else { try { text = JSON.stringify(value); } catch { text = String(value); } } return text.slice(0, 8000) || null; }
function truncateTitle(value: string): string { const one = value.replace(/\s+/g, " ").trim(); return one.length > 120 ? `${one.slice(0, 119)}…` : one; }
