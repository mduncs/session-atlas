import type { DB } from "../db/index.js";
import { computeCreators } from "./creator.js";
import { openLayersDb } from "./db.js";
import { computeShapes, formatShapes } from "./shape.js";

/**
 * Provider-free interpretation layers follow every ingest, so a new session is
 * decided human/agent before any lens sees it. A layer failure never fails ingest.
 */
export function refreshLayers(db: DB, dbPath: string, log: (line: string) => void = () => {}): boolean {
  try {
    const layers = openLayersDb(dbPath);
    try {
      const creators = computeCreators(db, layers);
      log(`layers · creator ${creators.human} human / ${creators.agent} agent / ${creators.unknown} unknown · ${creators.ms} ms`);
      const shapes = computeShapes(db, layers);
      log(`layers · shape ${formatShapes(shapes.shapes)} · ${shapes.episodes} episodes · ${shapes.ms} ms`);
      return true;
    } finally { layers.close(); }
  } catch (error) {
    log(`layers skipped: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
