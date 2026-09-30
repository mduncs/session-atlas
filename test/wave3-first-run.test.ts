import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { openDb, type DB } from "../src/db/index.js";
import type { IngestSummary } from "../src/ingest.js";
import { withConstructionAuthority } from "../src/runtime/writer-coordinator.js";
import {
  FirstRunController,
  inspectFirstRun,
  type FirstRunIngest,
  type FirstRunState,
} from "../src/tui/first-run.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(sources: Config["sources"]): Promise<{ db: DB; config: Config }> {
  const root = mkdtempSync(join(tmpdir(), "atlas-wave3-first-run-"));
  roots.push(root);
  const config: Config = {
    sources,
    providers: [],
    launchers: [],
    tunables: {
      tag_promotion_count: 3,
      export_budget_tokens: 20_000,
      fav_default_span: 6,
      summary_stale_pct: 25,
      redact_entropy_threshold: 4.8,
    },
    dbPath: join(root, "atlas.db"),
  };
  return { db: await openDb(config.dbPath), config };
}

function insertSession(db: DB, nativeId: string): void {
  db.prepare(
    `INSERT INTO sessions(harness,native_id,source_path,ingested_at,msg_count,transcript_bytes)
     VALUES ('claude',?, ?,1,0,0)`,
  ).run(nativeId, `/fixture/${nativeId}`);
}

function summary(source: string, inserted: number): IngestSummary {
  return {
    source,
    roots: [],
    inserted,
    replaced: 0,
    derivedRepaired: 0,
    unchanged: 0,
    orphans: 0,
    bytesConsumed: 0,
    elapsedMs: 1,
    chains: 0,
    chainMembers: 0,
  };
}

test("Wave 3 first run — nonempty archives never offer or auto-run ingestion", async () => {
  const { db, config } = await fixture({ claude: { roots: ["/configured"] } });
  insertSession(db, "existing");
  let calls = 0;
  const controller = new FirstRunController(db, config, { ingest: async () => { calls++; return []; } });
  expect(controller.state).toEqual({ kind: "not-needed", sessionCount: 1 });
  expect(await controller.start()).toEqual({ kind: "not-needed", sessionCount: 1 });
  expect(calls).toBe(0);
  await controller.close();
  db.close();
});

test("Wave 3 first run — missing roots and unsupported adapters produce configuration-needed states", async () => {
  const empty = await fixture({ claude: { roots: [] } });
  expect(inspectFirstRun(empty.db, empty.config)).toMatchObject({
    kind: "configuration-needed",
    totalRoots: 0,
    reason: "no-source-roots",
  });
  empty.db.close();

  const unsupported = await fixture({ mystery: { roots: ["/somewhere"] } });
  expect(inspectFirstRun(unsupported.db, unsupported.config)).toMatchObject({
    kind: "configuration-needed",
    totalRoots: 1,
    reason: "no-supported-adapters",
  });
  unsupported.db.close();
});

test("Wave 3 first run — explicit start reports source queue and rows appearing", async () => {
  const { db, config } = await fixture({
    claude: { roots: ["/one", "/two"] },
    codex: { roots: ["/three"] },
  });
  const observed: FirstRunState[] = [];
  const ingest: FirstRunIngest = async (target, _config, source, context) => {
    context.report({ phase: "ingesting", rootsComplete: 0 });
    insertSession(target, `${source.name}-session`);
    context.report({ phase: "ingesting", rootsComplete: 1, rowsAdded: 1, detail: "one session indexed" });
    return [summary(source.name, 1)];
  };
  const controller = new FirstRunController(db, config, { ingest });
  expect(controller.state).toMatchObject({ kind: "ready", totalRoots: 3 });
  controller.subscribe((state) => observed.push(state));
  const result = await controller.start();

  expect(result).toMatchObject({ kind: "complete", sessionCount: 2, completedSources: ["claude", "codex"] });
  expect(observed.some((state) => state.kind === "running" && state.sessionCount === 1)).toBe(true);
  expect(observed.some((state) => state.kind === "running" && state.queuedSources.includes("codex"))).toBe(true);
  if (result.kind === "complete") {
    expect(result.progress.map((item) => [item.source, item.phase, item.rowsAdded])).toEqual([
      ["claude", "complete", 1],
      ["codex", "complete", 1],
    ]);
  }
  await controller.close();
  db.close();
});

test("Wave 3 first run — cancellation aborts owned work and settles as cancelled", async () => {
  const { db, config } = await fixture({ claude: { roots: ["/one"] } });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const ingest: FirstRunIngest = async (_db, _config, _source, context) => {
    entered();
    await new Promise<void>((resolve, reject) => {
      context.signal.addEventListener("abort", () => {
        const error = new Error("cancelled");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
    return [];
  };
  const controller = new FirstRunController(db, config, { ingest });
  const run = controller.start();
  expect(controller.start()).toBe(run);
  await started;
  expect(controller.state.kind).toBe("running");
  await controller.cancel();
  expect((await run).kind).toBe("cancelled");
  expect(controller.state.kind).toBe("cancelled");
  await controller.close();
  db.close();
});

test("Wave 3 first run — held construction authority fails fast before custom ingest", async () => {
  const { db, config } = await fixture({ claude: { roots: ["/one"] } });
  let calls = 0;
  await withConstructionAuthority({ dbPath: config.dbPath, config, operation: "fixture scheduled walk" }, async () => {
    const controller = new FirstRunController(db, config, {
      ingest: async () => { calls++; return []; },
    });
    const result = await controller.start();
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.error.message).toContain("operation fixture scheduled walk");
      expect(result.error.message).toContain("acquired-at");
    }
    await controller.close();
  });
  expect(calls).toBe(0);
  db.close();
});
