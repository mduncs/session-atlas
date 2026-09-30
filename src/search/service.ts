import type { DB } from "../db/index.js";
import type {
  ActivityRecordDto,
  DialogueTurnDto,
  SearchErrorDto,
  SearchFilterDto,
  SearchHitDto,
  SearchPageDto,
  SearchRequestDto,
  SearchResultDto,
  SearchSnippetDto,
  SessionListItemDto,
  SessionSearchService,
  SessionTranscriptDto,
} from "../contracts/search.js";
import type { HarnessId, SessionKey, TitleAuthority, ToolActivityDto } from "../contracts/construction.js";
import { SearchQueryCompileError, type SearchSyntax } from "../fts-query.js";
import { effectiveSessionOriginSql } from "../human-classifier.js";
import { creatorJoinSql } from "../layers/creator-sql.js";
import {
  compileSearchSelection,
  normalizeListFilter,
  normalizeSearchFilter,
  searchFilterFingerprint,
  type ListFilter,
  type NormalizedSessionFilter,
} from "./compiler.js";

const MARK_OPEN = "\u001d";
const MARK_CLOSE = "\u001e";
const MAX_PAGE_SIZE = 300;

export interface CompatibilitySearchRow {
  id: number;
  harness: string;
  nativeId: string;
  title: string | null;
  cwd: string | null;
  project: string | null;
  lastActivity: number | null;
  durationMs: number | null;
  tokUser: number;
  tokAssistant: number;
  tokTool: number;
  dialogueTurnCount: number;
  modelsJson: string | null;
  chainId: number | null;
  favorite: boolean;
  engagement: number | null;
  orphaned: number;
  origin: string;
  originDetail: string | null;
  effectiveOrigin: "human" | "agent";
  classificationConfidence: number | null;
  classificationReason: string | null;
  classificationMethod: string | null;
}

export interface ExecutedSearchHit extends SearchHitDto {
  compatibility: CompatibilitySearchRow;
}

export interface ExecutedSearchPage extends Omit<SearchPageDto, "hits"> {
  hits: ExecutedSearchHit[];
}

export type ExecutedSearchResult =
  | { ok: true; page: ExecutedSearchPage }
  | { ok: false; error: SearchErrorDto };

export interface ListSearchRequest {
  query: string;
  syntax: SearchSyntax;
  filter: ListFilter;
  pageSize: number;
  cursor: string | null;
}

interface SearchCursor {
  v: 1;
  rank: number;
  activity: number;
  sessionId: number;
  fingerprint: string;
}

interface SearchDatabaseRow extends Record<string, unknown> {
  id: number;
  harness: string;
  native_id: string;
  relevance_rank: number;
  effective_title: string | null;
  title_authority: TitleAuthority | null;
  title_source_class: string | null;
  title_source_record_id: string | null;
  title_source_reference: string | null;
  title_source_ordinal: number | null;
  title_rule_version: string | null;
  original_project_key: string | null;
  canonical_project_key: string | null;
  cwd: string | null;
  last_activity: number | null;
  dialogue_start_ts: number | null;
  dialogue_end_ts: number | null;
  duration_ms: number | null;
  artifact_kind: SessionListItemDto["artifactKind"];
  history_completeness: SessionListItemDto["historyCompleteness"];
  source_validation_status: SessionListItemDto["sourceValidationStatus"];
  default_session_visible: number;
  construction_generation: string;
  models: string | null;
  favorite: number;
  chain_stable_key: string | null;
  chain_id: number | null;
  tok_user: number;
  tok_assistant: number;
  tok_tool: number;
  engagement: number | null;
  orphaned: number;
  origin: string;
  origin_detail: string | null;
  effective_origin: "human" | "agent";
  classification_confidence: number | null;
  classification_reason: string | null;
  classification_method: string | null;
  raw_provenance_row_count: number;
  logical_record_count: number;
  raw_tool_activity_count: number;
  logical_tool_activity_count: number;
  raw_prose_bearing_record_count: number;
  logical_prose_bearing_record_count: number;
  dialogue_turn_count: number;
  user_dialogue_turn_count: number;
  assistant_dialogue_turn_count: number;
  logical_replay_count: number;
  unknown_identity_raw_row_count: number;
}

export class SqliteSessionSearchService implements SessionSearchService {
  constructor(private readonly db: DB) {}

  search(request: SearchRequestDto): SearchResultDto {
    return executeSearch(this.db, request, normalizeSearchFilter(request.filters));
  }

  searchList(request: ListSearchRequest): ExecutedSearchResult {
    return executeSearch(this.db, request, normalizeListFilter(request.filter));
  }

  transcript(sessionKey: SessionKey): SessionTranscriptDto {
    const row = loadSessionByKey(this.db, sessionKey);
    if (!row) throw new Error(`No current valid construction for ${sessionKey.harness}:${sessionKey.nativeId}`);
    const session = toSessionItem(row);
    const records = this.db.prepare(
      `SELECT lm.id AS logical_record_id,lm.logical_ordinal,lm.record_kind,lm.dialogue_side,
              lm.replay_count,lm.construction_generation,m.ordinal AS raw_ordinal,
              m.prose,m.event_ts,m.id AS raw_record_id
       FROM logical_messages lm
       JOIN messages m ON m.id=lm.representative_message_id AND m.session_id=lm.session_id
       JOIN sessions s ON s.id=lm.session_id
       WHERE s.id=? AND s.construction_status='valid'
         AND lm.construction_generation=s.construction_generation
         AND m.construction_generation=s.construction_generation
       ORDER BY lm.logical_ordinal`,
    ).all(row.id) as Array<Record<string, unknown>>;
    const toolRows = this.db.prepare(
      `SELECT ta.id,ta.raw_record_id,ta.activity_ordinal,ta.activity_kind,ta.tool_name,ta.tool_text,ta.source_activity_id
       FROM tool_activities ta JOIN messages m ON m.id=ta.raw_record_id
       WHERE m.session_id=? AND ta.construction_generation=?
       ORDER BY ta.raw_record_id,ta.activity_ordinal`,
    ).all(row.id, row.construction_generation) as Array<Record<string, unknown>>;
    const tools = new Map<number, ToolActivityDto[]>();
    for (const tool of toolRows) {
      const rawId = Number(tool.raw_record_id);
      const values = tools.get(rawId) ?? [];
      values.push({
        toolActivityId: Number(tool.id),
        rawRecordId: rawId,
        activityOrdinal: Number(tool.activity_ordinal),
        activityKind: String(tool.activity_kind) as ToolActivityDto["activityKind"],
        toolName: nullableString(tool.tool_name),
        toolText: nullableString(tool.tool_text),
        sourceActivityId: nullableString(tool.source_activity_id),
      });
      tools.set(rawId, values);
    }
    const activity: ActivityRecordDto[] = records.map((record) => ({
      logicalRecordId: Number(record.logical_record_id),
      logicalOrdinal: Number(record.logical_ordinal),
      recordKind: String(record.record_kind) as ActivityRecordDto["recordKind"],
      prose: nullableString(record.prose),
      eventTs: nullableNumber(record.event_ts),
      replayCount: Number(record.replay_count),
      toolActivities: tools.get(Number(record.raw_record_id)) ?? [],
      constructionGeneration: String(record.construction_generation),
    }));
    const dialogue: DialogueTurnDto[] = records
      .filter((record) =>
        (record.record_kind === "real_user" && record.dialogue_side === "user")
        || (record.record_kind === "assistant_dialogue_prose" && record.dialogue_side === "assistant"),
      )
      .filter((record) => typeof record.prose === "string" && record.prose.trim().length > 0)
      .map((record) => ({
        logicalRecordId: Number(record.logical_record_id),
        logicalOrdinal: Number(record.logical_ordinal),
        rawRepresentativeOrdinal: Number(record.raw_ordinal),
        side: String(record.dialogue_side) as "user" | "assistant",
        recordKind: String(record.record_kind) as DialogueTurnDto["recordKind"],
        prose: String(record.prose),
        eventTs: nullableNumber(record.event_ts),
        replayCount: Number(record.replay_count),
        toolActivities: tools.get(Number(record.raw_record_id)) ?? [],
        constructionGeneration: String(record.construction_generation),
      }));
    return { session, dialogue, activity, diagnostic: null };
  }
}

export function createSessionSearchService(db: DB): SqliteSessionSearchService {
  return new SqliteSessionSearchService(db);
}

export function hasV12SearchIndex(db: DB): boolean {
  return !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_search_fts'`,
  ).get();
}

function executeSearch(
  db: DB,
  request: Pick<SearchRequestDto, "query" | "syntax" | "pageSize" | "cursor">,
  filter: NormalizedSessionFilter,
): ExecutedSearchResult {
  if (!Number.isSafeInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > MAX_PAGE_SIZE) {
    return failure("invalid_query", `Search page size must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  if (!hasV12SearchIndex(db)) {
    return failure("schema_not_ready", "Search requires the guarded schema v12 FTS migration");
  }
  try {
    const compiled = compileSearchSelection(request, filter, "s");
    const fingerprint = `${compiled.match}\n${searchFilterFingerprint(filter)}`;
    const cursor = decodeCursor(request.cursor, fingerprint);
    const where = compiled.filter.predicates.length ? `WHERE ${compiled.filter.predicates.join(" AND ")}` : "";
    const withSql = matchedSessionsCte(where);
    const total = Number((db.prepare(
      `${withSql} SELECT count(*) AS n FROM filtered_sessions`,
    ).get(compiled.match, ...compiled.filter.params) as { n: number }).n);

    const cursorClause = cursor
      ? `WHERE (fs.relevance_rank > ? OR (fs.relevance_rank = ? AND
          (COALESCE(fs.last_activity,-1) < ? OR (COALESCE(fs.last_activity,-1) = ? AND fs.session_id < ?))))`
      : "";
    const cursorParams = cursor
      ? [cursor.rank, cursor.rank, cursor.activity, cursor.activity, cursor.sessionId]
      : [];
    const rows = db.prepare(
      `${withSql}
       SELECT ${sessionColumns("s")},fs.relevance_rank
       FROM filtered_sessions fs
       JOIN sessions s ON s.id=fs.session_id
       JOIN construction_metrics cm ON cm.session_id=s.id AND cm.construction_generation=s.construction_generation
       LEFT JOIN title_evidence te ON te.session_id=s.id
         AND te.construction_generation=s.construction_generation AND te.selected=1
       LEFT JOIN chains ch ON ch.id=s.chain_id
       ${creatorJoinSql("s")}
       ${cursorClause}
       ORDER BY fs.relevance_rank ASC,COALESCE(fs.last_activity,-1) DESC,fs.session_id DESC
       LIMIT ?`,
    ).all(
      compiled.match,
      ...compiled.filter.params,
      ...cursorParams,
      request.pageSize + 1,
    ) as SearchDatabaseRow[];
    const hasMore = rows.length > request.pageSize;
    const visible = hasMore ? rows.slice(0, request.pageSize) : rows;
    const snippets = loadSnippets(db, compiled.match, visible.map((row) => row.id));
    const hits = visible.map((row) => toExecutedHit(row, snippets.get(row.id) ?? []));
    const last = visible.at(-1);
    const nextCursor = hasMore && last
      ? encodeCursor({
          v: 1,
          rank: Number(last.relevance_rank),
          activity: last.last_activity ?? -1,
          sessionId: Number(last.id),
          fingerprint,
        })
      : null;
    return {
      ok: true,
      page: { hits, total, nextCursor, queryDisplay: compiled.queryDisplay },
    };
  } catch (error) {
    if (error instanceof SearchQueryCompileError || isFtsSyntaxError(error)) {
      return failure("invalid_query", "Invalid FTS5 search syntax");
    }
    return failure("query_failed", `Search query failed: ${safeError(error)}`);
  }
}

function matchedSessionsCte(filterWhere: string): string {
  return `WITH matched_documents AS MATERIALIZED (
    SELECT d.session_id,bm25(session_search_fts,1.0,1.0) AS score
    FROM session_search_fts
    JOIN session_search_documents d ON d.id=session_search_fts.rowid
    WHERE session_search_fts MATCH ?
  ), ranked_sessions AS MATERIALIZED (
    SELECT session_id,MIN(score) AS relevance_rank
    FROM matched_documents GROUP BY session_id
  ), filtered_sessions AS (
    SELECT rs.session_id,rs.relevance_rank,s.last_activity
    FROM ranked_sessions rs JOIN sessions s ON s.id=rs.session_id
    ${filterWhere}
  )`;
}

function sessionColumns(alias: string): string {
  return `${alias}.id,${alias}.harness,${alias}.native_id,
    te.value AS effective_title,te.authority AS title_authority,
    te.harness_source_class AS title_source_class,te.source_record_id AS title_source_record_id,
    te.source_reference AS title_source_reference,te.source_ordinal AS title_source_ordinal,
    te.eligibility_rule_version AS title_rule_version,
    ${alias}.original_project_key,${alias}.canonical_project_key,${alias}.cwd,
    ${alias}.last_activity,${alias}.duration_ms,
    (SELECT MIN(mb.event_ts) FROM logical_messages lb JOIN messages mb ON mb.id=lb.representative_message_id
      WHERE lb.session_id=${alias}.id AND lb.construction_generation=${alias}.construction_generation
        AND mb.construction_generation=${alias}.construction_generation
        AND lb.record_kind IN ('real_user','assistant_dialogue_prose')) AS dialogue_start_ts,
    (SELECT MAX(mb.event_ts) FROM logical_messages lb JOIN messages mb ON mb.id=lb.representative_message_id
      WHERE lb.session_id=${alias}.id AND lb.construction_generation=${alias}.construction_generation
        AND mb.construction_generation=${alias}.construction_generation
        AND lb.record_kind IN ('real_user','assistant_dialogue_prose')) AS dialogue_end_ts,
    ${alias}.artifact_kind,${alias}.history_completeness,${alias}.source_validation_status,
    ${alias}.default_session_visible,${alias}.construction_generation,${alias}.models,
    EXISTS (SELECT 1 FROM favorites fav WHERE fav.harness=${alias}.harness AND fav.native_id=${alias}.native_id) AS favorite,
    ch.stable_key AS chain_stable_key,${alias}.chain_id,
    ${alias}.tok_user,${alias}.tok_assistant,${alias}.tok_tool,${alias}.engagement,${alias}.orphaned,
    ${alias}.origin,${alias}.origin_detail,${effectiveSessionOriginSql(alias)} AS effective_origin,
    hc.confidence AS classification_confidence,hc.reason AS classification_reason,hc.method AS classification_method,
    cm.raw_provenance_row_count,cm.logical_record_count,cm.raw_tool_activity_count,
    cm.logical_tool_activity_count,cm.raw_prose_bearing_record_count,cm.logical_prose_bearing_record_count,
    cm.dialogue_turn_count,cm.user_dialogue_turn_count,cm.assistant_dialogue_turn_count,
    cm.logical_replay_count,cm.unknown_identity_raw_row_count`;
}

function loadSessionByKey(db: DB, key: SessionKey): SearchDatabaseRow | null {
  return db.prepare(
    `SELECT ${sessionColumns("s")},0.0 AS relevance_rank
     FROM sessions s
     JOIN construction_metrics cm ON cm.session_id=s.id AND cm.construction_generation=s.construction_generation
     LEFT JOIN title_evidence te ON te.session_id=s.id
       AND te.construction_generation=s.construction_generation AND te.selected=1
     LEFT JOIN chains ch ON ch.id=s.chain_id
     ${creatorJoinSql("s")}
     WHERE s.harness=? AND s.native_id=? AND s.construction_status='valid'`,
  ).get(key.harness, key.nativeId) as SearchDatabaseRow | null;
}

interface HighlightRow {
  session_id: number;
  logical_record_id: number;
  logical_ordinal: number;
  side: "user" | "assistant";
  highlighted: string;
}

function loadSnippets(db: DB, match: string, sessionIds: number[]): Map<number, SearchSnippetDto[]> {
  const bySession = new Map<number, SearchSnippetDto[]>();
  if (!sessionIds.length) return bySession;
  const marks = sessionIds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT d.session_id,d.logical_record_id,d.logical_ordinal,d.side,
            highlight(session_search_fts,0,?,?) AS highlighted
     FROM session_search_fts
     JOIN session_search_documents d ON d.id=session_search_fts.rowid
     WHERE session_search_fts MATCH ? AND d.scope='dialogue' AND d.session_id IN (${marks})
     ORDER BY d.session_id,bm25(session_search_fts,1.0,1.0),d.logical_ordinal,d.id`,
  ).all(MARK_OPEN, MARK_CLOSE, match, ...sessionIds) as HighlightRow[];
  const documentCounts = new Map<number, number>();
  for (const row of rows) {
    const count = documentCounts.get(row.session_id) ?? 0;
    if (count >= 3) continue;
    documentCounts.set(row.session_id, count + 1);
    const current = bySession.get(row.session_id) ?? [];
    current.push(...highlightToSnippets(row));
    bySession.set(row.session_id, current.slice(0, 8));
  }
  return bySession;
}

interface MatchRange { start: number; end: number }

function highlightToSnippets(row: HighlightRow): SearchSnippetDto[] {
  const parsed = stripHighlight(row.highlighted);
  if (!parsed.ranges.length) return [];
  const groups: MatchRange[][] = [];
  for (const range of parsed.ranges) {
    const group = groups.at(-1);
    if (group && range.end - group[0]!.start <= 180) group.push(range);
    else groups.push([range]);
  }
  return groups.map((group) => {
    const first = group[0]!;
    const last = group.at(-1)!;
    const start = Math.max(0, first.start - 56);
    const end = Math.min(parsed.text.length, last.end + 80);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < parsed.text.length ? "…" : "";
    const text = prefix + parsed.text.slice(start, end) + suffix;
    return {
      logicalRecordId: row.logical_record_id,
      logicalOrdinal: row.logical_ordinal,
      side: row.side,
      text,
      matchStart: prefix.length + first.start - start,
      matchEnd: prefix.length + last.end - start,
    };
  });
}

function stripHighlight(highlighted: string): { text: string; ranges: MatchRange[] } {
  let text = "";
  const ranges: MatchRange[] = [];
  let index = 0;
  let open: number | null = null;
  for (const char of highlighted) {
    if (char === MARK_OPEN) {
      open = index;
    } else if (char === MARK_CLOSE) {
      if (open !== null) ranges.push({ start: open, end: index });
      open = null;
    } else {
      text += char;
      index++;
    }
  }
  return { text, ranges };
}

function toExecutedHit(row: SearchDatabaseRow, snippets: SearchSnippetDto[]): ExecutedSearchHit {
  return {
    session: toSessionItem(row),
    rank: Number(row.relevance_rank),
    snippets,
    compatibility: {
      id: Number(row.id),
      harness: String(row.harness),
      nativeId: String(row.native_id),
      title: row.effective_title,
      cwd: row.cwd,
      project: row.canonical_project_key ?? row.original_project_key,
      lastActivity: nullableNumber(row.last_activity),
      durationMs: nullableNumber(row.duration_ms),
      tokUser: Number(row.tok_user),
      tokAssistant: Number(row.tok_assistant),
      tokTool: Number(row.tok_tool),
      dialogueTurnCount: Number(row.dialogue_turn_count),
      modelsJson: row.models,
      chainId: nullableNumber(row.chain_id),
      favorite: !!row.favorite,
      engagement: nullableNumber(row.engagement),
      orphaned: Number(row.orphaned),
      origin: String(row.origin),
      originDetail: row.origin_detail,
      effectiveOrigin: row.effective_origin,
      classificationConfidence: nullableNumber(row.classification_confidence),
      classificationReason: row.classification_reason,
      classificationMethod: row.classification_method,
    },
  };
}

function toSessionItem(row: SearchDatabaseRow): SessionListItemDto {
  const titleEvidence = row.effective_title !== null && row.title_authority !== null && row.title_rule_version !== null
    ? {
        value: row.effective_title,
        authority: row.title_authority,
        harnessSourceClass: row.title_source_class,
        sourceRecordId: row.title_source_record_id,
        sourceReference: row.title_source_reference,
        sourceOrdinal: nullableNumber(row.title_source_ordinal),
        eligibilityRuleVersion: row.title_rule_version,
      }
    : null;
  return {
    sessionKey: { harness: row.harness as HarnessId, nativeId: row.native_id },
    surrogateId: Number(row.id),
    effectiveTitle: row.effective_title,
    titleEvidence,
    originalProjectKey: row.original_project_key,
    canonicalProjectKey: row.canonical_project_key,
    cwd: row.cwd,
    lastActivityTs: nullableNumber(row.last_activity),
    dialogueStartTs: nullableNumber(row.dialogue_start_ts),
    dialogueEndTs: nullableNumber(row.dialogue_end_ts),
    artifactKind: row.artifact_kind,
    historyCompleteness: row.history_completeness,
    sourceValidationStatus: row.source_validation_status,
    defaultSessionVisible: !!row.default_session_visible,
    constructionGeneration: row.construction_generation,
    metrics: {
      rawProvenanceRowCount: Number(row.raw_provenance_row_count),
      logicalRecordCount: Number(row.logical_record_count),
      rawToolActivityCount: Number(row.raw_tool_activity_count),
      logicalToolActivityCount: Number(row.logical_tool_activity_count),
      rawProseBearingRecordCount: Number(row.raw_prose_bearing_record_count),
      logicalProseBearingRecordCount: Number(row.logical_prose_bearing_record_count),
      dialogueTurnCount: Number(row.dialogue_turn_count),
      userDialogueTurnCount: Number(row.user_dialogue_turn_count),
      assistantDialogueTurnCount: Number(row.assistant_dialogue_turn_count),
      logicalReplayCount: Number(row.logical_replay_count),
      unknownIdentityRawRowCount: Number(row.unknown_identity_raw_row_count),
    },
    models: parseModels(row.models),
    favorite: !!row.favorite,
    chainStableKey: row.chain_stable_key,
  };
}

function parseModels(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null, fingerprint: string): SearchCursor | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SearchCursor>;
    if (
      parsed.v !== 1 || !Number.isFinite(parsed.rank) || !Number.isSafeInteger(parsed.activity)
      || !Number.isSafeInteger(parsed.sessionId) || parsed.sessionId! < 1
      || parsed.fingerprint !== fingerprint
    ) throw new Error("invalid cursor");
    return parsed as SearchCursor;
  } catch {
    throw new SearchQueryCompileError("Search cursor is invalid or belongs to another query");
  }
}

function failure(code: SearchErrorDto["code"], message: string): { ok: false; error: SearchErrorDto } {
  return { ok: false, error: { code, message, recoverable: true } };
}

function isFtsSyntaxError(error: unknown): boolean {
  return /fts5|unterminated|syntax error|malformed match|no such column/iu.test(safeError(error));
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
