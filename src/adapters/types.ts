import { closeSync, openSync, readSync } from "node:fs";
import type {
  ArtifactKind,
  DialogueSide,
  HistoryCompleteness,
  ProjectKeyEvidence,
  RecordKind,
  RejectionReasonCode,
  SourceValidationStatus,
  TitleAuthority,
  ToolActivityKind,
} from "../contracts/construction.js";

/**
 * Adapter interface — one file per harness (SPEC §1). A harness is "one
 * adapter file, not a redesign."
 *
 * Division of labor with the ingest orchestrator (src/ingest.ts):
 *   - ADAPTER owns FORMAT knowledge: how to find files, how to parse a
 *     single source unit into normalized records, and where the parse
 *     cursor stopped (offset discipline, Law 10).
 *   - ORCHESTRATOR owns STORAGE: mtime/size fast-path, dedupe across roots,
 *     session upsert, message append, ingest_state advancement.
 *
 * This keeps codex/kilo additions to one file each.
 */

/** A single readable source unit discovered under a root (a JSONL file, a db, ...). */
export interface DiscoveredSource {
  root: string; // absolute root path
  relPath: string; // stable key relative to root (for ingest_state)
  fullPath: string;
  nativeId: string; // provisional identity; authoritative extraction may replace it after admission
  /** Stable configured-root order used only after semantic-byte equality. */
  rootOrdinal?: number;
  /** Physical candidate family for reconciliation diagnostics, never a session kind. */
  candidateKind?: string;
  /**
   * Optional unit-local freshness evidence supplied by DB-backed adapters.
   * It must reflect the readable snapshot (including WAL), not merely the
   * container database file's stat values.
   */
  freshness?: { mtime: number; size: number };
}

export type Role = "user" | "assistant" | "tool" | "system";

/** Best-effort provenance derived only from durable harness metadata. */
export type SessionOrigin = "human" | "agent" | "mixed" | "unknown";

/** Stable source evidence used by the replay-aware logical projection. */
export type RecordIdentityKind = "uuid" | "record-id" | "message-id" | "none";

/** Whether a harness has a durable, parser-recognized continuity seam. */
export type ContinuitySupport = "supported" | "unknown" | "unsupported";
export type ContinuityEventKind = "compaction" | "checkpoint";

/** A continuity event is accepted only when a source record names it explicitly. */
export interface ContinuityEventEvidence {
  kind: ContinuityEventKind;
  sourceOrdinal: number;
  sourceRecordId?: string | null;
  sourceRecordUuid?: string | null;
  sourceRecordTs?: number | null;
  sourceIdentityKind?: RecordIdentityKind;
  detail?: string | null;
}

export interface SessionOriginEvidence {
  origin: SessionOrigin;
  detail: string | null;
}

/**
 * Resolve independent provenance signals conservatively. Stable, sorted
 * reason codes make origin_detail useful for inspection without storing
 * arbitrary source metadata or prompts.
 */
export function resolveSessionOrigin(
  agentSignals: Iterable<string>,
  humanSignals: Iterable<string>,
): SessionOriginEvidence {
  const agent = [...new Set(agentSignals)].sort();
  const human = [...new Set(humanSignals)].sort();
  if (agent.length > 0 && human.length > 0) {
    return { origin: "mixed", detail: `agent:${agent.join(",")};human:${human.join(",")}` };
  }
  if (agent.length > 0) return { origin: "agent", detail: agent.join(",") };
  if (human.length > 0) return { origin: "human", detail: human.join(",") };
  return { origin: "unknown", detail: null };
}

export interface NormalizedToolActivity {
  activityOrdinal: number;
  activityKind: ToolActivityKind;
  toolName: string | null;
  /**
   * Transient adapter output. Atlas sidecars replace this payload with the
   * digest/size/token metadata below before anything is persisted.
   */
  toolText: string | null;
  sourceActivityId: string | null;
  payloadDigest?: string | null;
  payloadBytes?: number;
  payloadTokenEstimate?: number;
}

/** One admitted raw provenance envelope, before replay election. */
export interface NormalizedMessage {
  ordinal: number;
  /** Original source ordering evidence. Gaps are allowed. */
  sourceOrdinal?: number;
  role: Role;
  ts: number | null; // legacy compatibility; canonical semantic time is eventTs
  text: string | null; // legacy compatibility; canonical source-backed channel is prose
  toolText: string | null; // legacy compatibility; child activities are canonical
  hasTool: boolean;
  /** Required for a valid v11 generation; absent legacy drafts fail closed. */
  recordKind?: RecordKind;
  dialogueSide?: DialogueSide | null;
  prose?: string | null;
  eventTs?: number | null;
  toolActivities?: NormalizedToolActivity[];
  /** Stable source-record evidence. Missing evidence is intentionally retained. */
  sourceRecordId?: string | null;
  sourceRecordUuid?: string | null;
  sourceRecordTs?: number | null;
  sourceIdentityKind?: RecordIdentityKind;
  /** Evidence retained when non-dialogue prose/control payload is omitted. */
  contentDigest?: string | null;
  contentBytes?: number;
  contentTokenEstimate?: number;
  sourceProsePresent?: boolean;
}

export interface AdapterTitleCandidate {
  value: string;
  authority: Exclude<TitleAuthority, "atlas_user_override">;
  harnessSourceClass: string | null;
  sourceRecordId: string | null;
  sourceReference: string | null;
  sourceOrdinal: number | null;
  eligibilityRuleVersion: string;
}

export interface AdapterConstructionDraft {
  artifactKind: ArtifactKind;
  historyCompleteness: HistoryCompleteness;
  defaultSessionVisible: boolean;
  sourceValidationStatus: SourceValidationStatus;
  sourceObservedTs: number | null;
  project: ProjectKeyEvidence;
  titleCandidates: AdapterTitleCandidate[];
  classificationRuleVersion: string;
  replayRuleVersion: string;
}

export interface RejectedSourceUnit {
  admitted: false;
  source: DiscoveredSource;
  reason: RejectionReasonCode;
  detail: string | null;
}

/** A parsed session ready for the orchestrator to reconcile. */
export interface IngestRecord {
  nativeId: string;
  cwd: string | null;
  project: string | null;
  title: string | null;
  startTs: number | null;
  endTs: number | null;
  models: string[];
  messages: NormalizedMessage[];
  transcriptBytes: number; // bytes of complete parsed source content
  origin: SessionOrigin;
  originDetail?: string | null;
  /**
   * Lineage edge: native id of the prior session this one continues
   * (resume/compact/fork). Null when none. Identity is (harness, native_id),
   * so the edge is only meaningful within the same harness. Kilo parent_id is
   * the live signal; Claude/Codex do inline compaction (singletons in md's data).
   */
  parentNativeId?: string | null;
  /** Explicit source continuity evidence; absent means no event was observed. */
  continuityEvents?: ContinuityEventEvidence[];
  /** Capability report used to distinguish empty history from unsupported evidence. */
  continuitySupport?: ContinuitySupport;
  /** Exact v11 evidence. Ingest rejects publication as valid when absent. */
  construction?: AdapterConstructionDraft;
}

export interface ParseResult {
  record: IngestRecord;
  /**
   * Position past the last complete parsed unit (Law 10: a torn trailing
   * unit is NOT counted here, so the next run re-reads it — zero lost,
   * zero duplicated).
   */
  consumed: number;
}

/** A newline-terminated JSONL record is complete and therefore must either
 * parse or stop the unit at its first byte.  Torn trailing records are not
 * returned and remain retryable on the next ingest. */
export class MalformedJsonlLineError extends Error {
  constructor(
    public readonly sourcePath: string,
    public readonly byteOffset: number,
    detail: string,
  ) {
    super(`malformed complete JSONL line at byte ${byteOffset} in ${sourcePath}: ${detail}`);
    this.name = "MalformedJsonlLineError";
  }
}

export interface ParsedJsonlLine {
  value: unknown;
  byteOffset: number;
}

/** Default source read window. It bounds raw-file memory independently of the
 * size of the JSONL unit; only a single unterminated logical line may exceed
 * it. Exported so tests can force chunk-boundary behavior with a tiny window. */
export const JSONL_READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Visit only newline-terminated records, with byte-accurate error offsets.
 * The callback form keeps a large JSONL source from retaining a second array
 * of every parsed record while an adapter builds its normalized transcript.
 */
export function visitCompleteJsonl(
  buffer: Buffer,
  sourcePath: string,
  visit: (line: ParsedJsonlLine) => void,
): number {
  const lastNewline = buffer.lastIndexOf(0x0a);
  const consumed = lastNewline < 0 ? 0 : lastNewline + 1;
  let offset = 0;
  while (offset < consumed) {
    const newline = buffer.indexOf(0x0a, offset);
    const raw = buffer.subarray(offset, newline);
    visitJsonlLine(raw, sourcePath, offset, visit);
    offset = newline + 1;
  }
  return consumed;
}

/**
 * Visit a JSONL file without retaining its raw bytes. The read buffer is
 * reused; only the trailing partial logical line is copied between reads.
 * Byte offsets and torn-tail semantics exactly match visitCompleteJsonl.
 */
export function visitCompleteJsonlFile(
  sourcePath: string,
  visit: (line: ParsedJsonlLine) => void,
  chunkBytes = JSONL_READ_CHUNK_BYTES,
): number {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new RangeError("JSONL chunk size must be a positive integer");
  }
  const fd = openSync(sourcePath, "r");
  const chunk = Buffer.allocUnsafe(chunkBytes);
  let carry: Buffer[] = [];
  let carryBytes = 0;
  let carryOffset = 0;
  let fileOffset = 0;
  let consumed = 0;
  try {
    while (true) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const view = chunk.subarray(0, bytesRead);
      let cursor = 0;

      if (carryBytes > 0) {
        const newline = view.indexOf(0x0a);
        if (newline < 0) {
          carry.push(Buffer.from(view));
          carryBytes += bytesRead;
          fileOffset += bytesRead;
          continue;
        }
        const raw = Buffer.concat([...carry, view.subarray(0, newline)], carryBytes + newline);
        visitJsonlLine(raw, sourcePath, carryOffset, visit);
        consumed = fileOffset + newline + 1;
        carry = [];
        carryBytes = 0;
        cursor = newline + 1;
      }

      while (cursor < bytesRead) {
        const newline = view.indexOf(0x0a, cursor);
        if (newline < 0) break;
        visitJsonlLine(view.subarray(cursor, newline), sourcePath, fileOffset + cursor, visit);
        consumed = fileOffset + newline + 1;
        cursor = newline + 1;
      }

      if (cursor < bytesRead) {
        const tail = Buffer.from(view.subarray(cursor));
        carry = [tail];
        carryBytes = tail.length;
        carryOffset = fileOffset + cursor;
      }
      fileOffset += bytesRead;
    }
    return consumed;
  } finally {
    closeSync(fd);
  }
}

function visitJsonlLine(
  raw: Buffer,
  sourcePath: string,
  byteOffset: number,
  visit: (line: ParsedJsonlLine) => void,
): void {
  const text = raw.toString("utf8");
  if (!text.trim()) return;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new MalformedJsonlLineError(sourcePath, byteOffset, detail);
  }
  visit({ value, byteOffset });
}

/** Compatibility collector for callers that genuinely need all parsed rows. */
export function parseCompleteJsonl(
  buffer: Buffer,
  sourcePath: string,
): { lines: ParsedJsonlLine[]; consumed: number } {
  const lines: ParsedJsonlLine[] = [];
  const consumed = visitCompleteJsonl(buffer, sourcePath, (line) => lines.push(line));
  return { lines, consumed };
}

export type AdmissionResult =
  | ({ admitted: true } & ParseResult)
  | RejectedSourceUnit;

export interface Adapter {
  source: string;
  /**
   * Version of the complete adapter output contract used by ingest sidecars.
   * Adapters without a version deliberately bypass the persistent sidecar
   * path; this keeps injected/legacy adapters from being cached accidentally.
   */
  sidecarVersion?: string;
  /**
   * Version of the admission rules alone. A cached rejection is honoured only
   * while this matches, so loosening admission re-checks rejected units without
   * re-parsing every admitted one (admitted sidecars follow sidecarVersion).
   */
  admissionVersion?: string;
  /** Small, source-backed dependencies not represented by the primary unit. */
  sidecarContextFingerprint?: (src: DiscoveredSource) => unknown;
  /** Static capability declaration; records may upgrade unknown to supported. */
  continuitySupport?: ContinuitySupport;
  /** Enumerate source units across the ordered roots. Never writes (Law 2). */
  discover(roots: string[]): DiscoveredSource[];
  /**
   * Re-derive the full current record for one source unit. The orchestrator
   * fast-paths unchanged units, so this only runs when something changed.
   */
  parse(src: DiscoveredSource): ParseResult;
  /**
   * Contract admission seam. Phase 3 adapters may implement this to separate
   * rejected physical units from admitted session candidates without making
   * path/filename discovery itself authoritative.
   */
  admit?: (src: DiscoveredSource) => AdmissionResult;
  /** Release read-only source snapshots/handles after each ingest run. */
  cleanup?: () => void;
}
