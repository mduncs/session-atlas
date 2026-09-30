import type {
  ActivityRecordDto,
  DialogueTurnDto,
  SessionTranscriptDto,
} from "../contracts/search.js";
import type { RecordKind, ToolActivityDto } from "../contracts/construction.js";
import type { DB } from "../db/index.js";
import { classifyUserText, type UserAuthor } from "../layers/authorship.js";
import type { RoleToggle, TranscriptMode } from "./store.js";

export type ReaderRole = "user" | "assistant" | RecordKind;

export interface ReaderDisplayRow {
  logicalRecordId: number;
  ordinal: number;
  role: ReaderRole;
  recordKind: RecordKind;
  /** Exact stored prose. Copy actions use this, never `display`. */
  prose: string | null;
  toolActivities: readonly ToolActivityDto[];
  /**
   * Display text with the source's line structure kept (paragraphs, lists,
   * headings, fences) and display-only paragraph breaks applied. Tool
   * payloads are not inlined; the layout folds them into their own lines.
   */
  display: string;
  dimmed: boolean;
  gutter: string;
  constructionGeneration: string;
  eventTs?: number | null;
  /** Who wrote a user-side record: md, another agent, or the harness. */
  author?: UserAuthor | null;
  authorRule?: string | null;
}

/** Sha-verified display-only paragraph breaks, keyed by message ordinal. */
export type ParagraphBreaks = ReadonlyMap<number, readonly number[]>;

export interface TranscriptDtoValidation {
  readable: boolean;
  diagnostic: string | null;
  warnings: string[];
}

/**
 * The frozen reader seam represents one atomic construction generation. The
 * TUI validates that claim before rendering even one turn; a malformed or
 * diagnostic DTO fails closed instead of falling back to legacy message rows.
 */
export function validateTranscriptDto(dto: SessionTranscriptDto): TranscriptDtoValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const session = dto.session;
  const metrics = session.metrics;
  const generation = session.constructionGeneration.trim();

  if (dto.diagnostic?.trim()) errors.push(dto.diagnostic.trim());
  if (!generation) errors.push("construction generation is missing");
  if (!session.sessionKey.nativeId.trim()) errors.push("session identity is incomplete");

  const generationMismatch = [...dto.dialogue, ...dto.activity]
    .some((row) => row.constructionGeneration !== session.constructionGeneration);
  if (generationMismatch) errors.push("reader rows span multiple construction generations");

  if (metrics.dialogueTurnCount !== metrics.userDialogueTurnCount + metrics.assistantDialogueTurnCount) {
    errors.push("dialogue metric invariant failed");
  }
  if (metrics.dialogueTurnCount !== dto.dialogue.length) {
    errors.push("dialogue projection does not match its current-generation metric");
  }
  if (metrics.logicalRecordCount !== dto.activity.length) {
    errors.push("activity projection does not match its current-generation metric");
  }
  if (metrics.logicalReplayCount !== metrics.rawProvenanceRowCount - metrics.logicalRecordCount) {
    errors.push("replay metric invariant failed");
  }

  const userTurns = dto.dialogue.filter((row) => row.side === "user").length;
  const assistantTurns = dto.dialogue.filter((row) => row.side === "assistant").length;
  if (userTurns !== metrics.userDialogueTurnCount || assistantTurns !== metrics.assistantDialogueTurnCount) {
    errors.push("dialogue side metrics do not match the projection");
  }

  if (!strictlyIncreasing(dto.dialogue.map((row) => row.logicalOrdinal))) {
    errors.push("dialogue projection is not in unique logical order");
  }
  if (!strictlyIncreasing(dto.activity.map((row) => row.logicalOrdinal))) {
    errors.push("activity projection is not in unique logical order");
  }

  for (const row of dto.dialogue) {
    const expectedKind = row.side === "user" ? "real_user" : "assistant_dialogue_prose";
    if (row.recordKind !== expectedKind || !row.prose.trim()) {
      errors.push(`dialogue turn ${row.logicalOrdinal} violates the canonical dialogue predicate`);
      break;
    }
  }

  const activityById = new Map(dto.activity.map((row) => [row.logicalRecordId, row]));
  for (const turn of dto.dialogue) {
    const activity = activityById.get(turn.logicalRecordId);
    if (!activity || activity.logicalOrdinal !== turn.logicalOrdinal || activity.recordKind !== turn.recordKind) {
      errors.push(`dialogue turn ${turn.logicalOrdinal} is absent from the activity projection`);
      break;
    }
  }

  if (session.artifactKind === "metadata_shell" && metrics.dialogueTurnCount !== 0) {
    errors.push("metadata shell claims dialogue turns");
  }
  if (session.artifactKind === "current_context_projection" && session.historyCompleteness !== "current_context_only") {
    errors.push("current-context projection is mislabeled as lifetime history");
  }

  if (session.sourceValidationStatus === "snapshot_only") warnings.push("SNAPSHOT ONLY · source is not currently reachable");
  if (session.sourceValidationStatus === "legacy_unverified") warnings.push("LEGACY UNVERIFIED · source validation is pending");
  if (session.artifactKind === "current_context_projection") warnings.push("CURRENT CONTEXT ONLY · not lifetime history");
  if (session.artifactKind === "metadata_shell") warnings.push("METADATA SHELL · no dialogue in source");
  if (metrics.dialogueTurnCount === 0 && session.artifactKind !== "metadata_shell") warnings.push("NO DIALOGUE IN SOURCE");
  if (metrics.dialogueTurnCount > 0 && (userTurns === 0 || assistantTurns === 0)) {
    warnings.push(`ONE-SIDED DIALOGUE · ${userTurns} user / ${assistantTurns} assistant`);
  }

  return {
    readable: errors.length === 0,
    diagnostic: errors.length === 0 ? null : errors.join(" · "),
    warnings: unique(warnings),
  };
}

export function projectReaderTranscript(
  dto: SessionTranscriptDto,
  mode: TranscriptMode,
  roleToggle: RoleToggle,
  validation = validateTranscriptDto(dto),
  paragraphs: ParagraphBreaks = NO_BREAKS,
): ReaderDisplayRow[] {
  if (!validation.readable) return [];
  if (mode === "dialogue" || mode === "prose") {
    return dto.dialogue.map((turn) => dialogueDisplayRow(turn, roleToggle, paragraphs));
  }
  return dto.activity.map((record) => activityDisplayRow(record, roleToggle, paragraphs));
}

const NO_BREAKS: ParagraphBreaks = new Map();

export function transcriptProjectionLabel(mode: TranscriptMode): string {
  switch (mode) {
    case "dialogue": return "DIALOGUE";
    case "full": return "ACTIVITY · FULL";
    case "stubs": return "ACTIVITY · STUBS";
    case "prose": return "DIALOGUE · PROSE";
  }
}

export function transcriptStateLabel(dto: SessionTranscriptDto, validation = validateTranscriptDto(dto)): string {
  if (!validation.readable && dto.session.sourceValidationStatus === "legacy_unverified") return "LEGACY INVALID";
  if (!validation.readable) return "PROJECTION INVALID";
  if (dto.session.artifactKind === "metadata_shell") return "METADATA SHELL";
  if (dto.session.artifactKind === "current_context_projection") return "CURRENT CONTEXT ONLY";
  if (dto.session.sourceValidationStatus === "snapshot_only") return "SNAPSHOT ONLY";
  if (dto.session.sourceValidationStatus === "legacy_unverified") return "LEGACY UNVERIFIED";
  return "CURRENT";
}

function dialogueDisplayRow(turn: DialogueTurnDto, roleToggle: RoleToggle, paragraphs: ParagraphBreaks): ReaderDisplayRow {
  const dimmed = roleToggle !== "all" && roleToggle !== turn.side;
  const verdict = turn.side === "user" ? classifyUserText(turn.prose) : null;
  const breaks = verdict?.author === "human" ? paragraphs.get(turn.logicalOrdinal) : undefined;
  return {
    logicalRecordId: turn.logicalRecordId,
    ordinal: turn.logicalOrdinal,
    role: turn.side,
    recordKind: turn.recordKind,
    prose: turn.prose,
    toolActivities: turn.toolActivities,
    display: readableText(breaks ? applyParagraphBreaks(turn.prose, breaks) : turn.prose),
    dimmed,
    gutter: turn.side === "user" ? "◆" : "◇",
    constructionGeneration: turn.constructionGeneration,
    eventTs: turn.eventTs,
    author: verdict?.author ?? null,
    authorRule: verdict?.rule ?? null,
  };
}

function activityDisplayRow(record: ActivityRecordDto, roleToggle: RoleToggle, paragraphs: ParagraphBreaks): ReaderDisplayRow {
  const side = sideForKind(record.recordKind);
  const dimmed = side === null || roleToggle !== "all" && roleToggle !== side;
  const prose = record.prose ?? "";
  const verdict = side === "user" && prose ? classifyUserText(prose) : null;
  const breaks = verdict?.author === "human" ? paragraphs.get(record.logicalOrdinal) : undefined;
  let display = readableText(breaks ? applyParagraphBreaks(prose, breaks) : prose);
  if (!display && record.toolActivities.length === 0) display = `${kindLabel(record.recordKind)} event`;
  return {
    logicalRecordId: record.logicalRecordId,
    ordinal: record.logicalOrdinal,
    role: side ?? record.recordKind,
    recordKind: record.recordKind,
    prose: record.prose,
    toolActivities: record.toolActivities,
    display,
    dimmed,
    gutter: side === "user" ? "◆" : side === "assistant" ? "◇" : "·",
    constructionGeneration: record.constructionGeneration,
    eventTs: record.eventTs,
    author: verdict?.author ?? null,
    authorRule: verdict?.rule ?? null,
  };
}

/**
 * Display-only paragraph breaks: a blank line at each UTF-16 offset into the
 * exact stored text. Whitespace at a cut is folded into the break; offsets
 * outside the text, duplicates, and cuts inside a surrogate pair are ignored.
 * The stored text is never rewritten.
 */
export function applyParagraphBreaks(text: string, breaks: readonly number[]): string {
  const cuts = [...new Set(breaks)]
    .filter((offset) => Number.isInteger(offset) && offset > 0 && offset < text.length && !isLowSurrogate(text.charCodeAt(offset)))
    .sort((a, b) => a - b);
  if (cuts.length === 0) return text;
  let out = "";
  let last = 0;
  for (const cut of cuts) {
    if (cut <= last) continue;
    const piece = text.slice(last, cut).replace(/\s+$/u, "");
    if (!piece) continue;
    out += `${piece}\n\n`;
    last = cut;
    while (last < text.length && /\s/u.test(text[last]!)) last++;
  }
  out += text.slice(last);
  return out.replace(/\n{3,}/g, "\n\n");
}

function isLowSurrogate(code: number): boolean { return code >= 0xdc00 && code <= 0xdfff; }

/**
 * Read `layers.message_paragraphs` for one session and keep only rows whose
 * `text_sha256` matches the current message text. Absent layers, an absent
 * table, or a stale hash all mean "show the text as-is".
 */
export function readParagraphBreaks(db: Pick<DB, "query">, dto: SessionTranscriptDto): ParagraphBreaks {
  let rows: Array<{ ordinal: number; text_sha256: string; breaks: string }>;
  try {
    rows = db.query(`SELECT ordinal, text_sha256, breaks FROM layers.message_paragraphs WHERE harness=? AND native_id=?`)
      .all(dto.session.sessionKey.harness, dto.session.sessionKey.nativeId) as typeof rows;
  } catch {
    return NO_BREAKS;
  }
  if (rows.length === 0) return NO_BREAKS;
  const byOrdinal = new Map(rows.map((row) => [row.ordinal, row]));
  const result = new Map<number, readonly number[]>();
  for (const turn of dto.dialogue) {
    if (turn.side !== "user") continue;
    const row = byOrdinal.get(turn.logicalOrdinal) ?? byOrdinal.get(turn.rawRepresentativeOrdinal);
    if (!row || row.text_sha256 !== sha256(turn.prose)) continue;
    try {
      const breaks: unknown = JSON.parse(row.breaks);
      if (Array.isArray(breaks) && breaks.every((value) => Number.isInteger(value))) result.set(turn.logicalOrdinal, breaks as number[]);
    } catch { /* malformed row: show the text as-is */ }
  }
  return result;
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * Keep the source's structure: line breaks, blank-line paragraphs, list and
 * heading lines, fences, and indentation. Only terminal hazards change: CRLF,
 * tabs, control characters, trailing spaces, and runs of blank lines.
 */
export function readableText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/gu, "")
    .replace(/[ \u00a0]+$/gmu, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

function sideForKind(kind: RecordKind): "user" | "assistant" | null {
  if (kind === "real_user") return "user";
  if (kind === "assistant_dialogue_prose") return "assistant";
  return null;
}



export function kindLabel(kind: RecordKind): string {
  return kind.replaceAll("_", " ");
}

function strictlyIncreasing(values: readonly number[]): boolean {
  for (let index = 1; index < values.length; index++) {
    if (values[index]! <= values[index - 1]!) return false;
  }
  return true;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
