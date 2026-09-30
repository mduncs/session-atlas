import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  acquireWriterLease,
  withWriterLease,
  WriterLeaseBusyError,
  type WriterLeaseMetadata,
} from "../src/runtime/writer-lease.js";

const roots: string[] = [];
const moduleUrl = pathToFileURL(resolve("src/runtime/writer-lease.ts")).href;

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

test("writer lease excludes another process while protecting the live owner", () => {
  const directory = leaseDirectory("multiprocess");
  const lease = acquireWriterLease(directory, "test-parent");

  const blocked = runChild(`
    import { acquireWriterLease, WriterLeaseBusyError } from ${JSON.stringify(moduleUrl)};
    try {
      acquireWriterLease(${JSON.stringify(directory)}, "test-child-contender");
      process.exit(10);
    } catch (error) {
      if (!(error instanceof WriterLeaseBusyError)) throw error;
      process.stdout.write(error.ownerState);
      process.exit(23);
    }
  `);

  expect(blocked.status).toBe(23);
  expect(["live", "unverifiable"]).toContain(blocked.stdout.trim());
  expect(readOwner(directory).token).toBe(lease.metadata.token);
  expect(lease.release()).toBe(true);

  const successor = runChild(`
    import { withWriterLease } from ${JSON.stringify(moduleUrl)};
    await withWriterLease(${JSON.stringify(directory)}, "test-child-successor", () => {
      process.stdout.write("acquired");
    });
  `);
  expect(successor.status).toBe(0);
  expect(successor.stdout).toBe("acquired");
  expect(existsSync(ownerPath(directory))).toBe(false);
});

test("writer lease recovers dead owners and PID reuse only with birth-time proof", () => {
  const directory = leaseDirectory("stale");
  mkdirSync(directory, { mode: 0o700 });

  writeOwner(directory, metadata({ pid: 2_147_483_647, processBirthTimeMs: null, operation: "dead" }));
  const afterDeadOwner = acquireWriterLease(directory, "recover-dead");
  expect(afterDeadOwner.metadata.operation).toBe("recover-dead");
  expect(afterDeadOwner.release()).toBe(true);

  writeOwner(directory, metadata({ pid: process.pid, processBirthTimeMs: 0, operation: "reused-pid" }));
  const afterPidReuse = acquireWriterLease(directory, "recover-reused-pid");
  expect(afterPidReuse.metadata.operation).toBe("recover-reused-pid");
  expect(afterPidReuse.release()).toBe(true);
});

test("writer lease fails closed for unverifiable or malformed ownership", () => {
  const directory = leaseDirectory("ambiguous");
  mkdirSync(directory, { mode: 0o700 });
  const ambiguous = metadata({ pid: process.pid, processBirthTimeMs: null, operation: "unknown-birth" });
  writeOwner(directory, ambiguous);

  expect(() => acquireWriterLease(directory, "must-not-steal")).toThrow(WriterLeaseBusyError);
  try {
    acquireWriterLease(directory, "must-not-steal");
  } catch (error) {
    expect(error).toBeInstanceOf(WriterLeaseBusyError);
    expect((error as WriterLeaseBusyError).ownerState).toBe("unverifiable");
  }
  expect(readOwner(directory).token).toBe(ambiguous.token);

  rmSync(ownerPath(directory));
  writeFileSync(ownerPath(directory), "{}\n", { mode: 0o600 });
  expect(() => acquireWriterLease(directory, "malformed-must-not-steal")).toThrow("unverifiable");
  expect(existsSync(ownerPath(directory))).toBe(true);
});

test("writer lease enforces owner-only modes and release is idempotent", () => {
  const directory = leaseDirectory("modes");
  mkdirSync(directory, { mode: 0o755 });
  const lease = acquireWriterLease(directory, "mode-check");

  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(statSync(ownerPath(directory)).mode & 0o777).toBe(0o600);
  expect(lease.release()).toBe(true);
  expect(lease.release()).toBe(false);
  expect(existsSync(ownerPath(directory))).toBe(false);
});

test("withWriterLease removes owner metadata after normal async completion", async () => {
  const directory = leaseDirectory("normal-exit");
  const result = await withWriterLease(directory, "normal-completion", async () => {
    expect(existsSync(ownerPath(directory))).toBe(true);
    await Promise.resolve();
    return 42;
  });

  expect(result).toBe(42);
  expect(existsSync(ownerPath(directory))).toBe(false);

  const child = runChild(`
    import { withWriterLease } from ${JSON.stringify(moduleUrl)};
    await withWriterLease(${JSON.stringify(directory)}, "child-normal-exit", async () => {
      await Promise.resolve();
    });
  `);
  expect(child.status).toBe(0);
  expect(existsSync(ownerPath(directory))).toBe(false);
});

function leaseDirectory(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `atlas-writer-lease-${name}-`));
  roots.push(root);
  return join(root, "writer-lease");
}

function ownerPath(directory: string): string {
  return join(directory, "owner.json");
}

function metadata(overrides: Partial<WriterLeaseMetadata>): WriterLeaseMetadata {
  return {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    processBirthTimeMs: null,
    acquiredAtMs: Date.now(),
    operation: "fixture",
    ...overrides,
  };
}

function writeOwner(directory: string, owner: WriterLeaseMetadata): void {
  writeFileSync(ownerPath(directory), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
}

function readOwner(directory: string): WriterLeaseMetadata {
  return JSON.parse(readFileSync(ownerPath(directory), "utf8")) as WriterLeaseMetadata;
}

function runChild(source: string): { status: number; stdout: string; stderr: string } {
  const child = spawnSync(process.execPath, ["-e", source], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 10_000,
  });
  if (child.error) throw child.error;
  return {
    status: child.status ?? -1,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}
