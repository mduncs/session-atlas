/**
 * Read-side view of the emergent layers: session shape, episodes, and the
 * facet/detail tags a labelling pass attached to them. Everything here reads
 * the attached `layers` schema; a missing table means "no layer pass yet",
 * never an error surface.
 */
import type { DB } from "../db/index.js";
import { LAYER_DISPLAY_TAGS_CTE, type FilterTerm, type ListFilter } from "../search/compiler.js";
import type { CountDatum, DashboardAnalytics } from "./analytics.js";
import { bg, fg, type Span } from "./skin.js";

export const FACET_PREFIX = "facet:";

/** Shared with the compiler so rail counts and list filters agree exactly. */
export const DISPLAY_TAGS_CTE = LAYER_DISPLAY_TAGS_CTE;

export interface EpisodeFacts {
  episode: number;
  startOrdinal: number;
  endOrdinal: number;
  startTs: number | null;
  endTs: number | null;
  /** Null until a labelling pass (or md) names the episode. */
  label: string | null;
  keywords: string[];
  facet: string | null;
  /** Detail tags after merges and demotions; nested tags read `parent/child`. */
  tags: string[];
}

export interface SessionLayers {
  shape: string | null;
  episodes: EpisodeFacts[];
  /** Whole-session tags (episode -1), used by tiny sessions. */
  sessionFacet: string | null;
  sessionTags: string[];
}

/** A nested child without its parent's name: `tmux-scrolling` under `tmux` reads `scrolling`. */
export function nestedLabel(parent: string, child: string): string {
  return child.startsWith(`${parent}-`) && child.length > parent.length + 1 ? child.slice(parent.length + 1) : child;
}

export const EMPTY_SESSION_LAYERS: SessionLayers = { shape: null, episodes: [], sessionFacet: null, sessionTags: [] };

function parseKeywords(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** One session's shape, episodes, and display tags. Absent layers read as empty. */
export function readSessionLayers(db: DB, harness: string, nativeId: string): SessionLayers {
  try {
    const shape = (db.prepare(
      `SELECT shape FROM layers.session_shape WHERE harness=? AND native_id=?`,
    ).get(harness, nativeId) as { shape: string } | null)?.shape ?? null;
    const episodeRows = db.prepare(
      `SELECT episode, start_ordinal, end_ordinal, start_ts, end_ts, keywords, label
       FROM layers.session_episodes WHERE harness=? AND native_id=? ORDER BY start_ordinal, episode`,
    ).all(harness, nativeId) as Array<{
      episode: number; start_ordinal: number; end_ordinal: number;
      start_ts: number | null; end_ts: number | null; keywords: string | null; label: string | null;
    }>;
    const tagRows = db.prepare(
      `WITH ${DISPLAY_TAGS_CTE}
       SELECT episode, tag, parent FROM display_tags
       WHERE harness=? AND native_id=? ORDER BY episode, COALESCE(parent, tag), parent IS NOT NULL, tag`,
    ).all(harness, nativeId) as Array<{ episode: number; tag: string; parent: string | null }>;
    const facets = new Map<number, string>();
    const details = new Map<number, string[]>();
    for (const row of tagRows) {
      if (row.tag.startsWith(FACET_PREFIX)) {
        if (!facets.has(row.episode)) facets.set(row.episode, row.tag.slice(FACET_PREFIX.length));
      } else {
        const list = details.get(row.episode) ?? [];
        const label = row.parent ? `${row.parent}/${nestedLabel(row.parent, row.tag)}` : row.tag;
        if (!list.includes(label)) list.push(label);
        details.set(row.episode, list);
      }
    }
    return {
      shape,
      episodes: episodeRows.map((row) => ({
        episode: row.episode,
        startOrdinal: row.start_ordinal,
        endOrdinal: row.end_ordinal,
        startTs: row.start_ts,
        endTs: row.end_ts,
        label: row.label?.trim() || null,
        keywords: parseKeywords(row.keywords),
        facet: facets.get(row.episode) ?? null,
        tags: details.get(row.episode) ?? [],
      })),
      sessionFacet: facets.get(-1) ?? null,
      sessionTags: details.get(-1) ?? [],
    };
  } catch {
    return EMPTY_SESSION_LAYERS;
  }
}

const FACET_SKIN: Record<string, { short: string; color: number }> = {
  code: { short: "code", color: 110 },
  design: { short: "dsgn", color: 180 },
  research: { short: "rsch", color: 146 },
  ops: { short: "ops", color: 108 },
  writing: { short: "writ", color: 174 },
  life: { short: "life", color: 151 },
  health: { short: "hlth", color: 115 },
  money: { short: "mony", color: 186 },
  learning: { short: "lrn", color: 139 },
  agents: { short: "agnt", color: 103 },
};

/** A small colored facet chip; unknown facets keep their first four letters. */
export function facetChip(facet: string): Span {
  const skin = FACET_SKIN[facet] ?? { short: facet.replace(/[^\x20-\x7e]/g, "").slice(0, 4) || "?", color: 246 };
  return [` ${skin.short} `, `${bg(236)}${fg(skin.color)}`];
}

/** The facet's own foreground color, for rows that name it in full. */
export function facetStyle(facet: string): string {
  return fg(FACET_SKIN[facet]?.color ?? 246);
}

export function facetShort(facet: string): string {
  return FACET_SKIN[facet]?.short ?? facet.slice(0, 4);
}

/**
 * The TAGS rail as data, shared by the rendered rail and its hit zones so
 * both walk the same rows. Without a facet the rail lists facets; with one it
 * offers a way back, the facet itself, and that facet's detail tags.
 */
export interface RailTagEntry {
  id: string;
  /** Filter value (canonical tag) or facet name. */
  label: string;
  /** What the rail prints; a nested child drops its parent's prefix. */
  display: string;
  count: number | null;
  kind: "facet" | "layerTag" | "tag" | "all" | "empty";
  active: boolean;
  /** A nested child listed under its parent. */
  nested: boolean;
  /** Clicking applies this term, or removes the named filter kind. */
  apply?: FilterTerm;
  remove?: FilterTerm["kind"];
}

export function railTagEntries(analytics: DashboardAnalytics, filter: Pick<ListFilter, "facet" | "layerTag">, legacyLimit: number): RailTagEntry[] {
  const facets: readonly CountDatum[] = analytics.facets ?? [];
  const entries: RailTagEntry[] = [];
  if (filter.facet) {
    entries.push({ id: "all", label: "< all facets", display: "< all facets", count: null, kind: "all", active: false, nested: false, remove: "facet" });
    const count = facets.find((entry) => entry.label === filter.facet)?.count ?? null;
    entries.push({ id: `facet:${filter.facet}`, label: filter.facet, display: filter.facet, count, kind: "facet", active: true, nested: false, remove: "layerTag" });
    for (const tag of analytics.layerTags ?? []) {
      const active = filter.layerTag === tag.label;
      entries.push({
        id: `layer:${tag.parent ? `${tag.parent}/` : ""}${tag.label}`,
        label: tag.label,
        display: tag.parent ? nestedLabel(tag.parent, tag.label) : tag.label,
        count: tag.count,
        kind: "layerTag",
        active,
        nested: tag.parent !== null,
        ...(active ? { remove: "layerTag" as const } : { apply: { kind: "layerTag" as const, value: tag.label } }),
      });
    }
    return entries;
  }
  for (const facet of facets) {
    entries.push({ id: `facet:${facet.label}`, label: facet.label, display: facet.label, count: facet.count, kind: "facet", active: false, nested: false, apply: { kind: "facet", value: facet.label } });
  }
  for (const tag of analytics.tags.slice(0, legacyLimit)) {
    entries.push({ id: `tag:${tag.label}`, label: tag.label, display: tag.label, count: tag.count, kind: "tag", active: false, nested: false, apply: { kind: "tag", value: tag.label } });
  }
  if (entries.length === 0) entries.push({ id: "empty", label: "no tags yet", display: "no tags yet", count: null, kind: "empty", active: false, nested: false });
  return entries;
}

/** An episode placed in the transcript's logical-ordinal space. */
export interface EpisodeAnchor {
  /** 1-based position among the session's episodes. */
  index: number;
  episode: number;
  /** Logical ordinal of the first message at or after the raw start; null past the end. */
  ordinal: number | null;
  /** The model/md label, or the boundary keywords while unlabelled. */
  title: string;
  labelled: boolean;
  facet: string | null;
  tags: readonly string[];
  startTs: number | null;
  endTs: number | null;
}

/**
 * Map raw episode starts onto logical ordinals through each dialogue turn's
 * raw representative ordinal. Legacy fixtures pass rows whose raw and logical
 * ordinals coincide.
 */
export function episodeAnchors(
  layers: SessionLayers | null | undefined,
  turns: readonly { logicalOrdinal: number; rawRepresentativeOrdinal: number }[],
): EpisodeAnchor[] {
  if (!layers || layers.episodes.length === 0) return [];
  const sorted = [...turns].sort((a, b) => a.rawRepresentativeOrdinal - b.rawRepresentativeOrdinal);
  return layers.episodes.map((episode, position) => {
    const turn = sorted.find((entry) => entry.rawRepresentativeOrdinal >= episode.startOrdinal && entry.rawRepresentativeOrdinal <= episode.endOrdinal)
      ?? null;
    return {
      index: position + 1,
      episode: episode.episode,
      ordinal: turn?.logicalOrdinal ?? null,
      title: episode.label ?? (episode.keywords.slice(0, 4).join(" . ") || `episode ${position + 1}`),
      labelled: episode.label !== null,
      facet: episode.facet,
      tags: episode.tags,
      startTs: episode.startTs,
      endTs: episode.endTs,
    };
  });
}

/** Index into `anchors` of the episode containing `ordinal` (the last one starting at or before it). */
export function episodeAt(anchors: readonly EpisodeAnchor[], ordinal: number | null): number {
  if (ordinal === null) return anchors.findIndex((anchor) => anchor.ordinal !== null);
  let found = -1;
  anchors.forEach((anchor, index) => { if (anchor.ordinal !== null && anchor.ordinal <= ordinal) found = index; });
  return found >= 0 ? found : anchors.findIndex((anchor) => anchor.ordinal !== null);
}

/** The next (`1`) or previous (`-1`) jumpable episode strictly beyond `ordinal`. */
export function episodeStep(anchors: readonly EpisodeAnchor[], ordinal: number | null, delta: -1 | 1): EpisodeAnchor | null {
  const placed = anchors.filter((anchor): anchor is EpisodeAnchor & { ordinal: number } => anchor.ordinal !== null);
  if (placed.length === 0) return null;
  if (ordinal === null) return delta > 0 ? placed[0]! : null;
  return delta > 0
    ? placed.find((anchor) => anchor.ordinal > ordinal) ?? null
    : [...placed].reverse().find((anchor) => anchor.ordinal < ordinal) ?? null;
}
