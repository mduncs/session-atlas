import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../src/db/index.js";
import { executeTool, extractCitations, parseToolCall_text } from "../src/chat.js";
import { publishFixtureDialogue } from "./current-generation-fixture.js";

test("M5 — citation extraction: [sid] and [sid:ordinal] both parse", () => {
  const text = "The refactor touched adapters [42] and the chain logic [42:7], see also [103:3].";
  const cites = extractCitations(text);
  expect(cites.length).toBe(3);
  expect(cites[0]).toEqual({ sessionId: 42, ordinal: null });
  expect(cites[1]).toEqual({ sessionId: 42, ordinal: 7 });
  expect(cites[2]).toEqual({ sessionId: 103, ordinal: 3 });
});

test("M5 — citation extraction: text with no brackets yields zero citations (uncited = failure)", () => {
  const text = "I think the adapter was refactored but I'm not sure when.";
  expect(extractCitations(text)).toEqual([]);
});

test("M5 — citation extraction: brackets that aren't citations (e.g. [TODO]) are ignored", () => {
  // [TODO] has no digits → not a citation.
  const text = "This is [TODO] and [not-a-cite] but [55] is real.";
  const cites = extractCitations(text);
  expect(cites.length).toBe(1);
  expect(cites[0]!.sessionId).toBe(55);
});

test("M5 — tool call parsing: search/read/list tokens", () => {
  expect(parseToolCall_text('blah\n<search query="astronomy"/>\nmore')).toEqual({
    kind: "search",
    query: "astronomy",
  });
  expect(parseToolCall_text('text <read session="42"/> end')).toEqual({
    kind: "read",
    session: 42,
  });
  expect(parseToolCall_text('<list harness="claude" limit="3"/>')).toEqual({
    kind: "list",
    harness: "claude",
    limit: 3,
  });
  expect(parseToolCall_text("no tool here")).toBeNull();
});

// Regression: the list tool once selected a bare `id` from a sessions⋈summaries
// join — SQLite threw "ambiguous column name: id" and, uncaught, it killed the
// whole chat round. Tools must run against the real schema and never throw.
test("M5 — executeTool list/read/search run against the real schema without throwing", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "atlas-chat-"));
  const db = await openDb(join(tmp, "atlas.db"));
  try {
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO sessions (harness, native_id, source_path, last_activity, ingested_at)
       VALUES (?,?,?,?,?)`,
    );
    ins.run("claude", "n1", "/tmp/a.jsonl", now, now);
    ins.run("codex", "n2", "/tmp/b.jsonl", now - 1000, now);
    db.prepare(
      `INSERT INTO summaries (session_id, tier, topic_line, msg_count_covered) VALUES (1, 1, 'adapter refactor', 4)`,
    ).run();
    db.prepare(
      `INSERT INTO messages (session_id, ordinal, role, text) VALUES (1, 0, 'user', 'please refactor the adapter')`,
    ).run();
    publishFixtureDialogue(db, 1);

    // list: both sessions, summarized + unsummarized, newest first.
    const listed = executeTool(db, { kind: "list", limit: 5 });
    expect(listed).toContain("[1] adapter refactor");
    expect(listed).toContain("[2] (unsummarized)");
    expect(listed.indexOf("[1]")).toBeLessThan(listed.indexOf("[2]"));

    // list filtered by harness.
    expect(executeTool(db, { kind: "list", harness: "codex", limit: 5 })).not.toContain("[1]");

    // read + search: exercise the other two branches on the same schema.
    expect(executeTool(db, { kind: "read", session: 1 })).toContain("[1:0] user:");
    expect(executeTool(db, { kind: "search", query: "adapter" })).toContain("[1:0]");
  } finally {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
