import type { ChainFilter, ListFilter, SessionStateFilter } from "../data-access/session-list.js";
import type { SessionOrigin } from "../adapters/types.js";
import { flagValue, hasFlag } from "./ctx.js";

const STATE_VALUES = new Set<SessionStateFilter>(["indexed", "orphaned", "summarized", "unsummarized", "pending", "failed"]);
const ORIGIN_VALUES = new Set<SessionOrigin>(["human", "agent", "mixed", "unknown"]);
const VALUED_FLAGS = new Set([
  "--config", "--limit", "--query", "--source", "--harness", "--model",
  "--path", "--project", "--tag", "--from", "--to", "--state", "--chain", "--origin",
]);

export interface ParsedListFilters {
  filter: ListFilter;
  positionals: string[];
  error?: string;
}

/** Parse the scriptable counterpart of the TUI's full narrowing algebra. */
export function parseListFilters(argv: string[]): ParsedListFilters {
  const filter: ListFilter = {};
  const source = flagValue(argv, "--source") ?? flagValue(argv, "--harness");
  const path = flagValue(argv, "--path") ?? flagValue(argv, "--project");
  if (source) filter.source = source;
  if (flagValue(argv, "--model")) filter.model = flagValue(argv, "--model");
  if (path) filter.path = path;
  if (flagValue(argv, "--tag")) filter.tag = flagValue(argv, "--tag");
  if (flagValue(argv, "--query")) filter.query = flagValue(argv, "--query");
  if (hasFlag(argv, "--favorite") && hasFlag(argv, "--not-favorite")) {
    return { filter, positionals: positionalArgs(argv), error: "--favorite and --not-favorite are mutually exclusive" };
  }
  if (hasFlag(argv, "--favorite")) filter.favorite = true;
  if (hasFlag(argv, "--not-favorite")) filter.favorite = false;

  const state = flagValue(argv, "--state");
  if (state) {
    if (!STATE_VALUES.has(state as SessionStateFilter)) {
      return { filter, positionals: positionalArgs(argv), error: `invalid --state ${state}` };
    }
    filter.state = state as SessionStateFilter;
  }

  const origin = flagValue(argv, "--origin");
  if (origin) {
    if (!ORIGIN_VALUES.has(origin as SessionOrigin)) {
      return { filter, positionals: positionalArgs(argv), error: `invalid --origin ${origin}` };
    }
    filter.origin = origin as SessionOrigin;
  }

  const chain = flagValue(argv, "--chain");
  if (chain) {
    const parsed = parseChain(chain);
    if (!parsed) return { filter, positionals: positionalArgs(argv), error: `invalid --chain ${chain}` };
    filter.chain = parsed;
  }

  const fromRaw = flagValue(argv, "--from");
  const toRaw = flagValue(argv, "--to");
  if (fromRaw || toRaw) {
    const from = fromRaw ? parseInstant(fromRaw) : 0;
    const to = toRaw ? parseInstant(toRaw) : null;
    if (from === null) return { filter, positionals: positionalArgs(argv), error: `invalid --from ${fromRaw}` };
    if (toRaw && to === null) return { filter, positionals: positionalArgs(argv), error: `invalid --to ${toRaw}` };
    if (to !== null && from >= to) return { filter, positionals: positionalArgs(argv), error: "--from must be earlier than --to" };
    filter.date = { from, to, label: [fromRaw ?? "start", toRaw ?? "now"].join("..") };
  }

  return { filter, positionals: positionalArgs(argv) };
}

function positionalArgs(argv: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (VALUED_FLAGS.has(arg)) { index++; continue; }
    if (!arg.startsWith("-")) values.push(arg);
  }
  return values;
}

function parseInstant(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseChain(value: string): ChainFilter | null {
  if (value === "chained" || value === "standalone") return { mode: value };
  const match = /^(?:id:)?(\d+)$/.exec(value);
  return match ? { mode: "chain", id: Number(match[1]) } : null;
}
