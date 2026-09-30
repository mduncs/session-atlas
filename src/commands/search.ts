import { withReadOnlyCtx, flagValue, hasFlag } from "./ctx.js";
import { fishPath } from "../paths.js";
import { parseListFilters } from "./list-filters.js";
import { createSessionSearchService, hasV12SearchIndex } from "../search/service.js";
import { fetchPage } from "../data-access/session-list.js";
import { compileFtsQuery } from "../fts-query.js";
import type { SearchSnippetDto } from "../contracts/search.js";
import { logSearch, refsFromHits, uncoveredScope } from "../layers/search-log.js";

/** atlas search <q> — semantic FTS over current logical dialogue (no model). */
export async function searchCmd(argv: string[]): Promise<number> {
  const parsed = parseListFilters(argv);
  const q = parsed.positionals[0]?.trim();
  const limit = Number(flagValue(argv, "--limit") ?? 30);
  if (parsed.error || !Number.isSafeInteger(limit) || limit < 1 || limit > 300) {
    process.stderr.write(`atlas search: ${parsed.error ?? "--limit must be an integer from 1 to 300"}\n`);
    return 2;
  }
  if (!q) {
    process.stderr.write("atlas search <query> [--raw]\n");
    return 2;
  }

  let exitCode = 0;
  await withReadOnlyCtx(argv, async ({ db, dbPath }) => {
    if (!hasV12SearchIndex(db)) {
      renderLegacySearch(db, parsed.filter, q, hasFlag(argv, "--raw"), limit);
      return;
    }
    const syntax = hasFlag(argv, "--raw") ? "raw_fts5" as const : "literal" as const;
    const result = createSessionSearchService(db).searchList({
      query: q,
      syntax,
      filter: parsed.filter,
      pageSize: limit,
      cursor: null,
    });
    if (!result.ok) {
      process.stderr.write(`atlas search: ${result.error.message}\n`);
      exitCode = 2;
      return;
    }
    const page = result.page;
    logSearch(dbPath, {
      surface: "cli-search", query: q, syntax, scope: parsed.filter, total: page.total,
      refs: refsFromHits(page.hits), uncovered: uncoveredScope(db, parsed.filter, page.total, page.hits.length),
    });
    if (page.hits.length === 0) {
      process.stdout.write(`(no hits for "${q}")\n`);
      return;
    }

    const home = process.env.HOME ?? "~";
    process.stdout.write(
      `atlas search · ${page.total} session(s) match "${q}" · showing ${page.hits.length}\n`,
    );
    for (const hit of page.hits) {
      const s = hit.compatibility;
      const when = s.lastActivity ? rel(s.lastActivity) : "—";
      const title = (hit.session.effectiveTitle ?? "(untitled)").replace(/\s+/gu, " ");
      process.stdout.write(
        `  #${String(s.id).padStart(5)} ${originCode(s.effectiveOrigin)} ${when.padEnd(9)} ${s.harness.padEnd(7)} ` +
          `${trunc(title, 40)}  ${(s.cwd ? fishPath(s.cwd, home) : "—").padEnd(26)}\n`,
      );
      if (hit.snippets.length === 0) {
        // Explicit title scope has no logical dialogue row to pretend is a
        // message snippet. The selected title evidence remains visible above.
        process.stdout.write("          [explicit title-scope match]\n");
      } else {
        for (const snippet of hit.snippets.slice(0, 3)) {
          process.stdout.write(`          ${renderSnippet(snippet)}\n`);
        }
      }
    }
  });
  return exitCode;
}

function legacyRawPage(
  db: Parameters<typeof fetchPage>[0],
  filter: Parameters<typeof fetchPage>[1],
  query: string,
  limit: number,
): ReturnType<typeof fetchPage> {
  // Explicit raw compatibility is confined to pre-v12 databases.
  const rows = db.prepare(
    `SELECT DISTINCT s.id FROM messages_fts
     JOIN messages m ON m.id=messages_fts.rowid
     JOIN sessions s ON s.id=m.session_id
     WHERE messages_fts MATCH ? ORDER BY s.last_activity DESC,s.id DESC LIMIT ?`,
  ).all(query, limit) as Array<{ id: number }>;
  const wanted = new Set(rows.map((row) => row.id));
  const page = fetchPage(db, filter, null, Math.max(limit, wanted.size));
  return { ...page, rows: page.rows.filter((row) => wanted.has(row.id)).slice(0, limit), hasMore: false };
}

function renderLegacySearch(
  db: Parameters<typeof fetchPage>[0],
  filter: Parameters<typeof fetchPage>[1],
  query: string,
  raw: boolean,
  limit: number,
): void {
  const legacyQuery = raw
    ? query
    : compileFtsQuery(query, "literal").match.replace(/^prose\s*:\s*\((.*)\)$/u, "$1");
  const page = raw
    ? legacyRawPage(db, filter, legacyQuery, limit)
    : fetchPage(db, { ...filter, query }, null, limit);
  if (page.error) throw new Error(page.error.message);
  if (page.rows.length === 0) {
    process.stdout.write(`(no hits for "${query}")\n`);
    return;
  }
  process.stdout.write(`atlas search · ${page.rows.length} session(s) match "${query}"\n`);
  const snippet = db.prepare(
    `SELECT snippet(messages_fts,0,'⟦','⟧','…',12) AS text
     FROM messages_fts JOIN messages m ON m.id=messages_fts.rowid
     WHERE messages_fts MATCH ? AND m.session_id=? ORDER BY rank LIMIT 1`,
  );
  const home = process.env.HOME ?? "~";
  for (const s of page.rows) {
    const when = s.last_activity ? rel(s.last_activity) : "—";
    const title = (s.title ?? "(untitled)").replace(/\s+/gu, " ");
    const evidence = (snippet.get(legacyQuery, s.id) as { text?: string } | null)?.text ?? "";
    process.stdout.write(
      `  #${String(s.id).padStart(5)} ${originCode(s.effective_origin)} ${when.padEnd(9)} ${s.harness.padEnd(7)} ` +
        `${trunc(title, 40)}  ${(s.cwd ? fishPath(s.cwd, home) : "—").padEnd(26)}\n` +
        `          ${evidence.replace(/\s+/gu, " ")}\n`,
    );
  }
}

function renderSnippet(snippet: SearchSnippetDto): string {
  const before = snippet.text.slice(0, snippet.matchStart);
  const match = snippet.text.slice(snippet.matchStart, snippet.matchEnd);
  const after = snippet.text.slice(snippet.matchEnd);
  return `${before}⟦${match}⟧${after}`.replace(/\s+/gu, " ");
}

function rel(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function originCode(origin: string | undefined): string {
  return origin === "human" ? "H" : origin === "agent" ? "A" : origin === "mixed" ? "M" : "?";
}
function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n);
}
