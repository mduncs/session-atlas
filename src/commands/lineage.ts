import { resolve } from "node:path";
import { withReadOnlyCtx, flagValue, hasFlag } from "./ctx.js";
import { expandPath, fishPath } from "../paths.js";
import { parseListFilters } from "./list-filters.js";
import { createSessionSearchService, hasV12SearchIndex } from "../search/service.js";
import { logSearch } from "../layers/search-log.js";
import type { DB } from "../db/index.js";
import type { ListFilter } from "../data-access/session-list.js";
import {
  clip, isoDay, loadCwdStats, loadDialogue, loadLineageSessions, nextIsoDay, resolveLineage, splitEras,
  type LineageScope, type LineageSession,
} from "../lineage.js";

export const LINEAGE_HELP = `Usage: atlas lineage [path] [--messages|--replies] [--from D --to D] [options]

One project's history across moves, renames, and worktrees, oldest first.
Without --messages it prints the resolved paths, eras, sessions, and sessions
elsewhere that mention the project. Path defaults to the current directory; a
worktree or role directory (source/, app/) resolves to its project root.
Origin letters are the creator layer's verdict (H/A/?). Sessions the harness
recorded as agent-launched (subagents, SDK, codex exec) are hidden.

  --messages        human messages verbatim, per session, with #id:ordinal refs
  --replies         --messages plus the agent's last reply to each message
  --from/--to D     sessions starting in [from, to); eras print ready-made ranges
  --also PATH       include another path (repeatable)
  --exclude PATH    drop a path the resolver included (repeatable)
  --agents          include agent-launched sessions (hidden by default)
  --max-chars N     clip each message to N chars (default 1500; 0 = never)
  --era-days N      idle days that start a new era (default 3)

Refs: \`atlas read <id> --around <ordinal>\` opens the surrounding transcript.
`;

const VALUED = new Set(["--config", "--from", "--to", "--also", "--exclude", "--max-chars", "--era-days"]);
const REPLY_CHARS = 600;
const MENTION_LIMIT = 10;

export async function lineageCmd(argv: string[]): Promise<number> {
  const positional = argv.find((arg, index) => !arg.startsWith("-") && !VALUED.has(argv[index - 1] ?? ""));
  const target = resolve(expandPath(positional ?? process.cwd()));
  const maxChars = Number(flagValue(argv, "--max-chars") ?? 1500);
  const eraDays = Number(flagValue(argv, "--era-days") ?? 3);
  const { filter, error } = parseListFilters(argv);
  if (error || !Number.isSafeInteger(maxChars) || maxChars < 0 || !(eraDays > 0)) {
    process.stderr.write(`atlas lineage: ${error ?? "--max-chars must be a whole number ≥ 0 and --era-days positive"}\n`);
    return 2;
  }
  const also = flagValues(argv, "--also").map((path) => resolve(expandPath(path)));
  const exclude = flagValues(argv, "--exclude").map((path) => resolve(expandPath(path)));
  const replies = hasFlag(argv, "--replies");
  const messages = replies || hasFlag(argv, "--messages");

  await withReadOnlyCtx(argv, async ({ db, dbPath }) => {
    const scope = resolveLineage(loadCwdStats(db), target, { also, exclude });
    const { sessions, hiddenAgents } = loadLineageSessions(db, scope.included.map((path) => path.cwd), {
      from: filter.date?.from || null,
      to: filter.date?.to ?? null,
      includeAgents: hasFlag(argv, "--agents"),
    });
    const out = (line = ""): void => { process.stdout.write(`${line}\n`); };
    const home = process.env.HOME ?? "~";

    if (messages) {
      renderMessages(db, scope, sessions, { replies, maxChars, out, home });
      return;
    }

    out(`atlas lineage · ${scope.target} · ${sessions.length} session(s)` +
      (hiddenAgents ? ` · ${hiddenAgents} agent-launched session(s) hidden (--agents)` : ""));
    if (scope.requested !== scope.target) out(`project root of ${scope.requested}`);
    out();
    out("paths");
    if (scope.included.length === 0) out("  (no sessions under this path or a recognised alias)");
    for (const path of scope.included) out(`  ${path.reason.padEnd(8)} ${pathLine(path)}`);
    if (scope.nearby.length) {
      out();
      out("nearby · not included · add with --also PATH");
      for (const path of scope.nearby) out(`  ${path.reason.padEnd(8)} ${pathLine(path)}`);
    }

    const repro = reproArgs(scope.target, also, exclude, argv);
    const eras = splitEras(sessions, eraDays);
    if (eras.length) {
      out();
      out(`eras · split at ${eraDays}+ idle days · human chars exclude injected records`);
      for (const [index, era] of eras.entries()) {
        const chars = era.sessions.reduce((sum, session) => sum + humanChars(db, session.id), 0);
        out(`  ${String(index + 1).padStart(2)}  ${isoDay(era.from)} → ${isoDay(era.to)}  ` +
          `${String(era.sessions.length).padStart(3)} sessions  ${String(chars).padStart(7)} human chars`);
        out(`      atlas lineage ${repro} --messages --from ${isoDay(era.from)} --to ${nextIsoDay(era.sessions.at(-1)!.start ?? era.from)}`);
      }
    }

    if (sessions.length) {
      out();
      out("sessions");
      for (const session of sessions) out(`  ${sessionLine(session, home)}`);
    }

    const mentions = findMentions(db, dbPath, scope, new Set(scope.included.map((path) => path.cwd)), filter.date);
    if (mentions.length) {
      out();
      out(`mentions elsewhere · "${scope.name}" · not included · atlas read <id>`);
      for (const line of mentions) out(`  ${line}`);
    }
  });
  return 0;
}

function renderMessages(
  db: DB,
  scope: LineageScope,
  sessions: LineageSession[],
  options: { replies: boolean; maxChars: number; out: (line?: string) => void; home: string },
): void {
  const { out } = options;
  out(`# lineage ${scope.target} · ${sessions.length} session(s) · human messages verbatim` +
    (options.replies ? " · ↳ agent's last reply" : ""));
  const seen = new Set<string>();
  for (const session of sessions) {
    const turns = loadDialogue(db, session.id);
    let replayed = 0;
    let replaying = true;
    const lines: string[] = [];
    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index]!;
      if (turn.side !== "user") continue;
      // A resumed or forked session opens by replaying earlier sessions' turns.
      // Past that opening run, a repeat ("continue", "4") is a real turn.
      const key = turn.text.replace(/\s+/gu, " ");
      if (replaying && seen.has(key)) { replayed++; continue; }
      replaying = false;
      seen.add(key);
      lines.push(`◆ #${session.id}:${turn.ordinal}  ${indentRest(clip(turn.text, options.maxChars))}`);
      if (options.replies) {
        let reply: string | null = null;
        for (let next = index + 1; next < turns.length && turns[next]!.side === "assistant"; next++) reply = turns[next]!.text;
        if (reply) lines.push(`  ↳ ${indentRest(clip(reply, Math.min(REPLY_CHARS, options.maxChars || REPLY_CHARS)))}`);
      }
    }
    if (lines.length === 0 && replayed === 0) continue;
    out();
    out(`## ${sessionLine(session, options.home)}`);
    for (const line of lines) out(line);
    if (replayed) out(`(${replayed} message(s) replayed from an earlier session skipped)`);
  }
}

function findMentions(db: DB, dbPath: string, scope: LineageScope, includedCwds: Set<string>, date: ListFilter["date"]): string[] {
  if (scope.name.length < 4 || !hasV12SearchIndex(db)) return [];
  const result = createSessionSearchService(db).searchList({
    query: scope.name, syntax: "literal", filter: date ? { date } : {}, pageSize: 100, cursor: null,
  });
  if (!result.ok) return [];
  const hits = result.page.hits.filter((hit) => !includedCwds.has(hit.compatibility.cwd ?? "")).slice(0, MENTION_LIMIT);
  logSearch(dbPath, {
    surface: "cli-lineage", query: scope.name, syntax: "literal", scope: date ? { date } : {}, total: result.page.total,
    refs: hits.map((hit) => [hit.compatibility.harness, hit.compatibility.nativeId, []]), uncovered: {},
  });
  const home = process.env.HOME ?? "~";
  return hits.map((hit) => {
    const s = hit.compatibility;
    const title = (hit.session.effectiveTitle ?? "(untitled)").replace(/\s+/gu, " ");
    return `#${String(s.id).padEnd(6)} ${isoDay(s.lastActivity)} ${s.harness.padEnd(7)} ${originCode(s.effectiveOrigin)} ` +
      `${(s.cwd ? fishPath(s.cwd, home) : "—").padEnd(24)} ${truncate(title, 70)}`;
  });
}

function humanChars(db: DB, sessionId: number): number {
  return loadDialogue(db, sessionId).reduce((sum, turn) => sum + (turn.side === "user" ? turn.text.length : 0), 0);
}

function pathLine(path: { cwd: string; sessions: number; first: number | null; last: number | null; harnesses: Record<string, number> }): string {
  const harnesses = Object.entries(path.harnesses).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(" ");
  return `${path.cwd}  · ${harnesses} · ${isoDay(path.first)} → ${isoDay(path.last)}`;
}

function sessionLine(session: LineageSession, home: string): string {
  const title = (session.title ?? "(untitled)").replace(/\s+/gu, " ");
  return `#${String(session.id).padEnd(6)} ${isoDay(session.start)} ${session.harness.padEnd(7)} ${originCode(session.origin)} ` +
    `${String(session.msgCount).padStart(5)}m  ${fishPath(session.cwd, home).padEnd(24)} ${truncate(title, 80)}`;
}

/** The invocation that reproduces this scope, for era commands. */
function reproArgs(target: string, also: string[], exclude: string[], argv: string[]): string {
  const parts = [quote(target), ...also.flatMap((p) => ["--also", quote(p)]), ...exclude.flatMap((p) => ["--exclude", quote(p)])];
  if (hasFlag(argv, "--agents")) parts.push("--agents");
  const config = flagValue(argv, "--config");
  if (config) parts.push("--config", quote(config));
  return parts.join(" ");
}

function quote(value: string): string {
  return /^[\w@%+=:,./~-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;
}

function flagValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length - 1; index++) if (argv[index] === flag) values.push(argv[index + 1]!);
  return values;
}

function indentRest(text: string): string {
  return text.replace(/\n/gu, "\n    ");
}

function originCode(origin: string | undefined): string {
  return origin === "human" ? "H" : origin === "agent" ? "A" : origin === "mixed" ? "M" : "?";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
