import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { Database } from "bun:sqlite";
import type { Config } from "../src/config.js";
import { runMigrations, type DB } from "../src/db/index.js";
import { InkLibraryBridge } from "../src/tui/library-bridge.js";
import { LibraryStore } from "../src/library/store.js";
import { makePassage } from "../src/library/passages.js";
import { attachLayers } from "../src/layers/db.js";
import { App, preserveRowsForRefetch, TuiRuntime, type TuiTranscriptReader } from "../src/tui/app.js";
import { _resetRegistry } from "../src/tui/commands.js";
import { _allowReinit, registerCommands } from "../src/tui/commands-defs.js";
import { TerminalResourceManager, type TerminalStdin } from "../src/tui/terminal.js";
import { appendRows, beginSearch, commitSearch, initialState } from "../src/tui/store.js";
import type { SessionRow } from "../src/tui/domain.js";

const roots: string[] = [];
afterEach(() => { delete process.env.ATLAS_CODING_KEY; while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

class FakeStdin extends EventEmitter implements TerminalStdin {
  isTTY = true;
  raw = false;
  setRawMode(value: boolean): void { this.raw = value; }
  resume(): void {}
  pause(): void {}
  send(value: string): void { this.emit("data", value); }
}

function config(root: string, overrides: Partial<Config> = {}): Config {
  return {
    sources: {}, providers: [], launchers: [], dbPath: join(root, "atlas.db"),
    tunables: { tag_promotion_count: 3, export_budget_tokens: 20_000, fav_default_span: 6, summary_stale_pct: 25, redact_entropy_threshold: 4.8 },
    ...overrides,
  };
}

function fixture(count = 4, chained = false): { root: string; db: DB; config: Config } {
  const root = mkdtempSync(join(tmpdir(), "atlas-app-")); roots.push(root);
  const cfg = config(root);
  const db = new Database(cfg.dbPath); runMigrations(db); attachLayers(db, cfg.dbPath);
  const now = Date.now();
  for (let index = 0; index < count; index++) {
    const inserted = db.prepare(`INSERT INTO sessions(harness,native_id,source_path,title,last_activity,duration_ms,models,tok_user,tok_assistant,tok_tool,msg_count,engagement,orphaned,ingested_at,chain_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run("claude", `native-${index}`, "/fixture", `${index} mounted topic`, now - index, 60_000, '["opus"]', 20, 40, 2, 5, 0.33, 0, now, chained && index < 2 ? 9 : null);
    const id = Number(inserted.lastInsertRowid);
    db.prepare(`INSERT INTO messages(session_id,ordinal,role,text,tool_text,ts,has_tool) VALUES (?,?,?,?,?,?,?)`).run(id, 0, "user", `question ${index}`, null, Date.now(), 0);
    db.prepare(`INSERT INTO messages(session_id,ordinal,role,text,tool_text,ts,has_tool) VALUES (?,?,?,?,?,?,?)`).run(id, 1, "assistant", `answer ${index}`, null, Date.now(), 0);
    const generation = `fixture-generation-${index}`;
    db.prepare(`UPDATE sessions SET construction_generation=?,construction_status='valid',construction_invalid_reason=NULL,
      artifact_kind='dialogue_history',history_completeness='complete',default_session_visible=1,
      source_validation_status='current',original_project_key='fixture-project',canonical_project_key='fixture-project',
      project_key_rule_version='fixture-project-v1',origin='human' WHERE id=?`).run(generation,id);
    db.prepare(`INSERT INTO construction_metrics(session_id,construction_generation,raw_provenance_row_count,
      logical_record_count,raw_tool_activity_count,logical_tool_activity_count,raw_prose_bearing_record_count,
      logical_prose_bearing_record_count,dialogue_turn_count,user_dialogue_turn_count,assistant_dialogue_turn_count,
      logical_replay_count,unknown_identity_raw_row_count,computed_at) VALUES (?,?,2,2,0,0,2,2,2,1,1,0,0,?)`).run(id,generation,now);
  }
  return { root, db, config: cfg };
}

function canonicalTranscriptReader(): TuiTranscriptReader {
  return { transcript(sessionKey) {
    const index = Number(sessionKey.nativeId.match(/(\d+)$/)?.[1] ?? 0);
    const generation = `fixture-reader-${sessionKey.nativeId}`;
    const dialogue = [
      { logicalRecordId:1,logicalOrdinal:0,rawRepresentativeOrdinal:0,side:"user" as const,recordKind:"real_user" as const,prose:`question ${index}`,eventTs:null,replayCount:0,toolActivities:[],constructionGeneration:generation },
      { logicalRecordId:2,logicalOrdinal:1,rawRepresentativeOrdinal:1,side:"assistant" as const,recordKind:"assistant_dialogue_prose" as const,prose:`answer ${index}`,eventTs:null,replayCount:0,toolActivities:[],constructionGeneration:generation },
    ];
    return { session:{sessionKey,surrogateId:7000+index,effectiveTitle:`${index} mounted topic`,titleEvidence:null,
      originalProjectKey:"fixture-project",canonicalProjectKey:"fixture-project",cwd:null,lastActivityTs:null,
      dialogueStartTs:null,dialogueEndTs:null,artifactKind:"dialogue_history",historyCompleteness:"complete",
      sourceValidationStatus:"current",defaultSessionVisible:true,constructionGeneration:generation,
      metrics:{rawProvenanceRowCount:2,logicalRecordCount:2,rawToolActivityCount:0,logicalToolActivityCount:0,
        rawProseBearingRecordCount:2,logicalProseBearingRecordCount:2,dialogueTurnCount:2,userDialogueTurnCount:1,
        assistantDialogueTurnCount:1,logicalReplayCount:0,unknownIdentityRawRowCount:0},models:["fixture-model"],favorite:false,chainStableKey:null},
      dialogue,activity:dialogue.map(({rawRepresentativeOrdinal:_,side:__,...row})=>row),diagnostic:null };
  }};
}

function mounted(db: DB, cfg: Config, width = 100, height = 12, libraryBridge?: InkLibraryBridge) {
  // Other command-registry unit files deliberately replace the process-global
  // registry. A mounted production shell needs its own canonical lattice.
  _resetRegistry();
  _allowReinit();
  registerCommands();
  const input = new FakeStdin();
  const bytes: string[] = [];
  const copied: string[] = [];
  const terminal = new TerminalResourceManager({ stdin: input, stdout: { write: (value) => { bytes.push(value); } } });
  terminal.acquire();
  const runtime = new TuiRuntime(db, cfg);
  const rendered = render(<App db={db} config={cfg} runtime={runtime} terminal={terminal} terminalStdin={input}
    copyText={(value) => { copied.push(value); return { ok: true, method: "test" }; }} fixedWidth={width} fixedHeight={height}
    transcriptReader={canonicalTranscriptReader()} libraryBridge={libraryBridge} readOnly={!!libraryBridge} />);
  // The flat dashboard colors per cell, so escapes interleave a line's text.
  // Assertions read what the terminal shows, not how it is painted.
  const view = { ...rendered, rendered, lastFrame: () => rendered.lastFrame()?.replace(/\x1b\[[0-9;]*m/g, "") };
  return { input, bytes, copied, terminal, runtime, view };
}

test("filter refetch keeps the settled rows visible until the new page arrives", () => {
  const row: SessionRow = {
    id: 1, harness: "claude", native_id: "native-1", title: "settled row", firstUser: null,
    cwd: "/fixture", project: "/fixture", last_activity: 1, duration_ms: null,
    tok_user: 1, tok_assistant: 1, tok_tool: 0, tok_total: 2, msg_count: 2,
    models: null, chain_id: null, favorite: 0, sizePct: 0.5, engagement: null,
  };
  let current = appendRows(initialState(10), [row], true);
  current = { ...beginSearch(current), searchInput: "new query" };
  const next = commitSearch(current);
  expect(next.list.rows).toHaveLength(0);
  const retained = preserveRowsForRefetch(current, next);
  expect(retained.filter.query).toBe("new query");
  expect(retained.list.rows).toEqual([row]);
});

test("mounted App gives keys, palette, and renderer zones one command lattice with modal interception", async () => {
  const { db, config: cfg } = fixture();
  const app = mounted(db, cfg);
  try {
    await appReady(app, "0 mounted");
    expect(lines(app.view.lastFrame())).toBeLessThanOrEqual(12);

    app.input.send("?"); await frameContains(app, "ATLAS HELP");
    // Row click coordinates at 100 columns: center begins x=23, the first
    // session sits below the creator:human filter row at y=4 (zero-based).
    // The modal backdrop must absorb it.
    app.input.send("\x1b[<0;30;5M"); await tick();
    expect(app.view.lastFrame()).toContain("ATLAS HELP");
    app.input.send("\x1b"); await frameContains(app, "0 mounted");

    app.input.send(":"); await frameContains(app, ":▏");
    app.input.send("grounded chat"); await frameContains(app, ":grounded chat");
    app.input.send("\r"); await frameContains(app, "GROUNDED CHAT");
    expect(app.view.lastFrame()).toContain("0 mounted topic");
    expect(lines(app.view.lastFrame())).toBeLessThanOrEqual(12);
    app.input.send("q"); await frameContains(app, "0 mounted");
    expect(app.view.lastFrame()).toContain("SESSIONS");

    app.input.send("\x1b[<65;30;5M"); // wheel down through root bubble
    await frameMatches(app, />\s+3 mounted/);
    app.input.send("\x1bx"); await tick(); // Alt-x is not plain selection
    expect(app.view.lastFrame()).not.toContain("1 selected");
    app.input.send("\r"); await frameMatches(app, /< back .*3 mounted topic/);
    app.input.send("q"); await frameContains(app, "SESSIONS");

    app.input.send("\x1b[<0;30;5M"); await frameMatches(app, /< back .*0 mounted topic/);
    app.input.send("\x1b"); await frameContains(app, "SESSIONS");
    app.input.send("q"); await tick();
  } finally {
    await cleanup(app, db);
  }
  const lifecycle = app.bytes.join("");
  expect(lifecycle).toContain("\x1b[?1049h");
  expect(lifecycle).toContain("\x1b[?1003h");
  expect(lifecycle).toContain("\x1b[?1003l");
  expect(lifecycle).toContain("\x1b[?1049l");
});

test("mounted App keeps chain focus finite and treats pasted punctuation as a safe literal", async () => {
  const { db, config: cfg } = fixture(16, true);
  const app = mounted(db, cfg, 80, 12);
  try {
    await appReady(app, "0 mounted");
    app.input.send("\x1b[Cjj\r"); await frameContains(app, "< back");
    expect(lines(app.view.lastFrame())).toBeLessThanOrEqual(12);
    app.input.send("q"); await frameContains(app, "0 mounted");
    app.input.send("/"); await frameContains(app, "> /");
    app.input.send("\x1b[200~\"unterminated\x1b[201~"); await frameContains(app, "\"unterminated");
    app.input.send("\r"); await tick(150);
    expect(app.view.lastFrame()).not.toContain("invalid search");
    expect(lines(app.view.lastFrame())).toBeLessThanOrEqual(12);
  } finally {
    await cleanup(app, db);
  }
});

test("mounted row click opens the clicked stable session, not prior focus", async () => {
  const { db, config: cfg } = fixture();
  const app = mounted(db, cfg);
  try {
    await appReady(app, "0 mounted");
    // Rows have no hidden click targets: any unlinked cell opens the row.
    // At 100 columns the second row is y=6 in one-based SGR coordinates
    // (below the creator:human filter row). Keyboard focus was native-0.
    app.input.send("\x1b[<0;26;6M");
    await frameMatches(app, /< back .*1 mounted topic/);
    app.input.send("f");
    await waitUntil(() => favoriteCount(db, "native-1") === 1, "opened row favorite");
    expect(favoriteCount(db, "native-0")).toBe(0);
    expect(favoriteCount(db, "native-1")).toBe(1);
  } finally {
    await cleanup(app, db);
  }
});

test("mounted list search affordance is clickable and edits the active query", async () => {
  const { db, config: cfg } = fixture();
  const app = mounted(db, cfg);
  try {
    await appReady(app, "0 mounted");
    const frame = (app.view.lastFrame() ?? "").split("\n");
    const y = frame.findIndex((line) => line.includes("/ edit"));
    app.input.send(`\x1b[<0;${frame[y]!.indexOf("/ edit") + 1};${y + 1}M`);
    await frameContains(app, "> /");
    app.input.send("mounted\r");
    await frameContains(app, "q:\"mounted\"");
    app.input.send("\x06"); // Ctrl-F edits the active query.
    await frameContains(app, "> /mounted");
  } finally {
    await cleanup(app, db);
  }
});

test("mounted list header columns resize through SGR drag motion", async () => {
  const { db, config: cfg } = fixture();
  const app = mounted(db, cfg);
  try {
    await appReady(app, "0 mounted");
    const frame = (app.view.lastFrame() ?? "").split("\n");
    const row = frame.findIndex((line) => line.includes("TOPIC") && line.includes("PATH"));
    const beforePath = frame[row]!.indexOf("PATH");
    // The topic/path separator is the gap cell left of PATH on the column
    // header row; SGR mouse coordinates are one-based.
    const separator = beforePath - 1;
    app.input.send(`\x1b[<0;${separator + 1};${row + 1}M`);
    app.input.send(`\x1b[<32;${separator + 6};${row + 1}M`);
    app.input.send(`\x1b[<0;${separator + 6};${row + 1}m`);
    await waitUntil(() => {
      const header = (app.view.lastFrame() ?? "").split("\n").find((line) => line.includes("TOPIC") && line.includes("PATH"));
      return Boolean(header && header.indexOf("PATH") > beforePath);
    }, "resized table header");
  } finally {
    await cleanup(app, db);
  }
});

test("mounted session yanks its visibly focused first message immediately", async () => {
  const { db, config: cfg } = fixture();
  const app = mounted(db, cfg);
  try {
    await appReady(app, "0 mounted");
    app.input.send("\r"); await frameMatches(app, /< back .*0 mounted topic/);
    expect(app.view.lastFrame()).toContain(" no wrap ");
    const activeTab = () => app.view.rendered.lastFrame()?.match(/\x1b\[48;5;214m\x1b\[38;5;232m ([a-z ]+?) \x1b/)?.[1];
    expect(activeTab()).toBe("dialogue");
    app.input.send("m"); await waitUntil(() => activeTab() === "activity", "activity tab");
    app.input.send("m"); await waitUntil(() => activeTab() === "full output", "full output tab");
    app.input.send("w"); await frameMatches(app, /\s wrap \s/);
    expect(app.view.lastFrame()).not.toContain(" no wrap ");
    app.input.send("m"); await waitUntil(() => activeTab() === "dialogue", "dialogue tab");
    app.input.send("y");
    await waitUntil(() => app.copied.length === 1, "visible message yank");
    expect(app.copied).toEqual(["question 0"]);
    await frameContains(app, "yanked logical record");
  } finally {
    await cleanup(app, db);
  }
});

test("mounted session steps episodes with [ and ] and draws their dividers", async () => {
  const { db, config: cfg } = fixture(1);
  const episode = db.prepare(`INSERT INTO layers.session_episodes(harness,native_id,episode,start_ordinal,end_ordinal,start_ts,end_ts,human_turns,boundary,keywords,label)
    VALUES ('claude','native-0',?,?,?,NULL,NULL,1,'gap',?,?)`);
  episode.run(0, 0, 0, '["opening"]', "Opening question");
  episode.run(1, 1, 1, '["answer","parity"]', null);
  db.prepare(`INSERT INTO layers.episode_tags(harness,native_id,episode,tag,source,model,created_at) VALUES ('claude','native-0',0,'facet:design','model','glm',0)`).run();
  const app = mounted(db, cfg, 100, 16);
  try {
    await appReady(app, "0 mounted");
    app.input.send("\r"); await frameMatches(app, /< back .*0 mounted topic/);
    await frameContains(app, "-- 1 . Opening question --");
    await frameContains(app, "-- 2 . answer . parity --");
    app.input.send("]"); await frameContains(app, "episode 2/2 . answer . parity");
    app.input.send("]"); await frameContains(app, "last episode");
    app.input.send("["); await frameContains(app, "episode 1/2 . Opening question");
    app.input.send("s"); await frameContains(app, "2 episodes");
    expect(app.view.lastFrame()).toMatch(/>1 Opening question/);
    expect(app.view.lastFrame()).toMatch(/ dsgn  +\n/);
  } finally {
    await cleanup(app, db);
  }
});

test("mounted export previews two launchers, Esc writes nothing, and confirm writes once", async () => {
  const value = fixture();
  value.config.launchers = [{ name: "Claude", cmd: "claude --resume {payload}" }, { name: "Codex", cmd: "codex exec {payload}" }];
  const app = mounted(value.db, value.config, 100, 24);
  try {
    await appReady(app, "0 mounted");
    app.input.send("e"); await frameContains(app, "NO FILE WRITTEN");
    expect(app.view.lastFrame()).toContain("Claude");
    expect(app.view.lastFrame()).toContain("Codex");
    expect(app.view.lastFrame()).toContain("predicted");
    expect(app.view.lastFrame()).toContain("PAYLOAD · first lines");
    expect(existsSync(join(value.root, "exports"))).toBe(false);
    app.input.send("\x1b"); await frameContains(app, "export cancelled - no file written");
    expect(existsSync(join(value.root, "exports"))).toBe(false);

    app.input.send("e"); await frameContains(app, "NO FILE WRITTEN");
    app.input.send("\x1b[B"); await tick();
    app.input.send("\r"); await waitUntil(() => existsSync(join(value.root, "exports")), "export directory");
    const output = join(value.root, "exports");
    await waitUntil(() => readdirSync(output).some((name) => name.endsWith(".md")), "export file");
    expect(readdirSync(output).filter((name) => name.endsWith(".md"))).toHaveLength(1);
    await frameContains(app, "export →");
  } finally {
    await cleanup(app, value.db);
  }
});

test("empty configured DB auto-indexes provider-free and publishes rows live", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-first-app-")); roots.push(root);
  const source = join(root, "claude");
  const project = join(source, "-tmp-project");
  mkdirSync(project, { recursive: true });
  const record = (type: string, role: string, text: string, i: number) => JSON.stringify({ type, message: { role, content: role === "assistant" ? [{ type: "text", text }] : text, ...(role === "assistant" ? { model: "opus" } : {}) }, timestamp: new Date(1_700_000_000_000 + i).toISOString(), cwd: "/tmp/project", sessionId: "first-run-session" });
  writeFileSync(join(project, "first-run-session.jsonl"), `${record("user", "user", "first run question", 0)}\n${record("assistant", "assistant", "first run answer", 1)}\n`);
  const cfg = config(root, { sources: { claude: { roots: [source] } } });
  const db = new Database(cfg.dbPath); runMigrations(db); attachLayers(db, cfg.dbPath);
  const app = mounted(db, cfg, 100, 12);
  try {
    await frameContains(app, "initial ingest complete");
    expect(app.view.lastFrame()).toContain("first run");
    expect(cfg.providers).toHaveLength(0);
  } finally {
    await cleanup(app, db);
  }
});

test("configured Coding Plan credentials stay provider-down and create no session-open job", async () => {
  const value = fixture();
  process.env.ATLAS_CODING_KEY = "present";
  value.config.providers = [{ name: "zai-coding", base: "https://api.z.ai/api/anthropic", kind: "anthropic", model: "glm", key_env: "ATLAS_CODING_KEY" }];
  const app = mounted(value.db, value.config, 100, 12);
  try {
    await appReady(app, "summary off");
    app.input.send("\r"); await frameContains(app, "< back");
    app.input.send("s"); await frameContains(app, "SUMMARY  unavailable");
    expect((value.db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n).toBe(0);
  } finally {
    await cleanup(app, value.db);
  }
});

function lines(frame: string | undefined): number { return (frame ?? "").split("\n").length; }
function favoriteCount(db: DB, nativeId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM favorites WHERE harness='claude' AND native_id=? AND status='ok'`).get(nativeId) as { n: number }).n;
}
function tick(ms = 45): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function cleanup(app: ReturnType<typeof mounted>, db: DB): Promise<void> {
  app.view.unmount();
  await app.runtime.close();
  app.terminal.teardown();
  db.close();
}
async function frameContains(app: ReturnType<typeof mounted>, needle: string): Promise<void> {
  await waitUntil(() => (app.view.lastFrame() ?? "").includes(needle), `frame containing ${JSON.stringify(needle)}`);
}
async function appReady(app: ReturnType<typeof mounted>, needle: string): Promise<void> {
  await frameContains(app, needle);
  await waitUntil(() => app.input.listenerCount("data") === 1, "terminal event pump subscription");
}
async function frameMatches(app: ReturnType<typeof mounted>, pattern: RegExp): Promise<void> {
  await waitUntil(() => pattern.test(app.view.lastFrame() ?? ""), `frame matching ${pattern}`);
}
// Bun schedules files concurrently; retain exact assertions while allowing a
// renderer timer to run under full-suite CPU contention.
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("Ink reader buttons use live favorites, conflict-safe undo, cached summaries and complete copy", async () => {
  const { root, db, config: cfg } = fixture(1);
  const path = join(root, "library.db");
  const store = new LibraryStore(path);
  const key = { harness: "claude", nativeId: "native-0" };
  const observation = { id: "obs", sourceId: "fixture", locator: "fixture", objectHash: "hash",
    retainedBoundary: { observationId: "obs", bytes: 5, at: 1 }, indexedBoundary: { observationId: "obs", bytes: 5, at: 1 },
    summaryCoverage: null, lastCompleteReconciliation: 1, format: "fixture", gaps: [] };
  store.publish({ session: { key, revision: "r1", title: "topic", origin: "human_started", originReason: "fixture",
    models: [], cwd: null, updatedAt: 1, summary: { revision: "r1", overview: "A useful cached overview", claims: [], episodes: [],
      coverage: { revision: "r1", covered: [], omitted: ["fixture"] }, model: "cached-model", createdAt: 1, provenance: "legacy-coverage-unverified" } },
    observation, passages: [makePassage({ sessionKey: key, observationId: "obs", record: "one", channel: "prose", role: "user", ordinal: 0, timestamp: null, text: "exact saved bytes" })] });
  store.close();
  const bridge = InkLibraryBridge.open({ libraryPath: path, legacyPath: cfg.dbPath });
  const app = mounted(db, cfg, 120, 32, bridge);
  try {
    await appReady(app, "0 mounted");
    app.input.send("\r"); await frameContains(app, "< back");
    // At 120 columns the about pane starts closed; its footer chip opens it.
    function clickLabel(label: string, row?: number) {
      const frame = (app.view.lastFrame() ?? "").split("\n");
      const y = row ?? frame.findLastIndex((line) => line.includes(label));
      const x = frame[y]!.indexOf(label);
      expect(x).toBeGreaterThanOrEqual(0);
      app.input.send(`\x1b[<0;${x + 2};${y + 1}M`);
    }
    const footer = () => (app.view.lastFrame() ?? "").split("\n").length - 2;
    clickLabel(" about ", footer()); await frameContains(app, "useful cached");
    expect(app.view.lastFrame()).toContain(" no wrap ");
    clickLabel(" copy all ", footer()); await tick();
    expect(app.copied.at(-1)).toContain("question 0");
    expect(app.copied.at(-1)).toContain("answer 0");
    clickLabel(" no wrap ", footer()); await frameMatches(app, /\s wrap \s/);
    clickLabel(" undo ", footer()); await frameContains(app, " no wrap ");
    app.input.send("f"); await frameContains(app, "conversation(s) updated");
    expect(bridge.store!.favorites()[0]?.text).toContain("exact saved bytes");
    clickLabel(" undo ", footer()); await frameContains(app, "Undone");
    expect(bridge.store!.favorites()).toHaveLength(0);
    clickLabel(" < back ", 0); await frameContains(app, "SESSIONS");
    expect(db.query("SELECT count(*) AS n FROM favorites").get()).toEqual({ n: 0 });
    clickLabel("status", footer() + 1); await frameContains(app, "SUMMARY PROCESSING");
    expect(app.view.lastFrame()).toContain("unconfigured");
    app.input.send("\x1b"); await frameContains(app, "0 mounted");
  } finally { await cleanup(app, db); bridge.close(); }
});
