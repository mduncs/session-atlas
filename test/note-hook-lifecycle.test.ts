import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnNoteHook } from "../scripts/note-hook.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

test("detached note child continues after the hook returns", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-note-hook-lifecycle-")); roots.push(root);
  const marker = join(root, "marker");
  const childScript = join(root, "slow-child.ts");
  writeFileSync(childScript, [
    `const marker = process.argv[2]!;`,
    `await Bun.write(marker, "started");`,
    `await Bun.sleep(250);`,
    `await Bun.write(marker, "finished");`,
  ].join("\n"));

  const startedAt = performance.now();
  const child = spawnNoteHook([process.execPath, childScript, marker]);
  const hookReturnedIn = performance.now() - startedAt;

  expect(hookReturnedIn).toBeLessThan(200);
  expect(child.pid).toBeGreaterThan(0);
  expect(child.stdout == null).toBe(true);
  expect(child.stderr == null).toBe(true);
  expect(child.stdin == null).toBe(true);

  await Bun.sleep(75);
  expect(existsSync(marker)).toBe(true);
  expect(readFileSync(marker, "utf8")).toBe("started");
  expect(await child.exited).toBe(0);
  expect(readFileSync(marker, "utf8")).toBe("finished");
});
