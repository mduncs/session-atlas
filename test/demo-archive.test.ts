import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeOut, buildDemoArchive, privacyScan, sourceDrift } from "../scripts/demo-archive.js";
import { SESSIONS, TIER2 } from "../demo/story.js";

const scratch = mkdtempSync(join(tmpdir(), "atlas-demo-archive-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("demo/sources is exactly what demo/story.ts renders", () => {
  expect(sourceDrift()).toEqual([]);
});

test("the builder refuses live, repository, and foreign output directories", () => {
  const env = { ...process.env, XDG_DATA_HOME: join(scratch, "xdg-data"), XDG_CONFIG_HOME: join(scratch, "xdg-config") };
  expect(() => assertSafeOut("relative/out", env)).toThrow(/absolute/);
  expect(() => assertSafeOut(join(scratch, "xdg-data", "session-atlas", "demo"), env)).toThrow(/protected/);
  expect(() => assertSafeOut(join(scratch, "xdg-data"), env)).toThrow(/protected/);
  expect(() => assertSafeOut(join(import.meta.dir, "..", "demo", "out"), env)).toThrow(/repository/);
  expect(() => assertSafeOut("/srv/x/.local/share/session-atlas/demo", env)).toThrow(/live Atlas/);
  const foreign = join(scratch, "foreign");
  mkdirSync(foreign);
  writeFileSync(join(foreign, "keep.txt"), "not ours");
  expect(() => assertSafeOut(foreign, env)).toThrow(/not empty/);
});

test("privacy scan catches a real home path but allows the build root", () => {
  const dir = join(scratch, "leak");
  mkdirSync(dir);
  writeFileSync(join(dir, "clean.txt"), `${dir}/atlas.db and /Users/demo/code/tidepool`);
  expect(privacyScan(dir).hits).toEqual([]);
  writeFileSync(join(dir, "leak.txt"), "cwd=/Users/someone-real/code");
  expect(privacyScan(dir).hits.join("\n")).toContain("non-demo /Users path");
});

test("builds the fictional archive with every lens populated and nothing private", async () => {
  const summary = await buildDemoArchive(join(scratch, "demo"));
  const workers = SESSIONS.filter((spec) => spec.launch !== "cli").length;
  expect(summary.sessions).toEqual({ claude: 22, codex: 14 });
  expect(summary.creators).toEqual({ human: SESSIONS.length - workers, agent: workers });
  expect(summary.shapes).toMatchObject({ marathon: 1, wanderer: 1, conversation: 1, worker: workers });
  expect(summary.episodes.total).toBe(8);
  expect(summary.episodes.labeled).toBe(8);
  expect(summary.paragraphs).toBe(1);
  const tier2 = Object.values(TIER2);
  expect(summary.summaries).toEqual({
    tier1: SESSIONS.length, tier2: tier2.length,
    anchors: tier2.reduce((n, entry) => n + entry.anchors.length, 0),
    fixture: SESSIONS.length + tier2.length,
  });
  expect(summary.tags.merges).toBe(6);
  expect(summary.rejected).toBe(0);
  expect(summary.privacy.hits).toEqual([]);
}, 120_000);
