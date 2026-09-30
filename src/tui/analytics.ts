import type { DB } from "../db/index.js";
import { compileListFilter, type ListFilter } from "./queries.js";
import { sessionKey, type SessionKey, type SessionRow } from "./domain.js";
import { effectiveSessionOriginSql } from "../human-classifier.js";
import { DISPLAY_TAGS_CTE, FACET_PREFIX } from "./layer-tags.js";

export interface CountDatum {
  label: string;
  count: number;
}

/** A layer detail tag; `parent` is set for a nested child shown under its parent. */
export interface LayerTagDatum extends CountDatum {
  parent: string | null;
}

export interface SourceDatum extends CountDatum {
  source: string;
  ageMs: number | null;
  reachable: boolean | null;
}

export interface SizeBucket extends CountDatum {
  key: "lt8k" | "8k-32k" | "32k-96k" | "96k+";
}

export interface DashboardEvent {
  id: string;
  at: number;
  kind: "error" | "summary" | "ingest";
  label: string;
}

export interface SummarizerTelemetry {
  queue: number;
  completedLastHour: number;
  ratePerMinute: number;
  failures: number;
  provider: string | null;
}

export interface DashboardAnalytics {
  /** The whole archive, even while the list is narrowed by filters. */
  corpusSessionCount: number;
  /** Sessions matching the current list filter. */
  visibleSessionCount: number;
  hasEverIngested: boolean;
  sources: SourceDatum[];
  /** Strict human/agent classification inside the current filter. */
  origins?: CountDatum[];
  states: {
    summarized: number;
    pending: number;
    orphaned: number;
    favorite: number;
  };
  tags: CountDatum[];
  /** Sessions per layer facet (without the `facet:` prefix), under every other filter. */
  facets?: CountDatum[];
  /** The active facet's top detail tags after merges; empty without a facet. */
  layerTags?: LayerTagDatum[];
  models: CountDatum[];
  sizes: SizeBucket[];
  ingest: {
    sessionsPerSecond: number | null;
    hourlySessions: number[];
  };
  summarizer: SummarizerTelemetry;
  errorCount: number;
  events: DashboardEvent[];
}

export interface DashboardRowState {
  orphaned: boolean;
  summary: "summarized" | "pending";
  failed: boolean;
  /** The session's most frequent layer facet, when a labelling pass tagged it. */
  facet?: string | null;
}

/**
 * Cheap first-paint telemetry for file-backed archives. The worker replaces
 * this shell with a complete snapshot after opening its own read-only SQLite
 * connection; no whole-corpus aggregation delays the interactive thread.
 */
export function readDashboardAnalyticsPlaceholder(db: DB): DashboardAnalytics {
  const corpusSessionCount = count(db, `SELECT COUNT(*) n FROM sessions`);
  return {
    corpusSessionCount,
    visibleSessionCount: corpusSessionCount,
    hasEverIngested: corpusSessionCount > 0,
    sources: [],
    origins: [],
    states: { summarized: 0, pending: 0, orphaned: 0, favorite: 0 },
    tags: [],
    facets: [],
    layerTags: [],
    models: [],
    sizes: [
      { key: "lt8k", label: "<8k", count: 0 },
      { key: "8k-32k", label: "8–32k", count: 0 },
      { key: "32k-96k", label: "32–96k", count: 0 },
      { key: "96k+", label: "96k+", count: 0 },
    ],
    ingest: { sessionsPerSecond: null, hourlySessions: Array.from({ length: 12 }, () => 0) },
    summarizer: { queue: 0, completedLastHour: 0, ratePerMinute: 0, failures: 0, provider: null },
    errorCount: 0,
    events: [],
  };
}

interface FilteredSql {
  cte: string;
  params: Array<string | number>;
}

function filteredSql(filter: ListFilter): FilteredSql {
  const compiled = compileListFilter(filter);
  const predicates = compiled.predicates.length ? `AND ${compiled.predicates.join(" AND ")}` : "";
  return {
    // compileListFilter's only join is a session-id GROUP BY projection, so it
    // cannot multiply sessions. DISTINCT here forced every analytics query to
    // materialize the entire wide sessions table on each refresh.
    cte: `WITH filtered AS (
      SELECT s.* FROM sessions s
      ${compiled.joins.join("\n")}
      WHERE 1=1 ${predicates}
    )`,
    params: [...compiled.joinParams, ...compiled.predicateParams],
  };
}

function count(db: DB, sql: string, ...params: Array<string | number>): number {
  return Number((db.prepare(sql).get(...params) as { n: number } | null)?.n ?? 0);
}

function shortModelName(raw: string): string {
  const value = raw.trim();
  if (!value) return "unknown";
  return value
    .replace(/^claude-/, "")
    .replace(/-(?:20\d{6}|latest)$/i, "")
    .replace(/^deepseek-/, "")
    .replace(/^openai\//, "");
}

function mergedCounts(rows: Array<{ label: string; count: number }>, limit: number): CountDatum[] {
  const merged = new Map<string, number>();
  for (const row of rows) {
    const label = shortModelName(row.label);
    merged.set(label, (merged.get(label) ?? 0) + Number(row.count));
  }
  return [...merged.entries()]
    .map(([label, value]) => ({ label, count: value }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/**
 * Read every permanent dashboard instrument from SQLite. Prototype values
 * never enter this layer; absent evidence stays zero, null, or an empty list.
 */
export function readDashboardAnalytics(
  db: DB,
  filter: ListFilter = {},
  now = Date.now(),
): DashboardAnalytics {
  const filtered = filteredSql(filter);
  const corpusSessionCount = count(db, `SELECT COUNT(*) n FROM sessions`);
  const visibleSessionCount = count(
    db,
    `${filtered.cte} SELECT COUNT(*) n FROM filtered`,
    ...filtered.params,
  );
  const hasEverIngested = count(db, `SELECT COUNT(*) n FROM ingest_runs`) > 0;

  const sourceCounts = db.prepare(
    `${filtered.cte}
     SELECT harness AS source, COUNT(*) AS count
     FROM filtered GROUP BY harness ORDER BY count DESC, harness`,
  ).all(...filtered.params) as Array<{ source: string; count: number }>;
  const freshnessRows = db.prepare(
    `SELECT r.source, r.finished_at, r.reachable
     FROM ingest_runs r
     JOIN (
       SELECT source, MAX(id) id FROM ingest_runs GROUP BY source
     ) latest ON latest.id=r.id
     ORDER BY r.source`,
  ).all() as Array<{ source: string; finished_at: number | null; reachable: number }>;
  const freshness = new Map(freshnessRows.map((row) => [row.source, row]));
  const knownSources = new Set([
    ...sourceCounts.map((row) => row.source),
    ...freshnessRows.map((row) => row.source),
  ]);
  const sources: SourceDatum[] = [...knownSources]
    .map((source) => {
      const amount = sourceCounts.find((row) => row.source === source)?.count ?? 0;
      const fresh = freshness.get(source);
      return {
        source,
        label: source,
        count: Number(amount),
        ageMs: fresh?.finished_at == null ? null : Math.max(0, now - fresh.finished_at),
        reachable: fresh ? fresh.reachable > 0 : null,
      };
    })
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));

  // Creator rail rows are choices: count each lens under every other filter.
  const lens = filter.origin == null ? filtered : filteredSql({ ...filter, origin: null });
  const originRows = db.prepare(
    `${lens.cte}
     SELECT ${effectiveSessionOriginSql("filtered")} AS label, COUNT(*) AS count
     FROM filtered GROUP BY label`,
  ).all(...lens.params) as Array<{ label: string; count: number }>;
  const originCounts = new Map(originRows.map((row) => [row.label, Number(row.count)]));
  const origins: CountDatum[] = ["human", "agent", "unknown"].map((label) => ({
    label,
    count: originCounts.get(label) ?? 0,
  }));

  const states = db.prepare(
    `${filtered.cte}
     SELECT
       SUM(CASE WHEN EXISTS (
         SELECT 1 FROM summaries sm WHERE sm.session_id=filtered.id AND sm.tier=1
       ) THEN 1 ELSE 0 END) AS summarized,
       SUM(CASE WHEN NOT EXISTS (
         SELECT 1 FROM summaries sm WHERE sm.session_id=filtered.id AND sm.tier=1
       ) THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN orphaned=1 THEN 1 ELSE 0 END) AS orphaned,
       SUM(CASE WHEN EXISTS (
         SELECT 1 FROM favorites fav
         WHERE fav.harness=filtered.harness AND fav.native_id=filtered.native_id
       ) THEN 1 ELSE 0 END) AS favorite
     FROM filtered`,
  ).get(...filtered.params) as Record<string, number | null> | null;

  // Drive promoted tags through the tag_id index. Without INDEXED BY, SQLite
  // chooses a repeated full session_tags scan on the live corpus.
  const tags = (db.prepare(
    `${filtered.cte}
     SELECT t.name AS label, COUNT(*) AS count
     FROM tags t
     JOIN session_tags st INDEXED BY idx_session_tags_tag ON st.tag_id=t.id
     WHERE t.promoted_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM filtered WHERE filtered.id=st.session_id)
     GROUP BY t.id, t.name ORDER BY count DESC, t.name LIMIT 7`,
  ).all(...filtered.params) as Array<{ label: string; count: number }>).map((row) => ({
    label: row.label,
    count: Number(row.count),
  }));

  const { facets, layerTags } = readLayerTagCounts(db, filter);

  const rawModels = db.prepare(
    `${filtered.cte}
     SELECT CAST(j.value AS TEXT) AS label, COUNT(*) AS count
     FROM filtered
     JOIN json_each(CASE WHEN json_valid(filtered.models) THEN filtered.models ELSE '[]' END) j
     GROUP BY CAST(j.value AS TEXT) ORDER BY count DESC`,
  ).all(...filtered.params) as Array<{ label: string; count: number }>;
  const models = mergedCounts(rawModels, 6);

  const sizeRow = db.prepare(
    `${filtered.cte}
     SELECT
       SUM(CASE WHEN tok_user+tok_assistant+tok_tool < 8000 THEN 1 ELSE 0 END) lt8k,
       SUM(CASE WHEN tok_user+tok_assistant+tok_tool >= 8000 AND tok_user+tok_assistant+tok_tool < 32000 THEN 1 ELSE 0 END) mid,
       SUM(CASE WHEN tok_user+tok_assistant+tok_tool >= 32000 AND tok_user+tok_assistant+tok_tool < 96000 THEN 1 ELSE 0 END) large,
       SUM(CASE WHEN tok_user+tok_assistant+tok_tool >= 96000 THEN 1 ELSE 0 END) huge
     FROM filtered`,
  ).get(...filtered.params) as Record<string, number | null> | null;
  const sizes: SizeBucket[] = [
    { key: "lt8k", label: "<8k", count: Number(sizeRow?.lt8k ?? 0) },
    { key: "8k-32k", label: "8–32k", count: Number(sizeRow?.mid ?? 0) },
    { key: "32k-96k", label: "32–96k", count: Number(sizeRow?.large ?? 0) },
    { key: "96k+", label: "96k+", count: Number(sizeRow?.huge ?? 0) },
  ];

  const dayAgo = now - 86_400_000;
  const ingestRuns = db.prepare(
    `SELECT id, source, started_at, finished_at, sessions_seen, reachable, error
     FROM ingest_runs WHERE finished_at >= ? ORDER BY finished_at`,
  ).all(dayAgo) as Array<{
    id: number;
    source: string;
    started_at: number;
    finished_at: number;
    sessions_seen: number;
    reachable: number;
    error: string | null;
  }>;
  // Runs open a row unfinished; one older than two hours was interrupted, not running.
  const ingesting = db.prepare(
    `SELECT 1 FROM ingest_runs WHERE finished_at IS NULL AND started_at >= ? LIMIT 1`,
  ).get(now - 7_200_000) !== null;
  const hourlySessions = Array.from({ length: 12 }, () => 0);
  let scannedSessions = 0;
  let scanMs = 0;
  for (const run of ingestRuns) {
    const bucket = Math.max(0, Math.min(11, Math.floor((run.finished_at - dayAgo) / 7_200_000)));
    hourlySessions[bucket] = (hourlySessions[bucket] ?? 0) + Number(run.sessions_seen);
    if (run.reachable) {
      scannedSessions += Number(run.sessions_seen);
      scanMs += Math.max(0, run.finished_at - run.started_at);
    }
  }

  const summarizerRow = db.prepare(
    `SELECT
       SUM(CASE WHEN status='pending' AND kind IN ('tier1','tier2') THEN 1 ELSE 0 END) queue,
       SUM(CASE WHEN status='done' AND kind IN ('tier1','tier2') AND updated_at >= ? THEN 1 ELSE 0 END) completed,
       SUM(CASE WHEN kind IN ('tier1','tier2') AND
         (status='failed' OR (status='pending' AND last_error IS NOT NULL)) THEN 1 ELSE 0 END) failures
     FROM jobs`,
  ).get(now - 3_600_000) as Record<string, number | null> | null;
  const providerRow = db.prepare(
    `SELECT provider FROM jobs WHERE provider IS NOT NULL AND provider != ''
     ORDER BY updated_at DESC, id DESC LIMIT 1`,
  ).get() as { provider: string } | null;
  const completedLastHour = Number(summarizerRow?.completed ?? 0);
  const failures = Number(summarizerRow?.failures ?? 0);

  // Only roots the latest finished reconciliation still walks can be in error; a root dropped
  // from the config (or a disabled source) keeps its last failed run forever otherwise.
  const latestIngestErrors = count(
    db,
    `WITH plan AS (
       SELECT rs.source, rr.root FROM reconciliation_roots rr
       JOIN reconciliation_sources rs ON rs.id=rr.reconciliation_source_id
       WHERE rs.group_id=(SELECT MAX(id) FROM reconciliation_groups WHERE finished_at IS NOT NULL)
     )
     SELECT COUNT(*) n FROM ingest_runs r
     JOIN (SELECT source, root, MAX(id) id FROM ingest_runs GROUP BY source, root) latest
       ON latest.id=r.id
     WHERE r.error IS NOT NULL
       AND (NOT EXISTS (SELECT 1 FROM plan) OR EXISTS (SELECT 1 FROM plan p WHERE p.source=r.source AND p.root=r.root))`,
  );
  const errorCount = failures + latestIngestErrors;

  const jobEvents = db.prepare(
    `SELECT id, kind, session_id, status, updated_at, provider, last_error
     FROM jobs WHERE updated_at IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT 8`,
  ).all() as Array<{
    id: number;
    kind: string;
    session_id: number | null;
    status: string;
    updated_at: number;
    provider: string | null;
    last_error: string | null;
  }>;
  const events: DashboardEvent[] = [
    ...ingestRuns.slice(-8).map((run) => ({
      id: `ingest:${run.id}`,
      at: run.finished_at,
      kind: run.error ? "error" as const : "ingest" as const,
      label: run.error
        ? `${run.source} ${run.error}`
        : `ingest ${run.source} +${run.sessions_seen}`,
    })),
    ...jobEvents.map((job) => ({
      id: `job:${job.id}`,
      at: job.updated_at,
      kind: job.last_error && job.status !== "done" ? "error" as const : "summary" as const,
      label: job.last_error && job.status !== "done"
        ? `${job.kind} ${job.last_error}`
        : `${job.kind} ${job.session_id ?? job.status}${job.provider ? ` ${job.provider}` : ""}`,
    })),
  ].sort((a, b) => b.at - a.at).slice(0, 6);

  return {
    corpusSessionCount,
    visibleSessionCount,
    hasEverIngested,
    sources,
    origins,
    states: {
      summarized: Number(states?.summarized ?? 0),
      pending: Number(states?.pending ?? 0),
      orphaned: Number(states?.orphaned ?? 0),
      favorite: Number(states?.favorite ?? 0),
    },
    tags,
    facets,
    layerTags,
    models,
    sizes,
    ingest: {
      // The day's scan throughput, shown only while a run is open: an idle
      // archive reads "idle", not a stale rate that looks live.
      sessionsPerSecond: ingesting && scanMs > 0 ? scannedSessions / (scanMs / 1000) : null,
      hourlySessions,
    },
    summarizer: {
      queue: Number(summarizerRow?.queue ?? 0),
      completedLastHour,
      ratePerMinute: completedLastHour / 60,
      failures,
      provider: providerRow?.provider ?? null,
    },
    errorCount,
    events,
  };
}

/**
 * Facet choices count sessions under every filter except the layer lens
 * itself. Detail tags co-occur with the active facet on the same episode and
 * count sessions exactly as the list filter will; a parent counts its nested
 * children, and the parent in focus (the active tag or the active child's
 * parent) lists its children right after it.
 * A layers schema without episode tags reads as empty.
 */
function readLayerTagCounts(db: DB, filter: ListFilter): { facets: CountDatum[]; layerTags: LayerTagDatum[] } {
  const session = "harness || char(0) || native_id";
  try {
    const lens = filteredSql({ ...filter, facet: null, layerTag: null });
    const facets = (db.prepare(
      `${lens.cte}, ${DISPLAY_TAGS_CTE}
       SELECT substr(tag, ${FACET_PREFIX.length + 1}) AS label, COUNT(DISTINCT ${session}) AS count
       FROM display_tags
       WHERE tag LIKE '${FACET_PREFIX}%' AND (harness, native_id) IN (SELECT harness, native_id FROM filtered)
       GROUP BY label ORDER BY count DESC, label`,
    ).all(...lens.params) as Array<{ label: string; count: number }>).map((row) => ({ label: row.label, count: Number(row.count) }));
    if (!filter.facet) return { facets, layerTags: [] };

    const scoped = filteredSql({ ...filter, layerTag: null });
    const rows = db.prepare(
      `${scoped.cte}, ${DISPLAY_TAGS_CTE},
       facet_episodes AS (
         SELECT DISTINCT harness, native_id, episode FROM display_tags WHERE tag=?
       ),
       -- Membership is episode-level: a tag belongs to the facet it shares an episode with.
       members AS (
         SELECT DISTINCT dt.tag, dt.parent
         FROM display_tags dt
         JOIN facet_episodes fe ON fe.harness=dt.harness AND fe.native_id=dt.native_id AND fe.episode=dt.episode
         WHERE dt.tag NOT LIKE '${FACET_PREFIX}%'
       ),
       -- Counts are session-level, exactly what the list shows once the tag is clicked.
       visible AS (
         SELECT DISTINCT harness, native_id, tag, parent FROM display_tags
         WHERE (harness, native_id) IN (SELECT harness, native_id FROM filtered)
       )
       SELECT r.label, NULL AS parent, COUNT(DISTINCT ${session}) AS count
       FROM (SELECT DISTINCT COALESCE(parent, tag) AS label FROM members) r
       JOIN visible v ON v.tag=r.label OR v.parent=r.label
       GROUP BY r.label
       UNION ALL
       SELECT m.tag AS label, m.parent, COUNT(DISTINCT ${session}) AS count
       FROM members m JOIN visible v ON v.tag=m.tag
       WHERE m.parent IS NOT NULL GROUP BY m.parent, m.tag`,
    ).all(...scoped.params, `${FACET_PREFIX}${filter.facet}`) as Array<{ label: string; parent: string | null; count: number }>;
    const ranked = rows.filter((row) => row.parent === null).sort((a, b) => Number(b.count) - Number(a.count) || a.label.localeCompare(b.label));
    const children = rows.filter((row) => row.parent !== null);
    const activeChild = children.find((row) => row.label === filter.layerTag);
    const focus = activeChild?.parent ?? filter.layerTag ?? null;
    // The top eight, plus the tag in focus when it ranks lower.
    const roots = ranked.slice(0, 8);
    const focused = ranked.slice(8).find((row) => row.label === focus);
    if (focused) roots.push(focused);
    const layerTags: LayerTagDatum[] = [];
    for (const root of roots) {
      layerTags.push({ label: root.label, count: Number(root.count), parent: null });
      if (root.label !== focus) continue;
      for (const child of children.filter((row) => row.parent === root.label).sort((a, b) => Number(b.count) - Number(a.count) || a.label.localeCompare(b.label))) {
        layerTags.push({ label: child.label, count: Number(child.count), parent: root.label });
      }
    }
    return { facets, layerTags };
  } catch {
    return { facets: [], layerTags: [] };
  }
}

/** Fetch state markers only for rows the viewport is about to render. */
export function readDashboardRowStates(
  db: DB,
  rows: readonly Pick<SessionRow, "id" | "harness" | "native_id">[],
): ReadonlyMap<SessionKey, DashboardRowState> {
  if (rows.length === 0) return new Map();
  const ids = [...new Set(rows.map((row) => row.id))];
  const placeholders = ids.map(() => "?").join(",");
  // db.query caches by SQL text: a viewport has a handful of arities, while a
  // per-frame prepare compiles a new statement that waits on GC to finalize.
  const stateRows = db.query(
    `SELECT s.id, s.harness, s.native_id, s.orphaned,
       EXISTS(SELECT 1 FROM summaries sm WHERE sm.session_id=s.id AND sm.tier=1) summarized,
       EXISTS(SELECT 1 FROM jobs j WHERE j.session_id=s.id AND
         (j.status='failed' OR (j.status='pending' AND j.last_error IS NOT NULL))) failed
     FROM sessions s WHERE s.id IN (${placeholders})`,
  ).all(...ids) as Array<{
    id: number;
    harness: string;
    native_id: string;
    orphaned: number;
    summarized: number;
    failed: number;
  }>;
  const facets = readRowFacets(db, stateRows);
  return new Map(stateRows.map((row) => {
    const facet = facets.get(sessionKey(row));
    return [sessionKey(row), {
      orphaned: row.orphaned > 0,
      summary: row.summarized > 0 ? "summarized" : "pending",
      failed: row.failed > 0,
      ...(facet ? { facet } : {}),
    }];
  }));
}

/**
 * Viewport-bounded primary-key probes of `layers.episode_tags`; a session's
 * facet is the one most of its episodes carry. No layers reads as no facet.
 */
function readRowFacets(db: DB, rows: readonly Pick<SessionRow, "harness" | "native_id">[]): Map<SessionKey, string> {
  const result = new Map<SessionKey, string>();
  if (rows.length === 0) return result;
  let tagged: Array<{ harness: string; native_id: string; facet: string; n: number }>;
  try {
    tagged = db.query(
      `SELECT harness, native_id, substr(tag, ${FACET_PREFIX.length + 1}) AS facet, COUNT(*) AS n
       FROM layers.episode_tags
       WHERE (harness, native_id) IN (VALUES ${rows.map(() => "(?,?)").join(",")}) AND tag LIKE '${FACET_PREFIX}%'
       GROUP BY harness, native_id, tag ORDER BY n DESC, facet`,
    ).all(...rows.flatMap((row) => [row.harness, row.native_id])) as typeof tagged;
  } catch {
    return result;
  }
  for (const row of tagged) {
    const key = sessionKey(row);
    if (!result.has(key)) result.set(key, row.facet);
  }
  return result;
}
