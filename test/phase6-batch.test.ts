import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../src/db/index.js";
import {
  applySimulatedResult,
  capDialogueTurns,
  checkpointBatchRunning,
  planBatch,
  readDialogueProjection,
  readManifest,
  renderAnthropicRequest,
  renderBatchJsonl,
  renderOpenAIRequest,
  resumeManifest,
  sha256,
  writeManifest,
} from "../src/batch/index.js";
import { assertProductionSubmissionAuthorized, submitBatch } from "../src/batch/index.js";
import type { BatchManifest, BatchCaps, SimulatedResult } from "../src/batch/types.js";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

const caps: BatchCaps = {
  maxInputTokens: 10_000,
  maxOutputTokens: 1_000,
  maxInputDollars: 1,
  maxOutputDollars: 1,
  maxDollars: 1,
};

function fixture(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  insertSession(db, "recent", "gen-recent", 200, [
    ["user", "recent question", "real_user", "user", "u-recent"],
    ["assistant", "recent answer", "assistant_dialogue_prose", "assistant", "a-recent"],
  ]);
  insertSession(db, "old", "gen-old", 100, [["user", "old question", "real_user", "user", "u-old"]]);
  // Same native identity is invalid and must never leak through as a fallback.
  insertSession(db, "invalid", "gen-invalid", 300, [["user", "must not be read", "real_user", "user", "u-invalid"]], false);
  return db;
}

function insertSession(
  db: Database,
  nativeId: string,
  generation: string,
  activity: number,
  rows: Array<[string, string, "real_user" | "assistant_dialogue_prose", "user" | "assistant", string]>,
  valid = true,
): void {
  const inserted = db.prepare(`INSERT INTO sessions(harness,native_id,source_path,last_activity,ingested_at,construction_generation,construction_status,default_session_visible) VALUES ('claude',?,'fixture',?,?,?,?,?)`)
    .run(nativeId, activity, activity, generation, valid ? "valid" : "invalid", valid ? 1 : 0);
  const sessionId = Number(inserted.lastInsertRowid);
  const message = db.prepare(`INSERT INTO messages(session_id,ordinal,role,text,source_ordinal,record_kind,dialogue_side,prose,construction_generation,source_identity_kind,source_record_id,source_record_ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const logical = db.prepare(`INSERT INTO logical_messages(session_id,representative_message_id,logical_ordinal,logical_key,identity_kind,record_kind,dialogue_side,construction_generation) VALUES (?,?,?,?,?,?,?,?)`);
  rows.forEach(([role, text, kind, side, sourceId], ordinal) => {
    const row = message.run(sessionId, ordinal, role, text, ordinal, kind, side, text, generation, "record-id", sourceId, activity + ordinal);
    logical.run(sessionId, Number(row.lastInsertRowid), ordinal, sourceId, "record-id", kind, side, generation);
  });
}

test("candidate reader accepts only valid current-generation logical dialogue and orders newest first", () => {
  const db = fixture();
  try {
    const candidates = readDialogueProjection(db);
    expect(candidates.map((candidate) => candidate.sessionKey.nativeId)).toEqual(["recent", "old"]);
    expect(candidates[0]?.constructionGeneration).toBe("gen-recent");
    expect(candidates[0]?.turns.map((turn) => turn.side)).toEqual(["user", "assistant"]);
  } finally { db.close(); }
});

test("4k dialogue cap preserves head and tail while remaining within token budget", () => {
  const turns = [
    { ordinal: 1, side: "user" as const, text: "HEAD " + "a ".repeat(8_000) },
    { ordinal: 2, side: "assistant" as const, text: "MIDDLE " + "b ".repeat(8_000) },
    { ordinal: 3, side: "assistant" as const, text: "TAIL " + "c ".repeat(8_000) },
  ];
  const capped = capDialogueTurns(turns);
  expect(capped.capped).toBe(true);
  expect(capped.tokenCount).toBeLessThanOrEqual(4_000);
  expect(capped.turns.map((turn) => turn.ordinal)).toContain(1);
  expect(capped.turns.map((turn) => turn.ordinal)).toContain(3);
  expect(capped.turns[0]?.text.startsWith("HEAD")).toBe(true);
  expect(capped.turns.at(-1)?.text.trimEnd().endsWith("c")).toBe(true);
});

test("plan has provenance, hashes, explicit token/dollar totals, and deterministic batches", () => {
  const db = fixture();
  try {
    const options = { provider: "openai:gpt-5.4-nano", caps, outputTokensPerRequest: 180, redact: false, now: 42 };
    const first = planBatch(db, options);
    const second = planBatch(db, options);
    expect(first.planHash).toBe(second.planHash);
    expect(first.manifestId).toBe(second.manifestId);
    expect(first.totals.inputTokens).toBeGreaterThan(0);
    expect(first.totals.totalDollars).toBeGreaterThan(0);
    expect(first.candidates.every((candidate) => candidate.inputHash.length === 64 && candidate.provenanceHash.length === 64)).toBe(true);
    expect(first.batches.every((batch) => batch.cost.inputTokens <= caps.maxInputTokens && batch.cost.totalDollars <= caps.maxDollars)).toBe(true);
  } finally { db.close(); }
});

test("both exact Batch renderers use the approved provider shapes", () => {
  const db = fixture();
  try {
    const base = planBatch(db, { provider: "openai:gpt-5.4-nano", caps, outputTokensPerRequest: 180, redact: false, now: 42 });
    const openai = renderOpenAIRequest(base, base.candidates[0]!);
    expect(openai).toMatchObject({ custom_id: base.candidates[0]!.customId, method: "POST", url: "/v1/chat/completions", body: { model: "gpt-5.4-nano", max_tokens: 180 } });
    expect(openai.body.messages[1]!.content).toContain("ATLAS_BATCH_TRANSCRIPT");
    const anthropic = planBatch(db, { provider: "anthropic:claude-haiku-4.5", caps, outputTokensPerRequest: 180, redact: false, now: 42 });
    const request = renderAnthropicRequest(anthropic, anthropic.candidates[0]!);
    expect(request).toMatchObject({ custom_id: anthropic.candidates[0]!.customId, params: { model: "claude-haiku-4-5", max_tokens: 180, messages: [{ role: "user" }] } });
    expect(renderBatchJsonl(anthropic).trim().split("\n")).toHaveLength(anthropic.candidates.length);
  } finally { db.close(); }
});

test("manifest checkpoint, resume, and simulated result apply are idempotent", async () => {
  const db = fixture();
  const root = mkdtempSync(join(tmpdir(), "atlas-phase6-manifest-")); roots.push(root);
  try {
    const planned = planBatch(db, { provider: "openai:gpt-5.4-nano", caps, outputTokensPerRequest: 180, redact: false, now: 42 });
    const path = join(root, "manifest.json");
    await writeManifest(path, planned);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const running = checkpointBatchRunning(await readManifest(path), planned.batches[0]!.batchId, 43);
    await writeManifest(path, running);
    const candidate = running.candidates[0]!;
    const result: SimulatedResult = {
      customId: candidate.customId,
      sessionKey: candidate.sessionKey,
      provider: running.provider.id,
      model: running.provider.model,
      inputHash: candidate.inputHash,
      outputText: '{"topic_line":"fixture","tags":["fixture"]}',
      outputHash: sha256('{"topic_line":"fixture","tags":["fixture"]}'),
      outputTokens: 20,
      simulatedAt: 44,
    };
    const once = applySimulatedResult(running, result, 45);
    const twice = applySimulatedResult(once, result, 46);
    expect(twice.candidates[0]!.status).toBe("applied");
    expect(twice.batches[0]!.appliedRequestIds).toEqual([candidate.customId]);
    expect(resumeManifest(twice).pendingCustomIds).not.toContain(candidate.customId);
    expect(resumeManifest(twice).estimatedRemaining.totalDollars).toBeGreaterThanOrEqual(0);
    expect(readFileSync(path, "utf8")).toContain(planned.manifestId);
  } finally { db.close(); }
});

test("production submission has no path without explicit authorization and still fails closed", () => {
  const db = fixture();
  try {
    const manifest = planBatch(db, { provider: "openai:gpt-5.4-nano", caps, outputTokensPerRequest: 180, redact: false, now: 42 });
    expect(() => assertProductionSubmissionAuthorized(manifest, undefined)).toThrow("explicit authorization object");
    expect(() => submitBatch([], undefined)).toThrow("explicit authorization object");
    expect(() => submitBatch([], { authorizationId: "md-approval", provider: manifest.provider.id, outboundContentApproved: true, spendApproved: true, maxBatchDollars: 1, approvedAt: 1 })).toThrow("provider-free");
  } finally { db.close(); }
});
