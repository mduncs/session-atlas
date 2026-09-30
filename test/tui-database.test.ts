import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db/index.js";
import { openTuiDatabase } from "../src/tui/database.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("Ink browses the published legacy index without releasing its fence or allowing writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-ink-db-")); roots.push(root);
  const path = join(root, "legacy.db");
  (await openDb(path)).close();
  const stateFile = join(root, "cutover.json");
  const lock = `${path}.maintenance.lock`;
  const state = { token: "owned", phase: "published", spec: { legacyDatabase: path } };
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(lock, JSON.stringify({ liveCutoverToken: "owned", stateFile }));
  const before = readFileSync(lock);
  const opened = await openTuiDatabase(path);
  try {
    expect(opened.readOnly).toBe(true);
    expect(opened.db.query("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(() => opened.db.exec("INSERT INTO meta(key,value) VALUES('test','no')")).toThrow();
  } finally { opened.db.close(); }
  expect(readFileSync(lock)).toEqual(before);
  for (const changed of [{ ...state, phase: "prepared" }, { ...state, token: "other" }]) {
    writeFileSync(stateFile, JSON.stringify(changed));
    await expect(openTuiDatabase(path)).rejects.toThrow("under maintenance");
  }
  writeFileSync(lock, "rebuild-owned");
  await expect(openTuiDatabase(path)).rejects.toThrow("under maintenance");
});

test("ordinary unfenced Ink archives stay writable", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-ink-db-")); roots.push(root);
  const opened = await openTuiDatabase(join(root, "archive.db"));
  try {
    expect(opened.readOnly).toBe(false);
    opened.db.exec("INSERT INTO meta(key,value) VALUES('test','yes')");
  } finally { opened.db.close(); }
});
