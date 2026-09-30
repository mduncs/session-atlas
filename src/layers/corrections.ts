/** md's one-key creator corrections, written through an archive handle with `layers` attached. */
import type { DB } from "../db/index.js";
import { effectiveCreatorSql, type EffectiveCreator } from "./creator-sql.js";

export interface SessionIdentity { harness: string; nativeId: string }

export function readCreator(db: DB, key: SessionIdentity): EffectiveCreator {
  const row = db.query(`SELECT ${effectiveCreatorSql("s")} AS creator FROM sessions s WHERE s.harness=? AND s.native_id=?`)
    .get(key.harness, key.nativeId) as { creator: EffectiveCreator } | null;
  return row?.creator ?? "unknown";
}

/** Set md's verdict; returns the previous effective creator (for undo). */
export function correctCreator(db: DB, key: SessionIdentity, startedBy: "human" | "agent", now = Date.now()): EffectiveCreator {
  const previous = readCreator(db, key);
  db.query(`INSERT OR REPLACE INTO layers.creator_corrections(harness,native_id,started_by,previous,corrected_at) VALUES(?,?,?,?,?)`)
    .run(key.harness, key.nativeId, startedBy, previous, now);
  return previous;
}

/** Cycle human → agent → human (unknown starts at human): the one-key toggle. */
export function toggleCreator(db: DB, key: SessionIdentity, now = Date.now()): "human" | "agent" {
  const next = readCreator(db, key) === "human" ? "agent" : "human";
  correctCreator(db, key, next, now);
  return next;
}

export function clearCorrection(db: DB, key: SessionIdentity): void {
  db.query(`DELETE FROM layers.creator_corrections WHERE harness=? AND native_id=?`).run(key.harness, key.nativeId);
}
