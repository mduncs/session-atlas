import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createSessionSearchService } from "../src/search/service.js";
import { emptySearchFilter } from "../src/search/compiler.js";
import { applyV12SearchFragment } from "../src/search/v12-fts.js";
import { phase4Database, seedSyntheticSession } from "./phase4-search-fixture.js";

let db: Database | null = null;
afterEach(() => { db?.close(); db = null; });

test("search query plan is MATCH-driven and deterministic without OFFSET", () => {
  db = phase4Database();
  for (let index = 0; index < 120; index++) {
    seedSyntheticSession(db, {
      nativeId: `fixture-perf-${index}`,
      lastActivity: index,
      records: [{ kind: "real_user", side: "user", prose: `planbeacon ${index % 3 === 0 ? "sharedtoken" : "other"}` }],
    });
  }
  applyV12SearchFragment(db);
  const plan = db.prepare(
    `EXPLAIN QUERY PLAN
     WITH matched_documents AS MATERIALIZED (
       SELECT d.session_id,bm25(session_search_fts,1.0,1.0) AS score
       FROM session_search_fts
       JOIN session_search_documents d ON d.id=session_search_fts.rowid
       WHERE session_search_fts MATCH ?
       ORDER BY bm25(session_search_fts,1.0,1.0)
     )
     SELECT session_id,MIN(score) FROM matched_documents GROUP BY session_id`,
  ).all('prose : ("sharedtoken")') as Array<{ detail: string }>;
  expect(plan.some((step) => /SCAN session_search_fts VIRTUAL TABLE INDEX.*M/i.test(step.detail))).toBe(true);

  const started = performance.now();
  const result = createSessionSearchService(db).search({
    query: "sharedtoken", syntax: "literal", filters: emptySearchFilter(), pageSize: 12, cursor: null,
  });
  const elapsed = performance.now() - started;
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.page.total).toBe(40);
  expect(result.page.hits).toHaveLength(12);
  expect(result.page.hits.map((hit) => hit.session.lastActivityTs)).toEqual([
    117, 114, 111, 108, 105, 102, 99, 96, 93, 90, 87, 84,
  ]);
  expect(elapsed).toBeLessThan(100);
});
