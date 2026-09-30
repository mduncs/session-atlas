import { createFavorite, resolveSessionRef, type FavoriteRecord, type StableSessionRef } from "../favorites.js";
import { ingestOne } from "../ingest.js";
import { flagValue, withCtx } from "./ctx.js";
import { isConstructionRefusal, withConstructionAuthority } from "../runtime/writer-coordinator.js";

export interface FavoriteCommandResult {
  favorite: FavoriteRecord;
  targetedHarnesses: string[];
}

/** Command-independent favorite operation used by the CLI and TUI wiring. */
export async function favoriteIdentifier(
  db: import("../db/index.js").DB,
  config: import("../config.js").Config,
  identifier: string,
  options: { harness?: string; from?: number; to?: number; topic?: string; wholeSession?: boolean } = {},
): Promise<FavoriteCommandResult> {
  let ref = resolveSessionRef(db, identifier, options.harness);
  const targetedHarnesses: string[] = [];
  let targetedRefusal: Error | null = null;
  if (!ref) {
    const harnesses = options.harness ? [options.harness] : Object.keys(config.sources);
    try {
      await withConstructionAuthority({
        dbPath: config.dbPath,
        config,
        operation: "atlas fav targeted ingest",
      }, async () => {
        for (const harness of harnesses) {
          targetedHarnesses.push(harness);
          const result = await ingestOne(db, config, harness, identifier);
          if (result.found) {
            ref = { harness, nativeId: identifier };
            break;
          }
        }
      });
    } catch (error) {
      if (!isConstructionRefusal(error)) throw error;
      targetedRefusal = error;
    }
  }
  // Unknown ids are still durable. If no harness can be inferred, use the
  // explicit hint or the only configured source; truly ambiguous input is a
  // usage error because stable identity includes harness.
  if (!ref) {
    const configured = Object.keys(config.sources);
    if (options.harness) ref = { harness: options.harness, nativeId: identifier };
    else if (configured.length === 1) ref = { harness: configured[0]!, nativeId: identifier };
    else throw new Error(`unknown session '${identifier}'; pass --harness so the pending favorite has stable identity`);
  }

  const target: StableSessionRef = ref;
  const favorite = await createFavorite(
    db,
    {
      ...target,
      fromOrdinal: options.from,
      toOrdinal: options.to,
      topic: options.topic,
      wholeSession: options.wholeSession,
    },
    {
      defaultSpan: config.tunables.fav_default_span,
      targetedIngest: async () => {
        targetedHarnesses.push(target.harness);
        if (targetedRefusal) throw targetedRefusal;
        await withConstructionAuthority({
          dbPath: config.dbPath,
          config,
          operation: "atlas fav targeted ingest",
        }, () => ingestOne(db, config, target.harness, target.nativeId));
      },
    },
  );
  return { favorite, targetedHarnesses };
}

/** atlas fav <session-id> [--harness H] [--from N --to M] [topic] */
export async function favCmd(argv: string[]): Promise<number> {
  const positional = positionalArgs(argv, new Set(["--config", "--harness", "--from", "--to", "--session", "--topic"]));
  const identifier = flagValue(argv, "--session") ?? positional[0];
  if (!identifier) {
    process.stderr.write("atlas fav <session-id> [--harness claude|codex|kilo] [--from N --to M] [topic]\n");
    return 2;
  }
  const fromRaw = flagValue(argv, "--from");
  const toRaw = flagValue(argv, "--to");
  const from = fromRaw === undefined ? undefined : Number(fromRaw);
  const to = toRaw === undefined ? undefined : Number(toRaw);
  let exitCode = 0;
  await withCtx(argv, async ({ db, config }) => {
    try {
      const { favorite } = await favoriteIdentifier(db, config, identifier, {
        harness: flagValue(argv, "--harness") ?? inferHarness(),
        from,
        to,
        topic: flagValue(argv, "--topic") ?? (positional.slice(1).join(" ") || undefined),
      });
      process.stdout.write(
        `★ ${favorite.harness}/${favorite.nativeId}` +
          (favorite.topic ? ` · ${favorite.topic}` : "") +
          (favorite.status === "pending" ? ` · pending (${favorite.lastError ?? "awaiting ingest"})` : "") +
          "\n",
      );
    } catch (error) {
      exitCode = 2;
      process.stderr.write(`atlas fav: ${messageOf(error)}\n`);
    }
  });
  return exitCode;
}

function positionalArgs(argv: string[], valuedFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!;
    if (valuedFlags.has(value)) {
      i++;
      continue;
    }
    if (!value.startsWith("-")) out.push(value);
  }
  return out;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inferHarness(): string | undefined {
  if (process.env.ATLAS_HARNESS) return process.env.ATLAS_HARNESS;
  if (process.env.CLAUDECODE || process.env.CLAUDE_SESSION_ID) return "claude";
  if (process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID) return "codex";
  if (process.env.KILO_SESSION_ID) return "kilo";
  return undefined;
}
