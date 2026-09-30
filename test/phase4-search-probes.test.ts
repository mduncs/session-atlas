import { afterEach, describe, expect, test } from "bun:test";
import type { SearchSyntax } from "../src/fts-query.js";
import { createSessionSearchService } from "../src/search/service.js";
import { emptySearchFilter } from "../src/search/compiler.js";
import { fetchPage } from "../src/data-access/session-list.js";
import { seedLayerE } from "./phase4-search-fixture.js";
import type { Database } from "bun:sqlite";

let db: Database | null = null;
afterEach(() => { db?.close(); db = null; });

function query(text: string, syntax: SearchSyntax = "literal", pageSize = 30) {
  const seeded = seedLayerE(); db = seeded.db;
  return {
    seeded,
    result: createSessionSearchService(db).search({
      query: text,
      syntax,
      filters: emptySearchFilter(),
      pageSize,
      cursor: null,
    }),
  };
}

function nativeIds(result: ReturnType<typeof query>["result"]): string[] {
  if (!result.ok) throw new Error(result.error.message);
  return result.page.hits.map((hit) => hit.session.sessionKey.nativeId);
}

function requirePage(result: ReturnType<typeof query>["result"]) {
  if (!result.ok) throw new Error(result.error.message);
  return result.page;
}

describe("CENSUS §4 Q01-Q10 query semantics", () => {
  const punctuation = [
    ["Q01", "session-atlas"],
    ["Q02", "cost-effective"],
    ["Q04", "C++"],
    ["Q05", "parentSession"],
    ["Q06", "native_prime_child"],
    ["Q07", "messages_fts"],
    ["Q08", "src/commands/search.ts"],
    ["Q09", "fixture/root/session-atlas"],
    ["Q10", "rlm-subagents.jsonl"],
  ] as const;

  for (const [id, text] of punctuation) {
    test(`${id} default literal preserves the complete punctuation/code atom`, () => {
      const { result } = query(text);
      expect(result.ok).toBe(true);
      expect(nativeIds(result)).toContain("fixture-strong");
      if (id === "Q04") expect(nativeIds(result)).not.toContain("fixture-cpp-decoy");
      const page = requirePage(result);
      const hit = page.hits.find((candidate) => candidate.session.sessionKey.nativeId === "fixture-strong")!;
      expect(hit.snippets.some((snippet) => snippet.text.includes(text))).toBe(true);
    });
  }

  test("Q03 balanced quotes compile one exact adjacent phrase", () => {
    const { result } = query('"source logs"');
    expect(nativeIds(result)).toEqual(["fixture-strong"]);
    const snippet = requirePage(result).hits[0]!.snippets[0]!;
    expect(snippet.text.slice(snippet.matchStart, snippet.matchEnd)).toBe("source logs");
  });
});

describe("CENSUS §4 B11-B13 behavior", () => {
  test("B11 ranks relevance before recency with deterministic ties", () => {
    const { result } = query("session-atlas");
    expect(nativeIds(result)).toEqual(["fixture-strong", "fixture-recent"]);
  });

  test("B12 returns evidence from the actual matching logical row", () => {
    const { seeded, result } = query("messages_fts");
    const page = requirePage(result);
    const hit = page.hits[0]!;
    expect(hit.snippets).not.toHaveLength(0);
    expect(hit.snippets.every((snippet) => snippet.logicalRecordId === seeded.strong.logicalByKey.get("turn-assistant"))).toBe(true);
    expect(hit.snippets.some((snippet) => snippet.text.includes("messages_fts"))).toBe(true);
  });

  test("B13 reports the filtered total independent of page size and paginates without OFFSET", () => {
    const seeded = seedLayerE(); db = seeded.db;
    const service = createSessionSearchService(db);
    const first = service.search({ query: "session-atlas", syntax: "literal", filters: emptySearchFilter(), pageSize: 1, cursor: null });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.page.total).toBe(2);
    expect(first.page.hits).toHaveLength(1);
    expect(first.page.nextCursor).not.toBeNull();
    const second = service.search({ query: "session-atlas", syntax: "literal", filters: emptySearchFilter(), pageSize: 1, cursor: first.page.nextCursor });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.page.total).toBe(2);
    expect(second.page.hits[0]!.session.sessionKey.nativeId).not.toBe(first.page.hits[0]!.session.sessionKey.nativeId);
    expect(second.page.nextCursor).toBeNull();
  });
});

test("CLI/TUI list compatibility delegates literal queries to the sole search service", () => {
  const seeded = seedLayerE(); db = seeded.db;
  const service = createSessionSearchService(db);
  const direct = service.searchList({ query: "session-atlas", syntax: "literal", filter: {}, pageSize: 30, cursor: null });
  expect(direct.ok).toBe(true);
  const list = fetchPage(db, { query: "session-atlas" }, null, 30);
  expect(list.error).toBeUndefined();
  expect(list.total).toBe(2);
  expect(list.rows.map((row) => row.native_id)).toEqual(
    direct.ok ? direct.page.hits.map((hit) => hit.compatibility.nativeId) : [],
  );
});

test("search rows carry the browse list's title: summary topic line, else the display title", () => {
  const seeded = seedLayerE(); db = seeded.db;
  const hits = fetchPage(db, { query: "session-atlas" }, null, 30).rows;
  expect(hits.length).toBe(2);
  const [summarized] = hits;
  db.prepare(`INSERT INTO summaries(session_id, tier, topic_line, msg_count_covered, model, generated_at) VALUES (?, 1, 'fixture topic line', 1, 'fixture', 0)`).run(summarized!.id);
  const again = fetchPage(db, { query: "session-atlas" }, null, 30).rows;
  const browse = fetchPage(db, {}, null, 100).rows;
  for (const row of again) expect(row.title).toBe(browse.find((item) => item.id === row.id)!.title);
  expect(again.find((row) => row.id === summarized!.id)!.title).toBe("fixture topic line");
});

test("malformed raw syntax is recoverable while punctuation is always safe by default", () => {
  const seeded = seedLayerE(); db = seeded.db;
  const service = createSessionSearchService(db);
  const malformed = service.search({
    query: "(", syntax: "raw_fts5", filters: emptySearchFilter(), pageSize: 30, cursor: null,
  });
  expect(malformed).toEqual({
    ok: false,
    error: { code: "invalid_query", message: "Invalid FTS5 search syntax", recoverable: true },
  });
  const literal = service.search({
    query: "(", syntax: "literal", filters: emptySearchFilter(), pageSize: 30, cursor: null,
  });
  expect(literal.ok).toBe(true);
});

test("title-only metadata requires explicit labeled scope and never invents a message snippet", () => {
  const seeded = seedLayerE(); db = seeded.db;
  const service = createSessionSearchService(db);
  const ordinary = service.search({
    query: "titleonlytoken", syntax: "literal", filters: { ...emptySearchFilter(), includeHidden: true }, pageSize: 30, cursor: null,
  });
  expect(nativeIds(ordinary)).toEqual([]);
  const explicit = service.search({
    query: "title: titleonlytoken", syntax: "raw_fts5", filters: { ...emptySearchFilter(), includeHidden: true }, pageSize: 30, cursor: null,
  });
  expect(nativeIds(explicit)).toEqual([seeded.metadata.nativeId]);
  expect(requirePage(explicit).hits[0]!.snippets).toEqual([]);
});
