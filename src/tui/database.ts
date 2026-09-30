import { existsSync, readFileSync } from "node:fs";
import { openDb, openReadOnlyDb, type OpenDbOptions } from "../db/index.js";

/** A published migration retains the old index for safe Ink browsing. Never
 * bypass a rebuild/preparation fence or turn this into a writable connection. */
export function hasPublishedLegacyFence(path: string): boolean {
  const lock = `${path}.maintenance.lock`;
  if (existsSync(lock)) {
    try {
      const owner = JSON.parse(readFileSync(lock, "utf8"));
      const state = JSON.parse(readFileSync(owner.stateFile, "utf8"));
      if (typeof owner.liveCutoverToken === "string" && owner.liveCutoverToken.length > 0
        && state.token === owner.liveCutoverToken && state.phase === "published"
        && state.spec?.legacyDatabase === path) {
        return true;
      }
    } catch { /* Unknown locks are not a published, browsable archive. */ }
  }
  return false;
}

export function openComparisonDatabase(path: string) {
  if (existsSync(`${path}.maintenance.lock`) && !hasPublishedLegacyFence(path)) {
    throw new Error(`Database is under maintenance: ${path}`);
  }
  return { db: openReadOnlyDb(path), readOnly: true };
}

export async function openTuiDatabase(path: string, options: OpenDbOptions = {}) {
  if (hasPublishedLegacyFence(path)) return { db: openReadOnlyDb(path), readOnly: true };
  return { db: await openDb(path, options), readOnly: false };
}
