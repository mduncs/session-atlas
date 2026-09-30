import type { SessionOrigin } from "../adapters/types.js";
import type { SearchFilterDto, SearchRequestDto } from "../contracts/search.js";
import { compileFtsQuery, type SearchSyntax } from "../fts-query.js";
import { creatorFilterSql } from "../layers/creator-sql.js";

export type SessionStateFilter = "indexed" | "orphaned" | "summarized" | "unsummarized" | "pending" | "failed";
export type ChainFilter =
  | { mode: "chained" }
  | { mode: "standalone" }
  | { mode: "chain"; id: number };

export interface DateFilter {
  /** Inclusive epoch-millisecond lower bound. */
  from: number;
  /** Exclusive epoch-millisecond upper bound; null means unbounded. */
  to: number | null;
  label?: string;
}

/**
 * Compatibility input used by the existing list/TUI surface. Query text is
 * always ordinary literal syntax here; raw FTS5 is an explicit CLI/service
 * request and never inferred from punctuation.
 */
export interface ListFilter {
  query?: string | null;
  source?: string | null;
  /** @deprecated Wave 0 compatibility alias; new code uses `source`. */
  harness?: string | null;
  model?: string | null;
  path?: string | null;
  tag?: string | null;
  date?: DateFilter | null;
  favorite?: boolean | null;
  state?: SessionStateFilter | null;
  chain?: ChainFilter | null;
  origin?: SessionOrigin | null;
  /** Layer facet without its prefix (`design` means tag `facet:design`). */
  facet?: string | null;
  /** Layer detail tag (canonical identity); a parent also matches nested children. */
  layerTag?: string | null;
  /** Hide only source-proven agent runs, independently of topic classification. */
  hideAgentConversations?: boolean;
  /** @deprecated Wave 0 compatibility alias; new code uses `favorite`. */
  favoritesOnly?: boolean;
}

export type FilterTerm =
  | { kind: "query"; value: string }
  | { kind: "source"; value: string }
  | { kind: "model"; value: string }
  | { kind: "path"; value: string }
  | { kind: "tag"; value: string }
  | { kind: "date"; value: DateFilter }
  | { kind: "favorite"; value: boolean }
  | { kind: "state"; value: SessionStateFilter }
  | { kind: "chain"; value: ChainFilter }
  | { kind: "origin"; value: SessionOrigin }
  | { kind: "facet"; value: string }
  | { kind: "layerTag"; value: string };

export interface NormalizedSessionFilter {
  sources: string[];
  models: string[];
  projectKeys: string[];
  legacyPaths: string[];
  tags: string[];
  fromTs: number | null;
  toTsExclusive: number | null;
  favorite: boolean | null;
  artifactKinds: string[];
  sourceValidation: string[];
  chainStableKey: string | null;
  includeHidden: boolean;
  state: SessionStateFilter | null;
  chain: ChainFilter | null;
  origin: SessionOrigin | null;
  /** List-only provenance lens; absent and false both retain every origin. */
  hideAgentConversations?: boolean;
  /** Raw `layers.episode_tags` values (e.g. `facet:design`); each must match. */
  layerTags?: string[];
}

export interface CompiledSessionFilter {
  predicates: string[];
  params: Array<string | number>;
}

export interface CompiledSearchSelection {
  match: string;
  queryDisplay: string;
  syntax: SearchSyntax;
  filter: CompiledSessionFilter;
}

export function applyFilterTerm(filter: ListFilter, term: FilterTerm): ListFilter {
  switch (term.kind) {
    case "query": return { ...filter, query: term.value };
    case "source": return { ...filter, source: term.value, harness: null };
    case "model": return { ...filter, model: term.value };
    case "path": return { ...filter, path: term.value };
    case "tag": return { ...filter, tag: term.value };
    case "date": return { ...filter, date: { ...term.value } };
    case "favorite": return { ...filter, favorite: term.value, favoritesOnly: false };
    case "state": return { ...filter, state: term.value };
    case "chain": return { ...filter, chain: term.value };
    case "origin": return { ...filter, origin: term.value };
    case "facet": return { ...filter, facet: term.value, layerTag: null };
    case "layerTag": return { ...filter, layerTag: term.value };
  }
}

export function removeFilterTerm(filter: ListFilter, kind: FilterTerm["kind"]): ListFilter {
  const next = { ...filter };
  if (kind === "source") {
    delete next.source;
    delete next.harness;
  } else if (kind === "favorite") {
    delete next.favorite;
    delete next.favoritesOnly;
  } else if (kind === "facet") {
    // Detail tags are chosen inside a facet; clearing the facet clears both.
    delete next.facet;
    delete next.layerTag;
  } else {
    delete next[kind];
  }
  return next;
}

/** Stable cache/equality key independent of object insertion order and aliases. */
export function listFilterKey(filter: ListFilter): string {
  return JSON.stringify({
    query: filter.query || null,
    source: filter.source || filter.harness || null,
    model: filter.model || null,
    path: filter.path || null,
    tag: filter.tag || null,
    date: filter.date ? { from: filter.date.from, to: filter.date.to, label: filter.date.label ?? null } : null,
    favorite: filter.favorite ?? (filter.favoritesOnly ? true : null),
    state: filter.state ?? null,
    chain: filter.chain ?? null,
    origin: filter.origin ?? null,
    ...(filter.hideAgentConversations ? { hideAgentConversations: true } : {}),
    ...(filter.facet ? { facet: filter.facet } : {}),
    ...(filter.layerTag ? { layerTag: filter.layerTag } : {}),
  });
}

export function normalizeListFilter(filter: ListFilter): NormalizedSessionFilter {
  const source = filter.source || filter.harness;
  const favorite = filter.favorite ?? (filter.favoritesOnly ? true : null);
  return {
    sources: source ? [source] : [],
    models: filter.model ? [filter.model] : [],
    projectKeys: [],
    legacyPaths: filter.path ? [filter.path] : [],
    tags: filter.tag ? [filter.tag] : [],
    fromTs: filter.date?.from ?? null,
    toTsExclusive: filter.date?.to ?? null,
    favorite: favorite ?? null,
    artifactKinds: [],
    sourceValidation: [],
    chainStableKey: null,
    includeHidden: false,
    state: filter.state ?? null,
    chain: filter.chain ?? null,
    origin: filter.origin ?? null,
    hideAgentConversations: filter.hideAgentConversations === true,
    layerTags: [
      ...(filter.facet ? [`facet:${filter.facet}`] : []),
      ...(filter.layerTag ? [filter.layerTag] : []),
    ],
  };
}

export function normalizeSearchFilter(filter: SearchFilterDto): NormalizedSessionFilter {
  return {
    sources: unique(filter.sources),
    models: unique(filter.models),
    projectKeys: unique(filter.projectKeys),
    legacyPaths: [],
    tags: unique(filter.tags),
    fromTs: filter.fromTs,
    toTsExclusive: filter.toTsExclusive,
    favorite: filter.favorite,
    artifactKinds: unique(filter.artifactKinds),
    sourceValidation: unique(filter.sourceValidation),
    chainStableKey: filter.chainStableKey,
    includeHidden: filter.includeHidden,
    state: null,
    chain: null,
    origin: filter.origin ?? null,
  };
}

export function emptySearchFilter(): SearchFilterDto {
  return {
    sources: [],
    models: [],
    projectKeys: [],
    tags: [],
    fromTs: null,
    toTsExclusive: null,
    favorite: null,
    artifactKinds: [],
    sourceValidation: [],
    chainStableKey: null,
    includeHidden: false,
    origin: null,
  };
}

/**
 * Compile every non-query narrowing atom once. Search counts, ranked pages,
 * snippets, CLI, and TUI/list compatibility all consume this exact predicate
 * vector and parameter order.
 */
export function compileSessionFilter(
  filter: NormalizedSessionFilter,
  alias = "s",
  options: { semantic?: boolean } = { semantic: true },
): CompiledSessionFilter {
  const predicates: string[] = [];
  const params: Array<string | number> = [];
  const semantic = options.semantic !== false;

  if (semantic) {
    predicates.push(`${alias}.construction_status = 'valid'`);
    if (!filter.includeHidden) predicates.push(`${alias}.default_session_visible = 1`);
  }
  addIn(predicates, params, `${alias}.harness`, filter.sources);
  if (filter.models.length) {
    predicates.push(`EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(${alias}.models) THEN ${alias}.models ELSE '[]' END)
      WHERE CAST(value AS TEXT) IN (${placeholders(filter.models.length)})
    )`);
    params.push(...filter.models);
  }
  if (filter.projectKeys.length) {
    const marks = placeholders(filter.projectKeys.length);
    predicates.push(`(${alias}.canonical_project_key IN (${marks}) OR ${alias}.original_project_key IN (${marks}))`);
    params.push(...filter.projectKeys, ...filter.projectKeys);
  }
  if (filter.legacyPaths.length) {
    const marks = placeholders(filter.legacyPaths.length);
    predicates.push(`(${alias}.canonical_project_key IN (${marks}) OR ${alias}.original_project_key IN (${marks}) OR ${alias}.project IN (${marks}) OR ${alias}.cwd IN (${marks}))`);
    params.push(...filter.legacyPaths, ...filter.legacyPaths, ...filter.legacyPaths, ...filter.legacyPaths);
  }
  if (filter.tags.length) {
    predicates.push(`EXISTS (
      SELECT 1 FROM session_tags st JOIN tags t ON t.id=st.tag_id
      WHERE st.session_id=${alias}.id AND t.name IN (${placeholders(filter.tags.length)})
    )`);
    params.push(...filter.tags);
  }
  if (filter.fromTs !== null) {
    predicates.push(`${alias}.last_activity >= ?`);
    params.push(filter.fromTs);
  }
  if (filter.toTsExclusive !== null) {
    predicates.push(`${alias}.last_activity < ?`);
    params.push(filter.toTsExclusive);
  }
  if (filter.favorite !== null) {
    predicates.push(`${filter.favorite ? "" : "NOT "}EXISTS (
      SELECT 1 FROM favorites fav
      WHERE fav.harness=${alias}.harness AND fav.native_id=${alias}.native_id
    )`);
  }
  addIn(predicates, params, `${alias}.artifact_kind`, filter.artifactKinds);
  addIn(predicates, params, `${alias}.source_validation_status`, filter.sourceValidation);
  if (filter.chainStableKey !== null) {
    predicates.push(`EXISTS (SELECT 1 FROM chains fc WHERE fc.id=${alias}.chain_id AND fc.stable_key=?)`);
    params.push(filter.chainStableKey);
  }

  switch (filter.state) {
    case "indexed": predicates.push(`${alias}.orphaned = 0`); break;
    case "orphaned": predicates.push(`${alias}.orphaned = 1`); break;
    case "summarized":
      predicates.push(`EXISTS (SELECT 1 FROM summaries fs WHERE fs.session_id=${alias}.id AND fs.tier=1)`);
      break;
    case "unsummarized":
      predicates.push(`NOT EXISTS (SELECT 1 FROM summaries fs WHERE fs.session_id=${alias}.id AND fs.tier=1)`);
      break;
    case "pending":
      predicates.push(`EXISTS (SELECT 1 FROM jobs fj WHERE fj.session_id=${alias}.id AND fj.status='pending')`);
      break;
    case "failed":
      predicates.push(`EXISTS (SELECT 1 FROM jobs fj WHERE fj.session_id=${alias}.id AND fj.status='failed')`);
      break;
  }
  if (filter.chain?.mode === "chained") predicates.push(`${alias}.chain_id IS NOT NULL`);
  if (filter.chain?.mode === "standalone") predicates.push(`${alias}.chain_id IS NULL`);
  if (filter.chain?.mode === "chain") {
    predicates.push(`${alias}.chain_id = ?`);
    params.push(filter.chain.id);
  }
  if (filter.origin) {
    if (filter.origin === "human" || filter.origin === "agent" || filter.origin === "unknown") {
      predicates.push(creatorFilterSql(filter.origin, alias));
    } else {
      predicates.push(`${alias}.origin = ?`);
      params.push(filter.origin);
    }
  }
  if (filter.hideAgentConversations) {
    // Unknown provenance is not evidence of automation. In particular, a
    // technical human-led conversation can have an effective Agent topic label.
    predicates.push(`(${alias}.origin IS NULL OR ${alias}.origin <> 'agent')`);
  }
  for (const tag of filter.layerTags ?? []) {
    // Uncorrelated, so SQLite builds the matching key set once per statement.
    predicates.push(`(${alias}.harness, ${alias}.native_id) IN (
      WITH ${LAYER_DISPLAY_TAGS_CTE}
      SELECT harness, native_id FROM display_tags WHERE tag=? OR parent=?
    )`);
    params.push(tag, tag);
  }
  return { predicates, params };
}

/**
 * `display_tags(harness, native_id, episode, tag, parent)`: layer episode tags
 * as md sees them, after the newest `layers.tag_merges` decision per raw tag.
 * merge follows the chain to its final survivor (a merge into a demoted tag
 * follows the demote); demote folds a detail tag into its `facet:` target
 * (any other demote target hides it); nest keeps the tag and names its parent,
 * one level deep, with a merged parent resolved first; split/keep are as-is.
 * A parent's filter matches its nested children; a child's matches only itself.
 */
export const LAYER_DISPLAY_TAGS_CTE = `tag_decision AS (
  SELECT from_tag, to_tag, action FROM (
    SELECT m.from_tag, m.to_tag, m.action,
      ROW_NUMBER() OVER (PARTITION BY m.from_tag ORDER BY m.created_at DESC, m.rowid DESC) AS rn
    FROM layers.tag_merges m
  ) WHERE rn=1
),
merge_chain(from_tag, to_tag, depth) AS (
  SELECT from_tag, to_tag, 1 FROM tag_decision WHERE action='merge'
  UNION ALL
  SELECT c.from_tag, d.to_tag, c.depth + 1 FROM merge_chain c
  JOIN tag_decision d ON d.from_tag=c.to_tag AND d.action='merge'
  WHERE c.depth < 8
),
merge_final AS (
  SELECT from_tag, to_tag FROM (
    SELECT from_tag, to_tag, ROW_NUMBER() OVER (PARTITION BY from_tag ORDER BY depth DESC) AS rn FROM merge_chain
  ) WHERE rn=1
),
canonical_tags AS (
  SELECT et.harness, et.native_id, et.episode,
    CASE WHEN dm.action='demote' THEN dm.to_tag ELSE COALESCE(mf.to_tag, et.tag) END AS tag
  FROM layers.episode_tags et
  LEFT JOIN merge_final mf ON mf.from_tag=et.tag
  LEFT JOIN tag_decision dm ON dm.from_tag=COALESCE(mf.to_tag, et.tag) AND dm.action='demote'
  WHERE dm.action IS NULL OR dm.to_tag LIKE 'facet:%'
),
display_tags AS (
  SELECT DISTINCT c.harness, c.native_id, c.episode, c.tag,
    CASE WHEN n.action='nest' THEN COALESCE(pm.to_tag, n.to_tag) END AS parent
  FROM canonical_tags c
  LEFT JOIN tag_decision n ON n.from_tag=c.tag AND n.action='nest'
  LEFT JOIN merge_final pm ON pm.from_tag=n.to_tag
)`;

export function compileSearchSelection(
  request: Pick<SearchRequestDto, "query" | "syntax">,
  filter: NormalizedSessionFilter,
  alias = "s",
): CompiledSearchSelection {
  const compiledQuery = compileFtsQuery(request.query, request.syntax);
  return {
    match: compiledQuery.match,
    queryDisplay: compiledQuery.display,
    syntax: request.syntax,
    filter: compileSessionFilter(filter, alias, { semantic: true }),
  };
}

export function searchFilterFingerprint(filter: NormalizedSessionFilter): string {
  return JSON.stringify({
    sources: filter.sources,
    models: filter.models,
    projectKeys: filter.projectKeys,
    legacyPaths: filter.legacyPaths,
    tags: filter.tags,
    fromTs: filter.fromTs,
    toTsExclusive: filter.toTsExclusive,
    favorite: filter.favorite,
    artifactKinds: filter.artifactKinds,
    sourceValidation: filter.sourceValidation,
    chainStableKey: filter.chainStableKey,
    includeHidden: filter.includeHidden,
    state: filter.state,
    chain: filter.chain,
    origin: filter.origin,
    ...(filter.layerTags?.length ? { layerTags: filter.layerTags } : {}),
  });
}

function addIn(predicates: string[], params: Array<string | number>, expression: string, values: readonly string[]): void {
  if (!values.length) return;
  predicates.push(`${expression} IN (${placeholders(values.length)})`);
  params.push(...values);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
