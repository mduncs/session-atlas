import { createHash, randomUUID } from "node:crypto";
import { open, link, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Config } from "./config.js";
import { assertNoOpenDbLeases, openDb, openRebuildShadowDb, type DB } from "./db/index.js";
import { materializeSpan, WHOLE_SESSION_FAVORITE_MARKER } from "./favorites.js";
import { ingest } from "./ingest.js";
import { rebuildAllLogicalMetrics } from "./logical-metrics.js";
import { validateV12SearchIndex } from "./search/v12-fts.js";
import type { VolumeIdentityProbe } from "./runtime/storage-identity.js";
import { withConstructionAuthority } from "./runtime/writer-coordinator.js";

export type RebuildStage =
  | "locked"
  | "snapshotted"
  | "built"
  | "restored"
  | "validated"
  | "before-swap"
  | "swapped";

export interface RebuildOptions {
  hard?: boolean;
  /** Injectable fixture builder; production uses the canonical full ingest. */
  buildShadow?: (db: DB, config: Config) => Promise<void>;
  /** Test/telemetry seam. Throwing before `swapped` must preserve the original. */
  onStage?: (stage: RebuildStage) => void | Promise<void>;
  /** Injectable storage identity seam; production uses the real read-only probe. */
  storageProbe?: VolumeIdentityProbe;
}

export interface RebuildReport {
  hard: boolean;
  sessions: number;
  messages: number;
  favorites: number;
  summariesRestored: number;
  tagsRestored: number;
  prunedCacheEntries: number;
}

interface StableSummary {
  harness: string;
  nativeId: string;
  tier: number;
  topicLine: string | null;
  body: string | null;
  msgCountCovered: number;
  model: string | null;
  generatedAt: number | null;
  coverageBasis: string;
  needsRevalidation: number;
  anchors: Array<{
    ord: number;
    topic: string;
    fromOrdinal: number;
    toOrdinal: number;
    body: string | null;
  }>;
}

interface StableSessionTag {
  harness: string;
  nativeId: string;
  tagName: string;
}

interface StableCandidate extends StableSessionTag {}

interface StableSessionIdentity {
  harness: string;
  nativeId: string;
}

interface StableTagSynthesis {
  tagName: string;
  body: string;
  model: string;
  provider: string | null;
  citations: Array<{ session: StableSessionIdentity; ordinal: number | null }>;
  sessions: StableSessionIdentity[];
  generatedAt: number;
}

interface StableMergeTag {
  name: string;
  promotedAt: number | null;
  sessions: StableSessionIdentity[];
  candidates: StableSessionIdentity[];
}

interface StableTagMergeEvent {
  id: number;
  targetName: string;
  sourceNames: string;
  snapshot: { target: StableMergeTag; sources: StableMergeTag[] };
  model: string;
  provider: string | null;
  createdAt: number;
  revertedAt: number | null;
}

interface StableJobAttempt { [key: string]: unknown; id: number; work_id: number; attempt_ordinal: number; }
interface StableJobWork { [key: string]: unknown; id: number; }
interface PreservedState {
  favorites: FavoriteSnapshot[];
  summaries: StableSummary[];
  tags: Array<{ name: string; promotedAt: number | null }>;
  sessionTags: StableSessionTag[];
  candidates: StableCandidate[];
  tagSyntheses: StableTagSynthesis[];
  tagMergeEvents: StableTagMergeEvent[];
  jobWork: StableJobWork[];
  jobAttempts: StableJobAttempt[];
  favoriteFingerprint: string;
  durableFingerprint: string;
}

interface FavoriteSnapshot {
  id: number;
  harness: string;
  nativeId: string;
  fromOrdinal: number | null;
  toOrdinal: number | null;
  spanText: string | null;
  spanHash: string | null;
  topic: string | null;
  scope: "tail" | "span" | "session";
  status: "ok" | "pending";
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
}

/**
 * Rebuild the cache into a sibling database and replace the destination with
 * one atomic rename. The original is never dropped or edited table-by-table.
 */
export async function rebuildDatabase(config: Config, options: RebuildOptions = {}): Promise<RebuildReport> {
  return withConstructionAuthority({
    dbPath: config.dbPath,
    config,
    operation: `atlas rebuild${options.hard ? " --hard" : ""}`,
    probe: options.storageProbe,
  }, () => rebuildDatabaseWithAuthority(config, options));
}

async function rebuildDatabaseWithAuthority(config: Config, options: RebuildOptions): Promise<RebuildReport> {
  const dbPath = config.dbPath;
  const token = `${process.pid}-${randomUUID()}`;
  const lockPath = `${dbPath}.maintenance.lock`;
  const shadowPath = `${dbPath}.rebuild-${token}`;
  const backupPath = `${dbPath}.pre-rebuild-${token}.bak`;
  const backupWalPath = `${backupPath}-wal`;
  const backupShmPath = `${backupPath}-shm`;
  let lockHandle: FileHandle | null = null;
  let original: DB | null = null;
  let shadow: DB | null = null;
  let backupLinked = false;
  let swapped = false;
  let walMoved = false;
  let shmMoved = false;

  try {
    lockHandle = await acquireMaintenanceLock(lockPath);
    await options.onStage?.("locked");
    // Leases catch idle handles opened through Atlas before maintenance began.
    // The checkpoint/writer-lock probes below separately catch active handles
    // from non-cooperating SQLite clients which do not participate in leases.
    await assertNoOpenDbLeases(dbPath);

    original = await openDb(dbPath, {
      allowMaintenance: true,
      storage: config.storage,
      storageProbe: options.storageProbe,
    });
    original.exec("PRAGMA busy_timeout=0;");
    assertCheckpointAvailable(original);
    try {
      original.exec("BEGIN IMMEDIATE;");
    } catch (error) {
      throw new Error(`rebuild refused: database has an active writer (${messageOf(error)})`);
    }

    const snapshotOnly = Number((original.prepare(`SELECT COUNT(*) n FROM sessions WHERE source_validation_status='snapshot_only'`).get() as { n: number }).n);
    if (snapshotOnly > 0) throw new Error(`rebuild refused: ${snapshotOnly} retained snapshot-only session(s) require lossless shadow carry-forward`);
    const preserved = snapshotState(original, options.hard ?? false);
    await options.onStage?.("snapshotted");

    shadow = await openRebuildShadowDb(shadowPath, {
      storage: config.storage,
      storageProbe: options.storageProbe,
    });
    const shadowConfig = { ...config, dbPath: shadowPath };
    if (options.buildShadow) {
      await options.buildShadow(shadow, shadowConfig);
      // Custom shadow builders used by embedders/tests may insert raw rows
      // directly. Normal ingest already rebuilds each changed session.
      rebuildAllLogicalMetrics(shadow);
    } else {
      await ingest(shadow, shadowConfig, { full: true, storageProbe: options.storageProbe });
    }
    await options.onStage?.("built");

    const restored = restoreState(shadow, preserved, options.hard ?? false);
    await options.onStage?.("restored");
    rebuildIndexes(shadow);
    const counts = validateDatabase(shadow, preserved.favoriteFingerprint);
    await options.onStage?.("validated");

    // Produce a single-file shadow. A leftover WAL beside a newly renamed main
    // file can be replayed into the wrong database, so journal conversion is a
    // correctness condition rather than cleanup polish.
    const checkpoint = pragmaRow(shadow, "PRAGMA wal_checkpoint(TRUNCATE)") as CheckpointRow;
    if (checkpoint.busy !== 0) throw new Error("shadow checkpoint remained busy");
    shadow.exec("PRAGMA journal_mode=DELETE;");
    shadow.close();
    shadow = null;

    original.exec("COMMIT;");
    original.close();
    original = null;

    await options.onStage?.("before-swap");
    // Move (never unlink) checkpointed WAL bookkeeping out of the destination
    // namespace immediately before the main-file replacement. On macOS this
    // avoids invalidating a vnode retained by SQLite's WAL implementation.
    walMoved = await moveIfPresent(`${dbPath}-wal`, backupWalPath);
    shmMoved = await moveIfPresent(`${dbPath}-shm`, backupShmPath);
    await link(dbPath, backupPath);
    backupLinked = true;
    await rename(shadowPath, dbPath); // POSIX atomic replacement of destination.
    swapped = true;
    await options.onStage?.("swapped");

    // Verify the pathname now resolves to the validated image. If this final
    // check fails, atomically restore the hard-linked original.
    const installed = new (await import("bun:sqlite")).Database(dbPath, { readonly: true, strict: true });
    try {
      validateDatabase(installed, preserved.favoriteFingerprint);
    } finally {
      installed.close();
    }
    await rm(backupPath, { force: true });
    backupLinked = false;
    await rm(backupWalPath, { force: true }).catch(() => undefined);
    await rm(backupShmPath, { force: true }).catch(() => undefined);
    walMoved = false;
    shmMoved = false;

    return {
      hard: options.hard ?? false,
      sessions: counts.sessions,
      messages: counts.messages,
      favorites: counts.favorites,
      summariesRestored: restored.summaries,
      tagsRestored: restored.tags,
      prunedCacheEntries: restored.pruned,
    };
  } catch (error) {
    if (original) {
      try {
        original.exec("ROLLBACK;");
      } catch {}
      original.close();
      original = null;
    }
    if (shadow) {
      shadow.close();
      shadow = null;
    }
    if (swapped && backupLinked) {
      await rename(backupPath, dbPath);
      backupLinked = false;
    }
    if (walMoved) {
      await rename(backupWalPath, `${dbPath}-wal`).catch(() => undefined);
      walMoved = false;
    }
    if (shmMoved) {
      await rename(backupShmPath, `${dbPath}-shm`).catch(() => undefined);
      shmMoved = false;
    }
    throw error;
  } finally {
    await rm(shadowPath, { force: true }).catch(() => undefined);
    await rm(`${shadowPath}-wal`, { force: true }).catch(() => undefined);
    await rm(`${shadowPath}-shm`, { force: true }).catch(() => undefined);
    if (backupLinked && !swapped) await rm(backupPath, { force: true }).catch(() => undefined);
    if (!walMoved) await rm(backupWalPath, { force: true }).catch(() => undefined);
    if (!shmMoved) await rm(backupShmPath, { force: true }).catch(() => undefined);
    if (lockHandle) await lockHandle.close().catch(() => undefined);
    if (lockHandle) await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

async function acquireMaintenanceLock(path: string): Promise<FileHandle> {
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + "\n");
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`rebuild refused: maintenance lock exists at ${path}`);
    }
    throw error;
  }
}

function assertCheckpointAvailable(db: DB): void {
  const row = pragmaRow(db, "PRAGMA wal_checkpoint(TRUNCATE)") as CheckpointRow;
  if (row.busy !== 0) throw new Error("rebuild refused: WAL checkpoint is busy");
}

function pragmaRow(db: DB, sql: string): unknown {
  const statement = db.prepare(sql);
  try {
    return statement.get();
  } finally {
    statement.finalize();
  }
}

interface CheckpointRow {
  busy: number;
  log: number;
  checkpointed: number;
}

function snapshotState(db: DB, hard: boolean): PreservedState {
  const favorites = (db.prepare(`SELECT * FROM favorites ORDER BY id`).all() as Array<Record<string, unknown>>).map(
    (row) => {
      const harness = String(row.harness);
      const nativeId = String(row.native_id);
      const scope = row.scope as "tail" | "span" | "session";
      let spanText = nullableString(row.span_text);
      let spanHash = nullableString(row.span_hash);
      let status = row.status as "ok" | "pending";
      let lastError = nullableString(row.last_error);

      // The interactive favorite path stores only a constant-size identity
      // marker. Rebuild is the destructive cache boundary, so expand that
      // marker while the old indexed transcript is still readable, before a
      // missing source session can disappear from the shadow database.
      const markerHash = createHash("sha256").update(WHOLE_SESSION_FAVORITE_MARKER).digest("hex");
      if (
        scope === "session"
        && spanText === WHOLE_SESSION_FAVORITE_MARKER
        && spanHash === markerHash
      ) {
        const materialized = materializeSpan(db, { harness, nativeId, wholeSession: true });
        if (materialized) {
          spanText = materialized.text;
          spanHash = materialized.hash;
          status = "ok";
          lastError = null;
        }
      }

      return {
        id: Number(row.id),
        harness,
        nativeId,
        fromOrdinal: nullableNumber(row.from_ordinal),
        toOrdinal: nullableNumber(row.to_ordinal),
        spanText,
        spanHash,
        topic: nullableString(row.topic),
        scope,
        status,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        lastError,
      };
    },
  );
  // Hard rebuild is stronger reconstruction, never purge authorization.
  void hard;

  const summaries = (db
    .prepare(
      `SELECT sm.id, s.harness, s.native_id, sm.tier, sm.topic_line, sm.body,
              sm.msg_count_covered, sm.model, sm.generated_at,
              sm.coverage_basis, sm.needs_revalidation
       FROM summaries sm JOIN sessions s ON s.id=sm.session_id`,
    )
    .all() as Array<Record<string, unknown>>).map((row) => ({
      harness: String(row.harness),
      nativeId: String(row.native_id),
      tier: Number(row.tier),
      topicLine: nullableString(row.topic_line),
      body: nullableString(row.body),
      msgCountCovered: Number(row.msg_count_covered),
      model: nullableString(row.model),
      generatedAt: nullableNumber(row.generated_at),
      coverageBasis: String(row.coverage_basis),
      needsRevalidation: Number(row.needs_revalidation),
      anchors: (db
        .prepare(
          `SELECT ord, topic, from_ordinal, to_ordinal, body
           FROM summary_anchors WHERE summary_id=? ORDER BY ord`,
        )
        .all(Number(row.id)) as Array<Record<string, unknown>>).map((anchor) => ({
        ord: Number(anchor.ord),
        topic: String(anchor.topic),
        fromOrdinal: Number(anchor.from_ordinal),
        toOrdinal: Number(anchor.to_ordinal),
        body: nullableString(anchor.body),
      })),
    }));
  const tags = (db.prepare(`SELECT name, promoted_at FROM tags`).all() as Array<Record<string, unknown>>).map((row) => ({
    name: String(row.name),
    promotedAt: nullableNumber(row.promoted_at),
  }));
  const sessionTags = db
    .prepare(
      `SELECT s.harness, s.native_id, t.name tag_name
       FROM session_tags st JOIN sessions s ON s.id=st.session_id JOIN tags t ON t.id=st.tag_id`,
    )
    .all() as Array<{ harness: string; native_id: string; tag_name: string }>;
  const candidates = db
    .prepare(
      `SELECT s.harness, s.native_id, tc.name tag_name
       FROM tag_candidates tc JOIN sessions s ON s.id=tc.session_id`,
    )
    .all() as Array<{ harness: string; native_id: string; tag_name: string }>;

  const tagSyntheses = snapshotTagSyntheses(db);
  const tagMergeEvents = snapshotTagMergeEvents(db);
  const jobWork = db.prepare(`SELECT * FROM job_work ORDER BY id`).all() as StableJobWork[];
  const jobAttempts = db.prepare(`SELECT * FROM job_attempts ORDER BY id`).all() as StableJobAttempt[];
  const durable = { favorites, summaries, tags, sessionTags: sessionTags.map(stableTag), candidates: candidates.map(stableTag), tagSyntheses, tagMergeEvents, jobWork, jobAttempts };

  return {
    ...durable,
    favoriteFingerprint: fingerprintFavorites(favorites),
    durableFingerprint: fingerprintDurable(durable),
  };
}

function restoreState(
  db: DB,
  state: PreservedState,
  hard: boolean,
): { summaries: number; tags: number; pruned: number } {
  let summaries = 0;
  let tags = 0;
  let pruned = 0;
  const sessionId = db.prepare(`SELECT id FROM sessions WHERE harness=? AND native_id=?`);
  const tx = db.transaction(() => {
    for (const fav of state.favorites) {
      db.prepare(
        `INSERT INTO favorites(
           id,harness,native_id,from_ordinal,to_ordinal,span_text,span_hash,topic,scope,
           status,created_at,updated_at,last_error
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        fav.id,
        fav.harness,
        fav.nativeId,
        fav.fromOrdinal,
        fav.toOrdinal,
        fav.spanText,
        fav.spanHash,
        fav.topic,
        fav.scope,
        fav.status,
        fav.createdAt,
        fav.updatedAt,
        fav.lastError,
      );
    }

    // Merge history is user-visible undo data, not a re-derivable cache. Its
    // snapshots contain cache-local session ids, so always restore it after
    // remapping through stable session identity, including for hard rebuilds.
    restoreTagMergeEvents(db, state.tagMergeEvents, sessionId);
    for (const tag of state.tags) {
      db.prepare(`INSERT INTO tags(name,promoted_at) VALUES (?,?)`).run(tag.name, tag.promotedAt);
      tags++;
    }
    for (const summary of state.summaries) {
      const session = sessionId.get(summary.harness, summary.nativeId) as { id: number } | null;
      if (!session) throw new Error(`rebuild refused: summary target missing ${summary.harness}:${summary.nativeId}`);
      const inserted = db.prepare(
        `INSERT INTO summaries(
           session_id,tier,topic_line,body,msg_count_covered,model,generated_at,coverage_basis,needs_revalidation
         ) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        session.id,
        summary.tier,
        summary.topicLine,
        summary.body,
        summary.msgCountCovered,
        summary.model,
        summary.generatedAt,
        summary.coverageBasis,
        summary.needsRevalidation,
      );
      const summaryId = Number(inserted.lastInsertRowid);
      for (const anchor of summary.anchors) {
        db.prepare(
          `INSERT INTO summary_anchors(summary_id,ord,topic,from_ordinal,to_ordinal,body)
           VALUES (?,?,?,?,?,?)`,
        ).run(summaryId, anchor.ord, anchor.topic, anchor.fromOrdinal, anchor.toOrdinal, anchor.body);
      }
      summaries++;
    }
    for (const relation of state.sessionTags) {
      const session = sessionId.get(relation.harness, relation.nativeId) as { id: number } | null;
      if (!session) throw new Error(`rebuild refused: tag assignment target missing ${relation.harness}:${relation.nativeId}`);
      db.prepare(
        `INSERT INTO session_tags(session_id,tag_id)
         SELECT ?, id FROM tags WHERE name=?`,
      ).run(session.id, relation.tagName);
    }
    for (const candidate of state.candidates) {
      const session = sessionId.get(candidate.harness, candidate.nativeId) as { id: number } | null;
      if (!session) throw new Error(`rebuild refused: tag candidate target missing ${candidate.harness}:${candidate.nativeId}`);
      db.prepare(`INSERT INTO tag_candidates(name,session_id) VALUES (?,?)`).run(candidate.tagName, session.id);
    }
    for (const synthesis of state.tagSyntheses) {
      const tag = db.prepare(`SELECT id FROM tags WHERE name=?`).get(synthesis.tagName) as { id: number } | null;
      const sessions = remapSessions(synthesis.sessions, sessionId);
      const citations = synthesis.citations.flatMap((citation) => {
        const mapped = sessionId.get(citation.session.harness, citation.session.nativeId) as { id: number } | null;
        return mapped ? [{ sessionId: mapped.id, ordinal: citation.ordinal }] : [];
      });
      // A cached synthesis is only valid while its complete evidence ledger is
      // available. A missing tag or provenance session makes it re-derivable,
      // so prune it instead of installing citations that no longer prove it.
      if (!tag || sessions.length !== synthesis.sessions.length || citations.length !== synthesis.citations.length) {
        throw new Error(`rebuild refused: tag synthesis target/evidence missing for ${synthesis.tagName}`);
      }
      db.prepare(
        `INSERT INTO tag_syntheses(tag_id,body,model,provider,citations,session_ids,generated_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(tag_id) DO UPDATE SET
           body=excluded.body, model=excluded.model, provider=excluded.provider,
           citations=excluded.citations, session_ids=excluded.session_ids,
           generated_at=excluded.generated_at`,
      ).run(
        tag.id,
        synthesis.body,
        synthesis.model,
        synthesis.provider,
        JSON.stringify(citations),
        JSON.stringify(sessions),
        synthesis.generatedAt,
      );
    }
    for (const work of state.jobWork) insertWholeRow(db, "job_work", work);
    for (const attempt of state.jobAttempts) insertWholeRow(db, "job_attempts", attempt);
  });
  tx();
  const restoredFingerprint = snapshotState(db, false).durableFingerprint;
  if (restoredFingerprint !== state.durableFingerprint) throw new Error("rebuild durable-state fingerprint mismatch");
  return { summaries, tags, pruned };
}

function insertWholeRow(db: DB, table: "job_work" | "job_attempts", row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  if (columns.some((column) => !/^[a-z_]+$/.test(column))) throw new Error(`rebuild refused: invalid ${table} column`);
  const placeholders = columns.map(() => "?").join(",");
  const values = columns.map((column) => row[column]) as Array<string | number | bigint | null>;
  db.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES (${placeholders})`).run(...values);
}
function fingerprintDurable(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function rebuildIndexes(db: DB): void {
  const v12 = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_search_fts'`).get();
  if (v12) {
    db.exec(`DELETE FROM session_search_documents;
      INSERT INTO session_search_documents(
        session_id,logical_record_id,representative_raw_record_id,logical_ordinal,
        side,scope,prose,title,construction_generation
      ) SELECT session_id,logical_record_id,representative_raw_record_id,logical_ordinal,
        side,scope,prose,title,construction_generation FROM v12_search_eligible_documents;
      INSERT INTO session_search_fts(session_search_fts) VALUES ('rebuild');`);
  } else db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');`);
  db.exec("ANALYZE;");
}

function validateDatabase(
  db: DB,
  expectedFavoriteFingerprint: string,
): { sessions: number; messages: number; favorites: number } {
  const integrityStatement = db.prepare("PRAGMA integrity_check");
  const integrity = integrityStatement.all() as Array<{ integrity_check: string }>;
  integrityStatement.finalize();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error(`rebuilt database failed integrity_check: ${JSON.stringify(integrity)}`);
  }
  const foreignKeyStatement = db.prepare("PRAGMA foreign_key_check");
  const foreignKeys = foreignKeyStatement.all();
  foreignKeyStatement.finalize();
  if (foreignKeys.length > 0) throw new Error(`rebuilt database has ${foreignKeys.length} foreign-key violations`);
  const v12 = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_search_fts'`).get();
  if (v12) validateV12SearchIndex(db, { ftsIntegrityCheck: false });
  else {
    const prose = Number((db.prepare(`SELECT COUNT(*) n FROM messages WHERE role IN ('user','assistant')`).get() as { n: number }).n);
    const fts = Number((db.prepare(`SELECT COUNT(*) n FROM messages_fts`).get() as { n: number}).n);
    if (fts !== prose) throw new Error(`rebuilt FTS count mismatch: ${fts} indexed for ${prose} prose messages`);
  }

  const favorites = snapshotState(db, true).favorites;
  for (const favorite of favorites) {
    if (
      favorite.spanHash !== null &&
      favorite.spanText !== null &&
      createHash("sha256").update(favorite.spanText).digest("hex") !== favorite.spanHash
    ) {
      throw new Error(`favorite ${favorite.id} failed materialized span hash validation`);
    }
  }
  if (fingerprintFavorites(favorites) !== expectedFavoriteFingerprint) {
    throw new Error("rebuilt favorites differ from the materialized source snapshot");
  }
  return {
    sessions: Number((db.prepare(`SELECT COUNT(*) n FROM sessions`).get() as { n: number }).n),
    messages: Number((db.prepare(`SELECT COUNT(*) n FROM messages`).get() as { n: number }).n),
    favorites: favorites.length,
  };
}

function fingerprintFavorites(favorites: FavoriteSnapshot[]): string {
  const stable = favorites.map((fav) => ({
    id: fav.id,
    harness: fav.harness,
    nativeId: fav.nativeId,
    fromOrdinal: fav.fromOrdinal,
    toOrdinal: fav.toOrdinal,
    spanText: fav.spanText,
    spanHash: fav.spanHash,
    topic: fav.topic,
    scope: fav.scope,
    status: fav.status,
    createdAt: fav.createdAt,
    updatedAt: fav.updatedAt,
    lastError: fav.lastError,
  }));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function stableTag(row: { harness: string; native_id: string; tag_name: string }): StableSessionTag {
  return { harness: row.harness, nativeId: row.native_id, tagName: row.tag_name };
}

function snapshotTagSyntheses(db: DB): StableTagSynthesis[] {
  const sessionIdentity = db.prepare(`SELECT harness,native_id FROM sessions WHERE id=?`);
  return (db.prepare(
    `SELECT t.name tag_name, ts.body, ts.model, ts.provider, ts.citations,
            ts.session_ids, ts.generated_at
     FROM tag_syntheses ts JOIN tags t ON t.id=ts.tag_id
     ORDER BY t.name`,
  ).all() as Array<Record<string, unknown>>).map((row) => ({
    tagName: String(row.tag_name),
    body: String(row.body),
    model: String(row.model),
    provider: nullableString(row.provider),
    citations: parseJsonArray(row.citations, "tag synthesis citations").map((item) => {
      if (!isRecord(item) || !Number.isSafeInteger(item.sessionId)) {
        throw new Error("rebuild refused: invalid tag synthesis citation provenance");
      }
      return {
        session: requireStableSession(sessionIdentity, Number(item.sessionId), "tag synthesis citation"),
        ordinal: item.ordinal === null ? null : requireSafeInteger(item.ordinal, "tag synthesis citation ordinal"),
      };
    }),
    sessions: parseJsonArray(row.session_ids, "tag synthesis session_ids").map((id) =>
      requireStableSession(sessionIdentity, requireSafeInteger(id, "tag synthesis session id"), "tag synthesis")),
    generatedAt: Number(row.generated_at),
  }));
}

function snapshotTagMergeEvents(db: DB): StableTagMergeEvent[] {
  const sessionIdentity = db.prepare(`SELECT harness,native_id FROM sessions WHERE id=?`);
  return (db.prepare(`SELECT * FROM tag_merge_events ORDER BY id`).all() as Array<Record<string, unknown>>).map((row) => {
    const raw = parseJsonObject(row.snapshot, "tag merge snapshot");
    const target = stableMergeTag(raw.target, sessionIdentity);
    if (!Array.isArray(raw.sources)) throw new Error("rebuild refused: invalid tag merge snapshot sources");
    return {
      id: Number(row.id),
      targetName: String(row.target_name),
      sourceNames: String(row.source_names),
      snapshot: { target, sources: raw.sources.map((tag) => stableMergeTag(tag, sessionIdentity)) },
      model: String(row.model),
      provider: nullableString(row.provider),
      createdAt: Number(row.created_at),
      revertedAt: nullableNumber(row.reverted_at),
    };
  });
}

function stableMergeTag(value: unknown, sessionIdentity: ReturnType<DB["prepare"]>): StableMergeTag {
  if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.sessions) || !Array.isArray(value.candidates)) {
    throw new Error("rebuild refused: invalid tag merge snapshot entry");
  }
  return {
    name: value.name,
    promotedAt: value.promotedAt === null ? null : requireSafeInteger(value.promotedAt, "tag merge promoted_at"),
    sessions: value.sessions.map((id) =>
      requireStableSession(sessionIdentity, requireSafeInteger(id, "tag merge session id"), "tag merge snapshot")),
    candidates: value.candidates.map((id) =>
      requireStableSession(sessionIdentity, requireSafeInteger(id, "tag merge candidate id"), "tag merge snapshot")),
  };
}

function restoreTagMergeEvents(
  db: DB,
  events: StableTagMergeEvent[],
  sessionId: ReturnType<DB["prepare"]>,
): void {
  for (const event of events) {
    const remapTag = (tag: StableMergeTag) => ({
      name: tag.name,
      promotedAt: tag.promotedAt,
      sessions: remapSessions(tag.sessions, sessionId),
      candidates: remapSessions(tag.candidates, sessionId),
    });
    const snapshot = {
      target: remapTag(event.snapshot.target),
      sources: event.snapshot.sources.map(remapTag),
    };
    db.prepare(
      `INSERT INTO tag_merge_events(
         id,target_name,source_names,snapshot,model,provider,created_at,reverted_at
       ) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      event.id,
      event.targetName,
      event.sourceNames,
      JSON.stringify(snapshot),
      event.model,
      event.provider,
      event.createdAt,
      event.revertedAt,
    );
  }
}

function remapSessions(
  sessions: StableSessionIdentity[],
  sessionId: ReturnType<DB["prepare"]>,
): number[] {
  return sessions.map((session) => {
    const row = sessionId.get(session.harness, session.nativeId) as { id: number } | null;
    if (!row) throw new Error(`rebuild refused: stable target missing ${session.harness}:${session.nativeId}`);
    return row.id;
  });
}

function requireStableSession(
  statement: ReturnType<DB["prepare"]>,
  id: number,
  context: string,
): StableSessionIdentity {
  const row = statement.get(id) as { harness: string; native_id: string } | null;
  if (!row) throw new Error(`rebuild refused: ${context} references missing session ${id}`);
  return { harness: row.harness, nativeId: row.native_id };
}

function parseJsonArray(value: unknown, context: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  throw new Error(`rebuild refused: invalid ${context}`);
}

function parseJsonObject(value: unknown, context: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(String(value));
    if (isRecord(parsed)) return parsed;
  } catch {}
  throw new Error(`rebuild refused: invalid ${context}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireSafeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`rebuild refused: invalid ${context}`);
  return Number(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function moveIfPresent(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
