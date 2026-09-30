import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionOrigin } from "../src/adapters/types.js";
import { openDb, type DB } from "../src/db/index.js";
import { readDashboardAnalytics } from "../src/tui/analytics.js";
import {
  compileListFilter,
  fetchAllSessionKeys,
  fetchPage,
  listFilterKey,
} from "../src/tui/queries.js";
import { seedSyntheticSession } from "./phase4-search-fixture.js";

let root: string;
let db: DB;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "atlas-test-origin-filter-"));
  db = await openDb(join(root, "isolated-atlas.db"));
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function seed(origin: SessionOrigin, lastActivity: number, chainId: number | null = null): number {
  const session = seedSyntheticSession(db, {
    nativeId: `fixture-origin-${origin}`,
    harness: origin === "agent" ? "claude" : "codex",
    title: origin === "human" ? "Debug a compiler regression" : `Synthetic ${origin} conversation`,
    lastActivity,
    chainId,
    records: [{ kind: "real_user", side: "user", prose: "Find the synthetic compiler regression" }],
  });
  db.prepare(`UPDATE sessions SET origin=? WHERE id=?`).run(origin, session.id);
  return session.id;
}

test("agent-run hiding uses raw provenance, preserving technical human, mixed, and unknown conversations", () => {
  const agentId = seed("agent", 400);
  const humanId = seed("human", 300);
  const unknownId = seed("unknown", 200);
  const mixedId = seed("mixed", 100);
  db.prepare(`INSERT INTO session_human_classifications(
    session_id,decision,confidence,reason,method,model,runner,origin_snapshot,input_hash,classified_at
  ) VALUES (?,'agent',0.9,'Synthetic technical-topic classification','conservative-default',
    'fixture','fixture','human',?,1)`).run(humanId, "0".repeat(64));

  const all = fetchPage(db, {}, null, 20);
  expect(all.error).toBeUndefined();
  expect(all.rows.map((row) => row.id)).toEqual([agentId, humanId, unknownId, mixedId]);
  expect(fetchPage(db, { hideAgentConversations: false }, null, 20).rows).toEqual(all.rows);
  expect(listFilterKey({ hideAgentConversations: false })).toBe(listFilterKey({}));
  expect(listFilterKey({ hideAgentConversations: true })).not.toBe(listFilterKey({}));

  const filtered = fetchPage(db, { hideAgentConversations: true }, null, 20);
  expect(filtered.error).toBeUndefined();
  expect(filtered.rows.map((row) => row.id)).toEqual([humanId, unknownId, mixedId]);
  expect(filtered.rows[0]).toMatchObject({ origin: "human", effective_origin: "human" });
  expect(fetchPage(db, { origin: "human", hideAgentConversations: true }, null, 20).rows.map((row) => row.id)).toEqual([humanId]);
  expect(fetchPage(db, { origin: "agent", hideAgentConversations: true }, null, 20).rows).toEqual([]);
  expect(db.prepare(`SELECT origin FROM sessions WHERE id=?`).get(agentId)).toEqual({ origin: "agent" });
  expect(db.prepare(`SELECT COUNT(*) n FROM session_human_classifications`).get()).toEqual({ n: 1 });
});

test("agent-run filter is applied before keyset pagination and composes with group selection", () => {
  const chainId = Number(db.prepare(`INSERT INTO chains(member_count) VALUES (3)`).run().lastInsertRowid);
  seed("agent", 400, chainId);
  const humanId = seed("human", 300, chainId);
  const unknownId = seed("unknown", 200, chainId);
  seed("mixed", 100);
  const filter = { hideAgentConversations: true, chain: { mode: "chain" as const, id: chainId } };

  const first = fetchPage(db, filter, null, 1);
  expect(first.error).toBeUndefined();
  expect(first.rows.map((row) => row.id)).toEqual([humanId]);
  expect(first.hasMore).toBe(true);
  const second = fetchPage(db, filter, first.rows[0], 1);
  expect(second.rows.map((row) => row.id)).toEqual([unknownId]);
  expect(second.hasMore).toBe(false);
  expect(fetchAllSessionKeys(db, filter)).toEqual([
    '["codex","fixture-origin-human"]',
    '["codex","fixture-origin-unknown"]',
  ]);
});

test("ranked search, select-all, and filtered analytics agree while the whole corpus stays counted", () => {
  seed("agent", 400);
  seed("human", 300);
  seed("unknown", 200);
  seed("mixed", 100);
  const filter = { query: "compiler", hideAgentConversations: true };
  const first = fetchPage(db, filter, null, 2);
  expect(first.error).toBeUndefined();
  expect(first.total).toBe(3);
  expect(first.rows).toHaveLength(2);
  expect(first.hasMore).toBe(true);
  const second = fetchPage(db, filter, first.rows.at(-1), 2);
  expect(second.error).toBeUndefined();
  expect(second.total).toBe(3);
  expect(second.rows).toHaveLength(1);
  expect(second.hasMore).toBe(false);
  const origins = [...first.rows, ...second.rows].map((row) => row.origin).sort();
  expect(origins).toEqual(["human", "mixed", "unknown"]);
  expect(fetchAllSessionKeys(db, filter)).toHaveLength(3);
  expect(fetchPage(db, { query: "compiler" }, null, 20).total).toBe(4);

  const analytics = readDashboardAnalytics(db, filter, 500);
  expect(analytics.corpusSessionCount).toBe(4);
  expect(analytics.visibleSessionCount).toBe(3);
  expect(analytics.sources.map((source) => [source.source, source.count])).toEqual([["codex", 3]]);
  expect(analytics.states.pending).toBe(3);
  expect(readDashboardAnalytics(db, {}, 500).visibleSessionCount).toBe(4);
});

test("null provenance remains visible when evaluating the shared predicate", () => {
  // Current sessions.origin is NOT NULL; this small compatibility table also
  // verifies the fail-open behavior for a missing legacy provenance value.
  const nullable = new Database(":memory:");
  try {
    nullable.exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY, origin TEXT);
      INSERT INTO sessions(origin) VALUES (NULL),('unknown'),('human'),('mixed'),('agent');`);
    const compiled = compileListFilter({ hideAgentConversations: true }, "candidate");
    expect(nullable.prepare(`SELECT id FROM sessions candidate
      WHERE ${compiled.predicates.join(" AND ")} ORDER BY id`).all(...compiled.predicateParams))
      .toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  } finally {
    nullable.close();
  }
});
