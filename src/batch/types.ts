/**
 * Provider-free Phase 6 batch planning domain.
 *
 * This module deliberately contains no provider client, configuration loader,
 * secret lookup, or network transport. A manifest is an auditable plan and a
 * checkpoint, not permission to submit it.
 */

export const BATCH_PLAN_VERSION = 1 as const;
export const DIALOGUE_READER_RULE_VERSION = "phase6-current-generation-dialogue-v1" as const;
export const SESSION_DIALOGUE_TOKEN_CAP = 4_000 as const;

export type BatchProviderId =
  | "openai:gpt-5.4-nano"
  | "anthropic:claude-haiku-4.5";
export type BatchTransport = "openai" | "anthropic";

export interface ProviderSpec {
  id: BatchProviderId;
  transport: BatchTransport;
  model: string;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export interface BatchCaps {
  /** Hard ceiling on the sum of planned request input tokens in one batch. */
  maxInputTokens: number;
  /** Hard ceiling on reserved output tokens in one batch. */
  maxOutputTokens: number;
  /** Hard ceiling on estimated input dollars in one batch. */
  maxInputDollars: number;
  /** Hard ceiling on estimated output dollars in one batch. */
  maxOutputDollars: number;
  /** Hard ceiling on estimated total dollars in one batch. */
  maxDollars: number;
}

export interface BatchCost {
  inputTokens: number;
  outputTokens: number;
  inputDollars: number;
  outputDollars: number;
  totalDollars: number;
}

export interface DialogueTurn {
  ordinal: number;
  side: "user" | "assistant";
  text: string;
}

export interface DialogueSourceEvidence {
  logicalRecordId: number;
  representativeRawRecordId: number;
  logicalOrdinal: number;
  rawOrdinal: number | null;
  recordKind: "real_user" | "assistant_dialogue_prose";
  sourceIdentityKind: "uuid" | "record-id" | "message-id" | "none";
  sourceRecordId: string | null;
  sourceRecordUuid: string | null;
  sourceRecordTs: number | null;
}

export interface SessionKey {
  harness: string;
  nativeId: string;
}

export interface BatchCandidate {
  /** Stable Atlas identity; never a surrogate database id. */
  sessionKey: SessionKey;
  sessionId: number;
  constructionGeneration: string;
  lastActivity: number | null;
  /** The clean, capped projection sent as untrusted transcript data. */
  turns: DialogueTurn[];
  /** Estimated tokens for dialogue only, after the 4k cap. */
  dialogueTokens: number;
  /** True when the projection had to be head/tail sampled. */
  dialogueCapped: boolean;
  /** Hash of the canonical capped dialogue turns. */
  dialogueHash: string;
  /** Hash of source identity/order evidence for this candidate. */
  provenanceHash: string;
  /** Hash of the complete provider input (prompt + capped dialogue). */
  inputHash: string;
  /** Stable request id used in both allowed Batch formats. */
  customId: string;
  /** Input tokens including prompt overhead, not just dialogue. */
  inputTokens: number;
  /** Reserved output tokens for this request. */
  outputTokens: number;
  cost: BatchCost;
  sourceEvidence: DialogueSourceEvidence[];
  status: "pending" | "applied" | "failed";
  result: SimulatedResult | null;
}

export interface BatchRequestRef {
  customId: string;
  sessionKey: SessionKey;
  inputHash: string;
  inputTokens: number;
  outputTokens: number;
}

export type BatchCheckpointStatus = "planned" | "running" | "completed" | "failed";

export interface BatchCheckpoint {
  batchId: string;
  ordinal: number;
  status: BatchCheckpointStatus;
  requestCount: number;
  requests: BatchRequestRef[];
  cost: BatchCost;
  appliedRequestIds: string[];
  failedRequestIds: string[];
  error?: string | null;
  updatedAt: number;
}

export interface SimulatedResult {
  customId: string;
  sessionKey: SessionKey;
  provider: BatchProviderId;
  model: string;
  inputHash: string;
  outputText: string;
  outputHash: string;
  outputTokens: number;
  simulatedAt: number;
}

export interface BatchManifest {
  planVersion: typeof BATCH_PLAN_VERSION;
  manifestId: string;
  planHash: string;
  createdAt: number;
  updatedAt: number;
  provider: ProviderSpec;
  promptVersion: string;
  systemPrompt: string;
  redactionApplied: boolean;
  outputTokensPerRequest: number;
  caps: BatchCaps;
  readerRuleVersion: typeof DIALOGUE_READER_RULE_VERSION;
  sessionDialogueTokenCap: typeof SESSION_DIALOGUE_TOKEN_CAP;
  candidates: BatchCandidate[];
  batches: BatchCheckpoint[];
  totals: BatchCost;
  state: "planned" | "in_progress" | "completed" | "failed";
}

export interface PlanOptions {
  provider: string;
  caps: BatchCaps;
  /** Explicit reservation; it is never inferred from a provider response. */
  outputTokensPerRequest: number;
  systemPrompt?: string;
  promptVersion?: string;
  redact?: boolean;
  now?: number;
}

/** Explicit approval is required by any future transport boundary. */
export interface BatchAuthorization {
  authorizationId: string;
  provider: BatchProviderId;
  outboundContentApproved: true;
  spendApproved: true;
  maxBatchDollars: number;
  approvedAt: number;
}

export interface ResumeState {
  manifestId: string;
  state: BatchManifest["state"];
  pendingBatchIds: string[];
  pendingCustomIds: string[];
  completedBatchIds: string[];
  estimatedRemaining: BatchCost;
}
