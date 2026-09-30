import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConstructionAuthorityBusyError,
  constructionControlDirectory,
  withConstructionAuthority,
} from "../src/runtime/writer-coordinator.js";
import type { WriterLeaseMetadata } from "../src/runtime/writer-lease.js";
import type { Config } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { rebuildDatabase } from "../src/rebuild.js";

const roots: string[] = [];
const moduleUrl = pathToFileURL(resolve("src/runtime/writer-coordinator.ts")).href;

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

test("construction authority excludes another process and reports owner proof", async () => {
  const root = temporary("process");
  const dbPath = join(root, "atlas.db");

  await withConstructionAuthority({ dbPath, config: undefined, operation: "parent full walk" }, () => {
    const child = Bun.spawnSync({
      cmd: [process.execPath, "--eval", `
        import { ConstructionAuthorityBusyError, withConstructionAuthority } from ${JSON.stringify(moduleUrl)};
        try {
          await withConstructionAuthority({ dbPath: ${JSON.stringify(dbPath)}, config: undefined, operation: "child contender" }, () => {});
          process.exit(10);
        } catch (error) {
          if (!(error instanceof ConstructionAuthorityBusyError)) throw error;
          process.stdout.write(error.message);
          process.exit(23);
        }
      `],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    expect(child.exitCode).toBe(23);
    const message = child.stdout.toString();
    expect(message).toContain(`owner pid ${process.pid}`);
    expect(message).toContain("operation parent full walk");
    expect(message).toContain("acquired-at");
  });

  expect(existsSync(join(constructionControlDirectory(dbPath), "owner.json"))).toBe(false);
});

test("symlink spellings of one DB parent converge on one canonical control directory", async () => {
  const root = temporary("canonical");
  const realParent = join(root, "real");
  const aliasParent = join(root, "alias");
  mkdirSync(realParent);
  symlinkSync(realParent, aliasParent, "dir");
  const realDb = join(realParent, "atlas.db");
  const aliasDb = join(aliasParent, "atlas.db");

  expect(constructionControlDirectory(realDb)).toBe(constructionControlDirectory(aliasDb));
  await withConstructionAuthority({ dbPath: aliasDb, config: undefined, operation: "alias owner" }, async () => {
    await expect(withConstructionAuthority(
      { dbPath: realDb, config: undefined, operation: "real contender" },
      () => undefined,
    )).rejects.toBeInstanceOf(ConstructionAuthorityBusyError);
  });
});

test("construction authority recovers a provably dead owner and leaves no owner record", async () => {
  const root = temporary("stale");
  const dbPath = join(root, "atlas.db");
  const directory = constructionControlDirectory(dbPath);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const stale: WriterLeaseMetadata = {
    version: 1,
    token: randomUUID(),
    pid: 2_147_483_647,
    processBirthTimeMs: null,
    acquiredAtMs: Date.now() - 60_000,
    operation: "dead fixture owner",
  };
  writeFileSync(join(directory, "owner.json"), `${JSON.stringify(stale)}\n`, { mode: 0o600 });

  const result = await withConstructionAuthority(
    { dbPath, config: undefined, operation: "stale recovery" },
    () => "recovered",
  );
  expect(result).toBe("recovered");
  expect(existsSync(join(directory, "owner.json"))).toBe(false);
  expect(() => readFileSync(join(directory, "owner.json"), "utf8")).toThrow();
});

test("rebuild takes construction authority before creating its maintenance sentinel", async () => {
  const root = temporary("rebuild-order");
  const dbPath = join(root, "atlas.db");
  const db = await openDb(dbPath);
  db.close();
  const config = { dbPath, sources: {}, providers: [], launchers: [], tunables: {} } as unknown as Config;

  await withConstructionAuthority({ dbPath, config, operation: "fixture construction owner" }, async () => {
    await expect(rebuildDatabase(config, { buildShadow: async () => undefined }))
      .rejects.toBeInstanceOf(ConstructionAuthorityBusyError);
    expect(existsSync(`${dbPath}.maintenance.lock`)).toBe(false);
  });
});

function temporary(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `atlas-coordinator-${name}-`));
  roots.push(root);
  return root;
}
