import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/db/index.js";
import { literalFtsQuery } from "../src/fts-query.js";
import { publishFixtureDialogue, publishFixtureTitle } from "./current-generation-fixture.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

test("ls and search expose the TUI filter algebra through the real CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-cli-filter-")); roots.push(root);
  const dbPath = join(root, "atlas.db");
  const configPath = join(root, "config.toml");
  const db = new Database(dbPath); runMigrations(db);
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO sessions(
    harness,native_id,source_path,title,cwd,project,last_activity,duration_ms,models,
    tok_user,tok_assistant,tok_tool,msg_count,engagement,orphaned,ingested_at,chain_id,origin
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const alpha = Number(insert.run("claude", "alpha", "/fixture/a", "alpha raw", "/repo/a", "/repo/a", now, 1, '["opus"]', 10, 20, 0, 1, .33, 0, now, 7, "human").lastInsertRowid);
  const beta = Number(insert.run("codex", "beta", "/fixture/b", "beta raw", "/repo/b", "/repo/b", now - 1, 1, '["gpt"]', 10, 20, 0, 1, .33, 0, now, null, "agent").lastInsertRowid);
  db.prepare(`INSERT INTO messages(session_id,ordinal,role,text,ts,has_tool) VALUES (?,?,?,?,?,0)`).run(alpha, 0, "user", "astronomy evidence alpha", now);
  db.prepare(`INSERT INTO messages(session_id,ordinal,role,text,ts,has_tool) VALUES (?,?,?,?,?,0)`).run(beta, 0, "user", "astronomy evidence beta", now);
  publishFixtureDialogue(db, alpha, "fixture-alpha");
  publishFixtureDialogue(db, beta, "fixture-beta");
  publishFixtureTitle(db, alpha, "fixture-alpha", "alpha topic");
  db.prepare(`INSERT INTO summaries(session_id,tier,topic_line,msg_count_covered) VALUES (?,1,'alpha topic',1)`).run(alpha);
  const tag = Number(db.prepare(`INSERT INTO tags(name,promoted_at) VALUES ('astronomy',?)`).run(now).lastInsertRowid);
  db.prepare(`INSERT INTO session_tags(session_id,tag_id) VALUES (?,?)`).run(alpha, tag);
  db.prepare(`INSERT INTO favorites(harness,native_id,span_text,scope,status,created_at,updated_at) VALUES ('claude','alpha','astronomy evidence alpha','session','ok',?,?)`).run(now, now);
  // Effective origin is explicit-classification-only Human (see human-classifier):
  // raw sessions.origin='human' alone does not surface a row under --origin human.
  // Promote alpha through the same contract the production query reads from.
  db.prepare(`INSERT INTO session_human_classifications(
    session_id, decision, confidence, reason, method, model, runner,
    origin_snapshot, input_hash, classified_at
  ) VALUES (?, 'human', 0.9, 'fixture: explicit human-classification for filter parity',
            'glm-human-promotion', 'fixture', 'fixture', 'human',
            '0000000000000000000000000000000000000000000000000000000000000000', ?)`).run(alpha, now);
  db.close();
  writeFileSync(configPath, `dbPath = ${JSON.stringify(dbPath)}\n`);

  const filters = ["--source", "claude", "--model", "opus", "--tag", "astronomy", "--origin", "human", "--favorite", "--state", "summarized", "--chain", "7", "--config", configPath];
  const listed = await cli(["ls", ...filters]);
  expect(listed.exitCode).toBe(0);
  expect(listed.stdout).toContain("alpha topic");
  expect(listed.stdout).not.toContain("beta raw");

  const searched = await cli(["search", "evidence", ...filters]);
  expect(searched.exitCode).toBe(0);
  expect(searched.stdout).toContain("alpha topic");
  expect(searched.stdout).toContain("astronomy ⟦evidence⟧ alpha");
  expect(searched.stdout).not.toContain("beta raw");

  const invalid = await cli(["ls", "--state", "mystery", "--config", configPath]);
  expect(invalid.exitCode).toBe(2);
  expect(invalid.stderr).toContain("invalid --state mystery");

  const invalidOrigin = await cli(["ls", "--origin", "robot", "--config", configPath]);
  expect(invalidOrigin.exitCode).toBe(2);
  expect(invalidOrigin.stderr).toContain("invalid --origin robot");
});

test("search treats punctuation as literal text by default and offers explicit raw FTS5 syntax", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-cli-literal-search-")); roots.push(root);
  const dbPath = join(root, "atlas.db");
  const configPath = join(root, "config.toml");
  const db = new Database(dbPath); runMigrations(db);
  const now = Date.now();
  const sessionId = Number(db.prepare(`INSERT INTO sessions(
    harness,native_id,source_path,title,cwd,project,last_activity,duration_ms,models,
    tok_user,tok_assistant,tok_tool,msg_count,engagement,orphaned,ingested_at,origin
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "codex", "literal-search", "/fixture/literal", "punctuation fixture", "/repo/session-atlas",
    "/repo/session-atlas", now, 1, '["gpt"]', 10, 20, 0, 2, .5, 0, now, "human",
  ).lastInsertRowid);
  const insertMessage = db.prepare(`INSERT INTO messages(session_id,ordinal,role,text,ts,has_tool) VALUES (?,?,?,?,?,0)`);
  insertMessage.run(sessionId, 0, "user", "nodraw-site spatial-audio-engine session-atlas plainword", now);
  insertMessage.run(sessionId, 1, "assistant", 'multi word and a double " quote', now);
  publishFixtureDialogue(db, sessionId, "fixture-literal-search");
  publishFixtureTitle(db, sessionId, "fixture-literal-search", "punctuation fixture");
  db.close();
  writeFileSync(configPath, `dbPath = ${JSON.stringify(dbPath)}\n`);

  for (const query of ["nodraw-site", "spatial-audio-engine", "session-atlas", "plainword", "multi word", 'double " quote']) {
    const result = await cli(["search", query, "--config", configPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("punctuation fixture");
  }

  const raw = await cli(["search", "plainword OR absent", "--raw", "--config", configPath]);
  expect(raw.exitCode).toBe(0);
  expect(raw.stdout).toContain("punctuation fixture");

  const empty = await cli(["search", "", "--config", configPath]);
  expect(empty.exitCode).toBe(2);
  expect(empty.stderr).toContain("atlas search <query> [--raw]");
});

test("literalFtsQuery quotes every term and doubles embedded quotes", () => {
  expect(literalFtsQuery('nodraw-site repo:path file/name.ts say"hello'))
    .toBe('"nodraw-site" "repo:path" "file/name.ts" "say""hello"');
  expect(literalFtsQuery("  multi   word  ")).toBe('"multi" "word"');
  expect(literalFtsQuery("   ")).toBe("");
});

async function cli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "FORCE_COLOR"));
  env.NO_COLOR = "1";
  const child = Bun.spawn([processExec(), join(import.meta.dir, "../src/cli.ts"), ...args], { stdout: "pipe", stderr: "pipe", env });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function processExec(): string { return Bun.which("bun") ?? "bun"; }
