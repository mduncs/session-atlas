import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

type Environment = Record<string, string | undefined>;
export interface ActiveLibrary { database: string; kind: "library" | "legacy"; pointer: string }

/** Read the cutover pointer without bootstrapping configuration or opening a writer. */
export function readActiveLibrary(env: Environment = process.env): ActiveLibrary | null {
  const pointer = join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "session-atlas", "library-pointer.json");
  let contents: string;
  try { contents = readFileSync(pointer, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const value: unknown = JSON.parse(contents);
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("database" in value) || typeof value.database !== "string" || !isAbsolute(value.database)) {
      throw new Error("expected version 1 and an absolute database path");
    }
    const database = value.database;
    const db = new Database(database, { readonly: true, create: false, strict: true });
    try {
      const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
      if (tables.has("library_meta")) {
        const version = db.query("SELECT value FROM library_meta WHERE key='schema'").get() as { value: string } | null;
        if (version?.value !== "1" || !["library_sessions", "library_passages", "library_sources", "library_favorites", "library_journal"].every(name => tables.has(name))) throw new Error("unsupported or incomplete library schema");
        return { database, kind: "library", pointer };
      }
      if (tables.has("sessions") && tables.has("meta")) {
        const columns = new Set((db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map(row => row.name));
        if (columns.has("harness") && columns.has("native_id")) return { database, kind: "legacy", pointer };
      }
      throw new Error("unrecognized database schema");
    } finally { db.close(); }
  } catch (error) {
    throw new Error(`Invalid active library pointer ${pointer}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolveLibraryPath(explicit?: string, env: Environment = process.env): string {
  const override = explicit ?? env.ATLAS_LIBRARY_DB;
  if (override !== undefined) return resolve(override);
  const active = readActiveLibrary(env);
  if (active?.kind === "legacy") throw new Error(`Active library pointer ${active.pointer} targets an incompatible legacy database (${active.database}); use atlas --legacy or supply --library.`);
  return active?.database ?? join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "session-atlas-library", "library.db");
}
