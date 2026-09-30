import type { DB } from "../db/index.js";
import type { SessionRow } from "./domain.js";
import type { InkLibraryBridge } from "./library-bridge.js";

/** Existing archive text only: this comparison never generates a summary. */
export interface AtlasTestPreview {
  sourceTitle: string | null;
  summary: string | null;
  summaryLabel: string;
}

export function readAtlasTestPreview(db: DB, row: SessionRow, bridge?: InkLibraryBridge): AtlasTestPreview {
  const source = db.prepare("SELECT title FROM sessions WHERE harness=? AND native_id=?")
    .get(row.harness, row.native_id) as { title: string | null } | null;
  const sourceTitle = source?.title ?? null;
  if (bridge) {
    try {
      const view = bridge.getSessionView({ harness: row.harness, nativeId: row.native_id });
      if (view.result?.body.trim()) return {
        sourceTitle,
        summary: view.result.body,
        summaryLabel: view.stale ? "Saved summary (out of date)" : view.status === "ready" ? "Saved summary" : "Saved summary (coverage unverified)",
      };
    } catch { /* A missing library summary must not prevent index browsing. */ }
  }
  const summary = db.prepare(`SELECT tier, body, topic_line FROM summaries
    WHERE session_id=? AND (NULLIF(TRIM(body),'') IS NOT NULL OR NULLIF(TRIM(topic_line),'') IS NOT NULL)
    ORDER BY tier DESC LIMIT 1`).get(row.id) as { tier: number; body: string | null; topic_line: string | null } | null;
  return {
    sourceTitle,
    summary: summary?.body?.trim() || summary?.topic_line?.trim() || null,
    summaryLabel: summary ? (summary.tier === 1 ? "Saved topic (coverage unverified)" : "Saved summary (coverage unverified)") : "No saved summary",
  };
}
