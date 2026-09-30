import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { productionTranspilerCache } from "../src/production-exec.js";

const cache = mkdtempSync(join(tmpdir(), "atlas-transpiler-cache-"));
afterAll(() => rmSync(cache, { recursive: true, force: true }));

function probe(args: string[]): { nodeEnv: string | null; jsxDev: boolean; runtimeHasJsxDev: boolean } {
  const env: Record<string, string> = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: cache } as Record<string, string>;
  delete env.NODE_ENV;
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures", "production-probe.ts"), ...args], { env, stderr: "pipe" });
  expect(run.stderr.toString()).toBe("");
  return JSON.parse(run.stdout.toString());
}

test("the production re-exec compiles JSX for the production runtime even after a dev run cached it", () => {
  // A dev run first, sharing the cache: Bun 1.3.5 keys large transpiled files by
  // content alone, which is how `atlas` crashed with "jsxDEV is not a function".
  expect(probe([])).toEqual({ nodeEnv: null, jsxDev: true, runtimeHasJsxDev: true });
  expect(probe(["reexec"])).toEqual({ nodeEnv: "production", jsxDev: false, runtimeHasJsxDev: false });
}, 30_000);

test("the production transpiler cache never shares a directory with the dev cache", () => {
  expect(productionTranspilerCache("/tmp/c")).toBe(join("/tmp/c", "atlas-production"));
  expect(productionTranspilerCache("0")).toBe("0");
  expect(productionTranspilerCache(undefined)).toMatch(/session-atlas[/\\]bun-production$/);
});
