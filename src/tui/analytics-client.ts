import type { DashboardAnalytics } from "./analytics.js";
import type {
  DashboardAnalyticsWorkerRequest,
  DashboardAnalyticsWorkerResponse,
} from "./analytics-worker.js";
import type { ListFilter } from "./queries.js";

interface PendingRead {
  resolve: (analytics: DashboardAnalytics) => void;
  reject: (error: Error) => void;
}

type WorkerFactory = () => Worker;

/**
 * Owns the read-only SQLite worker used by the dashboard instruments. The
 * interactive thread only sends small filter messages and accepts the newest
 * completed snapshot; whole-corpus aggregation never shares its frame budget.
 */
export class DashboardAnalyticsClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, PendingRead>();
  #nextId = 1;
  #closed = false;

  constructor(
    private readonly dbPath: string,
    workerFactory: WorkerFactory = () => new Worker(new URL("./analytics-worker.ts", import.meta.url).href, { type: "module" }),
  ) {
    this.#worker = workerFactory();
    this.#worker.addEventListener("message", this.#onMessage);
    this.#worker.addEventListener("error", this.#onError);
  }

  read(filter: ListFilter, now = Date.now()): Promise<DashboardAnalytics> {
    if (this.#closed) return Promise.reject(new Error("dashboard analytics worker is closed"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, dbPath: this.dbPath, filter, now } satisfies DashboardAnalyticsWorkerRequest);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#worker.removeEventListener("message", this.#onMessage);
    this.#worker.removeEventListener("error", this.#onError);
    this.#worker.terminate();
    this.#rejectAll(new Error("dashboard analytics worker closed"));
  }

  readonly #onMessage = (event: MessageEvent<DashboardAnalyticsWorkerResponse>): void => {
    const response = event.data;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if ("error" in response) pending.reject(new Error(response.error));
    else pending.resolve(response.analytics);
  };

  readonly #onError = (event: ErrorEvent): void => {
    this.#rejectAll(new Error(event.message || "dashboard analytics worker failed"));
  };

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

export function canUseDashboardAnalyticsWorker(dbPath: string): boolean {
  return dbPath !== ":memory:";
}
