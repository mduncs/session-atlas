import { Database } from "bun:sqlite";
import { attachLayers } from "../layers/db.js";
import { readDashboardAnalytics, type DashboardAnalytics } from "./analytics.js";
import type { ListFilter } from "./queries.js";

export interface DashboardAnalyticsWorkerRequest {
  id: number;
  dbPath: string;
  filter: ListFilter;
  now: number;
}

export type DashboardAnalyticsWorkerResponse =
  | { id: number; analytics: DashboardAnalytics }
  | { id: number; error: string };

declare const self: {
  addEventListener(type: "message", listener: (event: MessageEvent<DashboardAnalyticsWorkerRequest>) => void): void;
  postMessage(message: DashboardAnalyticsWorkerResponse): void;
};

let database: Database | null = null;
let databasePath: string | null = null;

self.addEventListener("message", (event: MessageEvent<DashboardAnalyticsWorkerRequest>) => {
  const request = event.data;
  try {
    if (database === null || databasePath !== request.dbPath) {
      database?.close();
      database = new Database(request.dbPath, { readonly: true });
      database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
      attachLayers(database, request.dbPath);
      databasePath = request.dbPath;
    }
    let analytics: DashboardAnalytics;
    try {
      analytics = readDashboardAnalytics(database, request.filter, request.now);
    } catch {
      analytics = readDashboardAnalytics(database, { ...request.filter, query: null }, request.now);
    }
    self.postMessage({ id: request.id, analytics } satisfies DashboardAnalyticsWorkerResponse);
  } catch (error) {
    self.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies DashboardAnalyticsWorkerResponse);
  }
});
