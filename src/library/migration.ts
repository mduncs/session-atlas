import { Database } from "bun:sqlite";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { LibraryStore, type UserEvent } from "./store.js";
import { hashText } from "./passages.js";
import type { Favorite } from "./contracts.js";
const TABLES = ["favorites", "chains", "lineage_claims", "atlas_title_overrides", "tags", "session_tags", "tag_merge_events", "summaries", "summary_anchors", "session_human_classifications"];
export interface LegacyInventory { version: 1; source: string; capturedAt: number; tables: Record<string, Record<string, unknown>[]>; sessions: Record<string, unknown>[]; digest: string }
export function inventoryLegacy(path: string): LegacyInventory {
  if (!path.startsWith("/")) throw new Error("explicit absolute legacy database path required");
  const db = new Database(path, { readonly: true, strict: true });
  try {
    db.exec("BEGIN");
    const available = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name));
    const tables: LegacyInventory["tables"] = {};
    for (const table of TABLES) if (available.has(table)) tables[table] = db.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
    const sessions = available.has("sessions") ? db.query("SELECT * FROM sessions ORDER BY id").all() as Record<string, unknown>[] : [];
    const capturedAt = Date.now(); const digest = hashText(JSON.stringify({ tables, sessions })); db.exec("COMMIT");
    return { version: 1, source: resolve(path), capturedAt, tables, sessions, digest };
  } finally { db.close(); }
}
/** Stored bytes win over guessed ordinals. Full legacy records remain exportable. */
export function importLegacy(store: LibraryStore, inventory: LegacyInventory): { importedFavorites: number; unresolvedFavorites: number; digest: string; preservedTables: string[] } {
  if (resolve(inventory.source) === store.path) throw new Error("legacy source and destination must differ");
  if (hashText(JSON.stringify({ tables: inventory.tables, sessions: inventory.sessions })) !== inventory.digest) throw new Error("legacy inventory digest mismatch");
  let importedFavorites = 0; let unresolvedFavorites = 0;
  store.transaction(() => {
    store.db.query("INSERT OR REPLACE INTO library_meta VALUES(?,?)").run(`legacy-inventory:${inventory.digest}`, JSON.stringify(inventory));
    const sessions = new Map(inventory.sessions.map(s => [s.id, s]));
    const stable = (id: unknown) => { const s = sessions.get(id); return s ? { harness: String(s.harness), nativeId: String(s.native_id) } : null; };
    const lineage = (inventory.tables.lineage_claims ?? []).map(row => ({ ...row, sessionKey: stable(row.session_id), parentKey: { harness: row.parent_harness, nativeId: row.parent_native_id }, provenance: "preserved legacy relationship; source versus manual authority unchanged" }));
    const chains = (inventory.tables.chains ?? []).map(row => ({ ...row, headKey: stable(row.head_session_id), members: inventory.sessions.filter(s => s.chain_id === row.id).map(s => stable(s.id)) }));
    store.db.query("INSERT OR REPLACE INTO library_meta VALUES(?,?)").run("legacy-lineage", JSON.stringify({ lineage, chains, digest: inventory.digest }));
    const titles = Object.fromEntries((inventory.tables.atlas_title_overrides ?? []).flatMap(row => { const key = row.harness && row.native_id ? {harness:String(row.harness),nativeId:String(row.native_id)} : stable(row.session_id); return key ? [[JSON.stringify([key.harness,key.nativeId]), row.title ?? row.value]] : []; }));
    store.db.query("INSERT OR REPLACE INTO library_meta VALUES(?,?)").run("legacy-title-overrides", JSON.stringify(titles));

    const legacyClassifications = (inventory.tables.session_human_classifications ?? []).map(row => ({...row,sessionKey:stable(row.session_id),provenance:"historical classification; not revalidated"}));
    store.db.query("INSERT OR REPLACE INTO library_meta VALUES(?,?)").run("legacy-classifications", JSON.stringify(legacyClassifications));
    for (const tag of inventory.tables.tags ?? []) {
      const sessionKeys = (inventory.tables.session_tags ?? []).filter(row => row.tag_id === tag.id).flatMap(row => {const key=stable(row.session_id); return key ? [key] : [];});
      store.putCollection({id:`legacy-tag:${hashText(inventory.source).slice(0,16)}:${tag.id}`,title:`${String(tag.name)} [legacy tag]`,sessionKeys,refs:[],provisional:true});
    }
    const importPrefix = `legacy:${hashText(inventory.source).slice(0, 16)}:`;
    const presentImports = new Set((inventory.tables.favorites ?? []).map(row => `${importPrefix}${row.id}`));
    const priorJournal = store.journal();
    for (const favorite of store.favorites()) if (favorite.id.startsWith(importPrefix) && !presentImports.has(favorite.id) && !priorJournal.some(e => e.target === favorite.id && e.kind !== "legacy-import")) {
      store.db.query("DELETE FROM library_favorites WHERE id=?").run(favorite.id);
      const event: UserEvent = { id: randomUUID(), at: Date.now(), kind: "legacy-import", target: favorite.id, before: favorite, after: null };
      store.db.query("INSERT INTO library_journal VALUES(?,?,?)").run(event.id, event.at, JSON.stringify(event));
    }
    for (const row of inventory.tables.favorites ?? []) {
      const session = sessions.get(row.session_id);
      const harness = String(row.harness ?? session?.harness ?? "legacy-unresolved"); const nativeId = String(row.native_id ?? session?.native_id ?? `unresolved:${row.id}`);
      const text = typeof row.span_text === "string" ? row.span_text : "";
      const favorite: Favorite = { id: `legacy:${hashText(inventory.source).slice(0, 16)}:${row.id}`, sessionKey: { harness, nativeId }, refs: [], text, textHash: hashText(text), createdAt: Number(row.created_at ?? inventory.capturedAt), note: String(row.topic ?? "Imported legacy favorite; source span coordinates unresolved"), unresolved: true };
      // Reimport updates only unchanged legacy import, never a later user edit/removal.
      const previous = store.db.query("SELECT data FROM library_favorites WHERE id=?").get(favorite.id) as { data: string } | null;
      const journal = store.journal().filter(e => e.target === favorite.id);
      if (journal.some(e => e.kind !== "legacy-import")) continue;
      if (!previous || previous.data !== JSON.stringify(favorite)) {
        store.db.query("INSERT OR REPLACE INTO library_favorites VALUES(?,?)").run(favorite.id, JSON.stringify(favorite));
        const event: UserEvent = { id: randomUUID(), at: Date.now(), kind: "legacy-import", target: favorite.id, before: previous ? JSON.parse(previous.data) : null, after: favorite };
        store.db.query("INSERT INTO library_journal VALUES(?,?,?)").run(event.id, event.at, JSON.stringify(event)); importedFavorites++;
      }
      unresolvedFavorites++;
    }
  });
  return { importedFavorites, unresolvedFavorites, digest: inventory.digest, preservedTables: Object.keys(inventory.tables) };
}
export interface UserArchive { version: 1; favorites: Favorite[]; journal: UserEvent[]; overlays: { corrections: unknown[]; collections: unknown[] }; legacy: unknown[]; digest: string }
export function exportUserData(store: LibraryStore): UserArchive {
  const body = { version: 1 as const, favorites: store.favorites(), journal: store.journal(), overlays: { corrections: store.db.query("SELECT * FROM library_corrections ORDER BY key").all(), collections: store.db.query("SELECT * FROM library_collection_overlays ORDER BY id").all() }, legacy: store.db.query("SELECT * FROM library_meta WHERE key LIKE 'legacy-inventory:%' ORDER BY key").all() };
  return { ...body, digest: hashText(JSON.stringify(body)) };
}
export function importUserData(store: LibraryStore, archive: UserArchive): void {
  const { digest, ...body } = archive;
  if (archive.version !== 1 || hashText(JSON.stringify(body)) !== digest) throw new Error("user archive integrity check failed");
  store.transaction(() => {
    for (const f of archive.favorites) { if (hashText(f.text) !== f.textHash) throw new Error("favorite text hash failed"); store.db.query("INSERT OR REPLACE INTO library_favorites VALUES(?,?)").run(f.id, JSON.stringify(f)); }
    // Deletion is durable user data too; replay final state for every touched target.
    const touchedFavorites = new Set(archive.journal.filter(e => e.kind === "favorite" || e.kind === "legacy-import").map(e => e.target));
    const presentFavorites = new Set(archive.favorites.map(f => f.id));
    for (const id of touchedFavorites) if (!presentFavorites.has(id)) store.db.query("DELETE FROM library_favorites WHERE id=?").run(id);
    const correctionKeys = new Set((archive.overlays.corrections as { key: string }[]).map(r => r.key));
    const collectionKeys = new Set((archive.overlays.collections as { id: string }[]).map(r => r.id));
    for (const event of archive.journal) {
      if (event.kind === "classification" && !correctionKeys.has(event.target)) store.db.query("DELETE FROM library_corrections WHERE key=?").run(event.target);
      if (event.kind === "collection" && !collectionKeys.has(event.target)) store.db.query("DELETE FROM library_collection_overlays WHERE id=?").run(event.target);
    }
    for (const event of archive.journal) store.db.query("INSERT OR IGNORE INTO library_journal VALUES(?,?,?)").run(event.id, event.at, JSON.stringify(event));
    for (const raw of archive.overlays.corrections) { const r = raw as { key: string; data: string }; store.db.query("INSERT OR REPLACE INTO library_corrections VALUES(?,?)").run(r.key, r.data); }
    for (const raw of archive.overlays.collections) { const r = raw as { id: string; data: string }; store.db.query("INSERT OR REPLACE INTO library_collection_overlays VALUES(?,?)").run(r.id, r.data); }
    for (const raw of archive.legacy) { const r = raw as { key: string; value: string }; store.db.query("INSERT OR IGNORE INTO library_meta VALUES(?,?)").run(r.key, r.value); }
  });
}
/** Rollback replays durable favorite decisions into the real legacy schema.
 * New overlays/lineage journals without legacy equivalents remain in a named,
 * queryable preservation table and the verified external user archive. */
export function replayUserArchiveToLegacy(path: string, archive: UserArchive): { favorites: number; deleted: number } {
  const { digest, ...body } = archive;
  if (hashText(JSON.stringify(body)) !== digest) throw new Error("rollback user archive digest mismatch");
  const db = new Database(path, { create: false, strict: true });
  try {
    const columns = new Set((db.query("PRAGMA table_info(favorites)").all() as { name: string }[]).map(r => r.name));
    if (!columns.has("id") || !columns.has("span_text")) throw new Error("legacy favorite schema cannot replay exact saved bytes");
    const prefix = `legacy:${hashText(resolve(path)).slice(0,16)}:`;
    let favorites = 0, deleted = 0;
    db.transaction(() => {
      db.exec("CREATE TABLE IF NOT EXISTS atlas_library_replay_map(atlas_id TEXT PRIMARY KEY,legacy_id INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS atlas_library_user_journal(digest TEXT PRIMARY KEY,archive TEXT NOT NULL)");
      const present = new Set(archive.favorites.map(f => f.id));
      const touched = new Set(archive.journal.filter(e => e.kind === "favorite" || e.kind === "legacy-import").map(e => e.target));
      for (const id of touched) if (!present.has(id)) {
        const legacy = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : (db.query("SELECT legacy_id FROM atlas_library_replay_map WHERE atlas_id=?").get(id) as { legacy_id: number } | null)?.legacy_id;
        if (Number.isSafeInteger(legacy)) deleted += db.query("DELETE FROM favorites WHERE id=?").run(legacy!).changes;
      }
      for (const favorite of archive.favorites) {
        if (hashText(favorite.text) !== favorite.textHash) throw new Error("rollback favorite text hash mismatch");
        const legacy = favorite.id.startsWith(prefix) ? Number(favorite.id.slice(prefix.length)) : (db.query("SELECT legacy_id FROM atlas_library_replay_map WHERE atlas_id=?").get(favorite.id) as { legacy_id: number } | null)?.legacy_id;
        if (Number.isSafeInteger(legacy) && db.query("SELECT id FROM favorites WHERE id=?").get(legacy!)) {
          const patch: Record<string,unknown> = { span_text: favorite.text, span_hash: favorite.textHash, updated_at: Date.now(), status: "ok" };
          const fields = Object.keys(patch).filter(k => columns.has(k)); db.query(`UPDATE favorites SET ${fields.map(k => `${k}=?`).join(",")} WHERE id=?`).run(...fields.map(k => patch[k] as string | number), legacy!);
        } else {
          const values: Record<string,string | number | null> = { harness: favorite.sessionKey.harness, native_id: favorite.sessionKey.nativeId, from_ordinal: null, to_ordinal: null, span_text: favorite.text, span_hash: favorite.textHash, topic: `${favorite.note || "Saved passage"} [Atlas:${favorite.id}]`, scope: "span", status: "ok", created_at: favorite.createdAt, updated_at: Date.now(), last_error: null };
          const fields = Object.keys(values).filter(k => columns.has(k)); const inserted = db.query(`INSERT INTO favorites(${fields.join(",")}) VALUES(${fields.map(()=>"?").join(",")})`).run(...fields.map(k=>values[k]!));
          db.query("INSERT OR REPLACE INTO atlas_library_replay_map VALUES(?,?)").run(favorite.id, Number(inserted.lastInsertRowid));
        }
        favorites++;
      }
      db.query("INSERT OR REPLACE INTO atlas_library_user_journal VALUES(?,?)").run(digest, JSON.stringify(archive));
    }).immediate();
    return { favorites, deleted };
  } finally { db.close(); }
}
function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(temp, path);
  const dir = openSync(dirname(path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export interface CutoverReceipt { version: 1; id: string; pointer: string; from: string | null; to: string; at: number; userArchive: string; state: "prepared" | "published" | "rolled-back" }
/** Explicit pointer path only. Caller fences writers; no service is implicitly stopped. */
export function prepareCutover(pointer: string, next: LibraryStore, receiptDir: string): CutoverReceipt {
  if (![pointer, receiptDir].every(p => p.startsWith("/"))) throw new Error("absolute cutover paths required");
  const from = existsSync(pointer) ? (JSON.parse(readFileSync(pointer, "utf8")) as { database: string }).database : null;
  const id = randomUUID(); const userArchive = join(receiptDir, `${id}.user-data.json`); atomicJson(userArchive, exportUserData(next));
  const receipt: CutoverReceipt = { version: 1, id, pointer, from, to: next.path, at: Date.now(), userArchive, state: "prepared" }; atomicJson(join(receiptDir, `${id}.json`), receipt); return receipt;
}
export function publishCutover(receipt: CutoverReceipt, receiptDir: string): CutoverReceipt {
  const current = existsSync(receipt.pointer) ? (JSON.parse(readFileSync(receipt.pointer, "utf8")) as { database: string }).database : null;
  if (receipt.state !== "prepared" || current !== receipt.from) throw new Error("pointer changed; re-prepare cutover");
  const next = new LibraryStore(receipt.to, { readOnly: true }); try { if ((next.db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check !== "ok") throw new Error("destination integrity check failed"); } finally { next.close(); }
  atomicJson(receipt.pointer, { version: 1, database: receipt.to, transaction: receipt.id });
  const published: CutoverReceipt = { ...receipt, state: "published" }; atomicJson(join(receiptDir, `${receipt.id}.json`), published); return published;
}
export function rollbackCutover(receipt: CutoverReceipt, receiptDir: string): { receipt: CutoverReceipt; postCutoverUserData: string } {
  const current = JSON.parse(readFileSync(receipt.pointer, "utf8")) as { database: string; transaction: string };
  if (current.database !== receipt.to || current.transaction !== receipt.id || !receipt.from) throw new Error("rollback pointer mismatch or missing prior library");
  const currentStore = new LibraryStore(receipt.to, { readOnly: true }); const archive = exportUserData(currentStore); currentStore.close();
  const postCutoverUserData = join(receiptDir, `${receipt.id}.rollback-user-data.json`); atomicJson(postCutoverUserData, archive);
  // Replay exact favorite decisions into either schema and retain full overlay archive.
  let replayed = false;
  try { const old = new LibraryStore(receipt.from, { readOnly: true }); old.close(); replayed = true; } catch { /* incompatible legacy schema is left untouched */ }
  if (replayed) { const old = new LibraryStore(receipt.from); try { importUserData(old, archive); } finally { old.close(); } }
  else { replayUserArchiveToLegacy(receipt.from, archive); replayed = true; }
  atomicJson(receipt.pointer, { version: 1, database: receipt.from, rollbackOf: receipt.id, replayArchive: postCutoverUserData, replayed });
  const rolledBack: CutoverReceipt = { ...receipt, state: "rolled-back" }; atomicJson(join(receiptDir, `${receipt.id}.json`), rolledBack);
  return { receipt: rolledBack, postCutoverUserData };
}
