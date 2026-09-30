import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/db/index.js";
import { attachLayers } from "../src/layers/db.js";
import { buildPercentileMap, fetchPage } from "../src/tui/queries.js";

test("percentile normalization exactly matches percent_rank ties", () => {
  const map = buildPercentileMap([
    { id: 4, total: 40 },
    { id: 2, total: 20 },
    { id: 1, total: 10 },
    { id: 3, total: 20 },
  ]);

  expect(map.get(1)).toBe(0);
  expect(map.get(2)).toBeCloseTo(1 / 3);
  expect(map.get(3)).toBeCloseTo(1 / 3);
  expect(map.get(4)).toBe(1);
  expect(buildPercentileMap([{ id: 7, total: 10 }]).get(7)).toBe(0);
});

test("cold 6K-row page normalization stays inside the interactive budget", () => {
  const db = database();
  const insert = db.prepare(
    `INSERT INTO sessions(
       harness,native_id,source_path,title,last_activity,ingested_at,
       tok_user,tok_assistant,tok_tool,msg_count
     ) VALUES ('codex',?,'/fixture',?,?,1,?,?,?,1)`,
  );
  db.transaction(() => {
    for (let index = 0; index < 6_000; index++) {
      insert.run(
        `native-${index}`,
        `row ${index}`,
        6_000 - index,
        index % 101,
        (index * 7) % 83,
        (index * 13) % 47,
      );
    }
  })();
  revision(db, 1);

  const plan = db.prepare(
    `EXPLAIN QUERY PLAN
     SELECT s.id, s.tok_user+s.tok_assistant+s.tok_tool AS total
     FROM sessions s ORDER BY total, s.id`,
  ).all() as Array<{ detail: string }>;
  expect(plan.some((step) => step.detail.includes("COVERING INDEX idx_sessions_token_total"))).toBe(true);

  const started = performance.now();
  const first = fetchPage(db, {}, null, 300);
  const coldMs = performance.now() - started;
  const warmStarted = performance.now();
  const second = fetchPage(db, {}, null, 300);
  const warmMs = performance.now() - warmStarted;

  expect(first.error).toBeUndefined();
  expect(first.rows).toHaveLength(300);
  expect(second.rows.map((row) => row.sizePct)).toEqual(first.rows.map((row) => row.sizePct));
  // The former SQLite window query had a ~292ms live cold path. This leaves
  // broad shared-runner headroom while keeping list startup interactive.
  expect(coldMs).toBeLessThan(100);
  expect(warmMs).toBeLessThan(50);
  db.close();
});

test("percentile caches are connection-scoped and invalidate on archive revision", () => {
  const firstDb = database();
  seedTotals(firstDb, [10, 20, 30]);
  revision(firstDb, 7);
  expect(sizeByNativeId(firstDb, "native-0")).toBe(0);

  firstDb.prepare(`UPDATE sessions SET tok_user=100,tok_assistant=0,tok_tool=0 WHERE native_id='native-0'`).run();
  // Writers publish a revision after their transaction; until that point the
  // current refresh deliberately remains stable.
  expect(sizeByNativeId(firstDb, "native-0")).toBe(0);
  revision(firstDb, 8);
  expect(sizeByNativeId(firstDb, "native-0")).toBe(1);

  const secondDb = database();
  seedTotals(secondDb, [100, 50, 25]);
  revision(secondDb, 8);
  expect(sizeByNativeId(secondDb, "native-0")).toBe(1);
  expect(sizeByNativeId(secondDb, "native-2")).toBe(0);

  firstDb.close();
  secondDb.close();
});

function database(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  attachLayers(db, ":memory:");
  return db;
}

function seedTotals(db: Database, totals: number[]): void {
  const insert = db.prepare(
    `INSERT INTO sessions(
       harness,native_id,source_path,title,last_activity,ingested_at,
       tok_user,tok_assistant,tok_tool,msg_count
     ) VALUES ('claude',?,'/fixture',?,?,1,?,0,0,1)`,
  );
  totals.forEach((total, index) => insert.run(`native-${index}`, `row ${index}`, totals.length - index, total));
}

function revision(db: Database, value: number): void {
  db.prepare(
    `INSERT INTO meta(key,value) VALUES ('last_write',?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(String(value));
}

function sizeByNativeId(db: Database, nativeId: string): number {
  const row = fetchPage(db, {}, null, 20).rows.find((candidate) => candidate.native_id === nativeId);
  if (!row) throw new Error(`missing ${nativeId}`);
  return row.sizePct;
}
