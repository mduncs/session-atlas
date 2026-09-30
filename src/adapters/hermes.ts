import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
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

const HERMES_CLASSIFICATION_VERSION = "hermes-v11-contract-1";
const HERMES_REPLAY_VERSION = "hermes-platform-or-row-id-time-v1";
const HERMES_TITLE_VERSION = "hermes-title-v1";

/** Authoritative, read-only Hermes SQLite adapter. */
export const hermesAdapter: Adapter = {
  source: "hermes",
  continuitySupport: "unsupported",
  sidecarVersion: `${HERMES_CLASSIFICATION_VERSION}:${HERMES_REPLAY_VERSION}:${HERMES_TITLE_VERSION}:compact-v1`,

  discover(roots: string[]): DiscoveredSource[] {
    const out: DiscoveredSource[] = [];
    roots.forEach((configured, rootOrdinal) => {
      const path = resolve(configured);
      try {
        const db = openSource(path);
        beginSnapshot(db);
        const sessions = db.prepare(`SELECT id,source,parent_session_id,started_at,ended_at,model,cwd,git_repo_root,title,message_count,archived FROM sessions ORDER BY id`).all() as Array<Record<string, unknown>>;
        const hashes = new Map<string, ReturnType<typeof createHash>>();
        const highwater = new Map<string, number>();
        for (const row of sessions) {
          const id = requiredId(row.id, "sessions.id");
          if (hashes.has(id)) throw new Error(`hermes: duplicate authoritative sessions.id ${id}`);
          hashes.set(id, createHash("sha256").update(stableJson(row)));
          highwater.set(id, Math.max(sourceTimestamp(row.started_at) ?? 0, sourceTimestamp(row.ended_at) ?? 0));
        }
        const rows = db.prepare(`SELECT id,session_id,role,content,tool_call_id,tool_calls,tool_name,timestamp,platform_message_id,active,compacted FROM messages ORDER BY session_id,timestamp,id`).iterate() as Iterable<Record<string, unknown>>;
        for (const row of rows) {
          const sessionId = String(row.session_id);
          hashes.get(sessionId)?.update(stableJson(row));
          highwater.set(sessionId, Math.max(highwater.get(sessionId) ?? 0, sourceTimestamp(row.timestamp) ?? 0));
        }
        for (const row of sessions) {
          const id = String(row.id);
          out.push({
            root: path,
            relPath: id,
            fullPath: path,
            nativeId: id,
            rootOrdinal,
            candidateKind: "hermes:sqlite-session",
            freshness: { mtime: highwater.get(id) ?? 0, size: digestNumber(hashes.get(id)!) },
          });
        }
      } catch (error) {
        closeSource(path);
        throw error;
      }
    });
    return out;
  },

  parse(src: DiscoveredSource): ParseResult {
    const db = openSource(src.fullPath);
    beginSnapshot(db);
    const sessionRows = db.prepare(`SELECT id,source,parent_session_id,started_at,ended_at,model,cwd,git_repo_root,title,message_count FROM sessions WHERE id=?`).all(src.nativeId) as Array<Record<string, unknown>>;
    if (sessionRows.length === 0) throw new Error(`hermes: session ${src.nativeId} disappeared during ingest`);
    if (sessionRows.length !== 1) throw new Error(`hermes: duplicate authoritative session ${src.nativeId}`);
    const session = sessionRows[0]!;
    const rows = db.prepare(`SELECT id,role,content,tool_call_id,tool_calls,tool_name,timestamp,platform_message_id,active,compacted FROM messages WHERE session_id=? ORDER BY timestamp,id`).all(src.nativeId) as Array<Record<string, unknown>>;
    const messages: NormalizedMessage[] = [];
    let fallback: { value: string; ordinal: number; id: string | null } | null = null;

    for (const [sourceOrdinal, row] of rows.entries()) {
      const sourceRole = stringValue(row.role)?.toLowerCase() ?? "unknown";
      const role = normalizedRole(sourceRole);
      const content = stringValue(row.content);
      const activities = hermesActivities(row, sourceRole);
      const prose = sourceRole === "tool" ? null : content;
      let recordKind: NonNullable<NormalizedMessage["recordKind"]>;
      let dialogueSide: NormalizedMessage["dialogueSide"] = null;
      if (sourceRole === "user" && prose) { recordKind = "real_user"; dialogueSide = "user"; }
      else if (sourceRole === "assistant" && prose) { recordKind = "assistant_dialogue_prose"; dialogueSide = "assistant"; }
      else if (activities.length > 0 || sourceRole === "tool") recordKind = "tool";
      else if (sourceRole === "system" || sourceRole === "developer") recordKind = "developer_system";
      else recordKind = "unclassified";
      const stable = stringValue(row.platform_message_id) ?? String(row.id);
      const eventTs = sourceTimestamp(row.timestamp);
      const toolText = activities.map((item) => item.toolText).filter((item): item is string => item !== null).join("\n") || null;
      const message: NormalizedMessage = {
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
        sourceRecordId: stable,
        sourceRecordUuid: uuidValue(stable),
        sourceRecordTs: eventTs,
        sourceIdentityKind: row.platform_message_id ? "message-id" : "record-id",
      };
      messages.push(message);
      if (recordKind === "real_user" && prose && !fallback) fallback = { value: truncateTitle(prose), ordinal: sourceOrdinal, id: stable };
    }

    const explicitValue = stringValue(session.title);
    const explicit = explicitValue ? { value: truncateTitle(explicitValue), ordinal: 0, id: src.nativeId } : null;
    const fallbackValue = fallback as { value: string; ordinal: number; id: string | null } | null;
    const titleCandidates: AdapterTitleCandidate[] = [];
    if (explicit) titleCandidates.push(titleCandidate(explicit, "source_explicit", "sessions.title", src.relPath));
    if (fallbackValue) titleCandidates.push(titleCandidate(fallbackValue, "real_user_fallback", "messages.real_user", src.relPath));
    const cwd = stringValue(session.cwd);
    const canonicalProject = stringValue(session.git_repo_root) ?? (cwd ? gitRoot(cwd) : null);
    const construction: AdapterConstructionDraft = {
      artifactKind: rows.length === 0 ? "metadata_shell" : "dialogue_history",
      historyCompleteness: "complete",
      defaultSessionVisible: messages.some((message) => message.dialogueSide !== null),
      sourceValidationStatus: "current",
      sourceObservedTs: sourceObservedTs(src.fullPath),
      project: { originalProjectKey: cwd, canonicalProjectKey: canonicalProject, canonicalizationRuleVersion: canonicalProject ? "hermes-git-root-v1" : null },
      titleCandidates,
      classificationRuleVersion: HERMES_CLASSIFICATION_VERSION,
      replayRuleVersion: HERMES_REPLAY_VERSION,
    };
    const source = stringValue(session.source);
    const parent = stringValue(session.parent_session_id);
    const semanticBytes = semanticProjectionBytes(messages);
    return {
      record: {
        nativeId: src.nativeId,
        cwd,
        project: canonicalProject,
        title: explicit?.value ?? fallbackValue?.value ?? null,
        startTs: sourceTimestamp(session.started_at),
        endTs: sourceTimestamp(session.ended_at),
        models: stringValue(session.model) ? [String(session.model).trim()] : [],
        messages,
        transcriptBytes: semanticBytes,
        parentNativeId: parent,
        origin: parent ? "agent" : source === "cli" ? "human" : "unknown",
        originDetail: parent ? "hermes:parent_session_id" : source === "cli" ? "hermes:direct-cli" : source ? `hermes:source:${source}` : null,
        continuityEvents: [],
        continuitySupport: "unsupported",
        construction,
      },
      consumed: semanticBytes,
    };
  },

  cleanup(): void { resetHermesCache(); },
};

function hermesActivities(row: Record<string, unknown>, sourceRole: string): NormalizedToolActivity[] {
  const activities: NormalizedToolActivity[] = [];
  const calls = stringValue(row.tool_calls);
  if (calls) {
    const decoded = safeJson(calls);
    const values = Array.isArray(decoded) ? decoded : [decoded ?? calls];
    for (const value of values) {
      const call = objectValue(value);
      const fn = objectValue(call?.function);
      activities.push({
        activityOrdinal: activities.length,
        activityKind: "call",
        toolName: stringValue(fn?.name) ?? stringValue(call?.name) ?? stringValue(row.tool_name),
        toolText: safeBounded(fn?.arguments ?? call?.arguments ?? call?.input ?? value),
        sourceActivityId: stringValue(call?.id) ?? stringValue(row.tool_call_id),
      });
    }
  }
  if (sourceRole === "tool" || (!calls && (stringValue(row.tool_name) || stringValue(row.tool_call_id)))) {
    activities.push({
      activityOrdinal: activities.length,
      activityKind: sourceRole === "tool" ? "result" : calls ? "other" : "call",
      toolName: stringValue(row.tool_name),
      toolText: sourceRole === "tool" ? safeBounded(row.content) : null,
      sourceActivityId: stringValue(row.tool_call_id),
    });
  }
  return activities;
}

const connections = new Map<string, SourceDB>();
function openSource(path: string): SourceDB {
  const cached = connections.get(path);
  if (cached) return cached;
  let db: SourceDB;
  try { db = new (require("bun:sqlite").Database)(path, { readonly: true, strict: true }); }
  catch { throw new Error(`hermes: cannot open ${path} (read-only)`); }
  try {
    db.exec("PRAGMA query_only=ON;");
    db.exec("PRAGMA busy_timeout=5000;");
  } catch (error) {
    db.close();
    throw error;
  }
  connections.set(path, db);
  return db;
}
function beginSnapshot(db: SourceDB): void { if (!db.inTransaction) db.exec("BEGIN DEFERRED TRANSACTION;"); }
function closeSource(path: string): void {
  const db = connections.get(path);
  if (!db) return;
  try { if (db.inTransaction) db.exec("ROLLBACK;"); } catch {}
  try { db.close(); } catch {}
  connections.delete(path);
}
export function resetHermesCache(): void { for (const path of [...connections.keys()]) closeSource(path); }
export function hermesOpenSnapshotCount(): number { return connections.size; }

function titleCandidate(candidate: { value: string; ordinal: number; id: string | null }, authority: "source_explicit" | "real_user_fallback", sourceClass: string, reference: string): AdapterTitleCandidate {
  return { value: candidate.value, authority, harnessSourceClass: sourceClass, sourceRecordId: candidate.id, sourceReference: reference, sourceOrdinal: candidate.ordinal, eligibilityRuleVersion: HERMES_TITLE_VERSION };
}
function semanticProjectionBytes(messages: NormalizedMessage[]): number {
  if (messages.length === 0) return 0;
  return Buffer.byteLength(JSON.stringify(messages.map((message) => [message.recordKind, message.dialogueSide, message.prose, message.eventTs, message.sourceRecordId, message.toolActivities])), "utf8");
}
function sourceObservedTs(path: string): number | null {
  let observed: number | null = null;
  for (const candidate of [path, `${path}-wal`]) {
    try { const value = Math.floor(statSync(candidate).mtimeMs); observed = observed === null ? value : Math.max(observed, value); } catch {}
  }
  return observed;
}
function digestNumber(hash: ReturnType<typeof createHash>): number { return Number.parseInt(hash.digest("hex").slice(0, 13), 16); }
function stableJson(value: unknown): string { return JSON.stringify(value); }
function sourceTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value < 10_000_000_000 ? value * 1000 : value);
  if (typeof value === "string" && value.trim()) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
}
function normalizedRole(value: string): Role { return value === "user" ? "user" : value === "assistant" ? "assistant" : value === "system" || value === "developer" ? "system" : "tool"; }
function requiredId(value: unknown, field: string): string { const id = stringValue(value); if (!id) throw new Error(`hermes: missing ${field}`); return id; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function objectValue(value: unknown): Record<string, any> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null; }
function uuidValue(value: string): string | null { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null; }
function safeJson(value: string): unknown { try { return JSON.parse(value); } catch { return null; } }
function safeBounded(value: unknown): string | null { if (value === null || value === undefined) return null; let text: string; if (typeof value === "string") text = value; else { try { text = JSON.stringify(value); } catch { text = String(value); } } return text.slice(0, 8000) || null; }
function truncateTitle(value: string): string { const one = value.replace(/\s+/g, " ").trim(); return one.length > 120 ? `${one.slice(0, 119)}…` : one; }
