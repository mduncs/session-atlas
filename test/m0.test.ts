import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { openDb, type DB } from "../src/db/index.js";
import { ingest } from "../src/ingest.js";
import type { Config } from "../src/config.js";

/** Minimal valid Config pointed at a temp root + temp db. */
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

/** Build Claude-JSONL-shaped records (mirrors the real on-disk format). */
function line(
  type: "user" | "assistant",
  role: string,
  content: unknown,
  i: number,
  extra: Record<string, unknown> = {},
): string {
  const msg: Record<string, unknown> = { role };
  if (role === "assistant") msg.model = "claude-opus-4-8";
  msg.content = content;
  return JSON.stringify({
    type,
    message: msg,
    timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    cwd: "/Users/tester/code/proj",
    sessionId: "session-1",
    ...extra,
  });
}

function userText(s: string, i: number): string {
  return line("user", "user", s, i);
}
function assistantText(s: string, i: number): string {
  return line("assistant", "assistant", [{ type: "text", text: s }], i);
}
function assistantTool(name: string, i: number): string {
  return line("assistant", "assistant", [{ type: "tool_use", id: "t" + i, name, input: { x: 1 } }], i);
}
function toolResult(text: string, i: number): string {
  return line("user", "user", [{ type: "tool_result", tool_use_id: "t" + i, content: text }], i);
}

/** A 6-record transcript: u/a/u(tool_result)/a/u/a */
function sampleTranscript(): string[] {
  return [
    userText("hello, tell me about variable stars", 0),
    assistantText("The period-luminosity relation…", 1),
    toolResult("ran bash: ls -la", 2),
    assistantTool("bash", 3),
    userText("and what about Cepheids?", 4),
    assistantText("Cepheids are variable stars…", 5),
  ];
}

let tmp: string;
let dbPath: string;
let db: DB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "atlas-m0-"));
  dbPath = join(tmp, "atlas.db");
});

afterEach(() => {
  db?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function writeSession(root: string, content: string, name = "session-1.jsonl"): string {
  const projDir = join(root, "-Users-md-code-proj");
  mkdirSync(projDir, { recursive: true });
  const fullPath = join(projDir, name);
  writeFileSync(fullPath, content);
  return fullPath;
}

function hash(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function mtimeMs(p: string): number {
  return Math.floor(statSync(p).mtimeMs);
}

test("Law 2 — source dirs are byte-identical after a full index", async () => {
  const root = join(tmp, "src");
  const transcript = sampleTranscript().join("\n") + "\n";
  const file = writeSession(root, transcript);

  const beforeHash = hash(file);
  const beforeMtime = mtimeMs(file);

  db = await openDb(dbPath);
  const summaries = await ingest(db, tempConfig(root, dbPath));

  // Read-only at the source (Law 2): hash unchanged; mtime not advanced by us.
  expect(hash(file)).toBe(beforeHash);
  expect(mtimeMs(file)).toBe(beforeMtime);
  expect(summaries[0]!.inserted).toBe(1);

  const sess = db
    .prepare(`SELECT msg_count, tok_user, tok_assistant, tok_tool, engagement FROM sessions`)
    .get() as { msg_count: number; tok_user: number; tok_assistant: number; tok_tool: number; engagement: number | null };
  // All six records are message-bearing: tool_result carries tool_text,
  // tool_use carries has_tool — neither is skipped. Consistency over which
  // records "count" (Law 5): every record is a turn.
  expect(sess.msg_count).toBe(6);
  expect(sess.tok_tool).toBeGreaterThan(0); // the tool_result content counted as tool tokens
  expect(sess.engagement).toBeGreaterThan(0);
});

test("Law 10 — a torn trailing line is not consumed; completing it loses/duplicates nothing", async () => {
  const root = join(tmp, "src");
  const fullLines = sampleTranscript();
  const fullText = fullLines.join("\n") + "\n";

  // Torn version: chop the last record mid-line so it is incomplete.
  const lastLine = fullLines[fullLines.length - 1]!;
  const tornText = fullLines.slice(0, -1).join("\n") + "\n" + lastLine.slice(0, Math.floor(lastLine.length / 2));

  const file = writeSession(root, tornText);
  db = await openDb(dbPath);

  await ingest(db, tempConfig(root, dbPath));
  const afterTorn = db
    .prepare(`SELECT COUNT(*) n FROM messages WHERE session_id=(SELECT id FROM sessions LIMIT 1)`)
    .get() as { n: number };
  const tornState = db
    .prepare(`SELECT offset, size FROM ingest_state WHERE source='claude'`)
    .get() as { offset: number; size: number };

  // The torn line was NOT consumed: offset lands before the partial line.
  expect(tornState.offset).toBeLessThan(tornState.size);
  // Five complete lines parsed (idx0..4); the torn idx5 assistant line is
  // dropped. All five are message-bearing (see Law 2 test).
  expect(afterTorn.n).toBe(5);

  // Now append the remainder, completing the file.
  writeFileSync(file, fullText);
  await ingest(db, tempConfig(root, dbPath));
  const afterComplete = db
    .prepare(`SELECT COUNT(*) n FROM messages WHERE session_id=(SELECT id FROM sessions LIMIT 1)`)
    .get() as { n: number };

  // All six records now complete and message-bearing (idx4 user, idx5 assistant).
  // Zero lost (torn line recovered), zero duplicated (ordinals unique).
  expect(afterComplete.n).toBe(6);

  // Ordinals are contiguous 0..n-1 with no gaps or dupes.
  const ordinals = (
    db
      .prepare(`SELECT ordinal FROM messages WHERE session_id=(SELECT id FROM sessions LIMIT 1) ORDER BY ordinal`)
      .all() as { ordinal: number }[]
  ).map((r) => r.ordinal);
  expect(ordinals).toEqual([0, 1, 2, 3, 4, 5]);

  // Offset now matches file size (fully consumed).
  const done = db.prepare(`SELECT offset, size FROM ingest_state WHERE source='claude'`).get() as {
    offset: number;
    size: number;
  };
  expect(done.offset).toBe(done.size);
});

test("dedupe — a session present in two roots yields one row, longer transcript wins", async () => {
  // live root: short transcript; archive root: longer transcript (same native id).
  const liveRoot = join(tmp, "live");
  const archiveRoot = join(tmp, "archive");
  const short = sampleTranscript().slice(0, 2).join("\n") + "\n"; // 2 records
  const long = sampleTranscript().join("\n") + "\n"; // 6 records
  writeSession(liveRoot, short);
  writeSession(archiveRoot, long);

  db = await openDb(dbPath);
  // Process live first (ordered roots), then archive.
  const cfg: Config = { ...tempConfig(liveRoot, dbPath) };
  cfg.sources = { claude: { roots: [liveRoot, archiveRoot] } };
  await ingest(db, cfg);

  const rows = db.prepare(`SELECT COUNT(*) n FROM sessions`).get() as { n: number };
  expect(rows.n).toBe(1); // one row despite two roots

  const sess = db.prepare(`SELECT msg_count, source_root FROM sessions`).get() as {
    msg_count: number;
    source_root: string;
  };
  // Archive (longer) wins: 6 messages, archive root recorded.
  expect(sess.msg_count).toBe(6);
  expect(sess.source_root).toBe(archiveRoot);
});
