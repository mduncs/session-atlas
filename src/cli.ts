#!/usr/bin/env bun
/** atlas — Session Atlas CLI entry and scriptable dispatcher. */
import { chatCmd } from "./commands/chat.js";
import { classifyHumansCmd } from "./commands/classify-humans.js";
import { doctorCmd } from "./commands/doctor.js";
import { exportCmd } from "./commands/export.js";
import { favCmd } from "./commands/fav.js";
import { indexCmd } from "./commands/index.js";
import { lsCmd } from "./commands/ls.js";
import { migrateCmd } from "./commands/migrate.js";
import { noteCmd } from "./commands/note.js";
import { readCmd } from "./commands/read.js";
import { rebuildCmd } from "./commands/rebuild.js";
import { repairCmd } from "./commands/repair.js";
import { layersCmd } from "./commands/layers.js";
import { corpusCmd, searchesCmd } from "./commands/corpus.js";
import { searchCmd } from "./commands/search.js";
import { summarizeCmd } from "./commands/summarize.js";
import { tagsCmd } from "./commands/tags.js";
import type { tuiCmd } from "./commands/tui.js";
import { readActiveLibrary } from "./library/active-library.js";

export const HELP = `atlas — Session Atlas: one searchable archive of your coding-agent sessions

Usage: atlas <command> [args] [--config <path>]

Browse
  atlas                       open the interactive TUI (also: atlas tui)
  atlas ls [filters]          list sessions; --source/model/path/tag/origin/favorite/state/chain/from/to
  atlas search <q> [filters]  literal search composed with list filters; --raw enables FTS5 syntax
  atlas read <id>             read a transcript
  atlas chat "<question>"     grounded, cited archive Q&A (needs a provider)

Keep
  atlas fav <session-id> [--from N --to M] [topic]
  atlas export <scope> [--budget N] [--launcher NAME] [--preview]
  atlas corpus save|from-search|rerun|show|list|export  saved searches as passage-ref snapshots with diffs
  atlas searches [--agents|--caller h:id]  the search log: who searched what, and what they could not see

Index and enrich
  atlas index [--full]        reconcile configured sources (provider-free)
  atlas note <session-id>     targeted ingest + summarize; --ingest-only is hook-safe
  atlas summarize [--backfill|--redo|<id>] [--concurrency N]   tier-1 summaries + tags
  atlas tags [NAME|consolidate|log] [--promote|--refresh]
  atlas classify-humans [--limit N] [--run|--all]  opt-in human/agent classifier; preview by default
  atlas layers creator|shape|all  recompute who-started / shape + episodes (provider-free)
  atlas layers plan|run|status|estimate  queue and run model layers (pauses at 95% usage, resumes after reset)

Maintain
  atlas doctor                inspect database, sources, jobs, providers, favorites
  atlas rebuild [--hard] [--yes]
  atlas repair targeted-ingest --older-than <Nm|Nh> [--yes]
  atlas repair titles [--yes] rewrite stored titles to the capped one-line projection
  atlas migrate --config <absolute-temp-config> --isolated-clone
                              migrate an isolated clone; never the live/default DB

Experimental
  atlas library [args]        the migrated library backend
  atlas library ui            the OpenTUI interface preview
  atlas --legacy              alias for the Ink dashboard

All commands accept --config <path>. The configured dbPath is authoritative.
Preview-by-default commands change nothing until --yes / --run.
`;

/** Dispatch a command-vector without process.exit, so routing is integration-testable. */
export interface CliOverrides {
  tui?: typeof tuiCmd;
  library?: (args: string[]) => Promise<void>;
  activeLibrary?: typeof readActiveLibrary;
}

export async function dispatchCli(args: string[], overrides: CliOverrides = {}): Promise<number> {
  const legacy = args[0] === "--legacy";
  if (legacy) args = args.slice(1);
  const library = async (libraryArgs: string[]): Promise<number> => {
    try { await (overrides.library ?? (await import("./library/cli.js")).main)(libraryArgs); return 0; }
    catch (error) { process.stderr.write(`atlas: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  };
  if (!legacy && args[0] === "library") return library(args.slice(1));
  const { command: cmd, rest } = splitGlobalArgs(args);
  // Help is always side-effect-free. Never let a verb-local help flag fall
  // through to indexing, rebuilding, provider calls, or another operation.
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  switch (cmd) {
    case undefined:
    case "tui":
    case "ui": {
      // Development React cost ~35% of scroll p99, and Bun picks both the
      // React build and the JSX transform at process start, so an unset
      // NODE_ENV re-executes under production instead of setting it late.
      if (overrides.tui) return overrides.tui(rest);
      if (process.env.NODE_ENV === undefined) return (await import("./production-exec.js")).execUnderProduction();
      return (await import("./commands/tui.js")).tuiCmd(rest);
    }
    case "ls": return lsCmd(rest);
    case "index": return indexCmd(rest);
    case "migrate": return migrateCmd(rest);
    case "doctor": return doctorCmd(rest);
    case "classify-humans": return classifyHumansCmd(rest);
    case "summarize": return summarizeCmd(rest);
    case "note": return noteCmd(rest);
    case "tags": return tagsCmd(rest);
    case "fav": return favCmd(rest);
    case "export": return exportCmd(rest);
    case "rebuild": return rebuildCmd(rest);
    case "repair": return repairCmd(rest);
    case "layers": return layersCmd(rest);
    case "corpus": return corpusCmd(rest);
    case "searches": return searchesCmd(rest);
    case "search": return searchCmd(rest);
    case "read": return readCmd(rest);
    case "chat": return chatCmd(rest);
    case "help":
    case "--help":
    case "-h": process.stdout.write(HELP); return 0;
    default:
      process.stderr.write(`atlas: unknown command '${cmd}'\n\n${HELP}`);
      return 2;
  }
}

/** Allow `atlas --config clone.toml` as well as verb-local `--config`. */
export function splitGlobalArgs(args: string[]): { command: string | undefined; rest: string[] } {
  const globals: string[] = [];
  let index = 0;
  while (args[index] === "--config") {
    const value = args[index + 1];
    if (value === undefined) return { command: "--config", rest: [] };
    globals.push("--config", value);
    index += 2;
  }
  return { command: args[index], rest: [...args.slice(index + 1), ...globals] };
}

if (import.meta.main) {
  dispatchCli(process.argv.slice(2)).then((code) => process.exit(code));
}
