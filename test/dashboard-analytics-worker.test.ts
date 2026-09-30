import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../src/db/index.js";
import { DashboardAnalyticsClient } from "../src/tui/analytics-client.js";

test("dashboard analytics refreshes on a read-only worker connection", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-analytics-worker-"));
  const dbPath = join(root, "atlas.db");
  const db = new Database(dbPath);
  const client = new DashboardAnalyticsClient(dbPath);
  try {
    runMigrations(db);
    db.prepare(`INSERT INTO sessions(
      harness,native_id,source_path,title,last_activity,duration_ms,models,
      tok_user,tok_assistant,tok_tool,msg_count,engagement,orphaned,ingested_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "claude", "worker-1", "/fixture", "worker analytics", Date.now(), 60_000,
      '["opus"]', 10, 20, 0, 2, 0.5, 0, Date.now(),
    );
    const analytics = await client.read({});
    expect(analytics.corpusSessionCount).toBe(1);
    expect(analytics.visibleSessionCount).toBe(1);
    expect(analytics.sources).toContainEqual(expect.objectContaining({ source: "claude", count: 1 }));
  } finally {
    client.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
