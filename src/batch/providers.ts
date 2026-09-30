import type { BatchAuthorization, BatchProviderId, BatchRequestRef, ProviderSpec } from "./types.js";

/** The sole Phase 6 provider allowlist. DeepSeek and every other provider fail closed. */
export const PROVIDERS: Record<BatchProviderId, ProviderSpec> = {
  "openai:gpt-5.4-nano": {
    id: "openai:gpt-5.4-nano",
    transport: "openai",
    model: "gpt-5.4-nano",
    inputUsdPerMillionTokens: 0.20,
    outputUsdPerMillionTokens: 1.25,
  },
  "anthropic:claude-haiku-4.5": {
    id: "anthropic:claude-haiku-4.5",
    transport: "anthropic",
    model: "claude-haiku-4-5",
    inputUsdPerMillionTokens: 1.00,
    outputUsdPerMillionTokens: 5.00,
  },
};

/** Accept only documented spellings and return a canonical allowlist id. */
export function providerSpec(value: string): ProviderSpec {
  const normalized = value.trim().toLowerCase();
  const aliases: Record<string, BatchProviderId> = {
    "openai:gpt-5.4-nano": "openai:gpt-5.4-nano",
    "gpt-5.4-nano": "openai:gpt-5.4-nano",
    "anthropic:claude-haiku-4.5": "anthropic:claude-haiku-4.5",
    "anthropic:claude-haiku-4-5": "anthropic:claude-haiku-4.5",
    "claude-haiku-4.5": "anthropic:claude-haiku-4.5",
    "claude-haiku-4-5": "anthropic:claude-haiku-4.5",
  };
  const id = aliases[normalized];
  if (!id) throw new Error(`provider ${value || "<empty>"} is not allowed for Phase 6 Batch planning (allowed: GPT-5.4-nano Batch, Claude Haiku 4.5 Batch)`);
  return PROVIDERS[id];
}

export function assertCaps(caps: {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxInputDollars: number;
  maxOutputDollars: number;
  maxDollars: number;
}): void {
  for (const [name, value] of Object.entries(caps)) {
    if (!Number.isSafeInteger(value) && (name === "maxInputTokens" || name === "maxOutputTokens")) {
      throw new RangeError(`${name} must be a positive integer`);
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be positive`);
    }
  }
  if (caps.maxDollars < caps.maxInputDollars || caps.maxDollars < caps.maxOutputDollars) {
    throw new RangeError("maxDollars must cover both component dollar caps");
  }
}

export function assertAuthorization(
  authorization: BatchAuthorization | undefined,
  provider: ProviderSpec,
): asserts authorization is BatchAuthorization {
  if (!authorization) throw new Error("Batch submission requires an explicit authorization object");
  if (authorization.authorizationId.trim() === "") throw new Error("authorizationId is required");
  if (authorization.provider !== provider.id) throw new Error("authorization provider does not match the manifest provider");
  if (authorization.outboundContentApproved !== true) throw new Error("outbound content approval is required");
  if (authorization.spendApproved !== true) throw new Error("spend approval is required; provider approval is not spend approval");
  if (!Number.isFinite(authorization.maxBatchDollars) || authorization.maxBatchDollars <= 0) throw new Error("authorization maxBatchDollars must be positive");
}

/**
 * Deliberately no-op transport boundary. Even with an authorization object,
 * this Phase 6 lane cannot submit production work; there is no fetch/imported
 * client here by design. Keeping this function makes accidental submission a
 * loud, testable failure rather than an unimplemented silent path.
 */
export function submitBatch(_requests: readonly BatchRequestRef[], authorization?: BatchAuthorization): never {
  if (!authorization) throw new Error("Batch submission requires an explicit authorization object");
  throw new Error("Phase 6 is provider-free: production Batch submission is out of scope and has no transport");
}
