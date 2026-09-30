import { Database } from "bun:sqlite";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, SCHEMA_VERSION_META_KEY, V13_FOREIGN_KEY_INDEX_SQL, type Migration } from "./schema.js";
import { V13_EFFICIENT_SEARCH_TRIGGER_SQL, validateV12SearchIndex } from "../search/v12-fts.js";
import { assertMutablePath, type StorageConfig, type VolumeIdentityProbe } from "../runtime/storage-identity.js";
import { attachLayers } from "../layers/db.js";

export type DB = Database;

/**
 * Open the core SQLite database. The DB is owned by atlas, so WAL is on
 * (TUI reads while the pipeline writes). Sources are opened separately and
 * read-only in their adapters (Law 2) — never via this handle.
 */
export interface OpenDbOptions {
  /** Only the rebuild owner may open the destination while its sentinel exists. */
  allowMaintenance?: boolean;
  /** Optional mount-prefix UUID expectations asserted before any write-side effect. */
  storage?: StorageConfig;
  /** Injectable identity seam; production callers use the real read-only probe. */
  storageProbe?: VolumeIdentityProbe;
}

/**
 * Open an already-current Atlas database. Ordinary commands never migrate:
 * a missing or stale schema fails closed with the guarded-clone instruction.
 */
export async function openDb(path: string, options: OpenDbOptions = {}): Promise<DB> {
  assertMutablePath(path, options.storage, options.storageProbe);
  const databaseExisted = existsSync(path);
  await mkdir(dirname(path), { recursive: true });
  if (!options.allowMaintenance && existsSync(`${path}.maintenance.lock`)) {
    throw new Error(`atlas database is under maintenance: ${path}`);
  }
  const leaseDir = connectionLeaseDir(path);
  await mkdir(leaseDir, { recursive: true });
  const leasePath = `${leaseDir}/${process.pid}-${randomUUID()}`;
  await writeFile(leasePath, `${Date.now()}\n`, { flag: "wx", mode: 0o600 });
  // Close the check/create race with rebuild: a lease created after rebuild's
  // sentinel must back out before opening SQLite.
  if (!options.allowMaintenance && existsSync(`${path}.maintenance.lock`)) {
    await rm(leasePath, { force: true });
    throw new Error(`atlas database is under maintenance: ${path}`);
  }

  let db: DB | null = null;
  try {
    db = new Database(path);
    // Recommended pragmas for a local write-mostly-cache with concurrent TUI reads.
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    // Creating a brand-new archive is initialization, not an upgrade. Any
    // pre-existing schema — including an empty or legacy file — fails closed.
    if (!databaseExisted) runMigrations(db);
    assertCurrentSchema(db, path);
    attachLayers(db, path);
  } catch (error) {
    try { db?.close(); } catch {}
    rmSync(leasePath, { force: true });
    if (!databaseExisted) {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
    throw error;
  }

  const currentDb = db;
  const sqliteClose = currentDb.close.bind(currentDb);
  let leaseClosed = false;
  Object.defineProperty(currentDb, "close", {
    configurable: true,
    value: (throwOnError?: boolean) => {
      sqliteClose(throwOnError);
      if (!leaseClosed) {
        rmSync(leasePath, { force: true });
        leaseClosed = true;
      }
    },
  });
  return currentDb;
}

/** Create only a disposable rebuild shadow; never initialize an ordinary path. */
export async function openRebuildShadowDb(path: string, options: OpenDbOptions = {}): Promise<DB> {
  assertMutablePath(path, options.storage, options.storageProbe);
  if (!path.includes(".rebuild-") || existsSync(path)) {
    throw new Error(`refusing to initialize non-shadow database: ${path}`);
  }
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    runMigrations(db);
    assertCurrentSchema(db, path);
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}


/**
 * Open an existing Atlas database without migrations, leases, journal-mode
 * changes, directory creation, or any write transaction. Read/status commands
 * use this path so they cannot silently index or mutate archive state.
 */
export function openReadOnlyDb(path: string): DB {
  if (!existsSync(path)) throw new Error(`atlas database does not exist: ${path}`);
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    assertCurrentSchema(db, path);
    attachLayers(db, path);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Refuse rebuild while any pre-existing cooperative Atlas handle is alive. */
export async function assertNoOpenDbLeases(path: string): Promise<void> {
  const leaseDir = connectionLeaseDir(path);
  let entries: string[];
  try {
    entries = await readdir(leaseDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const live: string[] = [];
  for (const entry of entries) {
    const path = `${leaseDir}/${entry}`;
    const pid = Number(entry.split("-", 1)[0]);
    if (Number.isInteger(pid) && leaseOwnsLiveProcess(pid, path)) live.push(entry);
    else await rm(path, { force: true });
  }
  if (live.length > 0) {
    throw new Error(`rebuild refused: ${live.length} open Atlas database handle(s)`);
  }
}

function connectionLeaseDir(path: string): string {
  return `${path}.connections`;
}

function leaseOwnsLiveProcess(pid: number, leasePath: string): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM proves that a process exists, not that it is the Atlas process
    // which created this lease. Continue to the creation-time comparison so
    // a stale Atlas PID reused by a root-owned service cannot block forever.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  // A bare PID is not a durable identity: after a crash macOS can reuse it,
  // making a stale lease look live forever. Atlas writes its creation epoch
  // into every lease. If the current process with that PID started later, the
  // lease belongs to a dead predecessor and is safe to prune.
  let leaseCreated = Number.NaN;
  try { leaseCreated = Number(readFileSync(leasePath, "utf8").trim()); } catch {}
  const processStarted = processStartMs(pid);
  if (Number.isFinite(leaseCreated) && processStarted !== null && processStarted > leaseCreated + 5_000) return false;
  return true;
}

function processStartMs(pid: number): number | null {
  try {
    const output = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1_000 }).trim();
    const parsed = Date.parse(output);
    return Number.isFinite(parsed) ? parsed : null;
  } catch { return null; }
}

export const ISOLATED_CLONE_MIGRATION_CONFIRMATION = "MIGRATE_ISOLATED_CLONE";

export interface IsolatedCloneMigrationRequest {
  dbPath: string;
  configPath: string;
  confirmation: typeof ISOLATED_CLONE_MIGRATION_CONFIRMATION;
}

export interface MigrationReport {
  dbPath: string;
  fromVersion: number;
  toVersion: number;
  integrity: "ok";
  foreignKeyViolations: 0;
}

/**
 * The only runtime migration entry: explicit absolute nondefault config,
 * exact configured DB target, owner-controlled temporary clone, and literal
 * confirmation. It never walks sources or invokes providers/launchers.
 */
export function migrateIsolatedClone(request: IsolatedCloneMigrationRequest): MigrationReport {
  assertIsolatedCloneMigrationRequest(request);
  const db = new Database(request.dbPath);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    const fromVersion = readSchemaVersion(db);
    if (fromVersion > LATEST_SCHEMA_VERSION) {
      throw new Error(`atlas schema v${fromVersion} is newer than this binary (v${LATEST_SCHEMA_VERSION})`);
    }
    runMigrations(db);
    assertCurrentSchema(db, request.dbPath);
    if (LATEST_SCHEMA_VERSION >= 12) validateV12SearchIndex(db);
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") throw new Error(`migration integrity_check failed: ${integrity.integrity_check}`);
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length !== 0) throw new Error(`migration produced ${foreignKeys.length} foreign-key violation(s)`);
    return {
      dbPath: request.dbPath,
      fromVersion,
      toVersion: LATEST_SCHEMA_VERSION,
      integrity: "ok",
      foreignKeyViolations: 0,
    };
  } finally {
    db.close();
  }
}

export function assertCurrentSchema(db: DB, path = "<database>"): void {
  const current = readSchemaVersion(db);
  const constructionShapeComplete = current < 11 || (
    hasColumn(db, "sessions", "original_project_key")
    && hasColumn(db, "messages", "record_kind")
    && tableExists(db, "construction_metrics")
    && tableExists(db, "job_work")
    && tableExists(db, "source_schedule_state")
  );
  const searchShapeComplete = current < 12 || (
    tableExists(db, "session_search_documents")
    && tableExists(db, "session_search_fts")
  );
  const compactEvidenceShapeComplete = current < 13 || (
    hasColumn(db, "messages", "content_digest")
    && hasColumn(db, "messages", "content_bytes")
    && hasColumn(db, "messages", "content_token_estimate")
    && hasColumn(db, "messages", "source_prose_present")
    && hasColumn(db, "tool_activities", "payload_digest")
    && hasColumn(db, "tool_activities", "payload_bytes")
    && hasColumn(db, "tool_activities", "payload_token_estimate")
  );
  if (current !== LATEST_SCHEMA_VERSION || !constructionShapeComplete || !searchShapeComplete || !compactEvidenceShapeComplete) {
    const shape = current === LATEST_SCHEMA_VERSION && (!constructionShapeComplete || !searchShapeComplete || !compactEvidenceShapeComplete) ? " (semantic shape incomplete)" : "";
    throw new Error(
      `atlas database schema v${current}${shape} is not current (requires v${LATEST_SCHEMA_VERSION}): ${path}; ` +
      "ordinary startup will not migrate it — use an explicit nondefault config and `atlas migrate --isolated-clone` on an isolated clone",
    );
  }
}

function readSchemaVersion(db: DB): number {
  const metaExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`).get() as { name: string } | null;
  if (!metaExists) return 0;
  const row = db.prepare(`SELECT value FROM meta WHERE key=?`).get(SCHEMA_VERSION_META_KEY) as { value: string } | null;
  const parsed = Number(row?.value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function assertIsolatedCloneMigrationRequest(request: IsolatedCloneMigrationRequest): void {
  if (request.confirmation !== ISOLATED_CLONE_MIGRATION_CONFIRMATION) {
    throw new Error("migration requires the literal isolated-clone confirmation");
  }
  if (!isAbsolute(request.configPath) || !isAbsolute(request.dbPath)) {
    throw new Error("migration requires absolute --config and dbPath values");
  }
  const defaultConfig = resolve(
    process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"),
    "session-atlas/config.toml",
  );
  const liveDb = resolve(
    process.env.XDG_DATA_HOME || resolve(homedir(), ".local/share"),
    "session-atlas/atlas.db",
  );
  if (resolve(request.configPath) === defaultConfig || resolve(request.dbPath) === liveDb) {
    throw new Error("migration refuses the default config and live Atlas database");
  }
  if (!existsSync(request.configPath) || !existsSync(request.dbPath)) {
    throw new Error("migration requires an existing explicit config and isolated clone database");
  }
  if (lstatSync(request.dbPath).isSymbolicLink() || lstatSync(request.configPath).isSymbolicLink()) {
    throw new Error("migration refuses symlinked config/database targets");
  }
  const realDb = realpathSync(request.dbPath);
  const realConfig = realpathSync(request.configPath);
  const allowedRoots = [realpathSync("/private/tmp"), realpathSync(tmpdir())];
  if (!allowedRoots.some((root) => isWithin(root, realDb)) || !allowedRoots.some((root) => isWithin(root, realConfig))) {
    throw new Error("migration target and config must both be inside an owner-controlled temporary clone root");
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith("/") ? root : root + "/");
}

/** Low-level schema primitive for explicit migration/test/shadow owners only. */
export function runMigrations(db: DB, targetVersion: number = LATEST_SCHEMA_VERSION): void {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0 || targetVersion > LATEST_SCHEMA_VERSION) {
    throw new RangeError(`invalid migration target v${targetVersion}`);
  }
  // Bootstrap: the `meta` table is itself created by migration v1, so it may
  // not exist yet on a fresh DB. Treat its absence as version 0.
  const metaExists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`)
    .get() as { name: string } | null;
  let current = 0;
  if (metaExists) {
    const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(SCHEMA_VERSION_META_KEY) as
      | { value: string }
      | null;
    current = Number(row?.value ?? 0);
  }

  const pending = MIGRATIONS.filter((m) => m.version > current && m.version <= targetVersion).sort((a, b) => a.version - b.version);
  if (pending.length === 0) {
    // v13 was exercised against isolated development clones before release.
    // Keep explicit migration ownership able to repair those already-stamped
    // databases without making ordinary openDb startup mutate schema.
    if (current === 13 && targetVersion >= 13) db.exec(V13_FOREIGN_KEY_INDEX_SQL);
    return;
  }

  const apply = db.transaction(() => {
    for (const m of pending) applyMigration(db, m);
  });
  apply();
}

function applyMigration(db: DB, m: Migration): void {
  // A dirty pre-release test/archive can carry the complete v11 shape while
  // its meta version was rolled back to exercise v10 conditional repair.
  // Do not replay non-idempotent ALTER statements over an already-complete v11.
  const v11AlreadyMaterialized = m.version === 11
    && hasColumn(db, "sessions", "original_project_key")
    && hasColumn(db, "messages", "record_kind")
    && tableExists(db, "construction_metrics")
    && tableExists(db, "job_work")
    && tableExists(db, "source_schedule_state");
  const v12AlreadyMaterialized = m.version === 12
    && tableExists(db, "session_search_documents")
    && tableExists(db, "session_search_fts");
  if (m.version === 13) {
    ensureColumn(db, "messages", "content_digest", "TEXT CHECK (content_digest IS NULL OR (length(content_digest)=64 AND content_digest NOT GLOB '*[^0-9a-f]*'))");
    ensureColumn(db, "messages", "content_bytes", "INTEGER CHECK (content_bytes IS NULL OR content_bytes >= 0)");
    ensureColumn(db, "messages", "content_token_estimate", "INTEGER CHECK (content_token_estimate IS NULL OR content_token_estimate >= 0)");
    ensureColumn(db, "messages", "source_prose_present", "INTEGER NOT NULL DEFAULT 0 CHECK (source_prose_present IN (0,1))");
    ensureColumn(db, "tool_activities", "payload_digest", "TEXT CHECK (payload_digest IS NULL OR (length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'))");
    ensureColumn(db, "tool_activities", "payload_bytes", "INTEGER CHECK (payload_bytes IS NULL OR payload_bytes >= 0)");
    ensureColumn(db, "tool_activities", "payload_token_estimate", "INTEGER CHECK (payload_token_estimate IS NULL OR payload_token_estimate >= 0)");
    db.exec(`UPDATE messages SET source_prose_present=1 WHERE source_prose_present=0 AND prose IS NOT NULL AND length(trim(prose))>0;`);
    db.exec(V13_EFFICIENT_SEARCH_TRIGGER_SQL);
    db.exec(V13_FOREIGN_KEY_INDEX_SQL);
  } else if (!v11AlreadyMaterialized && !v12AlreadyMaterialized && m.up.trim()) db.exec(m.up);
  if (m.version === 10) {
    ensureColumn(db, "logical_metrics", "logical_tool_call_count", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "ingest_state", "transcript_bytes", "INTEGER");
    db.exec(`UPDATE ingest_state SET transcript_bytes=offset WHERE transcript_bytes IS NULL;`);
  }
  db.prepare(
    `INSERT INTO meta(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SCHEMA_VERSION_META_KEY, String(m.version));
}

function ensureColumn(db: DB, table: string, column: string, declaration: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration};`);
}

function hasColumn(db: DB, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function tableExists(db: DB, table: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

/** Mark the core as written (TUI change-detection polls meta.last_write). */
export function bumpLastWrite(db: DB): void {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES ('last_write', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(Date.now()));
}

export function getLastWrite(db: DB): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'last_write'`).get() as
    | { value: string }
    | null;
  return Number(row?.value ?? 0);
}
