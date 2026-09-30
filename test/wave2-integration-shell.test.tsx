import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import React from "react";
import { render } from "ink-testing-library";
import { App, ListView, TuiRuntime } from "../src/tui/app.js";
import { runMigrations } from "../src/db/index.js";
import { attachLayers } from "../src/layers/db.js";
import { initialState } from "../src/tui/store.js";
import { SessionSelection, sessionKey, type SessionRow } from "../src/tui/domain.js";
import type { Config } from "../src/config.js";

const config: Config = {
  sources: {}, providers: [], launchers: [], dbPath: ":memory:",
  tunables: { tag_promotion_count: 3, export_budget_tokens: 20_000, fav_default_span: 6, summary_stale_pct: 25, redact_entropy_threshold: 4.8 },
};

test("integrated shell renders the flat responsive dashboard over a temp DB", async () => {
  const db = fixture();
  const runtime = new TuiRuntime(db, config);
  const wide = render(<App db={db} config={config} runtime={runtime} fixedWidth={160} visibleRows={12} />);
  await tick();
  expect(wide.lastFrame()).toContain("ATLAS");
  expect(wide.lastFrame()).toContain("SRC");
  expect(wide.lastFrame()).toContain("MODEL");
  expect(wide.lastFrame()).toContain("integrated shell topic");
  wide.unmount();

  const narrow = render(<App db={db} config={config} runtime={runtime} fixedWidth={60} visibleRows={12} />);
  await tick();
  expect(narrow.lastFrame()).toContain("ATLAS");
  expect(narrow.lastFrame()).toContain("integrated shell topic");
  expect(narrow.lastFrame()).not.toContain("SIZE DIST · TOK");
  narrow.unmount();
  await runtime.close();
  db.close();
});

test("compatibility list renderer consults stable selection identities, never row indices", () => {
  const row = domainRow();
  const state = initialState(5);
  state.list.rows = [row];
  state.list.focusKey = sessionKey(row);
  state.list.selected = new SessionSelection([sessionKey(row)]);
  const selected = render(<ListView state={state} />).lastFrame()!;
  expect(selected).toContain("◆");
  state.list.selected = new SessionSelection();
  (state.list.selected as Set<unknown>).add(0);
  const numeric = render(<ListView state={state} />).lastFrame()!;
  expect(numeric).not.toContain("◆");
});

function fixture(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  runMigrations(db);
  attachLayers(db, null);
  db.prepare(`INSERT INTO sessions(harness,native_id,source_path,title,last_activity,duration_ms,models,tok_user,tok_assistant,tok_tool,msg_count,engagement,orphaned,ingested_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("claude", "integrated-1", "/fixture", "integrated shell topic", Date.now(), 60_000, '["opus"]', 20, 40, 2, 5, 0.33, 0, Date.now());
  db.exec(`UPDATE sessions SET origin='human'`);
  return db;
}

function domainRow(): SessionRow {
  return { id: 1, harness: "claude", native_id: "stable", title: "stable selection", firstUser: null, cwd: null, project: null, last_activity: 1, duration_ms: null, tok_user: 1, tok_assistant: 1, tok_tool: 0, tok_total: 2, msg_count: 2, models: null, chain_id: null, favorite: 0, sizePct: 0, engagement: 0.5 };
}

function tick(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 30)); }
