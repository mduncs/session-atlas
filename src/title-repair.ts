import type { DB } from "./db/index.js";
import { bumpLastWrite } from "./db/index.js";
import { displayTitle } from "./ingest.js";

export interface TitleRepairReport {
  scanned: number;
  stale: number;
  repaired: number;
  bytesBefore: number;
  bytesAfter: number;
  confirmed: boolean;
}

/**
 * Preview or rewrite stored session titles to the current display projection.
 * Ingest already publishes `displayTitle`; this brings rows written before the
 * cap into line without a re-ingest. Title evidence, and therefore title
 * search, is untouched. The caller supplies the construction-authority boundary.
 */
export function repairSessionTitles(db: DB, options: { confirmed: boolean }): TitleRepairReport {
  const rows = db.prepare(`SELECT id, title FROM sessions WHERE title IS NOT NULL`).all() as { id: number; title: string }[];
  const stale: { id: number; title: string | null }[] = [];
  let bytesBefore = 0;
  let bytesAfter = 0;
  for (const row of rows) {
    const next = displayTitle(row.title);
    if (next === row.title) continue;
    stale.push({ id: row.id, title: next });
    bytesBefore += Buffer.byteLength(row.title);
    bytesAfter += next === null ? 0 : Buffer.byteLength(next);
  }
  const report = { scanned: rows.length, stale: stale.length, repaired: 0, bytesBefore, bytesAfter, confirmed: options.confirmed };
  if (!options.confirmed || stale.length === 0) return report;

  const update = db.prepare(`UPDATE sessions SET title=? WHERE id=?`);
  db.transaction(() => {
    for (const row of stale) report.repaired += Number(update.run(row.title, row.id).changes);
  })();
  if (report.repaired > 0) bumpLastWrite(db);
  return report;
}
