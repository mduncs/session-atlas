#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { assertNoOpenDbLeases } from "../db/index.js";
import { withConstructionAuthority } from "../runtime/writer-coordinator.js";
import type { StorageIdentityConfig } from "../runtime/storage-identity.js";
import { prepareCutover, publishCutover, rollbackCutover, type CutoverReceipt } from "./migration.js";
import { LibraryStore } from "./store.js";

export interface ServiceSnapshot { label: string; loaded: boolean; disabled: boolean; lastExitStatus: number | null }
export interface LiveCutoverHooks {
  snapshotServices(): Promise<ServiceSnapshot[]>;
  /** Stop/unload only; preserve original enable/disable configuration. */
  quiesceService(service: ServiceSnapshot): Promise<void>;
  validateDestination(database: string): Promise<void>;
  /** Must resolve only after new capture processes and their DB handles have stopped. */
  stopNewCapture(): Promise<void>;
  restoreService(service: ServiceSnapshot): Promise<void>;
}
export interface LiveCutoverSpec { legacyDatabase: string; nextDatabase: string; pointer: string; receiptDirectory: string; stateFile: string; storage?: StorageIdentityConfig }
export interface LiveCutoverState {
  version: 1; token: string; spec: LiveCutoverSpec; originalPointer: string | null;
  services: ServiceSnapshot[]; restoredServices?: string[]; phase: "fenced" | "prepared" | "published" | "replayed" | "releasing" | "rolled-back";
  receipt?: CutoverReceipt;
}
function syncDirectory(path: string): void { const fd = openSync(dirname(path), "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function atomicText(path: string, text: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path); syncDirectory(path);
}
function save(state: LiveCutoverState): void { atomicText(state.spec.stateFile, JSON.stringify(state, null, 2) + "\n"); }
function pointerBytes(path: string): string | null { try { return readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
function fencePath(state: LiveCutoverState): string { return `${state.spec.legacyDatabase}.maintenance.lock`; }
function assertOwned(state: LiveCutoverState): void {
  const owner = JSON.parse(readFileSync(fencePath(state), "utf8")) as { liveCutoverToken?: string };
  if (owner.liveCutoverToken !== state.token) throw new Error("maintenance fence ownership changed; refusing operation");
}
function nextFencePath(state: LiveCutoverState): string { return `${state.spec.nextDatabase}.maintenance.lock`; }
function assertNextFenceOwned(state: LiveCutoverState): void {
  const owner = JSON.parse(readFileSync(nextFencePath(state), "utf8")) as { liveCutoverToken?: string };
  if (owner.liveCutoverToken !== state.token) throw new Error("next library maintenance fence ownership changed; refusing rollback");
}
function acquireNextFence(state: LiveCutoverState): void {
  let fd: number;
  try { fd = openSync(nextFencePath(state), "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    assertNextFenceOwned(state); return;
  }
  try { writeFileSync(fd, JSON.stringify({ liveCutoverToken: state.token, pid: process.pid, stateFile: state.spec.stateFile, purpose: "rollback: retained to prevent post-rollback writes" }) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncDirectory(nextFencePath(state));
}
function checkSpec(spec: LiveCutoverSpec): void {
  for (const path of [spec.legacyDatabase, spec.nextDatabase, spec.pointer, spec.receiptDirectory, spec.stateFile]) if (!isAbsolute(path)) throw new Error("all live cutover paths must be absolute");
  if (realpathSync(spec.legacyDatabase) !== spec.legacyDatabase || realpathSync(spec.nextDatabase) !== spec.nextDatabase) throw new Error("database paths must be canonical (resolve symlinks before acquiring fences)");
  if (spec.legacyDatabase === spec.nextDatabase) throw new Error("legacy and next databases must differ");
  if (new Set([spec.legacyDatabase, spec.nextDatabase, spec.pointer, spec.stateFile, `${spec.legacyDatabase}.maintenance.lock`, `${spec.nextDatabase}.maintenance.lock`]).size !== 6) throw new Error("cutover paths must be distinct");
}
function authority<T>(state: LiveCutoverState, work: () => Promise<T>): Promise<T> {
  return withConstructionAuthority({ dbPath: state.spec.legacyDatabase, config: state.spec.storage, operation: `live-library-${state.phase}` }, work);
}
/** Prepare only. Any failure after the durable fence is acquired requires explicit rollback. */
export async function prepareLiveCutover(spec: LiveCutoverSpec, hooks: LiveCutoverHooks): Promise<LiveCutoverState> {
  checkSpec(spec);
  const db = new Database(spec.legacyDatabase, { readonly: true, create: false });
  try { db.query("SELECT harness,native_id FROM sessions LIMIT 0").all(); db.query("SELECT key,value FROM meta LIMIT 0").all(); } finally { db.close(); }
  const originalPointer = pointerBytes(spec.pointer);
  if (originalPointer !== null) {
    const current = JSON.parse(originalPointer) as { version: number; database: string };
    if (current.version !== 1 || current.database !== spec.legacyDatabase) throw new Error("existing pointer must target the specified legacy database");
  }
  const state: LiveCutoverState = { version: 1, token: randomUUID(), spec, originalPointer, services: await hooks.snapshotServices(), phase: "fenced" };
  return authority(state, async () => {
    mkdirSync(dirname(spec.stateFile), { recursive: true, mode: 0o700 });
    // Reserve the receipt before acquiring the fence: never overwrite another operation.
    const reservation = openSync(spec.stateFile, "wx", 0o600);
    try { writeFileSync(reservation, JSON.stringify(state, null, 2) + "\n"); fsyncSync(reservation); } finally { closeSync(reservation); }
    syncDirectory(spec.stateFile);
    let fd: number;
    try { fd = openSync(fencePath(state), "wx", 0o600); }
    catch (error) { unlinkSync(spec.stateFile); throw error; }
    try { writeFileSync(fd, JSON.stringify({ liveCutoverToken: state.token, pid: process.pid, stateFile: spec.stateFile }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    save(state); syncDirectory(fencePath(state));
    for (const service of state.services) if (service.loaded) await hooks.quiesceService(service);
    await assertNoOpenDbLeases(spec.legacyDatabase);
    if (pointerBytes(spec.pointer) !== originalPointer) throw new Error("pointer changed while acquiring fence");
    mkdirSync(dirname(spec.pointer), { recursive: true, mode: 0o700 });
    if (originalPointer === null) atomicText(spec.pointer, JSON.stringify({ version: 1, database: spec.legacyDatabase, liveCutoverSeed: state.token }) + "\n");
    const next = new LibraryStore(spec.nextDatabase, { readOnly: true });
    try { state.receipt = prepareCutover(spec.pointer, next, spec.receiptDirectory); } finally { next.close(); }
    state.phase = "prepared"; save(state); return state;
  });
}
export function readLiveCutoverState(path: string): LiveCutoverState {
  const state = JSON.parse(readFileSync(path, "utf8")) as LiveCutoverState;
  if (state.version !== 1 || state.spec.stateFile !== path || !state.token) throw new Error("invalid live cutover state");
  checkSpec(state.spec); return state;
}
export async function publishLiveCutover(stateFile: string, hooks: LiveCutoverHooks): Promise<LiveCutoverState> {
  const state = readLiveCutoverState(stateFile);
  return authority(state, async () => {
    assertOwned(state);
    if (state.phase !== "prepared" || !state.receipt) throw new Error("live cutover is not prepared");
    if (existsSync(nextFencePath(state))) throw new Error("next library is fenced; complete explicit rollback before any new cutover");
    await assertNoOpenDbLeases(state.spec.legacyDatabase);
    await hooks.validateDestination(state.spec.nextDatabase);
    assertOwned(state);
    state.receipt = publishCutover(state.receipt, state.spec.receiptDirectory);
    state.phase = "published"; save(state); return state;
  });
}
/** Replay first; restore original pointer bytes (including original absence); then release only our fence. */
export async function rollbackLiveCutover(stateFile: string, hooks: LiveCutoverHooks): Promise<LiveCutoverState> {
  const state = readLiveCutoverState(stateFile);
  if (state.phase === "rolled-back") { assertNextFenceOwned(state); await restoreHealthyServices(state, hooks); return state; }
  return authority(state, async () => {
    // `releasing` is durable proof that replay and exact route restoration
    // completed while our fence was still held. Its absence is expected after
    // an interruption between unlink and the final state write.
    if (state.phase === "releasing") { await finishRelease(state, hooks); return state; }
    assertOwned(state);
    // Block both fresh writers and subsequent transactions on existing UI/MCP
    // handles before capture shutdown and before exporting durable user data.
    acquireNextFence(state);
    await hooks.stopNewCapture();
    await assertNoOpenDbLeases(state.spec.legacyDatabase);
    await assertNoOpenDbLeases(state.spec.nextDatabase);
    assertNextFenceOwned(state);
    const current = pointerBytes(state.spec.pointer);
    const parsed = current === null ? null : JSON.parse(current) as { database?: string; transaction?: string; liveCutoverSeed?: string; rollbackOf?: string };
    // Recover a publish that completed before its live-state receipt was persisted.
    if (state.receipt && parsed?.transaction === state.receipt.id && parsed.database === state.spec.nextDatabase) {
      state.receipt = rollbackCutover(state.receipt, state.spec.receiptDirectory).receipt;
      state.phase = "replayed"; save(state);
    } else if (state.receipt && parsed?.rollbackOf === state.receipt.id && parsed.database === state.spec.legacyDatabase) {
      state.phase = "replayed"; save(state);
    } else if (state.phase === "published") throw new Error("published pointer changed; refusing rollback");
    else if (current !== state.originalPointer && !(parsed?.liveCutoverSeed === state.token && parsed.database === state.spec.legacyDatabase)) throw new Error("pointer changed; refusing rollback");
    assertOwned(state);
    if (state.originalPointer === null) { if (existsSync(state.spec.pointer)) { unlinkSync(state.spec.pointer); syncDirectory(state.spec.pointer); } }
    else atomicText(state.spec.pointer, state.originalPointer);
    // Persist replay/restore progress before release so interruption can be retried.
    state.phase = "releasing"; save(state);
    await finishRelease(state, hooks);
    return state;
  });
}

async function finishRelease(state: LiveCutoverState, hooks: LiveCutoverHooks): Promise<void> {
  assertNextFenceOwned(state);
  if (pointerBytes(state.spec.pointer) !== state.originalPointer) throw new Error("pointer changed after rollback restoration; refusing release");
  if (existsSync(fencePath(state))) {
    assertOwned(state); unlinkSync(fencePath(state));
  }
  syncDirectory(fencePath(state));
  state.phase = "rolled-back"; save(state);
  await restoreHealthyServices(state, hooks);
}

async function restoreHealthyServices(state: LiveCutoverState, hooks: LiveCutoverHooks): Promise<void> {
  state.restoredServices ??= [];
  for (const service of state.services) {
    if (!service.loaded || service.disabled || (service.lastExitStatus !== null && service.lastExitStatus !== 0) || state.restoredServices.includes(service.label)) continue;
    if (pointerBytes(state.spec.pointer) !== state.originalPointer || existsSync(fencePath(state))) throw new Error("rollback route/fence changed; refusing service restoration");
    await hooks.restoreService(service);
    state.restoredServices.push(service.label); save(state);
  }
}

// Explicit operational entry. The hooks module exports `hooks: LiveCutoverHooks`;
// the spec carries all absolute paths and storage volume expectations. No defaults.
if (import.meta.main) {
  const [command, specPath, hooksPath] = process.argv.slice(2);
  try {
    if (!["prepare", "publish", "rollback"].includes(command ?? "") || !specPath || !isAbsolute(specPath) || !hooksPath || !isAbsolute(hooksPath)) throw new Error("Usage: bun live-cutover.ts prepare|publish|rollback /absolute/spec.json /absolute/hooks.ts");
    const spec = JSON.parse(readFileSync(specPath, "utf8")) as LiveCutoverSpec;
    const { hooks } = await import(pathToFileURL(hooksPath).href) as { hooks: LiveCutoverHooks };
    const result = command === "prepare" ? await prepareLiveCutover(spec, hooks) : command === "publish" ? await publishLiveCutover(spec.stateFile, hooks) : await rollbackLiveCutover(spec.stateFile, hooks);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } catch (error) { process.stderr.write(`Live cutover: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
