/** Atlas library v1: source references never contain cache-local row IDs. */
export type SessionKey = { harness: string; nativeId: string; variant?: string };
export type Origin = "human_started" | "worker" | "mixed" | "unknown";
export type Role = "user" | "assistant" | "tool" | "system";
export type PassageRef = string;
export interface Boundary { observationId: string; bytes: number; at: number }
export interface SummaryCoverage { revision: string; covered: PassageRef[]; omitted: string[] }
export interface SourceObservation {
  id: string; sourceId: string; locator: string; objectHash: string;
  retainedBoundary: Boundary; indexedBoundary: Boundary | null;
  summaryCoverage: SummaryCoverage | null; lastCompleteReconciliation: number | null;
  format: string; gaps: string[];
  /** Verified identical/older-prefix copy indexed through an existing observation. Raw origin stays retained. */
  indexedVia?: string;
  admission?: { status: "excluded"; reason: string };
}
export interface Passage {
  ref: PassageRef; sessionKey: SessionKey; observationId: string; record: string;
  channel: string; startByte: number; endByte: number; textHash: string;
  text: string; role: Role; ordinal: number; timestamp: number | null;
}
export interface LibrarySession {
  key: SessionKey; revision: string; title: string; origin: Origin;
  originReason: string; models: string[]; cwd: string | null;
  updatedAt: number; passageCount: number; summary?: Interpretation | null;
}
export interface Interpretation {
  revision: string; overview: string; claims: Claim[];
  episodes: { title: string; claimIds: string[] }[];
  coverage: SummaryCoverage; model: string; createdAt: number;
  provenance: "validated" | "legacy-coverage-unverified" | "mock";
}
export interface Claim { id: string; text: string; kind: "question" | "proposal" | "decision" | "reversal" | "outcome" | "open_issue" | "topic"; refs: PassageRef[]; supersedes: string[] }
export interface SourceEntry {
  id: string; harness: string; root: string; enabled: boolean;
  capability: "live" | "import" | "unsupported"; reachable: boolean;
  error: string | null; lastCompleteReconciliation: number | null;
}
export interface QueryScope {
  view?: "conversations" | "direct" | "everything"; role?: Role;
  harness?: string; model?: string; since?: number; until?: number;
  path?: string; collection?: string; match?: "dialogue" | "title" | "summary" | "related";
}
export interface Coverage {
  sources: SourceEntry[]; observations: SourceObservation[]; scope: QueryScope;
  method: "literal" | "topic"; partial: boolean; limitations: string[];
  /** Global latest-per-source/locator totals, not counts inferred from samples. */
  totals?: { sources: number; sourceIssues: number; observations: number; indexedObservations: number; excludedObservations: number; observationIssues: number; limitations: number };
  samples?: {
    sources: { returned: number; truncated: boolean; nextCursor: string | null; detailRequiredIds: string[]; operation: "coverage.sources" };
    observations: { returned: number; truncated: boolean; nextCursor: string | null; detailRequiredIds: string[]; operation: "coverage.observations" };
    limitations: { returned: number; truncated: boolean; textTruncated: boolean };
    detailOperation: "coverage.detail";
  };
}
export interface CoverageRecordPage<T> {
  version: 1; kind: "sources" | "observations"; total: number;
  items: { id: string; record: T | null; bytes: number; detailRequired: boolean }[];
  nextCursor: string | null; detailOperation: "coverage.detail";
}
export interface SearchHit { session: LibrarySession; passage: Passage | null; match: string; rationale: string }
export interface SearchPage { version: 1; hits: SearchHit[]; nextCursor: string | null; coverage: Coverage; exhaustion: string | null }
export interface ReadPage { version: 1; session: LibrarySession; passages: Passage[]; nextCursor: string | null; coverage: Coverage }
export interface Favorite { id: string; sessionKey: SessionKey; refs: PassageRef[]; text: string; textHash: string; createdAt: number; note: string; unresolved?: boolean }
export interface ArtifactEvidence { id: string; sessionKey: SessionKey; ref: PassageRef; path: string; originalPath: string; kind: "mentioned" | "worked_on" | "creation_requested" | "creation_observed" | "cwd"; detail: string; certainty: "observed" | "claim" | "candidate" }
export interface Collection { id: string; title: string; sessionKeys: SessionKey[]; refs: PassageRef[]; hidden?: boolean; pinned?: boolean; provisional: boolean }
export interface CapturedSession { session: Omit<LibrarySession, "passageCount">; observation: SourceObservation; passages: Passage[]; artifacts?: ArtifactEvidence[] }
export interface LibraryReader {
  list(scope?: QueryScope, limit?: number, cursor?: string): { sessions: LibrarySession[]; nextCursor: string | null };
  session(key: SessionKey): LibrarySession | null;
  search(query: string, scope?: QueryScope, limit?: number, cursor?: string): SearchPage;
  read(key: SessionKey, limit?: number, cursor?: string): ReadPage;
  resolve(ref: PassageRef): { status: "current" | "pinned" | "unavailable"; passage: Passage | null; reason?: string };
  context(ref: PassageRef, before?: number, after?: number): ReadPage;
  streamCopy(key: SessionKey): Iterable<string>;
  sources(): SourceEntry[];
  coverage(scope?: QueryScope): Coverage;
  favorites(): Favorite[];
  collections(): Collection[];
}
