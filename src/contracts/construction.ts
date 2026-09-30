/**
 * Frozen cross-lane construction contract for schema v11.
 *
 * These names are the canonical construction vocabulary. Adapters produce drafts using
 * this vocabulary; ingest owns validation and atomic publication. Readers
 * accept only a current `valid` generation and never infer a fallback from
 * legacy roles/counts.
 */

export const HARNESS_IDS = ["claude", "codex", "prime", "hermes", "kimi", "zcode", "kilo"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export interface SessionKey {
  harness: HarnessId;
  nativeId: string;
}

export interface ProjectKeyEvidence {
  originalProjectKey: string | null;
  canonicalProjectKey: string | null;
  canonicalizationRuleVersion: string | null;
}

export type ArtifactKind = "dialogue_history" | "current_context_projection" | "metadata_shell";
export type HistoryCompleteness = "complete" | "current_context_only" | "unknown";
export type ConstructionStatus = "valid" | "invalid";
export type SourceValidationStatus = "current" | "snapshot_only" | "legacy_unverified";

export interface SessionConstructionState {
  sessionKey: SessionKey;
  artifactKind: ArtifactKind;
  historyCompleteness: HistoryCompleteness;
  constructionGeneration: string;
  constructionStatus: ConstructionStatus;
  invalidReason: string | null;
  defaultSessionVisible: boolean;
  sourceValidationStatus: SourceValidationStatus;
  sourceObservedTs: number | null;
}

export const RECORD_KINDS = [
  "real_user",
  "assistant_dialogue_prose",
  "tool",
  "control_context",
  "telemetry",
  "developer_system",
  "automatic_utility",
  "unclassified",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export type DialogueSide = "user" | "assistant";
export type SourceIdentityKind = "uuid" | "record-id" | "message-id" | "none";

export interface RawProvenanceRecordDto {
  rawRecordId: number;
  sessionKey: SessionKey;
  rawOrdinal: number;
  sourceOrdinal: number;
  recordKind: RecordKind;
  dialogueSide: DialogueSide | null;
  prose: string | null;
  eventTs: number | null;
  toolActivityCount: number;
  sourceRecordId: string | null;
  sourceRecordUuid: string | null;
  sourceRecordTs: number | null;
  sourceIdentityKind: SourceIdentityKind;
  constructionGeneration: string;
}

export type ToolActivityKind = "call" | "result" | "command" | "attachment" | "other";
export interface ToolActivityDto {
  toolActivityId: number;
  rawRecordId: number;
  activityOrdinal: number;
  activityKind: ToolActivityKind;
  toolName: string | null;
  toolText: string | null;
  sourceActivityId: string | null;
}

export type LogicalIdentityStatus = "proved" | "unknown";
export interface LogicalRecordDto {
  logicalRecordId: number;
  sessionKey: SessionKey;
  logicalOrdinal: number;
  representativeRawRecordId: number;
  recordKind: RecordKind;
  dialogueSide: DialogueSide | null;
  logicalKey: string;
  identityStatus: LogicalIdentityStatus;
  memberCount: number;
  replayCount: number;
  constructionGeneration: string;
}

export interface LogicalRecordMemberDto {
  logicalRecordId: number;
  rawRecordId: number;
  rawOrdinal: number;
  isReplay: boolean;
}

export interface ReplayElectionEvidenceDto {
  logicalRecordId: number;
  evidenceRuleVersion: string;
  sourceIdentityKind: SourceIdentityKind;
  sourceRecordId: string | null;
  sourceRecordUuid: string | null;
  sourceRecordTs: number | null;
  representativeRawRecordId: number;
  memberRawRecordIds: number[];
}

export const CONSTRUCTION_METRIC_KEYS = [
  "rawProvenanceRowCount",
  "logicalRecordCount",
  "rawToolActivityCount",
  "logicalToolActivityCount",
  "rawProseBearingRecordCount",
  "logicalProseBearingRecordCount",
  "dialogueTurnCount",
  "userDialogueTurnCount",
  "assistantDialogueTurnCount",
  "logicalReplayCount",
  "unknownIdentityRawRowCount",
] as const;
export type ConstructionMetricKey = (typeof CONSTRUCTION_METRIC_KEYS)[number];

export interface ConstructionMetricsDto {
  rawProvenanceRowCount: number;
  logicalRecordCount: number;
  rawToolActivityCount: number;
  logicalToolActivityCount: number;
  rawProseBearingRecordCount: number;
  logicalProseBearingRecordCount: number;
  dialogueTurnCount: number;
  userDialogueTurnCount: number;
  assistantDialogueTurnCount: number;
  logicalReplayCount: number;
  unknownIdentityRawRowCount: number;
}

export type TitleAuthority = "atlas_user_override" | "source_explicit" | "real_user_fallback";
export interface TitleEvidenceDto {
  value: string;
  authority: TitleAuthority;
  harnessSourceClass: string | null;
  sourceRecordId: string | null;
  sourceReference: string | null;
  sourceOrdinal: number | null;
  eligibilityRuleVersion: string;
}

export type ContinuityKind = "compaction" | "checkpoint";
export interface ContinuityEvidenceDto {
  kind: ContinuityKind;
  sourceOrdinal: number;
  sourceRecordId: string | null;
  sourceRecordUuid: string | null;
  sourceRecordTs: number | null;
  sourceIdentityKind: SourceIdentityKind;
  detail: string | null;
}

export type LineageResolution = "resolved" | "unresolved" | "invalid";
export interface LineageClaimDto {
  parent: SessionKey;
  resolution: LineageResolution;
  reason: string | null;
  resolvedParent: SessionKey | null;
}

export interface ConstructionProjectionDto {
  state: SessionConstructionState;
  project: ProjectKeyEvidence;
  title: TitleEvidenceDto | null;
  metrics: ConstructionMetricsDto;
  rawRecords: RawProvenanceRecordDto[];
  toolActivities: ToolActivityDto[];
  logicalRecords: LogicalRecordDto[];
  logicalMembers: LogicalRecordMemberDto[];
  replayEvidence: ReplayElectionEvidenceDto[];
  continuityEvidence: ContinuityEvidenceDto[];
  lineage: LineageClaimDto | null;
}

export const REJECTION_REASON_CODES = [
  "no_session_envelope",
  "auxiliary_workflow",
  "auxiliary_agent_artifact",
  "malformed_complete_record",
  "unsupported_unit_shape",
  "identity_mismatch",
] as const;
export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];

export type SourceResolutionMode = "builtin" | "extend" | "replace" | "disabled";
export interface ResolvedSourcePlanDto {
  source: HarnessId;
  mode: SourceResolutionMode;
  roots: string[];
  disabledReason: string | null;
}

export type RootReachability = "reachable" | "unreachable" | "error";
export type ReconciliationTrigger = "scheduled" | "manual" | "rebuild";
export interface ReconciliationQualityDto {
  physicalDiscoveredUnitCount: number;
  canonicalAdmissibleCandidateCount: number;
  admissibleUniqueIdentityCount: number | null;
  archivedElectedIdentityCount: number | null;
  duplicateCandidateCount: number;
  rejectedUnitCount: number;
  errorUnitCount: number;
  snapshotOnlyCount: number;
  unresolvedLineageCount: number;
}

export type JobState = "pending" | "running" | "blocked" | "done" | "failed" | "superseded";
export interface StableWorkKeyDto {
  kind: string;
  sessionKey: SessionKey | null;
  normalizedScope: string;
  inputVersion: string;
}
export interface JobLeaseDto {
  ownerToken: string;
  claimedAt: number;
  heartbeatAt: number;
  leaseExpiresAt: number;
}
