import type { DB } from "../db/index.js";
import { openDb, openReadOnlyDb } from "../db/index.js";
import type { Config } from "../config.js";
import { ConfigError, loadConfig, DEFAULT_CONFIG_PATH } from "../config.js";
import { expandPath } from "../paths.js";
import type { VolumeIdentityProbe } from "../runtime/storage-identity.js";
import { withConstructionAuthority } from "../runtime/writer-coordinator.js";

export interface CliCtx {
  db: DB;
  config: Config;
  configPath: string;
  dbPath: string;
}

export interface RuntimeCtx {
  config: Config;
  configPath: string;
  dbPath: string;
}

export interface MutableCtxOptions {
  storageProbe?: VolumeIdentityProbe;
}

/** Resolve the command's complete runtime target without opening it. */
export async function resolveRuntimeCtx(argv: string[], options: { bootstrap?: boolean } = {}): Promise<RuntimeCtx> {
  const configPath = flagValue(argv, "--config") ?? DEFAULT_CONFIG_PATH;
  try {
    const config = await loadConfig(configPath, options);
    return { config, configPath, dbPath: expandPath(config.dbPath) };
  } catch (error) {
    // The top-level dispatcher is intentionally frozen. Preserve exact CLI
    // invocation/config exit 2 even when the rejected promise reaches Bun.
    if (error instanceof ConfigError) {
      process.exitCode = 2;
      // The frozen CLI dispatcher attaches no rejection handler, and Bun
      // otherwise replaces an assigned exitCode with 1 for the uncaught
      // rejection. Direct CLI execution must still honor the config contract;
      // programmatic dispatch keeps receiving the typed exception.
      if (process.argv[1]?.endsWith("/src/cli.ts")) {
        process.stderr.write(`atlas: ${error.message}\n`);
        process.exit(2);
      }
    }
    throw error;
  }
}

export async function withCtx<T>(
  argv: string[],
  fn: (ctx: CliCtx) => Promise<T> | T,
  options: MutableCtxOptions = {},
): Promise<T> {
  const runtime = await resolveRuntimeCtx(argv);
  const db = await openDb(runtime.dbPath, {
    storage: runtime.config.storage,
    storageProbe: options.storageProbe,
  });
  try {
    return await fn({ db, ...runtime });
  } finally {
    db.close();
  }
}

/** Construction authority is operation-scoped; the DB handle lives only inside it. */
export async function withConstructionCtx<T>(
  argv: string[],
  operation: string,
  fn: (ctx: CliCtx) => Promise<T> | T,
  options: MutableCtxOptions = {},
): Promise<T> {
  const runtime = await resolveRuntimeCtx(argv);
  return withConstructionAuthority({
    dbPath: runtime.dbPath,
    config: runtime.config,
    operation,
    probe: options.storageProbe,
  }, async () => {
    const db = await openDb(runtime.dbPath, {
      storage: runtime.config.storage,
      storageProbe: options.storageProbe,
    });
    try {
      return await fn({ db, ...runtime });
    } finally {
      db.close();
    }
  });
}

/** Existing-database, no-bootstrap context for read/status commands. */
export async function withReadOnlyCtx<T>(
  argv: string[],
  fn: (ctx: CliCtx) => Promise<T> | T,
): Promise<T> {
  const runtime = await resolveRuntimeCtx(argv, { bootstrap: false });
  const db = openReadOnlyDb(runtime.dbPath);
  try {
    return await fn({ db, ...runtime });
  } finally {
    db.close();
  }
}

export function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}
