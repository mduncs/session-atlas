import { writeFileSync } from "node:fs";
import type { DB } from "../db/index.js";
import type { ListFilter } from "../data-access/session-list.js";
import { openLayersDb } from "../layers/db.js";
import { diffRefs, executeForRefs, readCorpus, saveCorpus, type PassageRef } from "../layers/search-log.js";
import { parseListFilters } from "./list-filters.js";
import { flagValue, hasFlag, withReadOnlyCtx } from "./ctx.js";

const USAGE = `usage:
  atlas corpus save <name> <query> [search filters] [--raw] [--note <text>]
  atlas corpus from-search <search-log id> <name>    make a corpus from any logged search (md's or an agent's)
  atlas corpus rerun <name>                          snapshot again and show what changed
  atlas corpus show <name> | list
  atlas corpus export <name> [--out <file.md>]        passages as Markdown
  atlas searches [--agents|--caller <harness:id>] [--limit N]   the search log`;

export async function corpusCmd(argv: string[]): Promise<number> {
  try {
    const [verb, ...rest] = argv;
    return await withReadOnlyCtx(argv, ({ db, dbPath }) => {
      const layers = openLayersDb(dbPath);
      try {
        if (verb === "save") return save(db, layers, rest);
        if (verb === "from-search") return fromSearch(db, layers, rest);
        if (verb === "rerun") return rerun(db, layers, rest[0]);
        if (verb === "show") return show(db, layers, rest[0]);
        if (verb === "list") return list(layers);
        if (verb === "export") return exportCorpus(db, layers, rest[0], flagValue(argv, "--out"));
        throw new Error(USAGE);
      } finally { layers.close(); }
    });
  } catch (error) {
    process.stderr.write(`atlas corpus: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

type Layers = ReturnType<typeof openLayersDb>;

function save(db: DB, layers: Layers, argv: string[]): number {
  const parsed = parseListFilters(argv);
  const [name, query] = parsed.positionals;
  if (parsed.error || !name || !query) throw new Error(parsed.error ?? USAGE);
  const syntax = hasFlag(argv, "--raw") ? "raw_fts5" as const : "literal" as const;
  const snapshot = executeForRefs(db, query, syntax, parsed.filter);
  saveCorpus(layers, { name, query, syntax, scope: parsed.filter, origin: "md", note: flagValue(argv, "--note") }, snapshot);
  process.stdout.write(`atlas corpus · ${name} · ${snapshot.refs.length} sessions · ${passages(snapshot.refs)} passages · ${bytes(snapshot.refs)} stored\n`);
  return 0;
}

function fromSearch(db: DB, layers: Layers, argv: string[]): number {
  const [idArg, name] = argv;
  if (!idArg || !name) throw new Error(USAGE);
  const row = layers.query(`SELECT query, syntax, scope, caller_harness, caller_native_id FROM search_log WHERE id=? AND surface='cli-search'`).get(Number(idArg)) as
    { query: string; syntax: "literal" | "raw_fts5"; scope: string; caller_harness: string; caller_native_id: string | null } | null;
  if (!row) throw new Error(`no logged search #${idArg}`);
  const scope = JSON.parse(row.scope) as ListFilter;
  const snapshot = executeForRefs(db, row.query, row.syntax, scope);
  saveCorpus(layers, { name, query: row.query, syntax: row.syntax, scope, origin: `search-log:${idArg} ${row.caller_harness}${row.caller_native_id ? `:${row.caller_native_id}` : ""}` }, snapshot);
  process.stdout.write(`atlas corpus · ${name} · from search #${idArg} ("${row.query}") · ${snapshot.refs.length} sessions · ${passages(snapshot.refs)} passages\n`);
  return 0;
}

function rerun(db: DB, layers: Layers, name: string | undefined): number {
  const found = name ? readCorpus(layers, name) : null;
  if (!found) throw new Error(name ? `no corpus ${name}` : USAGE);
  const previous = found.snapshots.at(-1)?.refs ?? [];
  const scope = JSON.parse(found.corpus.scope) as ListFilter;
  const snapshot = executeForRefs(db, found.corpus.query, found.corpus.syntax, scope);
  saveCorpus(layers, { name: found.corpus.name, query: found.corpus.query, syntax: found.corpus.syntax, scope, origin: found.corpus.origin }, snapshot);
  const diff = diffRefs(previous, snapshot.refs);
  process.stdout.write(`atlas corpus · ${found.corpus.name} · +${diff.added.length} new · -${diff.removed.length} gone · ~${diff.changed.length} changed passages · ${diff.kept} unchanged\n`);
  for (const ref of diff.added) process.stdout.write(`  + ${describe(db, ref)}\n`);
  for (const ref of diff.removed) process.stdout.write(`  - ${describe(db, ref)}\n`);
  for (const ref of diff.changed) process.stdout.write(`  ~ ${describe(db, ref)}\n`);
  return 0;
}

function show(db: DB, layers: Layers, name: string | undefined): number {
  const found = name ? readCorpus(layers, name) : null;
  if (!found) throw new Error(name ? `no corpus ${name}` : USAGE);
  const latest = found.snapshots.at(-1);
  process.stdout.write(`${found.corpus.name} · "${found.corpus.query}" · origin ${found.corpus.origin} · ${found.snapshots.length} snapshot(s) · latest ${latest ? new Date(latest.taken_at).toLocaleString() : "—"}\n`);
  for (const ref of latest?.refs ?? []) process.stdout.write(`  ${describe(db, ref)}\n`);
  return 0;
}

function list(layers: Layers): number {
  const rows = layers.query(`SELECT c.name, c.query, c.origin, COUNT(s.taken_at) AS snaps, MAX(s.taken_at) AS latest,
      (SELECT length(refs) FROM corpus_snapshots WHERE corpus=c.name ORDER BY taken_at DESC LIMIT 1) AS bytes
    FROM corpora c LEFT JOIN corpus_snapshots s ON s.corpus=c.name GROUP BY c.name ORDER BY latest DESC`).all() as { name: string; query: string; origin: string; snaps: number; latest: number; bytes: number }[];
  if (!rows.length) process.stdout.write("(no corpora yet — atlas corpus save <name> <query>)\n");
  for (const row of rows) process.stdout.write(`${row.name} · "${row.query}" · ${row.snaps} snapshot(s) · ${row.bytes ?? 0} B · ${row.origin}\n`);
  return 0;
}

function exportCorpus(db: DB, layers: Layers, name: string | undefined, out: string | undefined): number {
  const found = name ? readCorpus(layers, name) : null;
  if (!found) throw new Error(name ? `no corpus ${name}` : USAGE);
  const latest = found.snapshots.at(-1);
  const lines = [`# Corpus: ${found.corpus.name}`, "", `Query: \`${found.corpus.query}\` · snapshot ${latest ? new Date(latest.taken_at).toISOString() : "—"} · ${latest?.refs.length ?? 0} sessions`, ""];
  for (const ref of latest?.refs ?? []) {
    lines.push(`## ${describe(db, ref)}`, "");
    for (const passage of passageText(db, ref)) lines.push(`**${passage.side}** (#${passage.ordinal})`, "", passage.text.trim(), "");
  }
  const markdown = lines.join("\n");
  if (out) { writeFileSync(out, markdown, { mode: 0o600 }); process.stdout.write(`atlas corpus · exported ${found.corpus.name} → ${out}\n`); }
  else process.stdout.write(markdown);
  return 0;
}

function describe(db: DB, ref: PassageRef): string {
  const row = db.query(`SELECT id, title, last_activity FROM sessions WHERE harness=? AND native_id=?`).get(ref[0], ref[1]) as { id: number; title: string | null; last_activity: number | null } | null;
  const when = row?.last_activity ? new Date(row.last_activity).toISOString().slice(0, 10) : "—";
  return `#${row?.id ?? "?"} ${ref[0]} ${when} ${(row?.title ?? "(untitled)").replace(/\s+/g, " ").slice(0, 70)} · passages ${ref[2].join(",") || "—"}`;
}

function passageText(db: DB, ref: PassageRef): { ordinal: number; side: string; text: string }[] {
  if (!ref[2].length) return [];
  const marks = ref[2].map(() => "?").join(",");
  return db.query(`SELECT lm.logical_ordinal AS ordinal, lm.dialogue_side AS side, m.prose AS text FROM logical_messages lm
      JOIN messages m ON m.id=lm.representative_message_id JOIN sessions s ON s.id=lm.session_id
     WHERE s.harness=? AND s.native_id=? AND lm.construction_generation=s.construction_generation AND lm.logical_ordinal IN (${marks})
     ORDER BY lm.logical_ordinal`).all(ref[0], ref[1], ...ref[2]) as { ordinal: number; side: string; text: string }[];
}

const passages = (refs: PassageRef[]) => refs.reduce((n, ref) => n + ref[2].length, 0);
const bytes = (refs: PassageRef[]) => `${JSON.stringify(refs).length} B`;

export async function searchesCmd(argv: string[]): Promise<number> {
  const limit = Number(flagValue(argv, "--limit") ?? 30);
  const caller = flagValue(argv, "--caller")?.match(/^([a-z0-9-]+):(.+)$/);
  return withReadOnlyCtx(argv, ({ dbPath }) => {
    const layers = openLayersDb(dbPath);
    try {
      const where = caller ? `caller_harness=? AND caller_native_id=?` : hasFlag(argv, "--agents") ? `caller_harness NOT IN ('human','unknown')` : "1=1";
      const rows = layers.query(`SELECT id, at, surface, caller_harness, caller_native_id, query, total, returned, uncovered FROM search_log WHERE ${where} ORDER BY at DESC LIMIT ?`)
        .all(...(caller ? [caller[1]!, caller[2]!] : []), limit) as { id: number; at: number; surface: string; caller_harness: string; caller_native_id: string | null; query: string; total: number; returned: number; uncovered: string }[];
      if (!rows.length) process.stdout.write("(no searches logged yet)\n");
      for (const row of rows) {
        const who = row.caller_native_id ? `${row.caller_harness}:${row.caller_native_id.slice(0, 8)}` : row.caller_harness;
        const blind = Object.keys(JSON.parse(row.uncovered) as object).length ? ` · blind: ${row.uncovered}` : "";
        process.stdout.write(`#${row.id} ${new Date(row.at).toLocaleString()} · ${who.padEnd(17)} · ${row.surface.padEnd(10)} · ${row.returned}/${row.total} · ${row.query.replace(/\s+/g, " ").slice(0, 60)}${blind}\n`);
      }
      return 0;
    } finally { layers.close(); }
  });
}
