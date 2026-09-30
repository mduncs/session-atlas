import { mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  assertMutablePath,
  StorageIdentityError,
  type StorageIdentityConfig,
  type VolumeIdentityProbe,
} from "./storage-identity.js";
import {
  acquireWriterLease,
  WriterLeaseBusyError,
  type WriterLease,
  type WriterLeaseMetadata,
  type WriterLeaseOwnerState,
} from "./writer-lease.js";

/**
 * Session Atlas has two writer tiers. Construction operations (index, targeted
 * note/favorite ingest, TUI first-run ingest, and rebuild) hold this
 * operation-scoped authority. User-data mutations keep their existing WAL/job
 * serialization and receive only the storage guard through openDb; a long walk
 * never owns their connection lifetime. Favorite insertion itself stays in the
 * user-data tier when its optional targeted ingest is refused.
 *
 * Explicit exemptions are migrateCmd (owner-controlled temporary clones),
 * bootstrapConfig, and disposable clone-smoke/batch-dry-run/perf-gate scripts.
 * The busy branch below is the sole future intent-spool seam: a daemon may hold
 * the same lease and accept an intent there. This slice deliberately queues,
 * waits for, and submits nothing.
 */

export interface ConstructionAuthorityOptions {
  dbPath: string;
  config: StorageIdentityConfig;
  operation: string;
  probe?: VolumeIdentityProbe;
}

export class ConstructionAuthorityBusyError extends Error {
  readonly dbPath: string;
  readonly ownerState: WriterLeaseOwnerState;
  readonly owner: WriterLeaseMetadata | null;
  readonly leaseError: WriterLeaseBusyError;

  constructor(dbPath: string, error: WriterLeaseBusyError) {
    const owner = error.owner;
    const detail = owner
      ? `owner pid ${owner.pid} · operation ${owner.operation} · acquired-at ${new Date(owner.acquiredAtMs).toISOString()}`
      : `owner metadata unavailable · state ${error.ownerState}`;
    super(`construction writer busy for ${dbPath}: ${detail}; no work was started`);
    this.name = "ConstructionAuthorityBusyError";
    this.dbPath = dbPath;
    this.ownerState = error.ownerState;
    this.owner = owner;
    this.leaseError = error;
  }
}

/** The canonical control path for an existing DB parent. Performs no writes. */
export function constructionControlDirectory(dbPath: string): string {
  const normalized = resolve(dbPath);
  return join(realpathSync(dirname(normalized)), `${basename(normalized)}.writer-lock`);
}

/** Assert identity, canonicalize control ownership, hold for one construction operation, release. */
export async function withConstructionAuthority<T>(
  options: ConstructionAuthorityOptions,
  work: () => Promise<T> | T,
): Promise<T> {
  if (!isAbsolute(options.dbPath)) throw new Error("construction authority database path must be absolute");
  assertMutablePath(options.dbPath, options.config, options.probe);

  const parent = dirname(resolve(options.dbPath));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const controlDirectory = constructionControlDirectory(options.dbPath);
  let lease: WriterLease;
  try {
    lease = acquireWriterLease(controlDirectory, options.operation);
  } catch (error) {
    // Future intent submission replaces only this branch. There is no queue in
    // the current coordinator and callers fail immediately with owner proof.
    if (error instanceof WriterLeaseBusyError) {
      throw new ConstructionAuthorityBusyError(options.dbPath, error);
    }
    throw error;
  }
  try {
    return await work();
  } finally {
    lease.release();
  }
}

export function isConstructionRefusal(
  error: unknown,
): error is ConstructionAuthorityBusyError | StorageIdentityError {
  return error instanceof ConstructionAuthorityBusyError || error instanceof StorageIdentityError;
}
