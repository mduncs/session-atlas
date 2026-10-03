import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_TUNABLES, type Config } from "../src/config.js";
import { openDb, type DB } from "../src/db/index.js";
import { ingest } from "../src/ingest.js";
import { openLayersDb } from "../src/layers/db.js";
import { computeShapes } from "../src/layers/shape.js";

const roots: string[] = [];
let atlas: DB | undefined;
afterEach(() => {
  atlas?.close();
  atlas = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("shape streaming keeps assistant prose after an embedded NUL", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-shape-nul-"));
  roots.push(root);
  const dbPath = join(root, "atlas.db");
  atlas = await openDb(dbPath);
  const sid = Number(atlas.query(`INSERT INTO sessions(harness,native_id,source_path,ingested_at,construction_generation) VALUES ('claude','nul','fixture',1,'g')`).run().lastInsertRowid);
  const insert = atlas.query(`INSERT INTO messages(session_id,ordinal,role,text,record_kind,construction_generation) VALUES (?,?,?,?,?,'g')`);
  for (let i = 0; i < 10; i++) {
    insert.run(sid, i * 2, "user", "ok", "real_user");
    insert.run(sid, i * 2 + 1, "assistant", i === 0 ? "\0zebrafish zebrafish" : "done", "assistant_dialogue_prose");
  }
  const layers = openLayersDb(dbPath);
  try {
    computeShapes(atlas, layers);
    const episodes = layers.query(`SELECT keywords FROM session_episodes WHERE native_id='nul'`).all() as { keywords: string }[];
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.keywords).toContain("zebrafish");
  } finally { layers.close(); }
});

const NATIVE = "33333333-3333-4333-8333-333333333333";
const at = (second: number) => new Date(Date.UTC(2026, 7, 6, 19, 0, second)).toISOString();
let serial = 0;
const id = () => `44444444-4444-4444-8444-${String(++serial).padStart(12, "0")}`;
const user = (text: string, second: number) => ({ type: "user", uuid: id(), sessionId: NATIVE, timestamp: at(second), message: { role: "user", content: text } });
const reply = (text: string, second: number) => ({ type: "assistant", uuid: id(), sessionId: NATIVE, timestamp: at(second), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] } });
const boundary = (second: number) => ({ type: "system", subtype: "compact_boundary", uuid: id(), sessionId: NATIVE, timestamp: at(second), compactMetadata: { trigger: "manual" } });

test("compaction boundaries count toward shape even when no /compact text was archived", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-shape-compactions-"));
  roots.push(root);
  const project = join(root, "projects", "-Users-demo-code-tidepool");
  mkdirSync(project, { recursive: true });
  const lines = [
    user("reproduce the ghost hour before touching anything", 1),
    reply("Writing a failing test for Monterey first.", 2),
    boundary(3),
    user("ok, now the migration for every station", 4),
    reply("Migrating all 413 stations to IANA zones.", 5),
    // One compaction also left its command text; it must not double count.
    user("/compact", 6),
    boundary(7),
    user("pin both DST transitions in tests", 8),
    reply("Added spring-forward and fall-back cases.", 9),
  ];
  writeFileSync(join(project, `${NATIVE}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const dbPath = join(root, "atlas.db");
  const config: Config = { sources: { claude: { roots: [join(root, "projects")] } }, providers: [], launchers: [], tunables: DEFAULT_TUNABLES, dbPath };
  atlas = await openDb(dbPath);
  await ingest(atlas, config);
  const layers = openLayersDb(dbPath);
  try {
    computeShapes(atlas, layers);
    expect(layers.query(`SELECT shape, compactions FROM session_shape WHERE native_id=?`).get(NATIVE)).toEqual({ shape: "tiny", compactions: 2 });
  } finally {
    layers.close();
  }
});
