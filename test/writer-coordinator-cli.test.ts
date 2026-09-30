import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexCmd } from "../src/commands/index.js";
import { openDb } from "../src/db/index.js";
import { defaultIngestSidecarRoot } from "../src/ingest-sidecar.js";
import { withConstructionAuthority } from "../src/runtime/writer-coordinator.js";
import type { VolumeIdentityProbe } from "../src/runtime/storage-identity.js";

const EXPECTED = "11111111-2222-3333-4444-555555555555";
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

test("scheduled index and note refuse a held construction authority with metadata and write no evidence", async () => {
  const root = temporary("collision");
  const dbPath = join(root, "atlas.db");
  const sourceRoot = join(root, "source");
  const configPath = join(root, "config.toml");
  mkdirSync(join(sourceRoot, "project"), { recursive: true });
  writeFileSync(join(sourceRoot, "project", "collision-session.jsonl"), claudeLine("collision-session") + "\n");
  writeConfig(configPath, dbPath, { claudeRoot: sourceRoot });
  const initialized = await openDb(dbPath);
  initialized.close();

  await withConstructionAuthority({ dbPath, config: undefined, operation: "fixture held full walk" }, () => {
    const index = runCli(["index", "--scheduled", "--config", configPath]);
    expect(index.exitCode).toBe(1);
    expect(index.stderr).toContain(`owner pid ${process.pid}`);
    expect(index.stderr).toContain("operation fixture held full walk");
    expect(index.stderr).toContain("acquired-at");

    const note = runCli(["note", "collision-session", "--harness", "claude", "--ingest-only", "--config", configPath]);
    expect(note.exitCode).toBe(1);
    expect(note.stderr).toContain(`owner pid ${process.pid}`);
    expect(note.stderr).toContain("operation fixture held full walk");

    const favorite = runCli(["fav", "collision-session", "--harness", "claude", "--config", configPath]);
    expect(favorite.exitCode).toBe(0);
    expect(favorite.stdout).toContain("pending (construction writer busy");
    expect(favorite.stdout).toContain("operation fixture held full walk");
  });

  const db = new Database(dbPath, { readonly: true, strict: true });
  expect(count(db, "reconciliation_groups")).toBe(0);
  expect(count(db, "targeted_ingest_runs")).toBe(0);
  expect(count(db, "sessions")).toBe(0);
  expect(db.prepare(`SELECT status,last_error FROM favorites`).get()).toMatchObject({
    status: "pending",
    last_error: expect.stringContaining("operation fixture held full walk"),
  });
  db.close();
});

test("absent governed volume refuses a mutating command before DB, leases, lock, or sidecars exist", async () => {
  const root = temporary("absent");
  const fakePrefix = join(root, "missing-volume");
  const dbPath = join(fakePrefix, "archive", "atlas.db");
  const configPath = join(root, "config.toml");
  writeConfig(configPath, dbPath, { mountPrefix: fakePrefix });
  const absent: VolumeIdentityProbe = () => ({ mounted: false, uuid: null, staleDirectoryPresent: true });

  const stderr = await captureStderr(async () => {
    expect(await indexCmd(["--scheduled", "--config", configPath], { storageProbe: absent })).toBe(1);
  });
  expect(stderr).toContain(`expected UUID ${EXPECTED}`);
  expect(stderr).toContain("nothing mounted at prefix; stale directory present");
  expect(existsSync(dbPath)).toBe(false);
  expect(existsSync(`${dbPath}.writer-lock`)).toBe(false);
  expect(existsSync(`${dbPath}.connections`)).toBe(false);
  expect(existsSync(defaultIngestSidecarRoot(dbPath))).toBe(false);
  expect(existsSync(join(fakePrefix, "archive"))).toBe(false);
});

function writeConfig(
  path: string,
  dbPath: string,
  options: { claudeRoot?: string; mountPrefix?: string },
): void {
  const sourceBlocks = ["claude", "codex", "prime", "hermes", "kimi", "zcode", "kilo"].map((source) => {
    if (source === "claude" && options.claudeRoot) {
      return `[sources.claude]\nmode = "replace"\nroots = [${JSON.stringify(options.claudeRoot)}]`;
    }
    return `[sources.${source}]\nmode = "disabled"\nreason = "disposable coordinator fixture"`;
  }).join("\n\n");
  const storage = options.mountPrefix
    ? `\n\n[storage.volumes]\n${JSON.stringify(options.mountPrefix)} = "${EXPECTED}"`
    : "";
  writeFileSync(path, `dbPath = ${JSON.stringify(dbPath)}\n\n${sourceBlocks}${storage}\n`, { mode: 0o600 });
}

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args],
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  };
}

async function captureStderr(work: () => Promise<void>): Promise<string> {
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await work();
  } finally {
    process.stderr.write = original;
  }
  return output;
}

function count(db: Database, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count);
}

function claudeLine(sessionId: string): string {
  return JSON.stringify({
    type: "user",
    sessionId,
    uuid: "00000000-0000-4000-8000-000000000001",
    cwd: "/fixture",
    timestamp: "2026-08-19T00:00:00.000Z",
    message: { role: "user", content: "must not publish during collision" },
  });
}

function temporary(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `atlas-coordinator-cli-${name}-`));
  roots.push(root);
  return root;
}
