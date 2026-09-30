import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/db/index.js";
import { rebuildLogicalMetrics } from "../src/logical-metrics.js";
import { dispatchCli } from "../src/cli.js";

test("verb-local help is side-effect-free before command dispatch", async () => {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await dispatchCli([
      "index",
      "--help",
      "--config",
      "/definitely/missing/session-atlas-help-test.toml",
    ]);
    expect(code).toBe(0);
    expect(output).toContain("atlas index [--full]");
  } finally {
    process.stdout.write = original;
  }
});


const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

test("read and status commands neither bootstrap nor mutate the archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-readonly-cli-")); roots.push(root);
  const dbPath = join(root, "atlas.db");
  const configPath = join(root, "config.toml");
  const db = new Database(dbPath); runMigrations(db);
  const now = Date.now();
  const generation = "fixture-v11:readonly";
  const session = Number(db.prepare(
    `INSERT INTO sessions(
       harness,native_id,source_path,title,last_activity,models,ingested_at,msg_count,transcript_bytes,
       artifact_kind,history_completeness,construction_generation,construction_status,default_session_visible,
       source_validation_status,source_observed_ts
     ) VALUES ('claude','fixture','/fixture','readonly fixture',?,'[]',?,1,30,'dialogue_history','complete',?,'valid',1,'current',?)`,
  ).run(now, now, generation, now).lastInsertRowid);
  db.prepare(
    `INSERT INTO messages(
       session_id,ordinal,source_ordinal,role,ts,text,prose,event_ts,has_tool,tok_estimate,
       record_kind,dialogue_side,source_record_id,source_record_ts,source_identity_kind,construction_generation
     ) VALUES (?,0,0,'user',?,?,?,?,0,10,'real_user','user','fixture-user',?,'record-id',?)`,
  ).run(session, now, "readonly searchable fixture", "readonly searchable fixture", now, now, generation);
  rebuildLogicalMetrics(db, session, generation);
  db.close();
  const disabledSources = ["claude", "codex", "prime", "hermes", "kimi", "zcode", "kilo"]
    .map((source) => `[sources.${source}]\nmode = "disabled"\nreason = "read-only fixture owns no source"\n`)
    .join("\n");
  writeFileSync(configPath, `dbPath = ${JSON.stringify(dbPath)}\n\n${disabledSources}`);
  const before = fingerprint(dbPath);
  const namesBefore = readdirSync(root).sort();
  for (const args of [["ls"],["search","searchable"],["read",String(session)],["doctor"]]) {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", join(import.meta.dir,"../src/cli.ts"), ...args, "--config", configPath], { stdout:"pipe", stderr:"pipe", env: cleanEnv() });
    expect(await child.exited).toBe(0);
  }
  expect(fingerprint(dbPath)).toEqual(before);
  // Only the derived layers sidecar may appear: searches are logged there by design.
  expect(readdirSync(root).filter((name) => !/^atlas\.layers\.db(-shm|-wal)?$/.test(name)).sort()).toEqual(namesBefore);

  const missing = join(root,"missing","config.toml");
  const child = Bun.spawn([Bun.which("bun") ?? "bun", join(import.meta.dir,"../src/cli.ts"), "ls", "--config", missing], { stdout:"pipe", stderr:"pipe", env: cleanEnv() });
  expect(await child.exited).not.toBe(0);
  expect(existsSync(missing)).toBe(false);
  expect(existsSync(join(root,"missing","atlas.db"))).toBe(false);
});

function fingerprint(path: string): { size:number; mtimeMs:number; sha256:string } {
  const stat = statSync(path);
  return { size:stat.size, mtimeMs:stat.mtimeMs, sha256:createHash("sha256").update(readFileSync(path)).digest("hex") };
}
function cleanEnv(): Record<string,string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name,value]) => name !== "FORCE_COLOR" && value !== undefined)) as Record<string,string>;
  env.NO_COLOR="1"; return env;
}
