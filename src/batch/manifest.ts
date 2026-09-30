import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { clone, sha256, sumCost } from "./canonical.js";
import { assertAuthorization, providerSpec } from "./providers.js";
import type {
  BatchAuthorization,
  BatchCheckpoint,
  BatchManifest,
  ResumeState,
  SimulatedResult,
} from "./types.js";

/** Atomically checkpoint a manifest with owner-only permissions. */
export async function writeManifest(path: string, manifest: BatchManifest): Promise<void> {
  assertManifest(manifest);
  if (!isAbsolute(path)) throw new Error("manifest path must be absolute");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${path.split("/").pop() ?? "manifest"}.${process.pid}.${randomUUID()}.tmp`);
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readManifest(path: string): Promise<BatchManifest> {
  if (!isAbsolute(path)) throw new Error("manifest path must be absolute");
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assertManifest(parsed);
  return parsed;
}

/** Mark one planned batch running; this is the only lifecycle transition before apply. */
export function checkpointBatchRunning(manifest: BatchManifest, batchId: string, now = Date.now()): BatchManifest {
  const next = clone(manifest);
  const batch = findBatch(next, batchId);
  if (batch.status === "completed") return next;
  if (batch.status === "failed") throw new Error(`cannot resume failed batch ${batchId} without an explicit new plan`);
  batch.status = "running";
  batch.updatedAt = now;
  next.updatedAt = now;
  next.state = "in_progress";
  return next;
}


/** Checkpoint a failed request set without deleting its evidence. */
export function checkpointBatchFailed(
  manifest: BatchManifest,
  batchId: string,
  failedRequestIds: readonly string[],
  error: string,
  now = Date.now(),
): BatchManifest {
  if (!error.trim()) throw new Error("failed batch checkpoint requires an error");
  const next = clone(manifest);
  const batch = findBatch(next, batchId);
  const allowed = new Set(batch.requests.map((request) => request.customId));
  const failed = [...new Set(failedRequestIds)];
  if (failed.some((id) => !allowed.has(id))) throw new Error("failed request is not a member of the batch");
  for (const id of failed) {
    const candidate = next.candidates.find((item) => item.customId === id);
    if (candidate && candidate.status !== "applied") candidate.status = "failed";
  }
  batch.failedRequestIds = failed.sort();
  batch.error = error;
  batch.status = "failed";
  batch.updatedAt = now;
  next.updatedAt = now;
  next.state = "failed";
  return next;
}

/** Explicit retry transition for a failed checkpoint; no implicit retry occurs. */
export function retryFailedBatch(manifest: BatchManifest, batchId: string, now = Date.now()): BatchManifest {
  const next = clone(manifest);
  const batch = findBatch(next, batchId);
  if (batch.status !== "failed") return next;
  for (const id of batch.failedRequestIds) {
    const candidate = next.candidates.find((item) => item.customId === id);
    if (candidate?.status === "failed") { candidate.status = "pending"; candidate.result = null; }
  }
  batch.failedRequestIds = [];
  batch.error = null;
  batch.status = "running";
  batch.updatedAt = now;
  next.updatedAt = now;
  next.state = "in_progress";
  return next;
}

/** Apply a provider-free fixture result as an idempotent manifest upsert. */
export function applySimulatedResult(manifest: BatchManifest, result: SimulatedResult, now = Date.now()): BatchManifest {
  const next = clone(manifest);
  const candidate = next.candidates.find((item) => item.customId === result.customId);
  if (!candidate) throw new Error(`simulated result references unknown request ${result.customId}`);
  if (candidate.sessionKey.harness !== result.sessionKey.harness || candidate.sessionKey.nativeId !== result.sessionKey.nativeId) {
    throw new Error(`simulated result identity mismatch for ${result.customId}`);
  }
  if (next.provider.id !== result.provider || next.provider.model !== result.model) throw new Error(`simulated result provider/model mismatch for ${result.customId}`);
  if (candidate.inputHash !== result.inputHash) throw new Error(`simulated result input hash mismatch for ${result.customId}`);
  if (!Number.isSafeInteger(result.outputTokens) || result.outputTokens < 0 || result.outputTokens > candidate.outputTokens) {
    throw new Error(`simulated result output token count exceeds reservation for ${result.customId}`);
  }
  if (sha256(result.outputText) !== result.outputHash) throw new Error(`simulated result output hash mismatch for ${result.customId}`);

  if (candidate.status === "applied") {
    if (candidate.result?.outputHash !== result.outputHash) throw new Error(`conflicting simulated result for ${result.customId}`);
    return next; // idempotent replay: no timestamp/count churn
  }
  candidate.status = "applied";
  candidate.result = clone(result);
  const batch = next.batches.find((item) => item.requests.some((request) => request.customId === result.customId));
  if (!batch) throw new Error(`simulated result request has no batch ${result.customId}`);
  if (!batch.appliedRequestIds.includes(result.customId)) batch.appliedRequestIds.push(result.customId);
  batch.appliedRequestIds.sort();
  batch.failedRequestIds = batch.failedRequestIds.filter((id) => id !== result.customId);
  batch.status = batch.appliedRequestIds.length === batch.requestCount ? "completed" : "running";
  batch.updatedAt = now;
  next.updatedAt = now;
  next.state = next.batches.every((item) => item.status === "completed") ? "completed" : "in_progress";
  return next;
}

export async function applySimulatedResultToFile(path: string, result: SimulatedResult, now = Date.now()): Promise<BatchManifest> {
  const manifest = await readManifest(path);
  const next = applySimulatedResult(manifest, result, now);
  await writeManifest(path, next);
  return next;
}

export function resumeManifest(manifest: BatchManifest): ResumeState {
  const pendingBatches = manifest.batches.filter((batch) => batch.status !== "completed").map((batch) => batch.batchId);
  const pendingCustomIds = manifest.candidates.filter((candidate) => candidate.status !== "applied").map((candidate) => candidate.customId);
  const completedBatchIds = manifest.batches.filter((batch) => batch.status === "completed").map((batch) => batch.batchId);
  const remaining = manifest.candidates.filter((candidate) => candidate.status !== "applied");
  return {
    manifestId: manifest.manifestId,
    state: manifest.state,
    pendingBatchIds: pendingBatches,
    pendingCustomIds,
    completedBatchIds,
    estimatedRemaining: sumCost(remaining.map((candidate) => candidate.cost)),
  };
}

export function resumeFromFile(path: string): Promise<ResumeState> {
  return readManifest(path).then(resumeManifest);
}

/** Deliberate fail-closed guard for any future production transport. */
export function assertProductionSubmissionAuthorized(
  manifest: BatchManifest,
  authorization: BatchAuthorization | undefined,
): void {
  assertAuthorization(authorization, providerSpec(manifest.provider.id));
  if (authorization.maxBatchDollars < manifest.caps.maxDollars) {
    throw new Error("explicit authorization maxBatchDollars is below the manifest batch cap");
  }
}

function findBatch(manifest: BatchManifest, batchId: string): BatchCheckpoint {
  const batch = manifest.batches.find((item) => item.batchId === batchId);
  if (!batch) throw new Error(`unknown batch ${batchId}`);
  return batch;
}

function assertManifest(value: unknown): asserts value is BatchManifest {
  if (!value || typeof value !== "object") throw new Error("invalid batch manifest");
  const manifest = value as Partial<BatchManifest>;
  if (manifest.planVersion !== 1 || typeof manifest.manifestId !== "string" || typeof manifest.planHash !== "string") throw new Error("invalid batch manifest header");
  if (!manifest.provider || typeof manifest.provider !== "object") throw new Error("invalid batch manifest provider");
  providerSpec(manifest.provider.id);
  if (!Array.isArray(manifest.candidates) || !Array.isArray(manifest.batches)) throw new Error("invalid batch manifest collections");
  if (!manifest.caps || typeof manifest.caps !== "object") throw new Error("manifest is missing explicit caps");
}
