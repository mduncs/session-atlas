import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/db/index.js";
import {
  parseRepairAge,
  repairStaleTargetedRuns,
  TARGETED_REPAIR_REASON_PREFIX,
} from "../src/targeted-repair.js";

const NOW = 10_000_000;

test("repairs the exact cutoff while preserving newer running rows", () => {
  const db = fixture();
  try {
    insert(db, "at-cutoff", NOW - 30 * 60_000);
    insert(db, "newer", NOW - 30 * 60_000 + 1);
    const report = repairStaleTargetedRuns(db, {
      ageMs: 30 * 60_000,
      ageLabel: "30m",
      nowMs: NOW,
      confirmed: true,
    });
    expect(report).toMatchObject({ before: 1, repaired: 1, after: 0, confirmed: true });
    expect(db.prepare("SELECT status,finished_at,error FROM targeted_ingest_runs WHERE native_id='at-cutoff'").get()).toEqual({
      status: "failed",
      finished_at: NOW,
      error: `${TARGETED_REPAIR_REASON_PREFIX}; stale threshold 30m`,
    });
    expect(db.prepare("SELECT status,finished_at,error FROM targeted_ingest_runs WHERE native_id='newer'").get()).toEqual({
      status: "running",
      finished_at: null,
      error: null,
    });
  } finally { db.close(); }
});

test("preview and no-op are non-mutating, and live repair requires explicit confirmation", () => {
  const db = fixture();
  try {
    insert(db, "stale", NOW - 60 * 60_000);
    const preview = repairStaleTargetedRuns(db, {
      ageMs: 30 * 60_000,
      ageLabel: "30m",
      nowMs: NOW,
      confirmed: false,
    });
    expect(preview).toMatchObject({ before: 1, repaired: 0, after: 1, confirmed: false });
    expect(db.prepare("SELECT status,finished_at,error FROM targeted_ingest_runs").get()).toEqual({
      status: "running", finished_at: null, error: null,
    });

    const noOp = repairStaleTargetedRuns(db, {
      ageMs: 2 * 60 * 60_000,
      ageLabel: "2h",
      nowMs: NOW,
      confirmed: true,
    });
    expect(noOp).toMatchObject({ before: 0, repaired: 0, after: 0, confirmed: true });
    expect(db.prepare("SELECT status FROM targeted_ingest_runs").get()).toEqual({ status: "running" });
  } finally { db.close(); }
});

test("repair age accepts minutes and hours but requires an explicit positive threshold", () => {
  expect(parseRepairAge("30m")).toEqual({ ageMs: 30 * 60_000, ageLabel: "30m" });
  expect(parseRepairAge("2h")).toEqual({ ageMs: 2 * 60 * 60_000, ageLabel: "2h" });
  expect(() => parseRepairAge(undefined)).toThrow();
  expect(() => parseRepairAge("0m")).toThrow();
  expect(() => parseRepairAge("30s")).toThrow();
});

function fixture(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function insert(db: Database, nativeId: string, startedAt: number): void {
  db.prepare(
    `INSERT INTO targeted_ingest_runs(source,harness,native_id,trigger_kind,started_at,status)
     VALUES ('claude','claude',?,'hook',?,'running')`,
  ).run(nativeId, startedAt);
}
