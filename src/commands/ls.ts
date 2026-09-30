import { withReadOnlyCtx, flagValue } from "./ctx.js";
import { fishPath, expandPath } from "../paths.js";
import { fetchPage } from "../data-access/session-list.js";
import { parseListFilters } from "./list-filters.js";

export const LS_HELP = `Usage: atlas ls [filters] [--limit N]

Lists sessions with their numeric database IDs, suitable for \`atlas read <id>\`.
Filters: --source, --model, --path, --tag, --origin, --favorite, --state,
--chain, --from, and --to.
`;

export async function lsCmd(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(LS_HELP);
    return 0;
  }
  const limit = Number(flagValue(argv, "--limit") ?? 40);
  const parsed = parseListFilters(argv);
  if (parsed.error || !Number.isSafeInteger(limit) || limit < 1) {
    process.stderr.write(`atlas ls: ${parsed.error ?? "--limit must be a positive integer"}\n`);
    return 2;
  }
  let exitCode = 0;
  await withReadOnlyCtx(argv, async ({ db }) => {
    const page = fetchPage(db, parsed.filter, null, limit);
    if (page.error) {
      process.stderr.write(`atlas ls: ${page.error.message}\n`);
      exitCode = 2;
      return;
    }
    const rows = page.rows;

    if (rows.length === 0) {
      process.stdout.write("(no sessions — run `atlas index` first)\n");
      return;
    }

    const home = process.env.HOME ?? "~";
    for (const r of rows) {
      const when = r.last_activity ? relativeTime(r.last_activity) : "—";
      const title = (r.title ?? "(no content)").replace(/\s+/g, " ");
      const path = r.cwd ? fishPath(r.cwd, home) : r.project ?? "—";
      const toks = r.tok_total;
      const glyph = r.orphaned ? "✝" : " ";
      process.stdout.write(
        `${glyph}${originCode(r.effective_origin)} ${pad(String(r.id), 7)} ${pad(when, 9)} ${pad(r.harness, 7)} ${truncate(title, 48)}  ` +
          `${pad(path, 28)} ${pad(String(toks), 7)}t ${pad(String(r.msg_count), 4)}m\n`,
      );
    }
  });
  return exitCode;
}

function originCode(origin: string | undefined): string {
  return origin === "human" ? "H" : origin === "agent" ? "A" : origin === "mixed" ? "M" : "?";
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one.padEnd(n);
}

export { expandPath };
