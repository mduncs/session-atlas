import type { DB } from "../db/index.js";
import { redactString } from "../redact.js";
import { estimateTokens, sha256 } from "./canonical.js";
import {
  DIALOGUE_READER_RULE_VERSION,
  SESSION_DIALOGUE_TOKEN_CAP,
  type BatchCandidate,
  type DialogueSourceEvidence,
  type DialogueTurn,
  type SessionKey,
} from "./types.js";

interface SourceRow {
  sessionId: number;
  harness: string;
  nativeId: string;
  constructionGeneration: string;
  lastActivity: number | null;
  logicalRecordId: number;
  representativeRawRecordId: number;
  logicalOrdinal: number;
  rawOrdinal: number | null;
  recordKind: "real_user" | "assistant_dialogue_prose";
  dialogueSide: "user" | "assistant";
  prose: string;
  sourceIdentityKind: "uuid" | "record-id" | "message-id" | "none";
  sourceRecordId: string | null;
  sourceRecordUuid: string | null;
  sourceRecordTs: number | null;
}

/**
 * Read exactly the current-generation logical dialogue projection. In
 * particular, this query does not inspect legacy role/text rows as a fallback.
 */
export function readDialogueProjection(db: DB): BatchCandidate[] {
  const rows = db.prepare(`
    SELECT
      s.id AS "sessionId",
      s.harness,
      s.native_id AS "nativeId",
      s.construction_generation AS "constructionGeneration",
      s.last_activity AS "lastActivity",
      lm.id AS "logicalRecordId",
      lm.representative_message_id AS "representativeRawRecordId",
      lm.logical_ordinal AS "logicalOrdinal",
      m.source_ordinal AS "rawOrdinal",
      lm.record_kind AS "recordKind",
      lm.dialogue_side AS "dialogueSide",
      m.prose,
      m.source_identity_kind AS "sourceIdentityKind",
      m.source_record_id AS "sourceRecordId",
      m.source_record_uuid AS "sourceRecordUuid",
      m.source_record_ts AS "sourceRecordTs"
    FROM sessions s
    JOIN logical_messages lm
      ON lm.session_id = s.id
     AND lm.construction_generation = s.construction_generation
    JOIN messages m
      ON m.id = lm.representative_message_id
     AND m.session_id = s.id
     AND m.construction_generation = s.construction_generation
    WHERE s.construction_status = 'valid'
      AND lm.record_kind IN ('real_user', 'assistant_dialogue_prose')
      AND lm.dialogue_side IN ('user', 'assistant')
      AND m.prose IS NOT NULL
      AND length(trim(m.prose)) > 0
    ORDER BY
      CASE WHEN s.last_activity IS NULL THEN 1 ELSE 0 END,
      s.last_activity DESC,
      s.harness ASC,
      s.native_id ASC,
      lm.logical_ordinal ASC,
      lm.id ASC
  `).all() as SourceRow[];

  const grouped = new Map<string, SourceRow[]>();
  for (const row of rows) {
    const key = sessionKeyString({ harness: row.harness, nativeId: row.nativeId });
    const group = grouped.get(key);
    if (group) group.push(row);
    else grouped.set(key, [row]);
  }

  return [...grouped.values()].map(buildCandidate);
}

export function sessionKeyString(key: SessionKey): string {
  return `${key.harness}\u0000${key.nativeId}`;
}

export interface CapResult {
  turns: DialogueTurn[];
  tokenCount: number;
  capped: boolean;
}

/**
 * Keep the complete projection where possible; otherwise retain a deterministic
 * prefix and suffix. The cap applies to rendered dialogue lines, so the
 * manifest's token budget cannot be exceeded by role labels either.
 */
export function capDialogueTurns(turns: readonly DialogueTurn[], cap = SESSION_DIALOGUE_TOKEN_CAP): CapResult {
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new RangeError("dialogue token cap must be a positive integer");
  const normalized = turns.map((turn) => ({ ordinal: turn.ordinal, side: turn.side, text: turn.text }));
  const total = normalized.reduce((sum, turn) => sum + turnTokenCount(turn), 0);
  if (total <= cap) return { turns: normalized, tokenCount: total, capped: false };

  const headBudget = Math.floor(cap / 2);
  const tailBudget = cap - headBudget;
  const head = takePrefix(normalized, headBudget);
  const tail = takeSuffix(normalized, tailBudget);
  const byOrdinal = new Map<number, DialogueTurn>();
  for (const turn of head) byOrdinal.set(turn.ordinal, turn);
  for (const turn of tail) {
    const earlier = byOrdinal.get(turn.ordinal);
    if (!earlier) byOrdinal.set(turn.ordinal, turn);
    else byOrdinal.set(turn.ordinal, mergeFragments(earlier, turn, headBudget + tailBudget));
  }
  const result = [...byOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);
  // The overlap marker can itself consume a token. Trim only if necessary; the
  // two-sided selection remains deterministic and always preserves an edge.
  const trimmed = fitTotal(result, cap);
  return { turns: trimmed, tokenCount: trimmed.reduce((sum, turn) => sum + turnTokenCount(turn), 0), capped: true };
}

function buildCandidate(rows: SourceRow[]): BatchCandidate {
  const first = rows[0]!;
  const sourceEvidence: DialogueSourceEvidence[] = rows.map((row) => ({
    logicalRecordId: Number(row.logicalRecordId),
    representativeRawRecordId: Number(row.representativeRawRecordId),
    logicalOrdinal: Number(row.logicalOrdinal),
    rawOrdinal: row.rawOrdinal === null ? null : Number(row.rawOrdinal),
    recordKind: row.recordKind,
    sourceIdentityKind: row.sourceIdentityKind,
    sourceRecordId: row.sourceRecordId,
    sourceRecordUuid: row.sourceRecordUuid,
    sourceRecordTs: row.sourceRecordTs,
  }));
  const allTurns = rows.map((row) => ({ ordinal: Number(row.logicalOrdinal), side: row.dialogueSide, text: row.prose }));
  const capped = capDialogueTurns(allTurns);
  const key = { harness: first.harness, nativeId: first.nativeId };
  const dialogueHash = sha256({ reader: DIALOGUE_READER_RULE_VERSION, turns: capped.turns });
  const provenanceHash = sha256({
    reader: DIALOGUE_READER_RULE_VERSION,
    sessionKey: key,
    constructionGeneration: first.constructionGeneration,
    evidence: sourceEvidence,
  });
  const customId = `atlas-${sha256({ sessionKey: key, input: dialogueHash }).slice(0, 32)}`;
  return {
    sessionKey: key,
    sessionId: Number(first.sessionId),
    constructionGeneration: first.constructionGeneration,
    lastActivity: first.lastActivity === null ? null : Number(first.lastActivity),
    turns: capped.turns,
    dialogueTokens: capped.tokenCount,
    dialogueCapped: capped.capped,
    dialogueHash,
    provenanceHash,
    inputHash: "", // Filled by the planner after the exact prompt is rendered.
    customId,
    inputTokens: 0,
    outputTokens: 0,
    cost: { inputTokens: 0, outputTokens: 0, inputDollars: 0, outputDollars: 0, totalDollars: 0 },
    sourceEvidence,
    status: "pending",
    result: null,
  };
}

function turnTokenCount(turn: DialogueTurn): number {
  return estimateTokens(`${turn.side}: ${turn.text}`);
}

function takePrefix(turns: readonly DialogueTurn[], budget: number): DialogueTurn[] {
  const output: DialogueTurn[] = [];
  let remaining = budget;
  for (const turn of turns) {
    if (remaining <= 0) break;
    const full = turnTokenCount(turn);
    if (full <= remaining) {
      output.push({ ...turn });
      remaining -= full;
      continue;
    }
    const text = fitText(turn, remaining, "prefix");
    if (text) output.push({ ...turn, text });
    break;
  }
  return output;
}

function takeSuffix(turns: readonly DialogueTurn[], budget: number): DialogueTurn[] {
  const output: DialogueTurn[] = [];
  let remaining = budget;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    if (remaining <= 0) break;
    const full = turnTokenCount(turn);
    if (full <= remaining) {
      output.unshift({ ...turn });
      remaining -= full;
      continue;
    }
    const text = fitText(turn, remaining, "suffix");
    if (text) output.unshift({ ...turn, text });
    break;
  }
  return output;
}

function fitText(turn: DialogueTurn, tokenBudget: number, direction: "prefix" | "suffix"): string {
  if (tokenBudget <= 0) return "";
  const chars = [...turn.text];
  let low = 0;
  let high = chars.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = direction === "prefix" ? chars.slice(0, middle).join("") : chars.slice(chars.length - middle).join("");
    if (turnTokenCount({ ...turn, text: candidate }) <= tokenBudget) {
      best = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

function mergeFragments(head: DialogueTurn, tail: DialogueTurn, budget: number): DialogueTurn {
  const marker = "\n[…middle omitted…]\n";
  let text = `${head.text}${marker}${tail.text}`;
  if (turnTokenCount({ ...head, text }) <= budget) return { ...head, text };
  text = `${head.text}\n${tail.text}`;
  if (turnTokenCount({ ...head, text }) <= budget) return { ...head, text };
  const allowed = Math.max(1, Math.floor(budget / 2));
  return { ...head, text: `${fitText(head, allowed, "prefix")}${fitText(tail, allowed, "suffix")}` };
}

function fitTotal(turns: DialogueTurn[], cap: number): DialogueTurn[] {
  let current = turns.map((turn) => ({ ...turn }));
  let total = current.reduce((sum, turn) => sum + turnTokenCount(turn), 0);
  while (total > cap && current.length > 0) {
    const index = current.length - 1;
    const turn = current[index]!;
    const budget = Math.max(1, turnTokenCount(turn) - (total - cap));
    const fitted = fitText(turn, budget, "suffix");
    if (!fitted || fitted === turn.text) current.pop();
    else current[index] = { ...turn, text: fitted };
    total = current.reduce((sum, item) => sum + turnTokenCount(item), 0);
  }
  return current;
}

/** Escape only framing delimiters; transcript text remains source-faithful data. */
export function escapeTranscriptText(text: string): string {
  return text
    .replaceAll("<<<ATLAS_BATCH_TRANSCRIPT>>>", "[escaped batch transcript delimiter]")
    .replaceAll("<<<END_ATLAS_BATCH_TRANSCRIPT>>>", "[escaped end batch transcript delimiter]")
    .replaceAll("</atlas_transcript>", "&lt;/atlas_transcript&gt;");
}

export function renderTranscript(turns: readonly DialogueTurn[]): string {
  const lines = turns.map((turn) => `[ord ${turn.ordinal}] ${turn.side}: ${escapeTranscriptText(turn.text)}`);
  return `<atlas_transcript trust="untrusted-data">\n<<<ATLAS_BATCH_TRANSCRIPT>>>\n${lines.join("\n\n")}\n<<<END_ATLAS_BATCH_TRANSCRIPT>>>\n</atlas_transcript>`;
}

/** Optional local redaction for a dry run; it never reads environment secrets. */
export function redactTranscript(turns: readonly DialogueTurn[]): DialogueTurn[] {
  return turns.map((turn) => ({ ...turn, text: redactString(turn.text) }));
}

/** Integration-friendly alias; both names mean the same fail-closed reader. */
export const readBatchCandidates = readDialogueProjection;
