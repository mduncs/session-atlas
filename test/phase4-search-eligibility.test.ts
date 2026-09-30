import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { compileFtsQuery } from "../src/fts-query.js";
import { compileSessionFilter, emptySearchFilter } from "../src/search/compiler.js";
import { createSessionSearchService } from "../src/search/service.js";
import { validateV12SearchIndex } from "../src/search/v12-fts.js";
import { attachLayers } from "../src/layers/db.js";
import { seedLayerE } from "./phase4-search-fixture.js";

let db: Database | null = null;
afterEach(() => { db?.close(); db = null; });

function idsFor(text: string): string[] {
  const result = createSessionSearchService(db!).search({
    query: text, syntax: "literal", filters: { ...emptySearchFilter(), includeHidden: true }, pageSize: 30, cursor: null,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.page.hits.map((hit) => hit.session.sessionKey.nativeId);
}

test("Layer E seeds only logical dialogue representatives; replay and every nonprimary kind are absent", () => {
  const seeded = seedLayerE(); db = seeded.db;
  expect(validateV12SearchIndex(db)).toMatchObject({
    missingDocuments: 0,
    extraDocuments: 0,
    duplicateDialogue: 0,
    duplicateTitle: 0,
  });
  const dialogueDocs = db.prepare(
    `SELECT d.session_id,d.logical_record_id,d.representative_raw_record_id,d.prose
     FROM session_search_documents d WHERE d.scope='dialogue' ORDER BY d.session_id,d.logical_ordinal`,
  ).all() as Array<{ session_id: number; logical_record_id: number; representative_raw_record_id: number; prose: string }>;
  const strongDocs = dialogueDocs.filter((row) => row.session_id === seeded.strong.id);
  expect(strongDocs).toHaveLength(2);
  expect(strongDocs.filter((row) => row.logical_record_id === seeded.strong.logicalByKey.get("turn-user"))).toHaveLength(1);
  expect(strongDocs[0]!.representative_raw_record_id).toBe(seeded.strong.rawIds[0]);

  expect(idsFor("tokenuserprimary")).toEqual(["fixture-eligibility"]);
  expect(idsFor("tokenassistantprimary")).toEqual(["fixture-eligibility"]);
  for (const token of Object.values(seeded.excluded)) expect(idsFor(token)).toEqual([]);
  expect(idsFor("tokeninvalidscope")).toEqual([]);
  expect(db.prepare(`SELECT count(*) n FROM session_search_documents WHERE prose IS NOT NULL AND length(trim(prose))=0`).get()).toEqual({ n: 0 });
});

test("v12 triggers keep current-generation eligibility exact after semantic changes", () => {
  const seeded = seedLayerE(); db = seeded.db;
  const targetRaw = seeded.strong.rawIds[2]!;
  db.prepare(`UPDATE messages SET prose='triggerrefreshtoken' WHERE id=?`).run(targetRaw);
  expect(idsFor("messages_fts")).toEqual([]);
  expect(idsFor("triggerrefreshtoken")).toEqual(["fixture-strong"]);
  db.prepare(`UPDATE sessions SET construction_status='invalid',construction_invalid_reason='fixture-change' WHERE id=?`).run(seeded.strong.id);
  expect(idsFor("triggerrefreshtoken")).toEqual([]);
  expect(validateV12SearchIndex(db).extraDocuments).toBe(0);
});

test("exact filter composition is shared by count and ranked page", () => {
  const seeded = seedLayerE(); db = seeded.db;
  const service = createSessionSearchService(db);
  const cases = [
    { patch: { sources: ["claude"] }, expected: ["fixture-strong"] },
    { patch: { sources: ["codex"] }, expected: ["fixture-recent"] },
    { patch: { models: ["fixture-model-a"] }, expected: ["fixture-strong"] },
    { patch: { projectKeys: ["fixture-project-a"] }, expected: ["fixture-strong"] },
    { patch: { tags: ["fixture-tag-a"] }, expected: ["fixture-strong"] },
    { patch: { favorite: true }, expected: ["fixture-strong"] },
    { patch: { favorite: false }, expected: ["fixture-recent"] },
    { patch: { fromTs: 200 }, expected: ["fixture-recent"] },
    { patch: { toTsExclusive: 200 }, expected: ["fixture-strong"] },
    { patch: { sourceValidation: ["current"] }, expected: ["fixture-strong"] },
    { patch: { sourceValidation: ["snapshot_only"] }, expected: ["fixture-recent"] },
  ] as const;
  for (const item of cases) {
    const filters = { ...emptySearchFilter(), ...item.patch };
    const result = service.search({ query: "session-atlas", syntax: "literal", filters, pageSize: 30, cursor: null });
    if (!result.ok) throw new Error(result.error.message);
    const ids = result.page.hits.map((hit) => hit.session.sessionKey.nativeId);
    expect(ids).toEqual(item.expected);
    expect(result.page.total).toBe(ids.length);
  }
});

test("canonical search preserves the effective Human/Agent origin lens", () => {
  const seeded = seedLayerE(); db = seeded.db;
  attachLayers(db, ":memory:");
  const correct = db.prepare(`INSERT INTO layers.creator_corrections(harness,native_id,started_by,previous,corrected_at)
    SELECT harness,native_id,?, 'unknown', 1 FROM sessions WHERE id=?`);
  correct.run("human", seeded.strong.id);
  correct.run("agent", seeded.recent.id);
  const service = createSessionSearchService(db);
  const human = service.search({
    query: "session-atlas", syntax: "literal", filters: { ...emptySearchFilter(), origin: "human" }, pageSize: 30, cursor: null,
  });
  const agent = service.search({
    query: "session-atlas", syntax: "literal", filters: { ...emptySearchFilter(), origin: "agent" }, pageSize: 30, cursor: null,
  });
  expect(human.ok).toBe(true);
  expect(agent.ok).toBe(true);
  if (!human.ok || !agent.ok) return;
  expect(human.page.total).toBe(1);
  expect(human.page.hits.map((hit) => hit.compatibility.effectiveOrigin)).toEqual(["human"]);
  expect(agent.page.total).toBe(1);
  expect(agent.page.hits.map((hit) => hit.compatibility.effectiveOrigin)).toEqual(["agent"]);
});

test("filter compiler emits one stable parameter vector and no query algebra", () => {
  const compiled = compileSessionFilter({
    sources: ["claude", "codex"],
    models: ["fixture-model-a"],
    projectKeys: ["fixture-project-a"],
    legacyPaths: [],
    tags: ["fixture-tag-a"],
    fromTs: 100,
    toTsExclusive: 200,
    favorite: true,
    artifactKinds: ["dialogue_history"],
    sourceValidation: ["current"],
    chainStableKey: "fixture-chain",
    includeHidden: false,
    state: null,
    chain: null,
    origin: null,
  });
  expect(compiled.predicates[0]).toBe("s.construction_status = 'valid'");
  expect(compiled.predicates[1]).toBe("s.default_session_visible = 1");
  expect(compiled.params).toEqual([
    "claude", "codex", "fixture-model-a", "fixture-project-a", "fixture-project-a",
    "fixture-tag-a", 100, 200, "dialogue_history", "current", "fixture-chain",
  ]);
  expect(compiled.predicates.join(" ")).not.toContain("MATCH");
});

test("literal compiler preserves phrase and code/path atoms; raw mode is explicit and prose-scoped by default", () => {
  expect(compileFtsQuery('"source logs" C++ src/commands/search.ts')).toEqual({
    match: 'prose : ("source logs" "C++" "src/commands/search.ts")',
    display: '"source logs" C++ src/commands/search.ts',
    syntax: "literal",
  });
  expect(compileFtsQuery("session-atlas OR C++", "raw_fts5").match).toBe("prose : (session-atlas OR C++)");
  expect(compileFtsQuery("title: synthetic", "raw_fts5").match).toBe("title: synthetic");
});
