import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { openDb, type DB } from "../src/db/index.js";
import { ExportFlowController } from "../src/tui/export-flow.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(launchers = true): Promise<{ db: DB; config: Config; root: string; sessionId: number }> {
  const root = mkdtempSync(join(tmpdir(), "atlas-wave3-export-flow-"));
  roots.push(root);
  const config: Config = {
    sources: {},
    providers: [],
    launchers: launchers
      ? [
          { name: "claude", cmd: "claude --resume {payload}" },
          { name: "codex", cmd: "codex --prompt-file {payload}" },
        ]
      : [],
    tunables: {
      tag_promotion_count: 3,
      export_budget_tokens: 20_000,
      fav_default_span: 6,
      summary_stale_pct: 25,
      redact_entropy_threshold: 4.8,
    },
    dbPath: join(root, "atlas.db"),
  };
  const db = await openDb(config.dbPath);
  const inserted = db.prepare(
    `INSERT INTO sessions(harness,native_id,source_path,title,ingested_at,msg_count,transcript_bytes)
     VALUES ('claude','flow-1','/fixture','Flow fixture',1,1,24)`,
  ).run();
  const sessionId = Number(inserted.lastInsertRowid);
  db.prepare(
    `INSERT INTO messages(session_id,ordinal,role,text,tok_estimate) VALUES (?,0,'user','continue this work',4)`,
  ).run(sessionId);
  return { db, config, root, sessionId };
}

test("Wave 3 export flow — preview exposes budget and two launchers without writing", async () => {
  const { db, config, root, sessionId } = await fixture();
  const outputDir = join(root, "exports");
  const flow = new ExportFlowController(db, config);
  const state = flow.begin({ scope: { kind: "session", id: sessionId }, options: { outputDir } });

  expect(state.kind).toBe("preview");
  expect(state.preview.predictedTokens).toBeGreaterThan(0);
  expect(state.preview.budget).toBe(20_000);
  expect(state.compressionNeeded).toBe(false);
  expect(state.choices.map((choice) => choice.name)).toEqual([null, "claude", "codex"]);
  expect(existsSync(outputDir)).toBe(false);

  const constrained = new ExportFlowController(db, config).begin({
    scope: { kind: "session", id: sessionId },
    options: { budget: 1, outputDir },
  });
  expect(constrained.compressionNeeded).toBe(true);
  expect(constrained.preview.overBudgetBy).toBeGreaterThan(0);
  expect(existsSync(outputDir)).toBe(false);
  db.close();
});

test("Wave 3 export flow — cancel before confirmation writes nothing", async () => {
  const { db, config, root, sessionId } = await fixture();
  const outputDir = join(root, "exports");
  const flow = new ExportFlowController(db, config);
  flow.begin({ scope: { kind: "session", id: sessionId }, options: { outputDir } });
  expect(flow.cancel().kind).toBe("cancelled");
  await expect(flow.confirm("claude")).rejects.toThrow("cancelled");
  expect(existsSync(outputDir)).toBe(false);
  db.close();
});

test("Wave 3 export flow — confirmation writes exactly once and returns selected launcher command", async () => {
  const { db, config, root, sessionId } = await fixture();
  const outputDir = join(root, "exports");
  const flow = new ExportFlowController(db, config);
  flow.begin({
    scope: { kind: "session", id: sessionId },
    options: { outputDir, now: new Date("2026-07-19T12:00:00Z") },
  });
  const [first, second] = await Promise.all([flow.confirm("codex"), flow.confirm("codex")]);

  expect(first.kind).toBe("complete");
  expect(second).toBe(first);
  if (first.kind !== "complete") throw new Error("expected completed export");
  expect(first.written.launcherCommand).toBe(`codex --prompt-file ${first.written.path}`);
  expect(readdirSync(outputDir).filter((name) => name.endsWith(".md"))).toHaveLength(1);
  expect(flow.cancel()).toBe(first);
  db.close();
});

test("Wave 3 export flow — no-launcher configuration still offers export-only confirmation", async () => {
  const { db, config, root, sessionId } = await fixture(false);
  const flow = new ExportFlowController(db, config);
  const preview = flow.begin({ scope: { kind: "session", id: sessionId }, options: { outputDir: join(root, "out") } });
  expect(preview.choices.map((choice) => choice.name)).toEqual([null]);
  const result = await flow.confirm(null);
  expect(result.kind).toBe("complete");
  if (result.kind === "complete") expect(result.written.launcherCommand).toBeNull();
  db.close();
});
