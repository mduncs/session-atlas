/**
 * Stable list-domain contracts shared by the query, store, and future Ink
 * component layers. Database ids remain useful locators inside one index, but
 * operator state is keyed by the source identity that survives a rebuild.
 */

import type { SessionOrigin } from "../adapters/types.js";

export type SessionKey = string;
export type ChainId = number;
export type ProjectedRowKey = string;

export interface SessionRow {
  id: number;
  harness: string;
  native_id: string;
  title: string | null;
  firstUser: string | null;
  cwd: string | null;
  project: string | null;
  last_activity: number | null;
  duration_ms: number | null;
  tok_user: number;
  tok_assistant: number;
  tok_tool: number;
  tok_total: number;
  msg_count: number;
  models: string | null;
  chain_id: number | null;
  favorite: number;
  sizePct: number;
  engagement: number | null;
  /** Persisted source-loss marker; optional on synthetic/golden rows. */
  orphaned?: number;
  /** Deterministic creator provenance derived from harness metadata. */
  origin?: SessionOrigin;
  origin_detail?: string | null;
  /** Creator lens: md's correction, then the evidence layer; `unknown` shows as `?`. */
  effective_origin?: "human" | "agent" | "unknown";
  classification_confidence?: number | null;
  classification_reason?: string | null;
  classification_method?: string | null;
}

/** JSON tuple encoding is unambiguous even when a native id contains `:`. */
export function sessionKey(session: Pick<SessionRow, "harness" | "native_id">): SessionKey {
  return JSON.stringify([session.harness, session.native_id]);
}

export function parseSessionKey(key: SessionKey): { harness: string; nativeId: string } | null {
  try {
    const value: unknown = JSON.parse(key);
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [harness, nativeId] = value;
    return typeof harness === "string" && typeof nativeId === "string" ? { harness, nativeId } : null;
  } catch {
    return null;
  }
}

/**
 * A Set with a deliberately wide `has` signature. The old renderer can keep
 * asking about numeric row coordinates during Wave 0, but they never match:
 * only stable SessionKey strings can enter this collection.
 */
export class SessionSelection extends Set<SessionKey> {
  override has(value: unknown): boolean {
    return typeof value === "string" && super.has(value);
  }

  override delete(value: unknown): boolean {
    return typeof value === "string" && super.delete(value);
  }

  clone(): SessionSelection {
    return new SessionSelection(this);
  }
}

export type DateCluster = "today" | "yesterday" | "this-week" | `month:${string}` | "unknown";

export interface ClusterProjection {
  kind: "cluster";
  /**
   * A cluster may occur more than once when search rank interleaves dates.
   * Keep the first occurrence's historical key, then suffix later runs so the
   * projection index and interaction registry never see duplicate identities.
   */
  key: ProjectedRowKey;
  cluster: DateCluster;
  label: string;
}

export interface SessionProjection {
  kind: "session";
  key: SessionKey;
  session: SessionRow;
  chainId: ChainId | null;
  nested: boolean;
}

export interface ChainProjection {
  kind: "chain";
  key: string;
  chainId: ChainId;
  head: SessionRow;
  members: readonly SessionRow[];
  expanded: boolean;
  aggregate: {
    memberCount: number;
    tokTotal: number;
    msgCount: number;
    firstActivity: number | null;
    lastActivity: number | null;
    favoriteCount: number;
  };
}

export type ProjectedListRow = ClusterProjection | SessionProjection | ChainProjection;

function dayStart(timestamp: number): number {
  const d = new Date(timestamp);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function dateCluster(timestamp: number | null, now = Date.now()): DateCluster {
  if (timestamp === null) return "unknown";
  const today = dayStart(now);
  const target = dayStart(timestamp);
  if (target === today) return "today";
  if (target === today - 86_400_000) return "yesterday";

  const todayDate = new Date(today);
  const mondayOffset = (todayDate.getDay() + 6) % 7;
  const weekStart = today - mondayOffset * 86_400_000;
  if (target >= weekStart && target < today - 86_400_000) return "this-week";

  const d = new Date(timestamp);
  return `month:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function clusterLabel(cluster: DateCluster): string {
  if (cluster === "today") return "TODAY";
  if (cluster === "yesterday") return "YESTERDAY";
  if (cluster === "this-week") return "THIS WEEK";
  if (cluster === "unknown") return "UNKNOWN";
  const [year, month] = cluster.slice("month:".length).split("-");
  const d = new Date(Number(year), Number(month) - 1, 1);
  return `${d.toLocaleString("en-US", { month: "long" }).toUpperCase()} ${year}`;
}

function chainProjectionKey(members: readonly SessionRow[]): string {
  const chainId = members[0]?.chain_id;
  return chainId === null || chainId === undefined
    ? `chain:${members.map(sessionKey).sort().join("|")}`
    : `chain:${chainId}`;
}

interface ProjectionCacheEntry {
  expandedKey: string;
  localDay: string;
  value: readonly ProjectedListRow[];
}

const projectionCache = new WeakMap<object, ProjectionCacheEntry>();

/**
 * Collapse chains to their newest member's position. Expansion keeps the
 * aggregate row and inserts every member directly below it; cluster headers
 * describe logical rows, never each nested member.
 */
export function projectListRows(
  rows: readonly SessionRow[],
  expandedChains: ReadonlySet<ChainId>,
  now = Date.now(),
): ProjectedListRow[] {
  const expandedKey = [...expandedChains].sort((left, right) => left - right).join(",");
  const localDay = new Date(now).toDateString();
  const cached = projectionCache.get(rows as object);
  if (cached?.expandedKey === expandedKey && cached.localDay === localDay) {
    return cached.value as ProjectedListRow[];
  }
  const membersByChain = new Map<ChainId, SessionRow[]>();
  for (const row of rows) {
    if (row.chain_id === null) continue;
    const members = membersByChain.get(row.chain_id) ?? [];
    members.push(row);
    membersByChain.set(row.chain_id, members);
  }

  // Headers only describe chronological lists. Relevance order interleaves
  // months, so a result set that revisits one drops headers; age stays per row.
  const dated = chronological(rows, now);
  const emittedChains = new Set<ChainId>();
  const projected: ProjectedListRow[] = [];
  let previousCluster: DateCluster | null = null;
  for (const row of rows) {
    if (row.chain_id !== null && emittedChains.has(row.chain_id)) continue;
    const cluster = dateCluster(row.last_activity, now);
    if (dated && cluster !== previousCluster) {
      projected.push({ kind: "cluster", key: `cluster:${cluster}`, cluster, label: clusterLabel(cluster) });
      previousCluster = cluster;
    }

    if (row.chain_id === null) {
      projected.push({ kind: "session", key: sessionKey(row), session: row, chainId: null, nested: false });
      continue;
    }

    emittedChains.add(row.chain_id);
    const members = membersByChain.get(row.chain_id) ?? [row];
    const activities = members.flatMap((member) => member.last_activity === null ? [] : [member.last_activity]);
    const expanded = expandedChains.has(row.chain_id);
    projected.push({
      kind: "chain",
      key: chainProjectionKey(members),
      chainId: row.chain_id,
      head: row,
      members,
      expanded,
      aggregate: {
        memberCount: members.length,
        tokTotal: members.reduce((sum, member) => sum + member.tok_total, 0),
        msgCount: members.reduce((sum, member) => sum + member.msg_count, 0),
        firstActivity: activities.length ? Math.min(...activities) : null,
        lastActivity: activities.length ? Math.max(...activities) : null,
        favoriteCount: members.filter((member) => member.favorite > 0).length,
      },
    });
    if (expanded) {
      for (const member of members) {
        projected.push({
          kind: "session",
          key: sessionKey(member),
          session: member,
          chainId: row.chain_id,
          nested: true,
        });
      }
    }
  }
  projectionCache.set(rows as object, { expandedKey, localDay, value: projected });
  return projected;
}

function chronological(rows: readonly SessionRow[], now: number): boolean {
  const seen = new Set<DateCluster>();
  const chains = new Set<ChainId>();
  let previous: DateCluster | null = null;
  for (const row of rows) {
    if (row.chain_id !== null) {
      if (chains.has(row.chain_id)) continue;
      chains.add(row.chain_id);
    }
    const cluster = dateCluster(row.last_activity, now);
    if (cluster === previous) continue;
    if (seen.has(cluster)) return false;
    seen.add(cluster);
    previous = cluster;
  }
  return true;
}

/** Cluster headers consume viewport lines but never receive the list cursor. */
export function isFocusableProjection(row: ProjectedListRow): row is SessionProjection | ChainProjection {
  return row.kind !== "cluster";
}

export interface ProjectedCursor {
  /** Stable logical identity. A chain cursor is `chain:<id>`, never its raw-row index. */
  focusKey: ProjectedRowKey | null;
  /** Stable top-of-viewport identity; headers are valid anchors. */
  anchorKey: ProjectedRowKey | null;
}

export interface ProjectedViewport {
  rows: readonly ProjectedListRow[];
  startIndex: number;
  endIndex: number;
  focusIndex: number;
  usedLines: number;
  hiddenAbove: number;
  hiddenBelow: number;
}

export type ProjectionLineCost = (row: ProjectedListRow) => number;

export function projectedRowLineCost(_row: ProjectedListRow): number {
  return 1;
}

export function firstFocusableProjectionKey(rows: readonly ProjectedListRow[]): ProjectedRowKey | null {
  const index = projectionIndex(rows);
  const first = index.focusableIndices[0];
  return first === undefined ? null : rows[first]!.key;
}

interface ProjectionIndex {
  readonly indexByKey: ReadonlyMap<ProjectedRowKey, number>;
  readonly focusableIndices: readonly number[];
  readonly focusablePositionByKey: ReadonlyMap<ProjectedRowKey, number>;
}

/**
 * Navigation asks the same immutable projection array for key coordinates on
 * every keypress. Build those coordinates once instead of rescanning an ever
 * larger archive as the cursor moves toward its oldest rows.
 */
const projectionIndexCache = new WeakMap<object, ProjectionIndex>();

function projectionIndex(rows: readonly ProjectedListRow[]): ProjectionIndex {
  const cached = projectionIndexCache.get(rows as object);
  if (cached) return cached;
  const indexByKey = new Map<ProjectedRowKey, number>();
  const focusableIndices: number[] = [];
  const focusablePositionByKey = new Map<ProjectedRowKey, number>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    indexByKey.set(row.key, index);
    if (!isFocusableProjection(row)) continue;
    focusablePositionByKey.set(row.key, focusableIndices.length);
    focusableIndices.push(index);
  }
  const value = { indexByKey, focusableIndices, focusablePositionByKey };
  projectionIndexCache.set(rows as object, value);
  return value;
}

export function focusedProjection(
  rows: readonly ProjectedListRow[],
  key: ProjectedRowKey | null,
): SessionProjection | ChainProjection | null {
  const index = projectionIndex(rows);
  const exactIndex = key === null ? undefined : index.indexByKey.get(key);
  const exact = exactIndex === undefined ? undefined : rows[exactIndex];
  if (exact && isFocusableProjection(exact)) return exact;
  const fallbackIndex = index.focusableIndices[0];
  if (fallbackIndex === undefined) return null;
  const fallback = rows[fallbackIndex]!;
  return isFocusableProjection(fallback) ? fallback : null;
}

/**
 * Move over the logical projection, skipping cluster headers and therefore
 * never landing on a collapsed/hidden chain member. The returned key remains
 * stable as later keyset pages add older members to an already-visible chain.
 */
export function moveProjectedCursor(
  rows: readonly ProjectedListRow[],
  currentKey: ProjectedRowKey | null,
  delta: number,
): ProjectedRowKey | null {
  const index = projectionIndex(rows);
  if (index.focusableIndices.length === 0) return null;
  const current = currentKey === null ? 0 : (index.focusablePositionByKey.get(currentKey) ?? 0);
  const next = Math.max(0, Math.min(index.focusableIndices.length - 1, current + delta));
  return rows[index.focusableIndices[next]!]!.key;
}

function lineSum(
  rows: readonly ProjectedListRow[],
  start: number,
  end: number,
  cost: ProjectionLineCost,
): number {
  let total = 0;
  for (let index = start; index < end; index++) total += Math.max(1, Math.floor(cost(rows[index]!)));
  return total;
}

/**
 * Resolve a stable cursor into a line-budgeted viewport. This deliberately
 * operates on the complete accumulated projection rather than one fetched
 * page, so expanding a chain whose members cross a keyset boundary cannot
 * omit members or strand focus off-screen.
 */
export function projectedViewport(
  rows: readonly ProjectedListRow[],
  cursor: ProjectedCursor,
  lineBudget: number,
  cost: ProjectionLineCost = projectedRowLineCost,
): ProjectedViewport {
  if (rows.length === 0) {
    return { rows: [], startIndex: 0, endIndex: 0, focusIndex: -1, usedLines: 0, hiddenAbove: 0, hiddenBelow: 0 };
  }
  const budget = Math.max(1, Math.floor(lineBudget));
  const index = projectionIndex(rows);
  const fallbackFocus = index.focusableIndices[0] ?? -1;
  const requestedFocusCandidate = cursor.focusKey === null ? undefined : index.indexByKey.get(cursor.focusKey);
  const requestedFocus = requestedFocusCandidate !== undefined && isFocusableProjection(rows[requestedFocusCandidate]!)
    ? requestedFocusCandidate
    : -1;
  const focusIndex = requestedFocus >= 0 ? requestedFocus : fallbackFocus;
  let start = cursor.anchorKey === null ? 0 : (index.indexByKey.get(cursor.anchorKey) ?? -1);
  if (start < 0) start = 0;
  if (focusIndex >= 0 && focusIndex < start) start = focusIndex;
  while (focusIndex >= start && lineSum(rows, start, focusIndex + 1, cost) > budget) start++;

  let end = start;
  let usedLines = 0;
  while (end < rows.length) {
    const next = Math.max(1, Math.floor(cost(rows[end]!)));
    if (end > start && usedLines + next > budget) break;
    usedLines += next;
    end++;
  }
  // A stale anchor can be below focus. Re-anchor at focus and refill.
  if (focusIndex >= end) {
    start = focusIndex;
    end = focusIndex;
    usedLines = 0;
    while (end < rows.length) {
      const next = Math.max(1, Math.floor(cost(rows[end]!)));
      if (end > start && usedLines + next > budget) break;
      usedLines += next;
      end++;
    }
  }
  return {
    rows: rows.slice(start, end),
    startIndex: start,
    endIndex: end,
    focusIndex,
    usedLines,
    hiddenAbove: start,
    hiddenBelow: rows.length - end,
  };
}

/** Underlying session represented by a logical row (chain rows resolve to their head). */
export function projectionSession(row: SessionProjection | ChainProjection): SessionRow {
  return row.kind === "session" ? row.session : row.head;
}

export interface TraversalEntry {
  key: SessionKey;
  id: number;
  harness: string;
  nativeId: string;
}

export interface FrozenTraversal {
  readonly entries: readonly TraversalEntry[];
  readonly indexByKey: ReadonlyMap<SessionKey, number>;
}

/** Freeze the logical list order at excursion time; later inserts cannot yank traversal. */
export function freezeTraversal(rows: readonly SessionRow[], expandedChains: ReadonlySet<ChainId>): FrozenTraversal {
  const projected = projectListRows(rows, expandedChains);
  const entries: TraversalEntry[] = [];
  for (const row of projected) {
    if (row.kind === "session") {
      entries.push({ key: row.key, id: row.session.id, harness: row.session.harness, nativeId: row.session.native_id });
    } else if (row.kind === "chain") {
      entries.push({
        key: sessionKey(row.head),
        id: row.head.id,
        harness: row.head.harness,
        nativeId: row.head.native_id,
      });
    }
  }
  // Expanded chains contain their head twice (aggregate row + first nested row).
  const unique = entries.filter((entry, index) => entries.findIndex((candidate) => candidate.key === entry.key) === index);
  return { entries: unique, indexByKey: new Map(unique.map((entry, index) => [entry.key, index])) };
}

export function clampTranscriptScroll(scroll: number, transcriptLength: number, visibleRows: number): number {
  const maximum = Math.max(0, transcriptLength - Math.max(1, visibleRows));
  return Math.max(0, Math.min(maximum, scroll));
}
