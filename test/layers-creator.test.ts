import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyUserText, decideCreator, setLearnedVocabulary, typoCount, voiceOf, type CreatorInput } from "../src/layers/authorship.js";
import { attachLayers, layersPathFor, openLayersDb } from "../src/layers/db.js";
import { correctCreator, readCreator, toggleCreator } from "../src/layers/corrections.js";
import { creatorFilterSql } from "../src/layers/creator-sql.js";

const none = new Set<string>();
const session = (detail: string | null, texts: string[], origin: CreatorInput["origin"] = "human"): CreatorInput =>
  ({ harness: "codex", origin, originDetail: detail, userRecords: texts.map((text, ordinal) => ({ ordinal, text })) });

describe("user-side authorship", () => {
  test("harness plumbing is never the owner", () => {
    for (const text of [
      "<recommended_plugins>\nHere is a list of plugins",
      "# AGENTS.md instructions\n\n<INSTRUCTIONS>",
      "<codex_internal_context source=\"goal\">\nContinue",
      "Base directory for this skill: /Users/demo/.claude/skills/fav",
      "Stop hook feedback:\nvibe check failed",
      "35 background agents were stopped by the user: \"Read-only…\"",
    ]) expect(classifyUserText(text).author).toBe("harness");
  });

  test("relays, teammates, probes and role briefs are agents", () => {
    for (const text of [
      "[from parent]\nAgent-to-agent message received.",
      "[task from parent]\n\nImplement the thing",
      "<teammate-message teammate_id=\"team-lead\">",
      "Reply with exactly: LAUNCHER_OK",
      `You are qa-gremlin, a specialist who breaks things. ${"x".repeat(220)}`,
    ]) expect(classifyUserText(text).author).toBe("agent");
  });

  test("slash commands, attachments and approved plans are the owner's actions", () => {
    expect(classifyUserText("/compact").author).toBe("human");
    expect(classifyUserText("[Image: source: /Users/demo/Documents/Screenshots/a.png]").author).toBe("human");
    expect(classifyUserText("Implement the following plan:\n\n# Plan").rule).toBe("human:plan-accept");
  });

  test("the owner's typos count; jargon and inflections do not", () => {
    setLearnedVocabulary(new Set(["worktree", "implementation"]));
    expect(typoCount("implemneatation order here pelase do it on a new owrktree")).toBe(2);
    setLearnedVocabulary(new Set());
    expect(typoCount("verified flagged copies applies having committed larger")).toBe(0);
  });

  test("voice separates the owner from dispatched lane briefs", () => {
    const owner = voiceOf("hi new worktree, do you see /test-runner ? can you maake like 3 experiemental layouts");
    const brief = voiceOf("Read docs/briefs/tile-cache-lane.md in full and execute it exactly. It is lane TILECACHE. Work in /Users/demo/code/harbor-charts.");
    expect(owner.human).toBeGreaterThan(owner.brief);
    expect(brief.brief - brief.human).toBeGreaterThanOrEqual(2);
  });
});

describe("who started the session", () => {
  test("worker launch metadata outranks the owner's inherited words", () => {
    const verdict = decideCreator(session("codex:subagent.thread_spawn", ["can you maake the thing pelase"], "agent"), none);
    expect(verdict.startedBy).toBe("agent");
  });

  test("interactive launch is not proof of the owner: lanes dispatched through vscode are agents", () => {
    const verdict = decideCreator(session("codex:source:vscode", ["You are lane GRIDSWEEP on the harbor-charts project. Read and follow your brief at ~/code/harbor-charts/docs/briefs/grid-sweep-lane.md exactly. Work in ~/code/harbor-charts and do not commit anything until the gates pass."]), none);
    expect(verdict.startedBy).toBe("agent");
  });

  test("the owner opening past harness plumbing is human", () => {
    const verdict = decideCreator(session("codex:source:cli", ["<recommended_plugins>\n- Airtable", "hey! who am i talkng to today"]), none);
    expect(verdict).toMatchObject({ startedBy: "human", humanTurns: 1, harnessTurns: 1 });
  });

  test("a pasted handoff followed by the owner talking is human", () => {
    const verdict = decideCreator(session("claude:direct-cli", [
      "### Claude handoff\n\nContinue the Session Atlas long-term architecture work in /Users/demo/code/session-atlas. Evidence: the ledger is complete.",
      "ok so waht did you find, is the ledger actualy done?",
    ]), none);
    expect(verdict.startedBy).toBe("human");
  });

  test("a templated opener is scripted unless the owner then talks", () => {
    const opener = "Read the attached coflow execution brief in full and perform that bounded lane. Return a concise completion report.";
    const templated = new Set([opener.toLowerCase()]);
    expect(decideCreator(session(null, [opener], "unknown"), templated).startedBy).toBe("agent");
    expect(decideCreator(session(null, [opener, "hmm that didnt work, can you retyr with the other brnach?"], "unknown"), templated).startedBy).toBe("human");
  });

  test("no dialogue stays unknown", () => {
    expect(decideCreator(session(null, [], "unknown"), none).startedBy).toBe("unknown");
  });
});

describe("layers database", () => {
  test("attaches beside the archive, corrections win, and each lens is exact", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-layers-"));
    try {
      const path = join(dir, "atlas.db");
      const db = new Database(path);
      db.exec("CREATE TABLE sessions(id INTEGER PRIMARY KEY, harness TEXT, native_id TEXT, origin TEXT)");
      db.exec("INSERT INTO sessions VALUES (1,'codex','a','human'),(2,'codex','b','agent'),(3,'claude','c','unknown')");
      expect(attachLayers(db, path)).toBe("file");
      expect(layersPathFor(path)).toBe(join(dir, "atlas.layers.db"));
      const layers = openLayersDb(path);
      layers.exec("INSERT INTO session_creator VALUES('codex','a',1,'agent',0.8,'e',null,0,1,0,1,0)");
      layers.close();
      expect(readCreator(db, { harness: "codex", nativeId: "a" })).toBe("agent");
      expect(readCreator(db, { harness: "claude", nativeId: "c" })).toBe("unknown");
      expect(toggleCreator(db, { harness: "codex", nativeId: "a" })).toBe("human");
      correctCreator(db, { harness: "codex", nativeId: "b" }, "agent");
      const human = db.query(`SELECT s.id FROM sessions s WHERE ${creatorFilterSql("human")} ORDER BY s.id`).all();
      expect(human).toEqual([{ id: 1 }]);
      expect(db.query(`SELECT s.id FROM sessions s WHERE ${creatorFilterSql("unknown")} ORDER BY s.id`).all()).toEqual([{ id: 3 }]);
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("a read-only archive handle still gets a queryable layer", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-layers-ro-"));
    try {
      const path = join(dir, "atlas.db");
      new Database(path).close();
      const ro = new Database(path, { readonly: true });
      attachLayers(ro, path);
      expect(ro.query("SELECT count(*) AS n FROM layers.session_creator").get()).toEqual({ n: 0 });
      ro.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
