import type { Config } from "../config.js";
import type { DB } from "../db/index.js";
import { ingest, type IngestSummary } from "../ingest.js";
import { refreshLayers } from "../layers/refresh.js";
import { TaskSupervisor } from "../runtime/tasks.js";
import type { VolumeIdentityProbe } from "../runtime/storage-identity.js";
import { withConstructionAuthority } from "../runtime/writer-coordinator.js";

const BUILT_IN_ADAPTERS = new Set(["claude", "codex", "kilo"]);

export interface FirstRunSource {
  name: string;
  roots: string[];
  rootCount: number;
  adapterAvailable: boolean;
}

export interface FirstRunSourceProgress {
  source: string;
  phase: "queued" | "discovering" | "ingesting" | "complete" | "failed";
  rootsComplete: number;
  rootCount: number;
  rowsAdded: number;
  detail?: string;
}

export type FirstRunState =
  | { kind: "not-needed"; sessionCount: number }
  | {
      kind: "configuration-needed";
      sessionCount: 0;
      sources: FirstRunSource[];
      totalRoots: number;
      reason: "no-source-roots" | "no-supported-adapters";
    }
  | { kind: "ready"; sessionCount: 0; sources: FirstRunSource[]; totalRoots: number }
  | {
      kind: "running";
      sessionCount: number;
      currentSource: string;
      queuedSources: string[];
      completedSources: string[];
      progress: FirstRunSourceProgress[];
    }
  | {
      kind: "complete";
      sessionCount: number;
      completedSources: string[];
      progress: FirstRunSourceProgress[];
      summaries: IngestSummary[];
    }
  | {
      kind: "cancelled";
      sessionCount: number;
      completedSources: string[];
      progress: FirstRunSourceProgress[];
    }
  | {
      kind: "failed";
      sessionCount: number;
      completedSources: string[];
      progress: FirstRunSourceProgress[];
      error: Error;
    };

export interface FirstRunIngestContext {
  signal: AbortSignal;
  report(update: Partial<Omit<FirstRunSourceProgress, "source" | "rootCount">>): void;
}

export type FirstRunIngest = (
  db: DB,
  config: Config,
  source: FirstRunSource,
  context: FirstRunIngestContext,
) => Promise<IngestSummary[]>;

export interface FirstRunControllerOptions {
  supervisor?: TaskSupervisor;
  ingest?: FirstRunIngest;
  storageProbe?: VolumeIdentityProbe;
}

/** Explicit, provider-free first-run indexing state for the dashboard shell. */
export class FirstRunController {
  private stateValue: FirstRunState;
  private readonly listeners = new Set<(state: FirstRunState) => void>();
  private readonly supervisor: TaskSupervisor;
  private readonly ownsSupervisor: boolean;
  private readonly ingestSource: FirstRunIngest;
  private readonly storageProbe: VolumeIdentityProbe | undefined;
  private startPromise: Promise<FirstRunState> | null = null;

  constructor(
    private readonly db: DB,
    private readonly config: Config,
    options: FirstRunControllerOptions = {},
  ) {
    this.supervisor = options.supervisor ?? new TaskSupervisor();
    this.ownsSupervisor = !options.supervisor;
    this.storageProbe = options.storageProbe;
    this.ingestSource = options.ingest ?? ((db, config, source, context) =>
      defaultFirstRunIngest(db, config, source, context, this.storageProbe));
    this.stateValue = inspectFirstRun(db, config);
  }

  get state(): FirstRunState {
    return this.stateValue;
  }

  subscribe(listener: (state: FirstRunState) => void): () => void {
    this.listeners.add(listener);
    listener(this.stateValue);
    return () => this.listeners.delete(listener);
  }

  /** Start only from the explicitly presented ready state. */
  start(): Promise<FirstRunState> {
    if (this.startPromise) return this.startPromise;
    if (this.stateValue.kind !== "ready") return Promise.resolve(this.stateValue);
    this.startPromise = this.startOnce();
    return this.startPromise;
  }

  private async startOnce(): Promise<FirstRunState> {
    if (this.stateValue.kind !== "ready") return this.stateValue;
    const sources = this.stateValue.sources.filter((source) => source.adapterAvailable && source.rootCount > 0);
    const progress = sources.map<FirstRunSourceProgress>((source) => ({
      source: source.name,
      phase: "queued",
      rootsComplete: 0,
      rootCount: source.rootCount,
      rowsAdded: 0,
    }));
    const completedSources: string[] = [];
    const summaries: IngestSummary[] = [];
    let activeSource: string | null = sources[0]?.name ?? null;

    // Publish synchronously before TaskSupervisor's replacement microtask, so
    // an immediate Esc can cancel a queued start as well as active ingestion.
    if (activeSource) {
      this.publishRunning(activeSource, sources.slice(1).map((item) => item.name), completedSources, progress);
    }

    try {
      return await this.supervisor.replace(async (task) => withConstructionAuthority({
        dbPath: this.config.dbPath,
        config: this.config,
        operation: "tui first-run ingest",
        probe: this.storageProbe,
      }, async () => {
        for (const [index, source] of sources.entries()) {
          activeSource = source.name;
          assertActive(task.signal);
          const sourceStartCount = sessionCount(this.db);
          updateProgress(progress, source.name, { phase: "discovering" });
          this.publishRunning(source.name, sources.slice(index + 1).map((item) => item.name), completedSources, progress);
          const result = await this.ingestSource(this.db, this.config, source, {
            signal: task.signal,
            report: (update) => {
              if (!task.isCurrent()) return;
              updateProgress(progress, source.name, update);
              this.publishRunning(source.name, sources.slice(index + 1).map((item) => item.name), completedSources, progress);
            },
          });
          assertActive(task.signal);
          if (!task.isCurrent()) throw abortError("first-run indexing superseded");
          summaries.push(...result);
          refreshLayers(this.db, this.config.dbPath);
          const rowsAdded = Math.max(0, sessionCount(this.db) - sourceStartCount);
          updateProgress(progress, source.name, {
            phase: "complete",
            rootsComplete: source.rootCount,
            rowsAdded,
          });
          completedSources.push(source.name);
          this.publishRunning(source.name, sources.slice(index + 1).map((item) => item.name), completedSources, progress);
        }
        const complete: FirstRunState = {
          kind: "complete",
          sessionCount: sessionCount(this.db),
          completedSources: [...completedSources],
          progress: cloneProgress(progress),
          summaries,
        };
        this.publish(complete);
        return complete;
      }), "restart first-run indexing");
    } catch (reason) {
      if (!isAbort(reason) && activeSource) updateProgress(progress, activeSource, { phase: "failed", detail: String(reason) });
      const state: FirstRunState = isAbort(reason)
        ? {
            kind: "cancelled",
            sessionCount: sessionCount(this.db),
            completedSources: [...completedSources],
            progress: cloneProgress(progress),
          }
        : {
            kind: "failed",
            sessionCount: sessionCount(this.db),
            completedSources: [...completedSources],
            progress: cloneProgress(progress),
            error: reason instanceof Error ? reason : new Error(String(reason)),
          };
      this.publish(state);
      return state;
    }
  }

  async cancel(): Promise<FirstRunState> {
    if (this.stateValue.kind !== "running") return this.stateValue;
    await this.supervisor.cancelAndWait("first-run indexing cancelled");
    return this.stateValue;
  }

  async close(): Promise<void> {
    if (this.ownsSupervisor) await this.supervisor.close("first-run controller closed");
    else if (this.stateValue.kind === "running") await this.supervisor.cancelAndWait("first-run controller closed");
  }

  private publishRunning(
    currentSource: string,
    queuedSources: string[],
    completedSources: string[],
    progress: FirstRunSourceProgress[],
  ): void {
    this.publish({
      kind: "running",
      sessionCount: sessionCount(this.db),
      currentSource,
      queuedSources,
      completedSources: [...completedSources],
      progress: cloneProgress(progress),
    });
  }

  private publish(state: FirstRunState): void {
    this.stateValue = state;
    for (const listener of this.listeners) listener(state);
  }
}

export function inspectFirstRun(db: DB, config: Config): FirstRunState {
  const count = sessionCount(db);
  if (count > 0) return { kind: "not-needed", sessionCount: count };
  const sources = Object.entries(config.sources).map(([name, source]) => {
    const roots = source?.roots ?? [];
    return { name, roots: [...roots], rootCount: roots.length, adapterAvailable: BUILT_IN_ADAPTERS.has(name) };
  });
  const totalRoots = sources.reduce((total, source) => total + source.rootCount, 0);
  if (totalRoots === 0) {
    return { kind: "configuration-needed", sessionCount: 0, sources, totalRoots, reason: "no-source-roots" };
  }
  if (!sources.some((source) => source.adapterAvailable && source.rootCount > 0)) {
    return { kind: "configuration-needed", sessionCount: 0, sources, totalRoots, reason: "no-supported-adapters" };
  }
  return { kind: "ready", sessionCount: 0, sources, totalRoots };
}

async function defaultFirstRunIngest(
  db: DB,
  config: Config,
  source: FirstRunSource,
  context: FirstRunIngestContext,
  storageProbe?: VolumeIdentityProbe,
): Promise<IngestSummary[]> {
  assertActive(context.signal);
  context.report({ phase: "ingesting" });
  const result = await ingest(db, config, { onlySource: source.name, storageProbe });
  assertActive(context.signal);
  return result;
}

function sessionCount(db: DB): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM sessions`).get() as { count: number }).count);
}

function updateProgress(
  progress: FirstRunSourceProgress[],
  source: string,
  update: Partial<Omit<FirstRunSourceProgress, "source" | "rootCount">>,
): void {
  const target = progress.find((item) => item.source === source);
  if (target) Object.assign(target, update);
}

function cloneProgress(progress: FirstRunSourceProgress[]): FirstRunSourceProgress[] {
  return progress.map((item) => ({ ...item }));
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw abortError("first-run indexing cancelled");
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbort(reason: unknown): boolean {
  return reason instanceof Error && reason.name === "AbortError";
}
