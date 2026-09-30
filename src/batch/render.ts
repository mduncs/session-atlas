import { renderSummaryPrompt } from "./plan.js";
import { providerSpec } from "./providers.js";
import type { BatchCandidate, BatchManifest } from "./types.js";
import { renderTranscript } from "./dialogue.js";

interface OpenAIRequest {
  custom_id: string;
  method: "POST";
  url: "/v1/chat/completions";
  body: {
    model: string;
    max_tokens: number;
    messages: Array<{ role: "system" | "user"; content: string }>;
  };
}

interface AnthropicRequest {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: "user"; content: string }>;
  };
}

/** Render exactly one OpenAI Chat Completions Batch JSONL request. */
export function renderOpenAIRequest(manifest: BatchManifest, candidate: BatchCandidate): OpenAIRequest {
  assertCandidate(manifest, candidate);
  return {
    custom_id: candidate.customId,
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: manifest.provider.model,
      max_tokens: candidate.outputTokens,
      messages: [
        { role: "system", content: manifest.systemPrompt },
        { role: "user", content: renderSummaryPrompt(renderTranscript(candidate.turns), manifest.promptVersion) },
      ],
    },
  };
}

/** Render exactly one Anthropic Message Batches JSONL request. */
export function renderAnthropicRequest(manifest: BatchManifest, candidate: BatchCandidate): AnthropicRequest {
  assertCandidate(manifest, candidate);
  return {
    custom_id: candidate.customId,
    params: {
      model: manifest.provider.model,
      max_tokens: candidate.outputTokens,
      system: manifest.systemPrompt,
      messages: [{ role: "user", content: renderSummaryPrompt(renderTranscript(candidate.turns), manifest.promptVersion) }],
    },
  };
}

export function renderBatchRequest(manifest: BatchManifest, candidate: BatchCandidate): OpenAIRequest | AnthropicRequest {
  if (manifest.provider.transport === "openai") return renderOpenAIRequest(manifest, candidate);
  return renderAnthropicRequest(manifest, candidate);
}

/** Exact newline-delimited request body, with a final newline. */
export function renderBatchJsonl(manifest: BatchManifest, batchId?: string): string {
  const batch = batchId ? manifest.batches.find((item) => item.batchId === batchId) : undefined;
  const ids = batch?.requests.map((request) => request.customId) ?? manifest.candidates.map((candidate) => candidate.customId);
  const byId = new Map(manifest.candidates.map((candidate) => [candidate.customId, candidate]));
  return ids.map((id) => {
    const candidate = byId.get(id);
    if (!candidate) throw new Error(`manifest request has no candidate: ${id}`);
    return JSON.stringify(renderBatchRequest(manifest, candidate));
  }).join("\n") + (ids.length > 0 ? "\n" : "");
}

function assertCandidate(manifest: BatchManifest, candidate: BatchCandidate): void {
  const spec = providerSpec(manifest.provider.id);
  if (spec.id !== manifest.provider.id || candidate.customId.trim() === "") throw new Error("invalid manifest/provider candidate");
  if (candidate.outputTokens !== manifest.outputTokensPerRequest) throw new Error(`candidate ${candidate.customId} has inconsistent output reservation`);
  if (!manifest.candidates.some((item) => item.customId === candidate.customId && item.inputHash === candidate.inputHash)) {
    throw new Error(`candidate ${candidate.customId} is not a member of this manifest`);
  }
}

/** Explicit aliases used by dry-run/integration callers. */
export const renderOpenAIBatchRequest = renderOpenAIRequest;
export const renderAnthropicBatchRequest = renderAnthropicRequest;
