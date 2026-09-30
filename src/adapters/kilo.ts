import type { Database as KiloDB } from "bun:sqlite";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";
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

const KILO_CLASSIFICATION_VERSION = "kilo-v11-generic-tool-v1";
const KILO_REPLAY_VERSION = "kilo-message-id-original-time-v1";
const KILO_TITLE_VERSION = "kilo-title-v1";

/** Read-only, WAL-visible Kilo SQLite adapter. */
export const kiloAdapter: Adapter = {
  source: "kilo",
  continuitySupport: "unsupported",
  sidecarVersion: `${KILO_CLASSIFICATION_VERSION}:${KILO_REPLAY_VERSION}:${KILO_TITLE_VERSION}:compact-v1`,

  discover(roots: string[]): DiscoveredSource[] {
    const out: DiscoveredSource[] = [];
    roots.forEach((configured, rootOrdinal) => {
      const path = resolve(configured);
      try {
        const db = openKilo(path);
        beginSnapshot(db);
        const rows = db.prepare(`SELECT rowid AS source_rowid,id,directory,title,time_created,time_updated,parent_id FROM session ORDER BY source_rowid`).all() as Array<Record<string, unknown>>;
        const hashes = new Map<string, ReturnType<typeof createHash>>();
        const highwater = new Map<string, number>();
        for (const row of rows) {
          const id = requiredId(row.id, "session.id");
          if (hashes.has(id)) throw new Error(`kilo: duplicate session.id ${id}`);
          hashes.set(id, createHash("sha256").update(stableJson(row)));
          highwater.set(id, Math.max(sourceTimestamp(row.time_created) ?? 0, sourceTimestamp(row.time_updated) ?? 0));
        }
        const messageRows = db.prepare(`SELECT rowid AS source_rowid,session_id,id,time_created,data FROM message ORDER BY source_rowid`).iterate() as Iterable<Record<string, unknown>>;
        for (const row of messageRows) {
          const sessionId = String(row.session_id);
          hashes.get(sessionId)?.update(stableJson(row));
          highwater.set(sessionId, Math.max(highwater.get(sessionId) ?? 0, sourceTimestamp(row.time_created) ?? 0));
        }
        const partRows = db.prepare(`SELECT p.rowid AS source_rowid,m.session_id,p.id,p.message_id,p.time_created,p.data FROM part p JOIN message m ON m.id=p.message_id ORDER BY p.rowid`).iterate() as Iterable<Record<string, unknown>>;
        for (const row of partRows) {
          const sessionId = String(row.session_id);
          hashes.get(sessionId)?.update(stableJson(row));
          highwater.set(sessionId, Math.max(highwater.get(sessionId) ?? 0, sourceTimestamp(row.time_created) ?? 0));
        }
        for (const row of rows) {
          const id = String(row.id);
          out.push({
            root: path,
            relPath: id,
            fullPath: path,
            nativeId: id,
            rootOrdinal,
            candidateKind: "kilo:sqlite-session",
            freshness: { mtime: highwater.get(id) ?? 0, size: digestNumber(hashes.get(id)!) },
          });
        }
      } catch (error) {
        closeKilo(path);
        throw error;
      }
    });
    return out;
  },

  parse(src: DiscoveredSource): ParseResult {
    const db = openKilo(src.fullPath);
    beginSnapshot(db);
    const session = db.prepare(`SELECT rowid AS source_rowid,id,directory,title,time_created,time_updated,parent_id FROM session WHERE id=?`).get(src.nativeId) as Record<string, unknown> | null;
    if (!session) throw new Error(`kilo: session ${src.nativeId} disappeared during ingest`);
    const rows = db.prepare(`SELECT rowid AS source_rowid,id,time_created,data FROM message WHERE session_id=? ORDER BY source_rowid`).all(src.nativeId) as Array<Record<string, unknown>>;
    const partRows = db.prepare(`SELECT rowid AS source_rowid,id,message_id,time_created,data FROM part WHERE message_id IN (SELECT id FROM message WHERE session_id=?) ORDER BY source_rowid`).all(src.nativeId) as Array<Record<string, unknown>>;
    const parts = new Map<string, Array<Record<string, unknown>>>();
    for (const row of partRows) {
      const messageId = String(row.message_id);
      const bucket = parts.get(messageId) ?? [];
      bucket.push(row);
      parts.set(messageId, bucket);
    }

    const messages: NormalizedMessage[] = [];
    const models = new Set<string>();
    let fallback: { value: string; ordinal: number; id: string | null } | null = null;
    for (const [sourceOrdinal, row] of rows.entries()) {
      const metadata = objectValue(safeJson(stringValue(row.data) ?? ""));
      const sourceRole = stringValue(metadata?.role)?.toLowerCase() ?? "unknown";
      const role = kiloRole(sourceRole);
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
        else if (type === "tool" || type === "tool-invocation" || type === "tool-call" || type === "tool-result" || type === "tool-output") {
          activities.push(kiloToolActivity(type, data!, activities.length, String(part.id)));
        } else if (type && /(reasoning|thinking|control)/i.test(type)) hasControl = true;
        else hasUnknown = true;
      }
      const messageType = stringValue(metadata?.type);
      if (messageType && /(reasoning|thinking|control)/i.test(messageType)) hasControl = true;
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

    const rawTitle = stringValue(session.title);
    const explicitValue = rawTitle && !isGenericPlaceholder(rawTitle) ? rawTitle : null;
    const explicit = explicitValue ? { value: truncateTitle(explicitValue), ordinal: 0, id: src.nativeId } : null;
    const fallbackValue = fallback as { value: string; ordinal: number; id: string | null } | null;
    const titleCandidates: AdapterTitleCandidate[] = [];
    if (explicit) titleCandidates.push(titleCandidate(explicit, "source_explicit", "session.title", src.relPath));
    if (fallbackValue) titleCandidates.push(titleCandidate(fallbackValue, "real_user_fallback", "message.real_user", src.relPath));
    const cwd = stringValue(session.directory);
    const parent = stringValue(session.parent_id);
    const construction: AdapterConstructionDraft = {
      artifactKind: rows.length === 0 ? "metadata_shell" : "dialogue_history",
      historyCompleteness: "complete",
      defaultSessionVisible: messages.some((message) => message.dialogueSide !== null),
      sourceValidationStatus: "current",
      sourceObservedTs: sourceObservedTs(src.fullPath),
      project: { originalProjectKey: cwd, canonicalProjectKey: cwd ? gitRoot(cwd) : null, canonicalizationRuleVersion: cwd ? "git-root-v1" : null },
      titleCandidates,
      classificationRuleVersion: KILO_CLASSIFICATION_VERSION,
      replayRuleVersion: KILO_REPLAY_VERSION,
    };
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
        origin: parent ? "agent" : "human",
        originDetail: parent ? "kilo:parent_id" : "kilo:root-session",
        continuityEvents: [],
        continuitySupport: "unsupported",
        construction,
      },
      consumed: semanticBytes,
    };
  },

  cleanup(): void { resetKiloCache(); },
};

function kiloToolActivity(type: string, data: Record<string, any>, ordinal: number, partId: string): NormalizedToolActivity {
  const state = objectValue(data.state);
  let activityKind: NormalizedToolActivity["activityKind"];
  if (type === "tool-result" || type === "tool-output") activityKind = "result";
  else if (type === "tool-invocation" || type === "tool-call") activityKind = "call";
  else activityKind = state && (state.output !== undefined || state.result !== undefined || state.error !== undefined) ? "result" : "call";
  const evidence = type === "tool"
    ? { status: state?.status ?? data.status, input: state?.input ?? data.input, output: state?.output ?? state?.result ?? state?.error ?? data.output ?? data.result }
    : activityKind === "call" ? data.input ?? data.arguments ?? state?.input : data.output ?? data.result ?? state?.output ?? state?.result ?? state?.error;
  return {
    activityOrdinal: ordinal,
    activityKind,
    toolName: stringValue(data.tool) ?? stringValue(data.toolName) ?? stringValue(data.name),
    toolText: safeBounded(evidence),
    sourceActivityId: stringValue(data.callID) ?? stringValue(data.toolCallId) ?? stringValue(data.id) ?? partId,
  };
}

const connections = new Map<string, KiloDB>();
function openKilo(path: string): KiloDB {
  const cached = connections.get(path);
  if (cached) return cached;
  let db: KiloDB;
  try { db = new (require("bun:sqlite").Database)(path, { readonly: true, strict: true }); }
  catch { throw new Error(`kilo: cannot open ${path} (read-only)`); }
  try { db.exec("PRAGMA query_only=ON;"); db.exec("PRAGMA busy_timeout=5000;"); }
  catch (error) { db.close(); throw error; }
  connections.set(path, db);
  return db;
}
function beginSnapshot(db: KiloDB): void { if (!db.inTransaction) db.exec("BEGIN DEFERRED TRANSACTION;"); }
function closeKilo(path: string): void { const db = connections.get(path); if (!db) return; try { if (db.inTransaction) db.exec("ROLLBACK;"); } catch {} try { db.close(); } catch {} connections.delete(path); }
export function resetKiloCache(): void { for (const path of [...connections.keys()]) closeKilo(path); }
export function kiloOpenSnapshotCount(): number { return connections.size; }

function titleCandidate(candidate: { value: string; ordinal: number; id: string | null }, authority: "source_explicit" | "real_user_fallback", sourceClass: string, reference: string): AdapterTitleCandidate {
  return { value: candidate.value, authority, harnessSourceClass: sourceClass, sourceRecordId: candidate.id, sourceReference: reference, sourceOrdinal: candidate.ordinal, eligibilityRuleVersion: KILO_TITLE_VERSION };
}
function isGenericPlaceholder(value: string): boolean {
  const match = /^New session - (.+)$/.exec(value.trim());
  if (!match) return false;
  return sourceTimestamp(match[1]) !== null;
}
function semanticProjectionBytes(messages: NormalizedMessage[]): number {
  if (messages.length === 0) return 0;
  return Buffer.byteLength(JSON.stringify(messages.map((message) => [message.recordKind, message.dialogueSide, message.prose, message.eventTs, message.sourceRecordId, message.toolActivities])), "utf8");
}
function sourceObservedTs(path: string): number | null { let observed: number | null = null; for (const candidate of [path, `${path}-wal`]) { try { const mtime = Math.floor(statSync(candidate).mtimeMs); observed = observed === null ? mtime : Math.max(observed, mtime); } catch {} } return observed; }
function digestNumber(hash: ReturnType<typeof createHash>): number { return Number.parseInt(hash.digest("hex").slice(0, 13), 16); }
function stableJson(value: unknown): string { return JSON.stringify(value); }
function sourceTimestamp(value: unknown): number | null { if (typeof value === "number" && Number.isFinite(value)) return Math.round(value); if (typeof value === "string" && value.trim()) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; } return null; }
function requiredId(value: unknown, field: string): string { const id = stringValue(value); if (!id) throw new Error(`kilo: missing ${field}`); return id; }
function kiloRole(value: string): Role { return value === "user" ? "user" : value === "assistant" ? "assistant" : value === "system" || value === "developer" ? "system" : "tool"; }
function objectValue(value: unknown): Record<string, any> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function uuidValue(value: string | null): string | null { return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null; }
function safeJson(value: string): unknown { try { return JSON.parse(value); } catch { return null; } }
function safeBounded(value: unknown): string | null { if (value === undefined || value === null) return null; let text: string; if (typeof value === "string") text = value; else { try { text = JSON.stringify(value); } catch { text = String(value); } } return text.slice(0, 8000) || null; }
function truncateTitle(value: string): string { const one = value.replace(/\s+/g, " ").trim(); return one.length > 120 ? `${one.slice(0, 119)}…` : one; }
