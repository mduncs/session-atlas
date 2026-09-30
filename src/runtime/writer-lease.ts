import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

const OWNER_FILE = "owner.json";
const RECOVERY_DIRECTORY = ".recovery";
const METADATA_VERSION = 1;
const MAX_METADATA_BYTES = 16 * 1024;
const BIRTH_TIME_TOLERANCE_MS = 2_000;
const ACQUIRE_ATTEMPTS = 4;
const PS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type WriterLeaseOwnerState = "live" | "unverifiable" | "recovery-in-progress";

export interface WriterLeaseMetadata {
  version: typeof METADATA_VERSION;
  token: string;
  pid: number;
  processBirthTimeMs: number | null;
  acquiredAtMs: number;
  operation: string;
}

export interface WriterLease {
  readonly directory: string;
  readonly metadata: WriterLeaseMetadata;
  /** Remove this handle's owner record only. Calling release again is harmless. */
  release(): boolean;
}

export class WriterLeaseBusyError extends Error {
  readonly ownerState: WriterLeaseOwnerState;
  readonly owner: WriterLeaseMetadata | null;

  constructor(directory: string, ownerState: WriterLeaseOwnerState, owner: WriterLeaseMetadata | null) {
    const detail = owner ? `pid ${owner.pid} (${owner.operation})` : "owner metadata unavailable";
    super(`writer lease unavailable at ${directory}: ${ownerState}; ${detail}`);
    this.name = "WriterLeaseBusyError";
    this.ownerState = ownerState;
    this.owner = owner;
  }
}

/**
 * Acquire a non-blocking, cross-process writer lease.
 *
 * The supplied directory is a dedicated owner-only control directory, not a
 * database path. The directory remains after release; owner.json is the atomic
 * lease record. This module has no startup hooks and is inert until called.
 */
export function acquireWriterLease(directory: string, operation: string): WriterLease {
  validateArguments(directory, operation);
  ensureControlDirectory(directory);
  const metadata = newMetadata(operation);

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    if (pathExists(recoveryPath(directory))) {
      throw new WriterLeaseBusyError(directory, "recovery-in-progress", null);
    }
    if (tryWriteOwner(directory, metadata)) return leaseHandle(directory, metadata);

    const observed = readOwner(directory);
    if (observed.kind === "missing") continue;
    if (observed.kind === "invalid") {
      throw new WriterLeaseBusyError(directory, "unverifiable", null);
    }

    const state = inspectOwner(observed.metadata);
    if (state !== "stale") {
      throw new WriterLeaseBusyError(directory, state, observed.metadata);
    }
    return recoverStaleOwner(directory, metadata);
  }

  throw new WriterLeaseBusyError(directory, "unverifiable", null);
}

/** Acquire for the duration of work and release in a finally block. */
export async function withWriterLease<T>(
  directory: string,
  operation: string,
  work: (lease: WriterLease) => Promise<T> | T,
): Promise<T> {
  const lease = acquireWriterLease(directory, operation);
  try {
    return await work(lease);
  } finally {
    lease.release();
  }
}

function recoverStaleOwner(directory: string, replacement: WriterLeaseMetadata): WriterLease {
  const guard = recoveryPath(directory);
  try {
    mkdirSync(guard, { mode: 0o700 });
    chmodSync(guard, 0o700);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new WriterLeaseBusyError(directory, "recovery-in-progress", null);
    }
    throw error;
  }

  try {
    const observed = readOwner(directory);
    if (observed.kind === "invalid") {
      throw new WriterLeaseBusyError(directory, "unverifiable", null);
    }
    if (observed.kind === "valid") {
      const state = inspectOwner(observed.metadata);
      if (state !== "stale") {
        throw new WriterLeaseBusyError(directory, state, observed.metadata);
      }
      unlinkSync(ownerPath(directory));
    }

    if (tryWriteOwner(directory, replacement)) return leaseHandle(directory, replacement);

    const winner = readOwner(directory);
    if (winner.kind === "valid") {
      const state = inspectOwner(winner.metadata);
      throw new WriterLeaseBusyError(
        directory,
        state === "stale" ? "unverifiable" : state,
        winner.metadata,
      );
    }
    throw new WriterLeaseBusyError(directory, "unverifiable", null);
  } finally {
    try { rmdirSync(guard); } catch {}
  }
}

function leaseHandle(directory: string, metadata: WriterLeaseMetadata): WriterLease {
  let released = false;
  return {
    directory,
    metadata,
    release(): boolean {
      if (released) return false;
      released = true;
      const observed = readOwner(directory);
      if (observed.kind !== "valid" || observed.metadata.token !== metadata.token) return false;
      try {
        unlinkSync(ownerPath(directory));
        return true;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
      }
    },
  };
}

function tryWriteOwner(directory: string, metadata: WriterLeaseMetadata): boolean {
  const path = ownerPath(directory);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`, "utf8");
    fsyncSync(descriptor);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

type OwnerRead =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; metadata: WriterLeaseMetadata };

function readOwner(directory: string): OwnerRead {
  const path = ownerPath(directory);
  let descriptor: number | null = null;
  try {
    const link = lstatSync(path);
    if (!link.isFile() || link.isSymbolicLink()) return { kind: "invalid" };
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_METADATA_BYTES) return { kind: "invalid" };
    if (!ownedByCurrentUser(stat.uid) || (stat.mode & 0o777) !== 0o600) return { kind: "invalid" };
    const parsed: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
    return isMetadata(parsed) ? { kind: "valid", metadata: parsed } : { kind: "invalid" };
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

type OwnerInspection = "live" | "stale" | "unverifiable";

function inspectOwner(metadata: WriterLeaseMetadata): OwnerInspection {
  const processState = inspectProcess(metadata.pid);
  if (processState.kind === "dead") return "stale";
  if (processState.kind === "unverifiable") return "unverifiable";
  if (metadata.processBirthTimeMs === null || processState.birthTimeMs === null) return "unverifiable";
  return Math.abs(metadata.processBirthTimeMs - processState.birthTimeMs) > BIRTH_TIME_TOLERANCE_MS
    ? "stale"
    : "live";
}

type ProcessInspection =
  | { kind: "dead" }
  | { kind: "unverifiable" }
  | { kind: "alive"; birthTimeMs: number | null };

function inspectProcess(pid: number): ProcessInspection {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (errorCode(error) === "ESRCH") return { kind: "dead" };
    if (errorCode(error) !== "EPERM") return { kind: "unverifiable" };
  }
  return { kind: "alive", birthTimeMs: processBirthTimeMs(pid) };
}

function processBirthTimeMs(pid: number): number | null {
  try {
    const output = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: 1_000,
    }).trim();
    const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(output);
    if (!match) return null;
    const month = PS_MONTHS.indexOf(match[1] as (typeof PS_MONTHS)[number]);
    if (month < 0) return null;
    const [, , day, hour, minute, second, year] = match;
    return Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second));
  } catch {
    return null;
  }
}

function newMetadata(operation: string): WriterLeaseMetadata {
  return {
    version: METADATA_VERSION,
    token: randomUUID(),
    pid: process.pid,
    processBirthTimeMs: processBirthTimeMs(process.pid),
    acquiredAtMs: Date.now(),
    operation,
  };
}

function ensureControlDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`writer lease path is not a real directory: ${directory}`);
  }
  if (!ownedByCurrentUser(stat.uid)) {
    throw new Error(`writer lease directory is not owned by the current user: ${directory}`);
  }
  chmodSync(directory, 0o700);
}

function validateArguments(directory: string, operation: string): void {
  if (!isAbsolute(directory)) throw new Error("writer lease directory must be absolute");
  if (!operation.trim() || operation.length > 200) {
    throw new Error("writer lease operation must contain 1-200 characters");
  }
}

function isMetadata(value: unknown): value is WriterLeaseMetadata {
  if (!isRecord(value)) return false;
  return value.version === METADATA_VERSION
    && typeof value.token === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.token)
    && Number.isSafeInteger(value.pid)
    && Number(value.pid) > 0
    && (value.processBirthTimeMs === null
      || (Number.isSafeInteger(value.processBirthTimeMs) && Number(value.processBirthTimeMs) >= 0))
    && Number.isSafeInteger(value.acquiredAtMs)
    && Number(value.acquiredAtMs) > 0
    && typeof value.operation === "string"
    && value.operation.trim().length > 0
    && value.operation.length <= 200;
}

function ownerPath(directory: string): string {
  return join(directory, OWNER_FILE);
}

function recoveryPath(directory: string): string {
  return join(directory, RECOVERY_DIRECTORY);
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    return true;
  }
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
