import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HARNESS_IDS, sourcePlanDigest, type Config } from "../src/config.js";
import { collectDoctorReport } from "../src/commands/doctor.js";
import { indexCmd } from "../src/commands/index.js";
import { openDb, type DB } from "../src/db/index.js";
import { computeRootChangeToken, ingest } from "../src/ingest.js";
import { rebuildLogicalMetrics } from "../src/logical-metrics.js";
import { summarizeTier2 } from "../src/tier2.js";

let dir: string;
let db: DB;
const originalFetch = globalThis.fetch;
const EXPECTED_VOLUME = "11111111-2222-3333-4444-555555555555";
const OTHER_VOLUME = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "atlas-wave3-integrity-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.ATLAS_WAVE3_KEY;
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function config(
  overrides: Record<string, { mode?: "builtin" | "extend" | "replace" | "disabled"; roots?: string[]; disabledReason?: string | null }>,
  providers: Config["providers"] = [],
): Config {
  const sources = Object.fromEntries(HARNESS_IDS.map((source) => {
    const override = overrides[source];
    return [source, override ? {
      mode: override.mode ?? "replace",
      roots: override.roots ?? [],
      disabledReason: override.disabledReason ?? null,
    } : { mode: "disabled", roots: [], disabledReason: "fixture owns no source" }];
  })) as Config["sources"];
  return {
    sources,
    providers,
    launchers: [],
    tunables: {
      tag_promotion_count: 3,
      export_budget_tokens: 20_000,
      fav_default_span: 6,
      summary_stale_pct: 25,
      redact_entropy_threshold: 4.8,
    },
    dbPath: join(dir, "atlas.db"),
  };
}

function seedCanonicalSession(
  db: DB,
  nativeId: string,
  rows: Array<{ role: "user" | "assistant"; text: string }>,
): number {
  const generation = `fixture-v11:${nativeId}`;
  const now = Date.now();
  const session = db.prepare(
    `INSERT INTO sessions(
       harness,native_id,source_path,ingested_at,msg_count,transcript_bytes,orphaned,
       artifact_kind,history_completeness,construction_generation,construction_status,
       default_session_visible,source_validation_status,source_observed_ts
     ) VALUES ('claude',?,'x',?,?,?,?, 'dialogue_history','complete',?,'valid',1,'current',?)`,
  ).run(nativeId, now, rows.length, rows.length * 10, 0, generation, now) as { lastInsertRowid: number | bigint };
  const sid = Number(session.lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO messages(
       session_id,ordinal,source_ordinal,role,ts,text,prose,event_ts,has_tool,tok_estimate,
       record_kind,dialogue_side,source_record_id,source_record_ts,source_identity_kind,construction_generation
     ) VALUES (?,?,?,?,?,?,?,?,0,10,?,?,?,?,?,?)`,
  );
  rows.forEach((row, ordinal) => {
    const ts = now + ordinal;
    insert.run(sid, ordinal, ordinal, row.role, ts, row.text, row.text, ts,
      row.role === "user" ? "real_user" : "assistant_dialogue_prose", row.role,
      `fixture-${nativeId}-${ordinal}`, ts, "record-id", generation);
  });
  rebuildLogicalMetrics(db, sid, generation);
  return sid;
}

function claudeLine(text: string, index: number, role: "user" | "assistant" = "user"): string {
  return JSON.stringify({
    type: role,
    cwd: "/fixture",
    timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    message: { role, model: role === "assistant" ? "fixture" : undefined, content: text },
  });
}

function claudeFile(root: string, lines: string[], name = "shared.jsonl"): string {
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  const path = join(project, name);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

function forceMtime(path: string, tick: number): void {
  const time = new Date(Date.now() + tick * 1000);
  utimesSync(path, time, time);
}

test("complete malformed Claude and Codex JSONL stop at the first invalid byte and recover after repair", async () => {
  db = await openDb(join(dir, "atlas.db"));

  const claudeRoot = join(dir, "claude");
  const c0 = claudeLine("héllo", 0);
  const c1 = claudeLine("repaired", 1, "assistant");
  const claudePath = claudeFile(claudeRoot, [c0]);
  const claudeCfg = config({ claude: { roots: [claudeRoot] } });
  await ingest(db, claudeCfg);
  const claudeOffset = Buffer.byteLength(c0 + "\n");
  writeFileSync(claudePath, `${c0}\n{bad json}\n${c1}\n`);
  forceMtime(claudePath, 1);
  const brokenClaude = await ingest(db, claudeCfg);
  expect(brokenClaude[0]?.roots[0]?.error).toContain(`byte_offset=${claudeOffset}`);
  expect((db.prepare(`SELECT offset FROM ingest_state WHERE source='claude'`).get() as { offset: number }).offset).toBe(claudeOffset);
  expect((db.prepare(`SELECT msg_count FROM sessions WHERE harness='claude'`).get() as { msg_count: number }).msg_count).toBe(1);
  writeFileSync(claudePath, `${c0}\n${c1}\n`);
  forceMtime(claudePath, 2);
  await ingest(db, claudeCfg);
  expect((db.prepare(`SELECT msg_count FROM sessions WHERE harness='claude'`).get() as { msg_count: number }).msg_count).toBe(2);

  const codexRoot = join(dir, "codex");
  const rolloutDir = join(codexRoot, "sessions", "2026", "07", "19");
  mkdirSync(rolloutDir, { recursive: true });
  const nativeId = "12345678-1234-4234-8234-123456789abc";
  const meta = JSON.stringify({ type: "session_meta", timestamp: "2026-07-19T00:00:00Z", payload: { id: nativeId, cwd: "/fixture" } });
  const response = JSON.stringify({ type: "response_item", timestamp: "2026-07-19T00:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex recovered" }] } });
  const codexPath = join(rolloutDir, `rollout-2026-07-19-${nativeId}.jsonl`);
  writeFileSync(codexPath, meta + "\n");
  const codexCfg = config({ codex: { roots: [codexRoot] } });
  await ingest(db, codexCfg);
  const codexOffset = Buffer.byteLength(meta + "\n");
  writeFileSync(codexPath, `${meta}\nnot-json\n${response}\n`);
  forceMtime(codexPath, 3);
  const brokenCodex = await ingest(db, codexCfg);
  expect(brokenCodex[0]?.roots[0]?.error).toContain(`byte_offset=${codexOffset}`);
  expect((db.prepare(`SELECT offset FROM ingest_state WHERE source='codex'`).get() as { offset: number }).offset).toBe(codexOffset);
  writeFileSync(codexPath, `${meta}\n${response}\n`);
  forceMtime(codexPath, 4);
  await ingest(db, codexCfg);
  expect((db.prepare(`SELECT msg_count FROM sessions WHERE harness='codex'`).get() as { msg_count: number }).msg_count).toBe(1);
});

test("a torn Codex tail stays unconsumed until its newline arrives", async () => {
  const root = join(dir, "codex");
  mkdirSync(root, { recursive: true });
  const nativeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const path = join(root, `rollout-now-${nativeId}.jsonl`);
  const meta = JSON.stringify({ type: "session_meta", payload: { id: nativeId, cwd: "/fixture" } });
  const response = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ text: "complete me" }] } });
  writeFileSync(path, `${meta}\n${response.slice(0, 20)}`);
  db = await openDb(join(dir, "atlas.db"));
  const cfg = config({ codex: { roots: [root] } });
  await ingest(db, cfg);
  const first = db.prepare(`SELECT offset,size FROM ingest_state WHERE source='codex'`).get() as { offset: number; size: number };
  expect(first.offset).toBe(Buffer.byteLength(meta + "\n"));
  expect(first.offset).toBeLessThan(first.size);
  writeFileSync(path, `${meta}\n${response}\n`);
  forceMtime(path, 1);
  await ingest(db, cfg);
  expect((db.prepare(`SELECT msg_count FROM sessions WHERE harness='codex'`).get() as { msg_count: number }).msg_count).toBe(1);
});

test("duplicate selection considers unchanged roots across shrink, delete, root order, and final orphan", async () => {
  const live = join(dir, "live");
  const archive = join(dir, "archive");
  const long = [0, 1, 2, 3].map((i) => claudeLine(`long ${i}`, i));
  const medium = [0, 1, 2].map((i) => claudeLine(`medium ${i}`, i));
  const livePath = claudeFile(live, long);
  const archivePath = claudeFile(archive, medium);
  db = await openDb(join(dir, "atlas.db"));
  const cfg = config({ claude: { roots: [live, archive] } });

  await ingest(db, cfg);
  expect(db.prepare(`SELECT source_root,msg_count FROM sessions`).get()).toMatchObject({ source_root: live, msg_count: 4 });

  // The current winner shrinks; the unchanged archive candidate must be
  // parsed and promoted rather than allowing the session to downgrade.
  writeFileSync(livePath, claudeLine("short", 0) + "\n");
  forceMtime(livePath, 1);
  await ingest(db, cfg);
  expect(db.prepare(`SELECT source_root,msg_count,orphaned FROM sessions`).get()).toMatchObject({ source_root: archive, msg_count: 3, orphaned: 0 });

  // Deleting the shorter duplicate cannot orphan or disturb the winner.
  unlinkSync(livePath);
  await ingest(db, cfg);
  expect(db.prepare(`SELECT source_root,msg_count,orphaned FROM sessions`).get()).toMatchObject({ source_root: archive, msg_count: 3, orphaned: 0 });

  // Equal candidates follow configured root order even when both fast-path.
  claudeFile(live, medium);
  forceMtime(join(live, "project", "shared.jsonl"), 2);
  await ingest(db, config({ claude: { roots: [archive, live] } }));
  expect((db.prepare(`SELECT source_root FROM sessions`).get() as { source_root: string }).source_root).toBe(archive);

  unlinkSync(archivePath);
  unlinkSync(join(live, "project", "shared.jsonl"));
  await ingest(db, cfg);
  expect((db.prepare(`SELECT orphaned FROM sessions`).get() as { orphaned: number }).orphaned).toBe(1);
});

test("governed-root UUID mismatch reuses unreachable retention, exits index 1, and creates zero orphans", async () => {
  const sourceRoot = join(dir, "governed-source");
  claudeFile(sourceRoot, [claudeLine("retained session", 0)]);
  db = await openDb(join(dir, "atlas.db"));
  const initialConfig = config({ claude: { roots: [sourceRoot] } });
  initialConfig.storage = { volumes: { [sourceRoot]: EXPECTED_VOLUME } };
  const matchProbe = () => ({ mounted: true, uuid: EXPECTED_VOLUME });
  const first = await ingest(db, initialConfig, { storageProbe: matchProbe });
  expect(first[0]).toMatchObject({ uniqueIdentities: 1, orphans: 0 });
  expect(db.prepare(`SELECT orphaned,source_validation_status FROM sessions`).get()).toEqual({
    orphaned: 0,
    source_validation_status: "current",
  });

  const configPath = join(dir, "governed.toml");
  const disabled = HARNESS_IDS.filter((source) => source !== "claude")
    .map((source) => `[sources.${source}]\nmode = "disabled"\nreason = "governed-root fixture"`)
    .join("\n\n");
  writeFileSync(configPath, `dbPath = ${JSON.stringify(initialConfig.dbPath)}\n\n[sources.claude]\nmode = "replace"\nroots = [${JSON.stringify(sourceRoot)}]\n\n${disabled}\n\n[storage.volumes]\n${JSON.stringify(sourceRoot)} = "${EXPECTED_VOLUME}"\n`);
  const mismatchProbe = () => ({ mounted: true, uuid: OTHER_VOLUME });
  const output = await captureStdout(() => indexCmd(["--config", configPath], { storageProbe: mismatchProbe }));
  expect(output.value).toBe(1);
  expect(output.text).toContain("0 orphaned");
  expect(output.text).toContain("[unreachable]");

  expect(db.prepare(`SELECT COUNT(*) count FROM sessions`).get()).toEqual({ count: 1 });
  expect(db.prepare(`SELECT orphaned,source_validation_status FROM sessions`).get()).toEqual({
    orphaned: 0,
    source_validation_status: "snapshot_only",
  });
  expect(db.prepare(
    `SELECT g.status group_status,rs.status source_status,rr.reachability,rr.error
     FROM reconciliation_groups g
     JOIN reconciliation_sources rs ON rs.group_id=g.id AND rs.source='claude'
     JOIN reconciliation_roots rr ON rr.reconciliation_source_id=rs.id
     ORDER BY g.id DESC LIMIT 1`,
  ).get()).toEqual({
    group_status: "incomplete",
    source_status: "incomplete",
    reachability: "unreachable",
    error: `volume identity mismatch (expected ${EXPECTED_VOLUME}, observed ${OTHER_VOLUME})`,
  });
});

function createKilo(path: string): Database {
  const source = new Database(path);
  source.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT,model TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,time_created INTEGER,data TEXT);
  `);
  return source;
}

test("Kilo freshness catches same-length WAL-visible in-place content updates", async () => {
  const sourcePath = join(dir, "kilo.db");
  const source = createKilo(sourcePath);
  source.prepare(`INSERT INTO session VALUES ('s1','/fixture','title','m',100,100,NULL)`).run();
  source.prepare(`INSERT INTO message VALUES ('m1','s1',100,?)`).run(JSON.stringify({ role: "user" }));
  source.prepare(`INSERT INTO part VALUES ('p1','m1',100,?)`).run(JSON.stringify({ type: "text", text: "alpha" }));
  db = await openDb(join(dir, "atlas.db"));
  const cfg = config({ kilo: { roots: [sourcePath] } });
  await ingest(db, cfg);

  source.prepare(`UPDATE part SET data=? WHERE id='p1'`).run(JSON.stringify({ type: "text", text: "bravo" }));
  const second = await ingest(db, cfg);
  expect(second[0]?.replaced).toBe(1);
  expect((db.prepare(`SELECT text FROM messages`).get() as { text: string }).text).toBe("bravo");
  source.close();
});

test("production ingest flags stale summaries for revalidation, keeps them, and requeues tier-1", async () => {
  const root = join(dir, "claude");
  const first = [0, 1, 2, 3].map((i) => claudeLine(`turn ${i}`, i));
  const path = claudeFile(root, first);
  db = await openDb(join(dir, "atlas.db"));
  const cfg = config({ claude: { roots: [root] } });
  await ingest(db, cfg);
  const sid = (db.prepare(`SELECT id FROM sessions`).get() as { id: number }).id;
  const turns = (db.prepare(`SELECT dialogue_turn_count n FROM construction_metrics WHERE session_id=?`).get(sid) as { n: number }).n;
  expect(turns).toBe(4);
  db.prepare(`INSERT INTO summaries(session_id,tier,topic_line,msg_count_covered,model,generated_at,coverage_basis) VALUES (?,1,'topic',?,'m',1,'dialogue_turn_count_v1')`).run(sid, turns);
  db.prepare(`INSERT INTO summaries(session_id,tier,body,msg_count_covered,model,generated_at) VALUES (?,2,'body',?,'m',1)`).run(sid, turns);

  writeFileSync(path, [...first, claudeLine("growth", 4)].join("\n") + "\n");
  forceMtime(path, 1);
  await ingest(db, cfg);
  expect(db.prepare(`SELECT tier,needs_revalidation FROM summaries WHERE session_id=? ORDER BY tier`).all(sid)).toEqual([
    { tier: 1, needs_revalidation: 1 },
    { tier: 2, needs_revalidation: 1 },
  ]);
  const work = db.prepare(
    `SELECT id,kind,current_status,blocked_reason,attempt_count
     FROM job_work WHERE target_harness='claude' AND target_native_id=? AND kind='tier1'`,
  ).get((db.prepare(`SELECT native_id FROM sessions WHERE id=?`).get(sid) as { native_id: string }).native_id) as {
    id: number; kind: string; current_status: string; blocked_reason: string; attempt_count: number;
  };
  expect(work).toMatchObject({ kind: "tier1", current_status: "blocked", attempt_count: 1 });
  expect(work.blocked_reason).toContain("stale");
  expect(db.prepare(`SELECT status,error FROM job_attempts WHERE work_id=?`).get(work.id)).toMatchObject({
    status: "blocked", error: expect.stringContaining("stale"),
  });
});

test("anchorless tier-2 remains visible and pending until a later valid retry", async () => {
  db = await openDb(join(dir, "atlas.db"));
  const sid = seedCanonicalSession(db, "s1", [{ role: "user", text: "hello" }]);
  db.prepare(`INSERT INTO summaries(session_id,tier,topic_line,msg_count_covered) VALUES (?,1,'topic',1)`).run(sid);
  process.env.ATLAS_WAVE3_KEY = "fixture";
  const cfg = config({}, [{ name: "fixture", base: "https://fixture.invalid", kind: "anthropic", model: "m", key_env: "ATLAS_WAVE3_KEY" }]);
  const replies = [
    "usable prose without JSON anchors",
    JSON.stringify({ body: "repaired body", topics: [{ topic: "start", from: 0, to: 0, body: "hello" }] }),
  ];
  globalThis.fetch = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: replies.shift()! }] }), { status: 200 })) as typeof fetch;

  const degraded = await summarizeTier2(db, cfg, sid);
  expect(degraded.status).toBe("degraded");
  expect((degraded as { result: { body: string } }).result.body).toContain("usable prose");
  const retryWork = db.prepare(
    `SELECT id,current_status,blocked_reason,attempt_count FROM job_work
     WHERE target_harness='claude' AND target_native_id='s1' AND kind='tier2'`,
  ).get() as { id: number; current_status: string; blocked_reason: string; attempt_count: number };
  expect(retryWork).toMatchObject({ current_status: "blocked", attempt_count: 1 });
  expect(retryWork.blocked_reason).toContain("anchor");
  expect(db.prepare(`SELECT status,error FROM job_attempts WHERE work_id=?`).get(retryWork.id)).toMatchObject({
    status: "blocked", error: expect.stringContaining("anchor"),
  });
  expect((db.prepare(`SELECT body FROM summaries WHERE session_id=? AND tier=2`).get(sid) as { body: string }).body).toContain("usable prose");

  const repaired = await summarizeTier2(db, cfg, sid);
  expect(repaired.status).toBe("summarized");
  // The valid retry settles the work it left, so the cache is trusted again.
  expect((db.prepare(`SELECT current_status FROM job_work WHERE id=?`).get(retryWork.id) as { current_status: string }).current_status).toBe("done");
  expect((db.prepare(`SELECT status,error FROM job_attempts WHERE work_id=? ORDER BY attempt_ordinal DESC LIMIT 1`).get(retryWork.id) as { status: string; error: string }).status).toBe("done");
  expect((await summarizeTier2(db, cfg, sid)).status).toBe("cached");
  expect((db.prepare(`SELECT COUNT(*) n FROM summary_anchors`).get() as { n: number }).n).toBe(1);
});

test("doctor marks a reachable root with latest unit errors DOWN", async () => {
  const root = join(dir, "root");
  mkdirSync(root);
  db = await openDb(join(dir, "atlas.db"));
  const now = Date.now();
  const cfg = config({ claude: { roots: [root] } });
  const digest = sourcePlanDigest(cfg);
  const group = Number((db.prepare(
    `INSERT INTO reconciliation_groups(
       config_digest,trigger_kind,started_at,finished_at,status,enabled_source_count,complete_source_count
     ) VALUES (?, 'manual', ?, ?, 'complete', 1, 1)`,
  ).run(digest, now, now) as { lastInsertRowid: number | bigint }).lastInsertRowid);
  const source = Number((db.prepare(
    `INSERT INTO reconciliation_sources(
       group_id,source,resolution_mode,resolved_roots_json,status,
       physical_unit_count,canonical_candidate_count,admissible_identity_count,archived_identity_count,error_unit_count
     ) VALUES (?, 'claude', 'replace', ?, 'incomplete', 1, 1, 1, 1, 1)`,
  ).run(group, JSON.stringify([root])) as { lastInsertRowid: number | bigint }).lastInsertRowid);
  db.prepare(
    `INSERT INTO reconciliation_roots(
       reconciliation_source_id,root_ordinal,root,reachability,started_at,finished_at,end_change_token,
       physical_unit_count,canonical_candidate_count,error
     ) VALUES (?,0,?,'reachable',?,?,?,?,?,?)`,
  ).run(source, root, now, now, computeRootChangeToken(root), 1, 1, "bad.jsonl: malformed complete line");
  const schedulePath = join(dir, "schedule.txt");
  writeFileSync(schedulePath, `<runtime-config>\n${cfg.dbPath}\n`);
  db.prepare(
    `INSERT INTO source_schedule_state(
       source,config_digest,expected_interval_ms,degraded_after_ms,stale_after_ms,schedule_kind,schedule_path,
       target_config_path,target_db_path,last_scheduled_group_id,updated_at
     ) VALUES ('claude',?,300000,900000,3600000,'fixture',?,?,?, ?, ?)`,
  ).run(digest, schedulePath, "<runtime-config>", cfg.dbPath, group, now);
  const report = collectDoctorReport(db, cfg);
  expect(report.ok).toBe(false);
  const lines = report.lines.join("\n");
  expect(lines).toContain("[ok] claude  root 1 reachability · reachable");
  expect(lines).toContain("[DOWN] claude  quality");
  expect(lines).toContain("malformed complete line");
});

async function captureStdout<T>(work: () => Promise<T>): Promise<{ value: T; text: string }> {
  const original = process.stdout.write;
  let text = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    text += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: await work(), text };
  } finally {
    process.stdout.write = original;
  }
}
