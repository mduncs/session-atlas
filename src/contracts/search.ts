/** Frozen search/TUI read seam for Phase 4 and Phase 5. */
import type {
  ArtifactKind,
  ConstructionMetricsDto,
  HistoryCompleteness,
  RecordKind,
  SessionKey,
  SourceValidationStatus,
  TitleEvidenceDto,
  ToolActivityDto,
} from "./construction.js";
import type { OriginLens } from "../adapters/types.js";

export interface SessionListItemDto {
  sessionKey: SessionKey;
  surrogateId: number;
  effectiveTitle: string | null;
  titleEvidence: TitleEvidenceDto | null;
  originalProjectKey: string | null;
  canonicalProjectKey: string | null;
  cwd: string | null;
  lastActivityTs: number | null;
  dialogueStartTs: number | null;
  dialogueEndTs: number | null;
  artifactKind: ArtifactKind;
  historyCompleteness: HistoryCompleteness;
  sourceValidationStatus: SourceValidationStatus;
  defaultSessionVisible: boolean;
  constructionGeneration: string;
  metrics: ConstructionMetricsDto;
  models: string[];
  favorite: boolean;
  chainStableKey: string | null;
}

export interface DialogueTurnDto {
  logicalRecordId: number;
  logicalOrdinal: number;
  rawRepresentativeOrdinal: number;
  side: "user" | "assistant";
  recordKind: "real_user" | "assistant_dialogue_prose";
  prose: string;
  eventTs: number | null;
  replayCount: number;
  toolActivities: ToolActivityDto[];
  constructionGeneration: string;
}

export interface ActivityRecordDto {
  logicalRecordId: number;
  logicalOrdinal: number;
  recordKind: RecordKind;
  prose: string | null;
  eventTs: number | null;
  replayCount: number;
  toolActivities: ToolActivityDto[];
  constructionGeneration: string;
}

export interface SessionTranscriptDto {
  session: SessionListItemDto;
  dialogue: DialogueTurnDto[];
  activity: ActivityRecordDto[];
  diagnostic: string | null;
}

export interface SearchFilterDto {
  sources: string[];
  models: string[];
  projectKeys: string[];
  tags: string[];
  fromTs: number | null;
  toTsExclusive: number | null;
  favorite: boolean | null;
  artifactKinds: ArtifactKind[];
  sourceValidation: SourceValidationStatus[];
  chainStableKey: string | null;
  includeHidden: boolean;
  /** Effective Human/Agent lens; mixed/unknown remain raw provenance filters. */
  origin?: OriginLens | null;
}

export interface SearchRequestDto {
  query: string;
  syntax: "literal" | "raw_fts5";
  filters: SearchFilterDto;
  pageSize: number;
  cursor: string | null;
}

export interface SearchSnippetDto {
  logicalRecordId: number;
  logicalOrdinal: number;
  side: "user" | "assistant";
  text: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchHitDto {
  session: SessionListItemDto;
  rank: number;
  snippets: SearchSnippetDto[];
}

export interface SearchPageDto {
  hits: SearchHitDto[];
  total: number;
  nextCursor: string | null;
  queryDisplay: string;
}

export type SearchErrorCode = "invalid_query" | "schema_not_ready" | "query_failed";
export interface SearchErrorDto {
  code: SearchErrorCode;
  message: string;
  recoverable: boolean;
}

export type SearchResultDto =
  | { ok: true; page: SearchPageDto }
  | { ok: false; error: SearchErrorDto };

/** Phase 4 owns the sole implementation; CLI and TUI consume this interface. */
export interface SessionSearchService {
  search(request: SearchRequestDto): SearchResultDto;
  transcript(sessionKey: SessionKey): SessionTranscriptDto;
}
