/**
 * Project lineage: one project's sessions across moves, renames, and
 * worktrees, in chronological order, with the human side verbatim.
 *
 * `canonical_project_key` is per-cwd, so a project that moved from
 * `~/code/x` to `/Volumes/Data/code/x`, or was renamed from `x-engine` to
 * `x/engine`, splits into unrelated keys. The resolver below rejoins them from
 * path shape alone and reports why each path was included, so the caller can
 * correct it with `--also` / `--exclude` instead of trusting a guess.
 */
import { basename, dirname } from "node:path";
import type { DB } from "./db/index.js";
import { effectiveSessionOriginSql } from "./human-classifier.js";

export type LineageReason = "exact" | "inside" | "moved" | "renamed" | "worktree" | "also";
export type NearbyReason = "parent" | "similar";

export interface CwdStat {
  cwd: string;
  sessions: number;
  first: number | null;
  last: number | null;
  harnesses: Record<string, number>;
}

export interface LineagePath extends CwdStat { reason: LineageReason }
export interface NearbyPath extends CwdStat { reason: NearbyReason }

export interface LineageScope {
  /** The project root the lineage is resolved from; `requested` may sit below it. */
  target: string;
  requested: string;
  /** The literal token used to find sessions elsewhere that mention the project. */
  name: string;
  included: LineagePath[];
  nearby: NearbyPath[];
}

export interface ResolveOptions {
  also?: string[];
  exclude?: string[];
}

/** Basenames that name a role inside a project rather than the project. */
const GENERIC_BASENAMES = new Set([
  "source", "src", "app", "apps", "web", "main", "repo", "code", "frontend", "backend", "server", "client",
  "docs", "packages", "worktrees", "test", "tests", "lib", "core", "site", "project", "workspace",
]);
/** A directory with this many distinct child cwds is a collection, not a project. */
const COLLECTION_CHILDREN = 8;
const WORKTREE_BASENAME = /^(.+?)(?:-wt-.+|-worktree(?:-.+)?|\.worktrees?)$/u;
/** `~/.codex/worktrees/<id>` and `.claude/worktrees/<name>` hold checkouts named after their repo. */
const AGENT_WORKTREE_DIR = /\/\.(?:codex|claude)\/worktrees\/[^/]+$/u;

export function resolveLineage(stats: CwdStat[], target: string, options: ResolveOptions = {}): LineageScope {
  const requested = trimSlash(target);
  const t = projectRoot(requested);
  const base = basename(t);
  const parent = basename(dirname(t));
  const flattened = `${parent}-${base}`;
  const generic = GENERIC_BASENAMES.has(base);
  const also = (options.also ?? []).map(trimSlash);
  const exclude = (options.exclude ?? []).map(trimSlash);
  const childCounts = childCountByDir(stats);
  // A same-named directory is the project only where projects live: beside it
  // under the same parent name, in a collection, or in an agent worktree.
  const holdsProjects = (dir: string): boolean =>
    basename(dir) === parent || (childCounts.get(dir) ?? 0) >= COLLECTION_CHILDREN || AGENT_WORKTREE_DIR.test(dir);

  const aliasReason = (dir: string): LineageReason | null => {
    if (dir === t || isUnder(dir, t) || isUnder(t, dir)) return null;
    const b = basename(dir);
    const pb = basename(dirname(dir));
    if (b === base && (generic ? pb === parent : holdsProjects(dirname(dir)))) return "moved";
    if (b === flattened || `${pb}-${b}` === base) return "renamed";
    const worktree = WORKTREE_BASENAME.exec(b);
    if (worktree && worktree[1] === base) return "worktree";
    return null;
  };

  const included: LineagePath[] = [];
  for (const stat of stats) {
    const c = trimSlash(stat.cwd);
    if (exclude.some((e) => c === e || isUnder(c, e))) continue;
    let reason: LineageReason | null = c === t ? "exact" : isUnder(c, t) ? "inside" : null;
    if (!reason && also.some((a) => c === a || isUnder(c, a))) reason = "also";
    // An old location may only hold sessions in its subdirectories, so every
    // ancestor of the cwd is a candidate alias root, deepest first.
    for (let dir = c; !reason && dir !== dirname(dir); dir = dirname(dir)) reason = aliasReason(dir);
    // Keep the stored cwd: the session query matches it byte for byte.
    if (reason) included.push({ ...stat, reason });
  }

  const includedCwds = new Set(included.map((path) => trimSlash(path.cwd)));
  const name = generic ? flattened : base;
  const nearby: NearbyPath[] = [];
  for (const stat of stats) {
    const c = trimSlash(stat.cwd);
    if (includedCwds.has(c) || exclude.includes(c)) continue;
    if (isUnder(t, c)) {
      // Home, volume roots, and code roots are launch pads, not parents.
      const depth = c.split("/").length - 1;
      if (depth >= 3 && (childCounts.get(c) ?? 0) < COLLECTION_CHILDREN) nearby.push({ ...stat, cwd: c, reason: "parent" });
      continue;
    }
    const b = basename(c);
    if (b.length < 4 || GENERIC_BASENAMES.has(b)) continue;
    if (b === name || b.startsWith(`${name}-`) || name.startsWith(`${b}-`)) nearby.push({ ...stat, cwd: c, reason: "similar" });
  }

  const byFirst = (a: CwdStat, b: CwdStat): number => (a.first ?? 0) - (b.first ?? 0) || a.cwd.localeCompare(b.cwd);
  return { target: t, requested, name, included: included.sort(byFirst), nearby: nearby.sort(byFirst) };
}

/**
 * The directory that names the project: a worktree resolves to the repo that
 * owns it, and a role directory (`nodraw/source`) to its parent.
 */
export function projectRoot(path: string): string {
  let root = trimSlash(path);
  const codex = /^(.*\/\.codex\/worktrees\/[^/]+\/[^/]+)(?:\/.*)?$/u.exec(root);
  const worktree = /^(.+?)\/(?:\.claude\/worktrees|\.worktrees|worktrees)\/[^/]+(?:\/.*)?$/u.exec(root);
  if (codex) root = codex[1]!;
  else if (worktree) root = worktree[1]!;
  const sibling = WORKTREE_BASENAME.exec(basename(root));
  if (sibling) root = `${dirname(root)}/${sibling[1]}`;
  // Never climb onto a code root such as /Volumes/Data/code or ~/code.
  while (root.split("/").length - 1 > 4 && GENERIC_BASENAMES.has(basename(root))) root = dirname(root);
  return root;
}

function childCountByDir(stats: CwdStat[]): Map<string, number> {
  const children = new Map<string, Set<string>>();
  for (const stat of stats) {
    for (let dir = trimSlash(stat.cwd); dir !== dirname(dir); dir = dirname(dir)) {
      const up = dirname(dir);
      const set = children.get(up) ?? new Set<string>();
      set.add(basename(dir));
      children.set(up, set);
    }
  }
  return new Map([...children].map(([dir, set]) => [dir, set.size]));
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}

function isUnder(path: string, dir: string): boolean {
  return path.startsWith(dir === "/" ? "/" : `${dir}/`) && path !== dir;
}

/** Visible, valid sessions grouped by cwd: the resolver's whole input. */
export function loadCwdStats(db: DB): CwdStat[] {
  const rows = db.prepare(
    `SELECT s.cwd AS cwd, s.harness AS harness, COUNT(*) AS n,
            MIN(COALESCE(s.start_ts, s.last_activity)) AS first, MAX(s.last_activity) AS last
     FROM sessions s
     WHERE s.cwd IS NOT NULL AND s.default_session_visible=1 AND s.construction_status='valid'
     GROUP BY s.cwd, s.harness`,
  ).all() as Array<{ cwd: string; harness: string; n: number; first: number | null; last: number | null }>;
  const byCwd = new Map<string, CwdStat>();
  for (const row of rows) {
    const stat = byCwd.get(row.cwd) ?? { cwd: row.cwd, sessions: 0, first: null, last: null, harnesses: {} };
    stat.sessions += row.n;
    stat.harnesses[row.harness] = (stat.harnesses[row.harness] ?? 0) + row.n;
    if (row.first !== null) stat.first = stat.first === null ? row.first : Math.min(stat.first, row.first);
    if (row.last !== null) stat.last = stat.last === null ? row.last : Math.max(stat.last, row.last);
    byCwd.set(row.cwd, stat);
  }
  return [...byCwd.values()];
}

export interface LineageSession {
  id: number;
  harness: string;
  nativeId: string;
  cwd: string;
  start: number | null;
  last: number | null;
  msgCount: number;
  title: string | null;
  /** The creator layer's verdict; display only, since it misreads one-turn human briefs. */
  origin: string;
}

export interface SessionQuery {
  from?: number | null;
  to?: number | null;
  includeAgents?: boolean;
}

export function loadLineageSessions(db: DB, cwds: string[], query: SessionQuery = {}): { sessions: LineageSession[]; hiddenAgents: number } {
  if (cwds.length === 0) return { sessions: [], hiddenAgents: 0 };
  const rows = db.prepare(
    `SELECT s.id, s.harness, s.native_id, s.cwd, COALESCE(s.start_ts, s.last_activity) AS start, s.last_activity,
            s.msg_count, COALESCE(sm.topic_line, s.title) AS title, s.origin AS raw_origin,
            ${effectiveSessionOriginSql("s")} AS origin
     FROM sessions s
     LEFT JOIN summaries sm ON sm.session_id=s.id AND sm.tier=1
     WHERE s.default_session_visible=1 AND s.construction_status='valid'
       AND s.cwd IN (${cwds.map(() => "?").join(",")})
     ORDER BY COALESCE(s.start_ts, s.last_activity), s.id`,
  ).all(...cwds) as Array<{
    id: number; harness: string; native_id: string; cwd: string; start: number | null; last_activity: number | null;
    msg_count: number; title: string | null; raw_origin: string; origin: string;
  }>;
  let hiddenAgents = 0;
  const sessions: LineageSession[] = [];
  for (const row of rows) {
    const start = row.start ?? 0;
    if (query.from != null && start < query.from) continue;
    if (query.to != null && start >= query.to) continue;
    if (row.origin === "empty") continue;
    // Hide by ingest origin: a subagent thread or sidechain is structurally
    // agent-started, whatever the creator layer concludes.
    if (row.raw_origin === "agent" && !query.includeAgents) { hiddenAgents++; continue; }
    sessions.push({
      id: row.id, harness: row.harness, nativeId: row.native_id, cwd: row.cwd, start: row.start, last: row.last_activity,
      msgCount: row.msg_count, title: row.title, origin: row.origin,
    });
  }
  return { sessions, hiddenAgents };
}

export interface DialogueTurn {
  /** Raw `messages.ordinal`, the unit `atlas read <id> --around N` takes. */
  ordinal: number;
  side: "user" | "assistant";
  text: string;
}

/** Logical dialogue with harness-injected user-side records removed. */
export function loadDialogue(db: DB, sessionId: number): DialogueTurn[] {
  const rows = db.prepare(
    `SELECT m.ordinal AS ordinal, d.side AS side, d.prose AS prose
     FROM v12_search_eligible_documents d
     JOIN messages m ON m.id=d.representative_raw_record_id
     WHERE d.session_id=? AND d.scope='dialogue'
     ORDER BY d.logical_ordinal`,
  ).all(sessionId) as Array<{ ordinal: number; side: "user" | "assistant"; prose: string }>;
  const turns: DialogueTurn[] = [];
  for (const row of rows) {
    const text = row.side === "user" ? humanText(row.prose) : row.prose.trim();
    if (text) turns.push({ ordinal: row.ordinal, side: row.side, text });
  }
  return turns;
}

/** Records the harness wrote on the user's side. None of these are the human speaking. */
const INJECTED_USER_RECORDS = [
  /^<(task-notification|command-message|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|environment_context|user_instructions|recommended_plugins|turn_aborted|goal_context|codex_internal_context|subagent_notification|skill)\b/u,
  /^\{"agent_path":/u,
  /^The following is the Codex agent history whose request action you are assessing/u,
  /^## Context Usage\b/u,
  /^Stop hook feedback:/u,
  /^The TodoWrite tool hasn't been used recently/u,
  /^# AGENTS\.md instructions\b/u,
  /^Base directory for this skill:/u,
  /^Caveat: The messages below were generated by the user while running local commands/u,
  /^Another Claude session sent a message:/u,
  /^Your claude\.ai usage limit has reset/u,
  /^\[Request interrupted by user/u,
];

/** The human's words, or null for injected records. A slash command keeps its arguments. */
export function humanText(prose: string): string | null {
  const text = prose.trim();
  if (text.startsWith("<command-name>")) {
    const name = /<command-name>([^<]*)<\/command-name>/u.exec(text)?.[1]?.trim();
    const args = /<command-args>([\s\S]*?)<\/command-args>/u.exec(text)?.[1]?.trim();
    return name && args ? `${name.startsWith("/") ? name : `/${name}`} ${args}` : null;
  }
  return INJECTED_USER_RECORDS.some((pattern) => pattern.test(text)) ? null : text || null;
}

export interface Era {
  sessions: LineageSession[];
  from: number;
  to: number;
}

/** Split chronological sessions wherever the project sat idle for `gapDays`. */
export function splitEras(sessions: LineageSession[], gapDays: number): Era[] {
  const eras: Era[] = [];
  const gap = gapDays * 86_400_000;
  let reach = -Infinity;
  for (const session of sessions) {
    const start = session.start ?? 0;
    const end = Math.max(start, session.last ?? start);
    const current = eras.at(-1);
    if (!current || start - reach >= gap) eras.push({ sessions: [session], from: start, to: end });
    else { current.sessions.push(session); current.to = Math.max(current.to, end); }
    reach = Math.max(reach, end);
  }
  return eras;
}

export function clip(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max)} …[+${text.length - max} chars]`;
}

export function isoDay(ms: number | null): string {
  return ms === null ? "—" : new Date(ms).toISOString().slice(0, 10);
}

/** The exclusive `--to` day that covers every session starting on `ms`'s UTC day. */
export function nextIsoDay(ms: number): string {
  return isoDay(Date.parse(isoDay(ms)) + 86_400_000);
}
