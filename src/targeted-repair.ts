import type { DB } from "./db/index.js";
import { bumpLastWrite } from "./db/index.js";

export const TARGETED_REPAIR_REASON_PREFIX = "synthetic recovery: interrupted targeted ingest";

export interface TargetedRepairOptions {
  ageMs: number;
  ageLabel: string;
  nowMs?: number;
  confirmed: boolean;
}

export interface TargetedRepairReport {
  cutoffMs: number;
  ageLabel: string;
  before: number;
  repaired: number;
  after: number;
  confirmed: boolean;
}

/**
 * Preview or recover stale targeted-ingest attempts. The caller supplies the
 * construction-authority boundary; this function only changes the targeted
 * run table and never invokes an adapter or provider.
 */
export function repairStaleTargetedRuns(db: DB, options: TargetedRepairOptions): TargetedRepairReport {
  if (!Number.isInteger(options.ageMs) || options.ageMs <= 0) {
    throw new Error("targeted-ingest repair age must be a positive duration");
  }
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = nowMs - options.ageMs;
  const count = () => Number((db.prepare(
    `SELECT COUNT(*) AS count
       FROM targeted_ingest_runs
      WHERE status='running' AND finished_at IS NULL AND started_at <= ?`,
  ).get(cutoffMs) as { count: number }).count);
  const before = count();
  if (!options.confirmed) {
    return { cutoffMs, ageLabel: options.ageLabel, before, repaired: 0, after: before, confirmed: false };
  }

  let repaired = 0;
  const reason = `${TARGETED_REPAIR_REASON_PREFIX}; stale threshold ${options.ageLabel}`;
  db.transaction(() => {
    repaired = Number(db.prepare(
      `UPDATE targeted_ingest_runs
          SET finished_at=?, status='failed', error=?
        WHERE status='running' AND finished_at IS NULL AND started_at <= ?`,
    ).run(nowMs, reason, cutoffMs).changes);
  })();
  if (repaired > 0) bumpLastWrite(db);
  return { cutoffMs, ageLabel: options.ageLabel, before, repaired, after: count(), confirmed: true };
}

export function parseRepairAge(value: string | undefined): { ageMs: number; ageLabel: string } {
  if (!value || !/^\d+(?:m|h)$/.test(value)) {
    throw new Error("targeted-ingest repair requires --older-than <positive-minutes-or-hours> (for example 30m or 2h)");
  }
  const amount = Number(value.slice(0, -1));
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("targeted-ingest repair age must be a positive duration");
  }
  const ageMs = amount * (value.endsWith("h") ? 60 * 60_000 : 60_000);
  if (!Number.isSafeInteger(ageMs)) throw new Error("targeted-ingest repair age is too large");
  return { ageMs, ageLabel: value };
}
