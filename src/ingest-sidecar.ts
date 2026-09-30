import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  Adapter,
  AdmissionResult,
  DiscoveredSource,
  IngestRecord,
  NormalizedMessage,
  NormalizedToolActivity,
  RecordIdentityKind,
} from "./adapters/types.js";
import type {
  ConstructionMetricsDto,
  DialogueSide,
  RecordKind,
  RejectionReasonCode,
  SourceIdentityKind,
} from "./contracts/construction.js";
import { engagementRatio, estimateTokens } from "./metrics.js";
import { countContinuityEvidence } from "./continuity-history.js";

export const INGEST_SIDECAR_FORMAT = "session-atlas-ingest-sidecar-v1";
const MAX_HEADER_BYTES = 256 * 1024;
const HEADER_PREFIX_PATTERN = /^ATLAS1:([0-9a-f]{8})\n$/;
const HEADER_PREFIX_BYTES = 16;

export interface PreparedLogicalRecord {
  logicalOrdinal: number;
  logicalKey: string;
  identityKind: SourceIdentityKind;
  sourceRecordId: string | null;
  sourceRecordUuid: string | null;
  sourceRecordTs: number | null;
  memberOrdinals: number[];
  recordKind: RecordKind;
  dialogueSide: DialogueSide | null;
  identityStatus: "proved" | "unknown";
}

export interface PreparedLegacyMetrics {
  tokUser: number;
  tokAssistant: number;
  tokTool: number;
  toolActivityCount: number;
  logicalRecordCount: number;
  logicalReplayCount: number;
  logicalIdentityCount: number;
  logicalUnknownCount: number;
  identityStatus: "complete" | "partial";
}

export interface PreparedConstruction {
  record: IngestRecord;
  logicalRecords: PreparedLogicalRecord[];
  constructionMetrics: ConstructionMetricsDto;
  logicalMetrics: PreparedLegacyMetrics;
  aggregate: {
    tokUser: number;
    tokAssistant: number;
    tokTool: number;
    engagement: number | null;
    durationMs: number | null;
    lastActivity: number | null;
  };
}

export interface AdmittedSidecarSummary {
  kind: "admitted";
  nativeId: string;
  consumed: number;
  semanticBytes: number;
  constructionGeneration: string;
  rawRecordCount: number;
  logicalRecordCount: number;
  rawToolActivityCount: number;
  continuityEvidenceCount: number;
  lineageClaimCount: number;
  titleCandidateCount: number;
  sourceValidationStatus: string;
  sourceObservedTs: number | null;
  defaultSessionVisible: boolean;
}

export interface RejectedSidecarSummary {
  kind: "rejected";
  reason: RejectionReasonCode;
  detail: string | null;
}

export type SidecarOutcomeSummary = AdmittedSidecarSummary | RejectedSidecarSummary;

export interface SidecarHeader {
  format: typeof INGEST_SIDECAR_FORMAT;
  parser: { source: string; version: string; admission?: string | null };
  source: {
    root: string;
    relPath: string;
    fullPath: string;
    provisionalNativeId: string;
    candidateKind: string | null;
    fingerprint: string;
  };
  outcome: SidecarOutcomeSummary;
  payloadBytes: number;
  payloadSha256: string;
  writtenAt: number;
}

export interface ResolvedSidecar {
  path: string;
  header: SidecarHeader;
  cache: "hit" | "miss";
  prepared: PreparedConstruction | null;
}

export interface ResolveSidecarOptions {
  root: string;
  adapter: Adapter;
  source: DiscoveredSource;
  parse: () => AdmissionResult;
  validate: (record: IngestRecord) => void;
  force?: boolean;
}

export class SourceChangedDuringSidecarCaptureError extends Error {
  constructor(path: string) {
    super(`source changed while capturing ingest sidecar: ${path}`);
    this.name = "SourceChangedDuringSidecarCaptureError";
  }
}

export class InvalidIngestSidecarError extends Error {
  constructor(path: string, detail: string) {
    super(`invalid ingest sidecar ${path}: ${detail}`);
    this.name = "InvalidIngestSidecarError";
  }
}

export function defaultIngestSidecarRoot(dbPath: string): string {
  return `${dbPath}.ingest-sidecars`;
}

export function ensureIngestSidecarRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const entry = lstatSync(root);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`ingest sidecar root is not an owner directory: ${root}`);
  chmodSync(root, 0o700);
}

export function resolveIngestSidecar(options: ResolveSidecarOptions): ResolvedSidecar {
  const version = options.adapter.sidecarVersion;
  if (!version) throw new Error(`${options.adapter.source} adapter has no ingest sidecar version`);
  ensureIngestSidecarRoot(options.root);
  const path = ingestSidecarPath(options.root, options.adapter.source, options.source);
  const fingerprint = sourceFingerprint(options.adapter, options.source);
  if (!options.force) {
    const cached = readHeader(path);
    if (cached && headerMatches(cached.header, options.adapter, options.source, fingerprint)) {
      return { path, header: cached.header, cache: "hit", prepared: null };
    }
  }

  const admission = options.parse();
  let prepared: PreparedConstruction | null = null;
  let outcome: SidecarOutcomeSummary;
  if (admission.admitted) {
    options.validate(admission.record);
    prepared = prepareConstruction(options.adapter.source, admission.record);
    options.validate(prepared.record);
    const generation = constructionGeneration(options.adapter.source, prepared.record);
    const draft = prepared.record.construction!;
    outcome = {
      kind: "admitted",
      nativeId: prepared.record.nativeId,
      consumed: admission.consumed,
      semanticBytes: prepared.record.transcriptBytes,
      constructionGeneration: generation,
      rawRecordCount: prepared.record.messages.length,
      logicalRecordCount: prepared.logicalRecords.length,
      rawToolActivityCount: prepared.constructionMetrics.rawToolActivityCount,
      continuityEvidenceCount: countContinuityEvidence(prepared.record.continuityEvents),
      lineageClaimCount: prepared.record.parentNativeId ? 1 : 0,
      titleCandidateCount: draft.titleCandidates.length,
      sourceValidationStatus: draft.sourceValidationStatus,
      sourceObservedTs: draft.sourceObservedTs,
      defaultSessionVisible: draft.defaultSessionVisible,
    };
  } else {
    outcome = { kind: "rejected", reason: admission.reason, detail: admission.detail };
  }
  const after = sourceFingerprint(options.adapter, options.source);
  if (after !== fingerprint) throw new SourceChangedDuringSidecarCaptureError(options.source.fullPath);

  const payload = prepared === null ? "" : JSON.stringify(prepared);
  const payloadBytes = Buffer.byteLength(payload);
  const header: SidecarHeader = {
    format: INGEST_SIDECAR_FORMAT,
    parser: { source: options.adapter.source, version, admission: options.adapter.admissionVersion ?? null },
    source: {
      root: options.source.root,
      relPath: options.source.relPath,
      fullPath: options.source.fullPath,
      provisionalNativeId: options.source.nativeId,
      candidateKind: options.source.candidateKind ?? null,
      fingerprint,
    },
    outcome,
    payloadBytes,
    payloadSha256: sha256(payload),
    writtenAt: Date.now(),
  };
  writeAtomic(path, header, payload);
  return { path, header, cache: "miss", prepared };
}

export function loadPreparedConstruction(sidecar: ResolvedSidecar): PreparedConstruction {
  if (sidecar.header.outcome.kind !== "admitted") {
    throw new InvalidIngestSidecarError(sidecar.path, "rejected units have no construction payload");
  }
  if (sidecar.prepared) return sidecar.prepared;
  const current = readHeader(sidecar.path);
  if (!current || JSON.stringify(current.header) !== JSON.stringify(sidecar.header)) {
    throw new InvalidIngestSidecarError(sidecar.path, "header changed after resolution");
  }
  const payload = Buffer.allocUnsafe(sidecar.header.payloadBytes);
  let fd: number | null = null;
  try {
    fd = openSync(sidecar.path, "r");
    readExact(fd, payload, current.payloadOffset);
  } catch (error) {
    throw new InvalidIngestSidecarError(sidecar.path, errorMessage(error));
  } finally { if (fd !== null) closeSync(fd); }
  if (payload.length !== sidecar.header.payloadBytes) {
    throw new InvalidIngestSidecarError(sidecar.path, "payload length mismatch");
  }
  if (sha256(payload) !== sidecar.header.payloadSha256) {
    throw new InvalidIngestSidecarError(sidecar.path, "payload checksum mismatch");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(payload.toString("utf8")); }
  catch (error) { throw new InvalidIngestSidecarError(sidecar.path, errorMessage(error)); }
  if (!isPreparedConstruction(parsed)) throw new InvalidIngestSidecarError(sidecar.path, "payload shape mismatch");
  const expected = sidecar.header.outcome;
  if (parsed.record.nativeId !== expected.nativeId
    || parsed.record.transcriptBytes !== expected.semanticBytes
    || parsed.record.messages.length !== expected.rawRecordCount
    || parsed.logicalRecords.length !== expected.logicalRecordCount
    || constructionGeneration(sidecar.header.parser.source, parsed.record) !== expected.constructionGeneration) {
    throw new InvalidIngestSidecarError(sidecar.path, "header/payload contract mismatch");
  }
  sidecar.prepared = parsed;
  return parsed;
}

export function constructionGeneration(source: string, record: IngestRecord): string {
  return `v13:${sha256(JSON.stringify([
    INGEST_SIDECAR_FORMAT,
    source,
    record.nativeId,
    record.transcriptBytes,
    record.construction,
    record.messages,
    record.continuityEvents ?? [],
    record.parentNativeId ?? null,
    record.title,
    record.startTs,
    record.endTs,
  ]))}`;
}

export function prepareConstruction(source: string, input: IngestRecord): PreparedConstruction {
  const record = compactRecord(input);
  const groups = new Map<string, { key: string; evidence: Evidence | null; members: NormalizedMessage[] }>();
  let unknown = 0;
  for (const message of record.messages) {
    const evidence = authoritativeEvidence(message);
    const key = evidence
      ? JSON.stringify([evidence.identityKind, evidence.sourceRecordId, evidence.sourceRecordTs])
      : `raw-ordinal:${message.ordinal}`;
    if (!evidence) unknown++;
    const group = groups.get(key);
    if (group) group.members.push(message);
    else groups.set(key, { key, evidence, members: [message] });
  }
  const ordered = [...groups.values()].sort((a, b) => a.members[0]!.ordinal - b.members[0]!.ordinal);
  ordered.forEach((group) => validateReplayAgreement(group, record.nativeId));

  let logicalTokUser = 0;
  let logicalTokAssistant = 0;
  let logicalTokTool = 0;
  let logicalToolCount = 0;
  let logicalProse = 0;
  let dialogue = 0;
  let userDialogue = 0;
  let assistantDialogue = 0;
  let proved = 0;
  let replay = 0;
  const logicalRecords: PreparedLogicalRecord[] = ordered.map((group, logicalOrdinal) => {
    const representative = group.members[0]!;
    const replayCount = group.members.length - 1;
    replay += replayCount;
    if (group.evidence) proved++;
    if (representative.dialogueSide === "user") logicalTokUser += contentTokens(representative);
    else if (representative.dialogueSide === "assistant") logicalTokAssistant += contentTokens(representative);
    logicalTokTool += toolTokens(representative.toolActivities ?? []);
    logicalToolCount += representative.toolActivities?.length ?? 0;
    if (representative.sourceProsePresent) logicalProse++;
    if (representative.sourceProsePresent && representative.recordKind === "real_user") { dialogue++; userDialogue++; }
    if (representative.sourceProsePresent && representative.recordKind === "assistant_dialogue_prose") { dialogue++; assistantDialogue++; }
    return {
      logicalOrdinal,
      logicalKey: group.key,
      identityKind: group.evidence?.identityKind ?? "none",
      sourceRecordId: group.evidence?.sourceRecordId ?? null,
      sourceRecordUuid: group.evidence?.sourceRecordUuid ?? null,
      sourceRecordTs: group.evidence?.sourceRecordTs ?? null,
      memberOrdinals: group.members.map((member) => member.ordinal),
      recordKind: messageKind(representative),
      dialogueSide: representative.dialogueSide ?? null,
      identityStatus: group.evidence ? "proved" : "unknown",
    };
  });

  const rawTool = record.messages.reduce((sum, message) => sum + (message.toolActivities?.length ?? 0), 0);
  const rawProse = record.messages.filter((message) => message.sourceProsePresent).length;
  const constructionMetrics: ConstructionMetricsDto = {
    rawProvenanceRowCount: record.messages.length,
    logicalRecordCount: logicalRecords.length,
    rawToolActivityCount: rawTool,
    logicalToolActivityCount: logicalToolCount,
    rawProseBearingRecordCount: rawProse,
    logicalProseBearingRecordCount: logicalProse,
    dialogueTurnCount: dialogue,
    userDialogueTurnCount: userDialogue,
    assistantDialogueTurnCount: assistantDialogue,
    logicalReplayCount: replay,
    unknownIdentityRawRowCount: unknown,
  };
  const logicalMetrics: PreparedLegacyMetrics = {
    tokUser: logicalTokUser,
    tokAssistant: logicalTokAssistant,
    tokTool: logicalTokTool,
    toolActivityCount: logicalToolCount,
    logicalRecordCount: logicalRecords.length,
    logicalReplayCount: replay,
    logicalIdentityCount: proved,
    logicalUnknownCount: unknown,
    identityStatus: unknown === 0 ? "complete" : "partial",
  };
  let tokUser = 0;
  let tokAssistant = 0;
  let tokTool = 0;
  for (const message of record.messages) {
    if (message.recordKind === "real_user") tokUser += contentTokens(message);
    else if (message.recordKind === "assistant_dialogue_prose") tokAssistant += contentTokens(message);
    tokTool += toolTokens(message.toolActivities ?? []);
  }
  const aggregate = {
    tokUser,
    tokAssistant,
    tokTool,
    engagement: engagementRatio({ user: tokUser, assistant: tokAssistant, tool: tokTool }),
    durationMs: record.startTs !== null && record.endTs !== null ? record.endTs - record.startTs : null,
    lastActivity: record.endTs,
  };
  void source;
  return { record, logicalRecords, constructionMetrics, logicalMetrics, aggregate };
}

function compactRecord(input: IngestRecord): IngestRecord {
  return {
    ...input,
    models: [...input.models],
    messages: input.messages.map((message): NormalizedMessage => {
      const sourceContent = message.prose ?? message.text;
      const sourceProsePresent = nonblank(message.prose);
      const dialogue = message.recordKind === "real_user" || message.recordKind === "assistant_dialogue_prose";
      return {
        ...message,
        text: dialogue ? message.text : null,
        prose: dialogue ? message.prose : null,
        toolText: null,
        toolActivities: (message.toolActivities ?? []).map(compactToolActivity),
        contentDigest: sourceContent === null ? null : sha256(sourceContent),
        contentBytes: sourceContent === null ? 0 : Buffer.byteLength(sourceContent),
        contentTokenEstimate: estimateTokens(sourceContent),
        sourceProsePresent,
      };
    }),
    continuityEvents: input.continuityEvents?.map((event) => ({ ...event })),
    construction: input.construction ? {
      ...input.construction,
      project: { ...input.construction.project },
      titleCandidates: input.construction.titleCandidates.map((candidate) => ({ ...candidate })),
    } : undefined,
  };
}

function compactToolActivity(activity: NormalizedToolActivity): NormalizedToolActivity {
  const value = activity.toolText;
  return {
    ...activity,
    toolText: null,
    payloadDigest: value === null ? null : sha256(value),
    payloadBytes: value === null ? 0 : Buffer.byteLength(value),
    payloadTokenEstimate: estimateTokens(value),
  };
}

function validateReplayAgreement(
  group: { members: NormalizedMessage[] },
  nativeId: string,
): void {
  if (group.members.length < 2) return;
  const signature = semanticSignature(group.members[0]!);
  for (const member of group.members.slice(1)) {
    if (semanticSignature(member) !== signature) {
      throw new Error(`contradictory replay evidence for ${nativeId}`);
    }
  }
}

function semanticSignature(message: NormalizedMessage): string {
  return JSON.stringify([
    message.recordKind,
    message.dialogueSide ?? null,
    message.contentDigest ?? null,
    Boolean(message.sourceProsePresent),
    (message.toolActivities ?? []).map((activity) => [
      activity.activityOrdinal,
      activity.activityKind,
      activity.toolName,
      activity.payloadDigest ?? null,
      activity.payloadBytes ?? 0,
      activity.sourceActivityId,
    ]),
  ]);
}

interface Evidence {
  identityKind: Exclude<RecordIdentityKind, "none">;
  sourceRecordId: string;
  sourceRecordUuid: string | null;
  sourceRecordTs: number;
}

function authoritativeEvidence(message: NormalizedMessage): Evidence | null {
  const kind = message.sourceIdentityKind ?? "none";
  const id = clean(message.sourceRecordId);
  const uuid = clean(message.sourceRecordUuid);
  const ts = message.sourceRecordTs;
  if (kind === "none" || !id || ts === null || ts === undefined || !Number.isSafeInteger(ts)) return null;
  if (kind !== "uuid" && kind !== "record-id" && kind !== "message-id") return null;
  if (uuid !== null && (!isUuid(uuid) || uuid !== id)) return null;
  if (kind === "uuid" && (uuid === null || !isUuid(id) || uuid !== id)) return null;
  return { identityKind: kind, sourceRecordId: id, sourceRecordUuid: uuid, sourceRecordTs: ts };
}

function sourceFingerprint(adapter: Adapter, source: DiscoveredSource): string {
  const stat = statIdentity(source.fullPath);
  const context = adapter.sidecarContextFingerprint?.(source) ?? null;
  return sha256(jsonStringify({
    root: source.root,
    relPath: source.relPath,
    fullPath: source.fullPath,
    nativeId: source.nativeId,
    candidateKind: source.candidateKind ?? null,
    freshness: source.freshness ?? null,
    stat,
    context,
  }));
}

function statIdentity(path: string): Record<string, string | number> {
  const value = statSync(path, { bigint: true });
  return {
    dev: value.dev.toString(),
    ino: value.ino.toString(),
    mode: value.mode.toString(),
    size: value.size.toString(),
    mtimeNs: value.mtimeNs.toString(),
    ctimeNs: value.ctimeNs.toString(),
  };
}

function ingestSidecarPath(root: string, source: string, unit: DiscoveredSource): string {
  const key = sha256(jsonStringify([source, unit.root, unit.relPath, unit.fullPath]));
  return join(root, source, key.slice(0, 2), `${key}.atlas-ingest`);
}

function readHeader(path: string): { header: SidecarHeader; payloadOffset: number } | null {
  let fd: number | null = null;
  try {
    const link = lstatSync(path);
    if (!link.isFile() || link.isSymbolicLink()) return null;
    fd = openSync(path, "r");
    const prefix = Buffer.allocUnsafe(HEADER_PREFIX_BYTES);
    readExact(fd, prefix, 0);
    const match = HEADER_PREFIX_PATTERN.exec(prefix.toString("ascii"));
    if (!match) return null;
    const headerBytes = Number.parseInt(match[1]!, 16);
    if (!Number.isSafeInteger(headerBytes) || headerBytes <= 0 || headerBytes > MAX_HEADER_BYTES) return null;
    const encoded = Buffer.allocUnsafe(headerBytes);
    readExact(fd, encoded, HEADER_PREFIX_BYTES);
    const parsed: unknown = JSON.parse(encoded.toString("utf8"));
    if (!isSidecarHeader(parsed)) return null;
    const size = Number(fstatSync(fd).size);
    const payloadOffset = HEADER_PREFIX_BYTES + headerBytes;
    if (size !== payloadOffset + parsed.payloadBytes) return null;
    if ((link.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
    return { header: parsed, payloadOffset };
  } catch { return null; }
  finally { if (fd !== null) closeSync(fd); }
}

function headerMatches(header: SidecarHeader, adapter: Adapter, source: DiscoveredSource, fingerprint: string): boolean {
  return header.format === INGEST_SIDECAR_FORMAT
    && header.parser.source === adapter.source
    && header.parser.version === adapter.sidecarVersion
    && (header.outcome.kind === "admitted" || (header.parser.admission ?? null) === (adapter.admissionVersion ?? null))
    && header.source.root === source.root
    && header.source.relPath === source.relPath
    && header.source.fullPath === source.fullPath
    && header.source.provisionalNativeId === source.nativeId
    && header.source.candidateKind === (source.candidateKind ?? null)
    && header.source.fingerprint === fingerprint;
}

function writeAtomic(path: string, header: SidecarHeader, payload: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error(`ingest sidecar parent is not an owner directory: ${dirname(path)}`);
  chmodSync(dirname(path), 0o700);
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const encodedHeader = JSON.stringify(header);
    const headerBytes = Buffer.byteLength(encodedHeader);
    if (headerBytes > MAX_HEADER_BYTES) throw new Error(`ingest sidecar header exceeds ${MAX_HEADER_BYTES} bytes`);
    const prefix = `ATLAS1:${headerBytes.toString(16).padStart(8, "0")}\n`;
    writeFileSync(temp, `${prefix}${encodedHeader}${payload}`, { mode: 0o600, flag: "wx" });
    const fd = openSync(temp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    chmodSync(path, 0o600);
    fsyncDirectory(dirname(path));
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

function readExact(fd: number, buffer: Buffer, position: number): void {
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (count === 0) throw new Error("unexpected end of sidecar");
    offset += count;
  }
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try { fd = openSync(path, "r"); fsyncSync(fd); }
  catch {}
  finally { if (fd !== null) closeSync(fd); }
}

function isSidecarHeader(value: unknown): value is SidecarHeader {
  if (!isRecord(value) || value.format !== INGEST_SIDECAR_FORMAT) return false;
  if (!isRecord(value.parser) || typeof value.parser.source !== "string" || typeof value.parser.version !== "string") return false;
  if (!isRecord(value.source) || typeof value.source.fingerprint !== "string") return false;
  if (!isRecord(value.outcome) || (value.outcome.kind !== "admitted" && value.outcome.kind !== "rejected")) return false;
  return Number.isSafeInteger(value.payloadBytes) && Number(value.payloadBytes) >= 0
    && typeof value.payloadSha256 === "string" && /^[0-9a-f]{64}$/.test(value.payloadSha256);
}

function isPreparedConstruction(value: unknown): value is PreparedConstruction {
  return isRecord(value)
    && isRecord(value.record)
    && typeof value.record.nativeId === "string"
    && Array.isArray(value.record.messages)
    && Array.isArray(value.logicalRecords)
    && isRecord(value.constructionMetrics)
    && isRecord(value.logicalMetrics)
    && isRecord(value.aggregate);
}

function messageKind(message: NormalizedMessage): RecordKind {
  if (!message.recordKind) throw new Error("prepared message has no record kind");
  return message.recordKind;
}
function contentTokens(message: NormalizedMessage): number {
  return message.contentTokenEstimate ?? estimateTokens(message.prose ?? message.text);
}
function toolTokens(activities: readonly NormalizedToolActivity[]): number {
  return activities.reduce((sum, activity) => sum + (activity.payloadTokenEstimate ?? estimateTokens(activity.toolText)), 0);
}
function nonblank(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function clean(value: unknown): string | null { if (value === null || value === undefined) return null; const text = String(value).trim(); return text || null; }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function jsonStringify(value: unknown): string { return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item); }
function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
