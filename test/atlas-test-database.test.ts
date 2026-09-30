import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.js";
import { hasPublishedLegacyFence, openComparisonDatabase } from "../src/tui/database.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("comparison opens an existing archive without writes and respects an active maintenance fence", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-test-database-")); roots.push(root);
  const path = join(root, "archive.db");
  (await openDb(path)).close();
  const before = readFileSync(path);
  const opened = openComparisonDatabase(path);
  try {
    expect(opened.readOnly).toBe(true);
    expect(() => opened.db.exec("INSERT INTO meta(key,value) VALUES('comparison','no')")).toThrow();
  } finally { opened.db.close(); }
  expect(readFileSync(path)).toEqual(before);
  writeFileSync(`${path}.maintenance.lock`, "active-rebuild");
  expect(hasPublishedLegacyFence(path)).toBe(false);
  expect(() => openComparisonDatabase(path)).toThrow("under maintenance");
});

test("only a verified published legacy fence admits the comparison bridge", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-test-published-")); roots.push(root);
  const path = join(root, "archive.db");
  (await openDb(path)).close();
  const stateFile = join(root, "state.json");
  const state = { token: "fixture-token", phase: "published", spec: { legacyDatabase: path } };
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(`${path}.maintenance.lock`, JSON.stringify({ liveCutoverToken: "fixture-token", stateFile }));
  expect(hasPublishedLegacyFence(path)).toBe(true);
  openComparisonDatabase(path).db.close();
  writeFileSync(stateFile, JSON.stringify({ ...state, spec: { legacyDatabase: join(root, "unrelated.db") } }));
  expect(hasPublishedLegacyFence(path)).toBe(false);
  expect(() => openComparisonDatabase(path)).toThrow("under maintenance");
});
