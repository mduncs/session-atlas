import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import type { Config } from "../src/config.js";
import { openReadOnlyDb, runMigrations } from "../src/db/index.js";
import { App, TuiRuntime, type TuiUiVariant } from "../src/tui/app.js";
import { _resetRegistry } from "../src/tui/commands.js";
import { _allowReinit } from "../src/tui/commands-defs.js";
import { TerminalResourceManager, type TerminalStdin } from "../src/tui/terminal.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

class Input extends EventEmitter implements TerminalStdin {
  isTTY = true;
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  send(value: string): void { this.emit("data", value); }
}

function fixture(chained = false) {
  const root = mkdtempSync(join(tmpdir(), "atlas-test-app-")); roots.push(root);
  const path = join(root, "archive.db");
  const db = new Database(path); runMigrations(db);
  const now = Date.now();
  for (const [index, origin, title, harness] of [
    [0, "human", "User-led compiler work", "codex"],
    [1, "agent", "Delegated worker investigation", "claude"],
    [2, "unknown", "Unknown-origin planning", "codex"],
    [3, "human", "User-led terminal repair", "claude"],
  ] as const) {
    db.prepare(`INSERT INTO sessions(harness,native_id,source_path,title,origin,last_activity,ingested_at)
      VALUES (?,?,?,?,?,?,?)`).run(harness, `comparison-${index}`, "/synthetic/source", title, origin, now - index * 1000, now);
  }
  db.prepare("INSERT INTO summaries(session_id,tier,body,generated_at) VALUES (1,2,?,?)")
    .run("Existing cached overview for the compiler conversation.", now);
  if (chained) db.exec("UPDATE sessions SET chain_id=42");
  db.close();
  const config: Config = {
    sources: {}, providers: [], launchers: [], dbPath: path,
    tunables: { tag_promotion_count: 3, export_budget_tokens: 20_000, fav_default_span: 6, summary_stale_pct: 25, redact_entropy_threshold: 4.8 },
  };
  return { db: openReadOnlyDb(path), config };
}

function mount(variant: TuiUiVariant, chained = false) {
  _resetRegistry(); _allowReinit();
  const { db, config } = fixture(chained);
  const input = new Input();
  const terminal = new TerminalResourceManager({ stdin: input, stdout: { write: () => {} } });
  terminal.acquire();
  const runtime = new TuiRuntime(db, config);
  const view = render(<App db={db} config={config} runtime={runtime} terminal={terminal} terminalStdin={input}
    readOnly uiVariant={variant} fixedWidth={120} fixedHeight={24} />);
  return { db, view, input, runtime, terminal, close: async () => {
    view.unmount(); await runtime.close(); terminal.teardown("normal"); db.close();
  } };
}

async function until(view: ReturnType<typeof render>, text: string, present = true): Promise<void> {
  const deadline = Date.now() + 4000;
  do {
    if (Boolean(view.lastFrame()?.includes(text)) === present) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  expect(view.lastFrame()?.includes(text)).toBe(present);
}

test("atlas-test keeps user-led technical conversations, toggles agents, and preserves its preference when clearing filters", async () => {
  const app = mount("atlas-test");
  try {
    await until(app.view, "User-led compiler work");
    expect(app.view.lastFrame()).toContain("ATLAS TEST");
    expect(app.view.lastFrame()).toContain("Unknown-origin planning");
    expect(app.view.lastFrame()).not.toContain("Delegated worker investigation");
    await until(app.view, "3 matching conversations");
    app.input.send("g");
    await until(app.view, "counting matches");
    await until(app.view, "Delegated worker investigation");
    await until(app.view, "4 matching conversations");
    app.input.send("g");
    await until(app.view, "Delegated worker investigation", false);
    app.input.send("1");
    await until(app.view, "User-led compiler work", false);
    app.input.send("0");
    await until(app.view, "User-led compiler work");
    expect(app.view.lastFrame()).toContain("Agent conversations: hidden");
    expect(app.view.lastFrame()).not.toContain("Delegated worker investigation");
  } finally { await app.close(); }
});

test("atlas-test previews stored summaries and prevents saved-data writes", async () => {
  const app = mount("atlas-test");
  try {
    await until(app.view, "User-led compiler work");
    app.input.send(" ");
    await until(app.view, "Existing cached overview");
    expect(app.view.lastFrame()?.split("\n").length).toBeLessThanOrEqual(24);
    app.input.send("\x1b");
    await until(app.view, "Existing cached overview", false);
    app.input.send("f");
    await until(app.view, "Read-only comparison");
    expect(app.db.query("SELECT COUNT(*) AS n FROM favorites").get()).toEqual({ n: 0 });
    expect(app.db.query("SELECT COUNT(*) AS n FROM summaries").get()).toEqual({ n: 1 });
    expect(app.db.query("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  } finally { await app.close(); }
});

test("classic Atlas opens on the human creator lens with a visible show-everything toggle", async () => {
  const app = mount("classic");
  try {
    await until(app.view, "User-led compiler work");
    expect(app.view.lastFrame()).toContain("SESSIONS");
    expect(app.view.lastFrame()).toContain("creator:human");
    // Undecided sessions have their own "? unsure" lens; they never pad the human view.
    expect(app.view.lastFrame()).not.toContain("Unknown-origin planning");
    expect(app.view.lastFrame()).not.toContain("Delegated worker investigation");
    expect(app.view.lastFrame()).not.toContain("ATLAS TEST");
    app.input.send("g");
    await until(app.view, "Delegated worker investigation");
    expect(app.view.lastFrame()).toContain("Unknown-origin planning");
    expect(app.view.lastFrame()).not.toContain("creator:human");
  } finally { await app.close(); }
});

test("expanding a group never inflates the matching conversation count", async () => {
  const app = mount("atlas-test", true);
  try {
    await until(app.view, "3 matching conversations");
    expect(app.view.lastFrame()).toContain("1 display rows shown");
    app.input.send("\x1b[C");
    await until(app.view, "4 display rows shown");
    expect(app.view.lastFrame()).toContain("3 matching conversations");
  } finally { await app.close(); }
});

test("comparison has no analytics trap: a and i are inert and Escape stays home", async () => {
  const app = mount("atlas-test");
  try {
    await until(app.view, "User-led compiler work");
    app.input.send("a");
    app.input.send("i");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(app.view.lastFrame()).not.toContain("detail view");
    app.input.send("\x1b");
    await until(app.view, "User-led compiler work");
    expect(app.view.lastFrame()).toContain("Agent conversations: hidden");
  } finally { await app.close(); }
});
