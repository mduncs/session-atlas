import { existsSync, readFileSync, statSync, mkdirSync, rmSync, writeFileSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { builtinSourceRoots } from "../config.js";
import type { CapturedSession, SourceEntry, SourceObservation } from "./contracts.js";
import type { IngestRecord } from "../adapters/types.js";
import { EvidenceStore, evidenceHash, type EvidenceManifest } from "./evidence.js";
import { discoverFiles, legacyAdapters, parseExport, parseGeminiStream, parseOpenCodeSqlite } from "./adapters/index.js";
import { makePassage } from "./passages.js";
import { extractArtifacts } from "./artifacts.js";

export interface CaptureStore {
  sources(): SourceEntry[];
  putSource(source: SourceEntry): unknown;
  publish(capture: CapturedSession): unknown;
  publishBounded?(capture: CapturedSession, options?: { signal?: AbortSignal }): Promise<void>;
  observations?(): SourceObservation[];
  observation?(id: string): SourceObservation | null;
  putObservation?(observation: SourceObservation): unknown;
  getState?<T>(key: string): T | null;
  setState?(key: string, value: unknown): unknown;
}
export interface CaptureOptions { reserveBytes?: number; sweepMs?: number; fullMs?: number; debounceMs?: number; afterRetention?: (observation: SourceObservation) => void; }
export interface CaptureResult { published: number; unchanged: number; failed: number; sources: number; }
export function discoverSources(home: string): SourceEntry[] {
  const roots: Record<string, string[]> = { ...builtinSourceRoots(home), gemini: [join(home, ".gemini", "tmp")], opencode: [join(home, ".local", "share", "opencode")] };
  return Object.entries(roots).flatMap(([harness, paths]) => paths.filter(path => existsSync(path)).map(root => ({ id: evidenceHash(`${harness}\0${resolve(root)}`), harness, root: resolve(root), enabled: false, capability: "live" as const, reachable: true, error: "Discovered; awaiting explicit source selection", lastCompleteReconciliation: null })));
}

export class CaptureCoordinator {
  readonly evidence: EvidenceStore;
  private running: Promise<CaptureResult> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private watchers: FSWatcher[] = [];
  private pending = new Set<string>();
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private manifests = new Map<string, EvidenceManifest>();
  private stopped = true;
  constructor(readonly store: CaptureStore, evidenceDir: string, readonly options: CaptureOptions = {}) {
    this.evidence = new EvidenceStore(evidenceDir, options.reserveBytes);
  }
  addSource(source: SourceEntry | { harness: string; root: string; capability?: SourceEntry["capability"] }): SourceEntry {
    const entry: SourceEntry = { id: "id" in source ? source.id : randomUUID(), harness: source.harness, root: resolve(source.root), capability: source.capability ?? (source.harness.endsWith("export") ? "import" : "live"), enabled: true, reachable: existsSync(source.root), error: null, lastCompleteReconciliation: null };
    this.store.putSource(entry);
    if (!this.stopped) this.notify(entry.id);
    return entry;
  }
  notify(sourceId = "*"): void {
    this.pending.add(sourceId);
    if (this.debounce || this.stopped) return;
    this.debounce = setTimeout(() => { this.debounce = null; void this.reconcile(false); }, this.options.debounceMs ?? 100);
  }
  async start(): Promise<CaptureResult> {
    if (!this.stopped) return this.reconcile();
    this.stopped = false;
    const result = await this.reconcile();
    for (const source of this.store.sources().filter(item => item.enabled)) {
      try { const watcher = watch(source.root, { recursive: statSync(source.root).isDirectory() }, () => this.notify(source.id)); watcher.on("error", () => this.notify(source.id)); this.watchers.push(watcher); } catch { /* Sweeps remain the correctness path. */ }
    }
    this.timers.push(setInterval(() => { void this.reconcile(false); }, this.options.sweepMs ?? 300_000));
    this.timers.push(setInterval(() => { void this.reconcile(true); }, this.options.fullMs ?? 1_800_000));
    return result;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    await this.running;
  }
  reconcile(full = true): Promise<CaptureResult> {
    if (this.running) { this.pending.add("*"); return this.running; }
    this.pending.clear();
    this.running = this.walk(full).finally(() => { this.running = null; if (this.pending.size && !this.stopped) this.notify(); });
    return this.running;
  }
  private async walk(full: boolean): Promise<CaptureResult> {
    const ownerDir = join(this.evidence.directory, ".capture-owner");
    try { mkdirSync(ownerDir, { mode: 0o700 }); }
    catch (error) {
      try {
        const owner = JSON.parse(readFileSync(join(ownerDir, "owner.json"), "utf8")) as { pid: number };
        let alive = true; try { process.kill(owner.pid, 0); } catch (e) { alive = (e as NodeJS.ErrnoException).code !== "ESRCH"; }
        if (alive) throw new Error(`Capture already owned by process ${owner.pid}; user actions and reads remain available`);
        rmSync(ownerDir, { recursive: true }); mkdirSync(ownerDir, { mode: 0o700 });
      } catch (e) { throw new Error(`Capture owner unavailable: ${e instanceof Error ? e.message : String(error)}`); }
    }
    writeFileSync(join(ownerDir, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });
    try { return await this.walkOwned(full); } finally { rmSync(ownerDir, { recursive: true, force: true }); }
  }
  private async walkOwned(full: boolean): Promise<CaptureResult> {
    this.store.setState?.("capture-status", { state: "capturing", startedAt: Date.now(), full });
    const result: CaptureResult = { published: 0, unchanged: 0, failed: 0, sources: 0 };
    for (const original of this.store.sources().filter(source => source.enabled)) {
      const source = { ...original }; result.sources++;
      const errors: string[] = [];
      const adapter = legacyAdapters[source.harness];
      try {
        statSync(source.root); source.reachable = true;
        if (source.capability === "unsupported") throw new Error("Source format unsupported");
        const sqliteRoot = statSync(source.root).isFile() && /\.(db|sqlite|sqlite3)$/.test(source.root);
        if (sqliteRoot && adapter) {
          const bytes = this.evidence.snapshotSqlite(source.root);
          const retained = this.retain(source, source.root, bytes, "sqlite");
          const snapshot = this.evidence.temporarySnapshot(bytes);
          try {
            const units = adapter.discover([snapshot.path]);
            for (const unit of units) {
              try { const parsed = adapter.admit ? adapter.admit(unit) : adapter.parse(unit); if (!("record" in parsed)) throw new Error(`Not admitted: ${parsed.reason}`); await this.publish(source, retained, parsed.record, bytes.length, result); } catch (error) { errors.push(String(error)); result.failed++; }
              await new Promise<void>(done => setImmediate(done));
            }
          } finally { adapter.cleanup?.(); snapshot.dispose(); }
        } else if (adapter) {
          const units = adapter.discover([source.root]);
          for (const unit of units) {
            try {
              const sqlite = /\.(db|sqlite|sqlite3)$/.test(unit.fullPath);
              if (sqlite) {
                const bytes = this.evidence.snapshotSqlite(unit.fullPath);
                const retained = this.retain(source, unit.fullPath, bytes, "sqlite");
                const snapshot = this.evidence.temporarySnapshot(bytes);
                try { const parsed = adapter.parse({ ...unit, fullPath: snapshot.path }); await this.publish(source, retained, parsed.record, bytes.length, result); } finally { adapter.cleanup?.(); snapshot.dispose(); }
              } else {
                const bytes = readFileSync(unit.fullPath);
                const format = unit.fullPath.endsWith("jsonl") ? "jsonl" : "json";
                const retained = this.retain(source, unit.fullPath, bytes, format);
                // Legacy admission retains original locator semantics (Kimi paired
                // state, Codex metadata), with content equality checked afterward.
                const dependency = JSON.stringify(adapter.sidecarContextFingerprint?.(unit) ?? null);
                this.evidence.retain(source.id, `${unit.fullPath}#parser-metadata`, Buffer.from(dependency), "metadata");
                const dependencyKey = `parsed-dependency:${retained.id}`;
                if (retained.indexedBoundary && this.store.getState?.<string>(dependencyKey) === dependency) { result.unchanged++; continue; }
                const parsed = adapter.admit ? adapter.admit(unit) : adapter.parse(unit);
                if (evidenceHash(readFileSync(unit.fullPath)) !== retained.objectHash || JSON.stringify(adapter.sidecarContextFingerprint?.(unit) ?? null) !== dependency) throw new Error("Source changed during parse; retained observation pending retry");
                if (!("record" in parsed)) {
                  if (parsed.reason === "auxiliary_workflow" || parsed.reason === "auxiliary_agent_artifact") {
                    this.store.putObservation?.({ ...retained, indexedBoundary: null, gaps: [], admission: { status: "excluded", reason: parsed.reason } });
                    await new Promise<void>(done => setImmediate(done));
                    continue;
                  }
                  throw new Error(`Not admitted: ${parsed.reason}`);
                }
                await this.publish(source, retained, parsed.record, Math.min(bytes.length, parsed.consumed), result);
                this.store.setState?.(dependencyKey, dependency);
              }
            } catch (error) { errors.push(`${unit.relPath}: ${String(error)}`); result.failed++; }
            await new Promise<void>(done => setImmediate(done));
          }
        } else {
          for (const path of discoverFiles(source.root, source.harness)) {
            try {
              const sqlite = /\.db$/.test(path);
              const bytes = sqlite ? this.evidence.snapshotSqlite(path) : readFileSync(path);
              const observation = this.retain(source, path, bytes, sqlite ? "sqlite" : path.endsWith("jsonl") ? "jsonl" : "export");
              let records: IngestRecord[];
              if (sqlite && source.harness === "opencode") {
                const snapshot = this.evidence.temporarySnapshot(bytes);
                try { records = parseOpenCodeSqlite(snapshot.path); } finally { snapshot.dispose(); }
              } else records = source.harness === "gemini" && path.endsWith("jsonl") ? parseGeminiStream(bytes) : parseExport(source.harness, bytes);
              for (const record of records) await this.publish(source, observation, record, observation.retainedBoundary.bytes - (path.endsWith("jsonl") ? bytes.length - bytes.lastIndexOf(10) - 1 : 0), result);
            } catch (error) { errors.push(`${path}: ${String(error)}`); result.failed++; }
            await new Promise<void>(done => setImmediate(done));
          }
        }
      } catch (error) { source.reachable = existsSync(source.root); errors.push(String(error)); result.failed++; }
      finally { adapter?.cleanup?.(); }
      source.error = errors.length ? errors.join("; ") : null;
      if (full && !errors.length) {
        source.lastCompleteReconciliation = Date.now();
        for (const observation of this.store.observations?.() ?? []) if (observation.sourceId === source.id && observation.indexedBoundary) this.store.putObservation?.({ ...observation, lastCompleteReconciliation: source.lastCompleteReconciliation });
      }
      this.store.putSource(source);
    }
    this.store.setState?.("capture-status", { state: result.failed ? "partial" : "idle", finishedAt: Date.now(), full, ...result });
    return result;
  }
  private retain(source: SourceEntry, locator: string, bytes: Buffer, format: string): SourceObservation {
    this.reportStage(source, locator, bytes.length, "retaining");
    const key = `${source.id}\0${locator}`;
    const manifest = this.evidence.retain(source.id, locator, bytes, format, this.manifests.get(key) ?? this.store.getState?.<EvidenceManifest>(`manifest:${key}`) ?? undefined);
    this.manifests.set(key, manifest);
    this.store.setState?.(`manifest:${key}`, manifest);
    const id = evidenceHash(JSON.stringify([source.id, locator, manifest.hash, "library-parser-v1"]));
    const prior = this.store.observation ? this.store.observation(id) : this.store.observations?.().find(item => item.id === id);
    const observation: SourceObservation = prior ?? { id, sourceId: source.id, locator, objectHash: manifest.hash, retainedBoundary: { observationId: id, bytes: bytes.length, at: manifest.capturedAt }, indexedBoundary: null, summaryCoverage: null, lastCompleteReconciliation: null, format, gaps: ["Retained evidence pending admission and indexing"] };
    this.store.putObservation?.(observation);
    this.options.afterRetention?.(observation);
    this.reportStage(source, locator, bytes.length, "parsing");
    return observation;
  }
  private reportStage(source: SourceEntry, locator: string, bytes: number, stage: string): void {
    this.store.setState?.("capture-status", {
      ...this.store.getState?.<Record<string, unknown>>("capture-status"),
      state: "capturing",
      active: { sourceId: source.id, harness: source.harness, locator, bytes, stage, at: Date.now() },
    });
  }
  private async publish(source: SourceEntry, observation: SourceObservation, record: IngestRecord, consumed: number, result: CaptureResult): Promise<void> {
    this.reportStage(source, observation.locator, observation.retainedBoundary.bytes, "preparing-passages");
    const sessionKey = { harness: source.harness, nativeId: record.nativeId };
    const passages = record.messages.flatMap(message => {
      const recordId = message.sourceRecordUuid ?? message.sourceRecordId ?? `ordinal:${message.sourceOrdinal ?? message.ordinal}`;
      const role = message.recordKind && !["real_user", "assistant_dialogue_prose"].includes(message.recordKind) ? message.recordKind === "tool" ? "tool" as const : "system" as const : message.role;
      const common = { sessionKey, observationId: observation.id, record: recordId, role, ordinal: message.ordinal, timestamp: message.ts };
      const out = [];
      const prose = message.prose ?? message.text;
      if (prose) out.push(makePassage({ ...common, channel: "prose", text: prose }));
      if (message.toolActivities?.length) {
        for (const activity of message.toolActivities) if (activity.toolText) out.push(makePassage({ ...common, record: activity.sourceActivityId ?? recordId, channel: `tool:${activity.activityOrdinal}:${activity.toolName ?? activity.activityKind}`, text: activity.toolText, role: "tool" }));
      } else if (message.toolText) out.push(makePassage({ ...common, channel: "tool", text: message.toolText, role: "tool" }));
      return out;
    });
    const revision = evidenceHash(JSON.stringify([observation.objectHash, record, passages.map(item => item.ref)]));
    const gaps = source.harness === "kimi" ? ["Kimi retains observed current context, not lifetime history"] : [];
    if (consumed < observation.retainedBoundary.bytes) gaps.push("Torn tail retained but not indexed");
    this.reportStage(source, observation.locator, observation.retainedBoundary.bytes, "extracting-artifacts");
    const capture: CapturedSession = { session: { key: sessionKey, revision, title: record.title ?? record.nativeId, cwd: record.cwd, updatedAt: record.endTs ?? record.startTs ?? 0, models: record.models, origin: record.origin === "human" ? "human_started" : record.origin === "agent" ? "worker" : record.origin, originReason: record.originDetail ?? "No explicit launch-origin evidence" }, observation: { ...observation, admission: undefined, indexedBoundary: { observationId: observation.id, bytes: consumed, at: Date.now() }, gaps }, passages, artifacts: extractArtifacts(passages, record.cwd) };
    this.reportStage(source, observation.locator, observation.retainedBoundary.bytes, "publishing");
    const published = this.store.publishBounded ? await this.store.publishBounded(capture) : this.store.publish(capture);
    if (published === false) result.unchanged++; else result.published++;
  }
}
