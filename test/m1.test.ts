import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, type DB } from "../src/db/index.js";
import { ingest } from "../src/ingest.js";
import { assembleChains } from "../src/chains.js";
import type { Config } from "../src/config.js";

function tempConfig(claudeRoot: string, dbPath: string): Config {
  return {
    sources: { claude: { roots: [claudeRoot] } },
    providers: [],
    launchers: [],
    tunables: {
      tag_promotion_count: 3,
      export_budget_tokens: 20000,
      fav_default_span: 6,
      summary_stale_pct: 25,
      redact_entropy_threshold: 4.8,
    },
    dbPath,
  };
}

function writeSession(root: string, text: string, name = "s1.jsonl"): void {
  mkdirSync(join(root, "-Users-md-code-proj"), { recursive: true });
  writeFileSync(join(root, "-Users-md-code-proj", name), text);
}

function userMsg(text: string, i: number): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    cwd: "/Users/tester/code/proj",
  });
}

let tmp: string;
let dbPath: string;
let db: DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atlas-m1-"));
  dbPath = join(tmp, "atlas.db");
});
afterEach(() => {
  db?.close();
  rmSync(tmp, { recursive: true, force: true });
});

test("Law 10 — an unreachable root does not abort the run; exit 0, others proceed", async () => {
  const liveRoot = join(tmp, "live");
  const deadRoot = join(tmp, "does-not-exist"); // never created → ENOENT
  writeSession(liveRoot, userMsg("hello", 0) + "\n");

  db = await openDb(dbPath);
  const cfg = tempConfig(liveRoot, dbPath);
  cfg.sources = { claude: { roots: [liveRoot, deadRoot] } };

  // ingest resolves (does not throw) — failure isolation keeps exit 0.
  const summaries = await ingest(db, cfg);
  const s = summaries[0]!;

  // Live root reachable + ingested; dead root isolated.
  const live = s.roots.find((r) => r.root === liveRoot)!;
  const dead = s.roots.find((r) => r.root === deadRoot)!;
  expect(live.reachable).toBe(true);
  expect(live.sessionsSeen).toBe(1);
  expect(dead.reachable).toBe(false);

  // The live session landed despite the dead root.
  const n = db.prepare(`SELECT COUNT(*) n FROM sessions`).get() as { n: number };
  expect(n.n).toBe(1);
});

test("Law 10 — one source failing does not block another (cross-source isolation)", async () => {
  const claudeRoot = join(tmp, "claude");
  const deadKilo = join(tmp, "no-kilo.db"); // unopenable as sqlite
  writeSession(claudeRoot, userMsg("hello again", 0) + "\n");

  db = await openDb(dbPath);
  const cfg = tempConfig(claudeRoot, dbPath);
  cfg.sources = { claude: { roots: [claudeRoot] }, kilo: { roots: [deadKilo] } };

  const summaries = await ingest(db, cfg);
  // Claude ingested; kilo root isolated; both sources reported.
  const claudeS = summaries.find((x) => x.source === "claude");
  const kiloS = summaries.find((x) => x.source === "kilo");
  expect(claudeS?.roots[0]?.reachable).toBe(true);
  expect(kiloS?.roots[0]?.reachable).toBe(false);
  const n = db.prepare(`SELECT COUNT(*) n FROM sessions`).get() as { n: number };
  expect(n.n).toBe(1); // claude's session, kilo contributed nothing
});

test("Law 5 — chain assembly groups lineage edges; aggregates are raw sums", async () => {
  db = await openDb(dbPath); // migration creates the schema incl. parent_native_id (v2)
  const ins = db.prepare(
    `INSERT INTO sessions(harness, native_id, last_activity, tok_user, tok_assistant, tok_tool,
        msg_count, ingested_at, parent_native_id, transcript_bytes, orphaned, source_path)
     VALUES ('kilo',?,?,?,?,?,?,?,?, 100, 0, 'x')`,
  );
  const addValidShell = (
    nativeId: string,
    lastActivity: number,
    tokUser: number,
    tokAssistant: number,
    parentNativeId: string | null,
  ): void => {
    const inserted = ins.run(nativeId, lastActivity, tokUser, tokAssistant, 0, 4, Date.now(), parentNativeId) as {
      lastInsertRowid: number | bigint;
    };
    const sessionId = Number(inserted.lastInsertRowid);
    const generation = `fixture-chain-${nativeId}`;
    db.prepare(`UPDATE sessions SET
      artifact_kind='metadata_shell', history_completeness='unknown', construction_generation=?,
      construction_status='valid', construction_invalid_reason=NULL, default_session_visible=0,
      source_validation_status='current', source_observed_ts=? WHERE id=?`).run(generation, Date.now(), sessionId);
    db.prepare(`INSERT INTO construction_metrics(session_id,construction_generation,computed_at)
      VALUES (?,?,?)`).run(sessionId, generation, Date.now());
  };
  // A fork: parent P, children C1 C2 C3 (parent_id = P), grandchild G (parent_id = C1).
  addValidShell("P", 1000, 1000, 1000, null);
  addValidShell("C1", 2000, 2000, 2000, "P");
  addValidShell("C2", 3000, 3000, 0, "P");
  addValidShell("C3", 1500, 0, 0, "P");
  addValidShell("G", 4000, 500, 500, "C1");

  const r = assembleChains(db, "kilo");
  // One connected component of 5 members.
  expect(r.chains).toBe(1);
  expect(r.members).toBe(5);

  const chain = db.prepare(`SELECT member_count, tok_total, first_ts, last_ts FROM chains`).get() as {
    member_count: number;
    tok_total: number;
    first_ts: number;
    last_ts: number;
  };
  expect(chain.member_count).toBe(5);
  // Raw sums: P(1000+1000) + C1(2000+2000) + C2(3000) + C3(0) + G(500+500)
  // = 10000. NOT deduped — compacted prefixes count as-is (Law 5: consistency
  // over precision; those tokens were in fact processed).
  expect(chain.tok_total).toBe(10000);
  expect(chain.first_ts).toBe(1000);
  expect(chain.last_ts).toBe(4000);
});
