import { test, expect } from "bun:test";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { ListView } from "../src/tui/app.js";
import { initialState, type TuiState } from "../src/tui/store.js";
import type { SessionRow } from "../src/tui/queries.js";

function row(id: number, harness = "claude"): SessionRow {
  return {
    id,
    harness,
    native_id: `s${id}`,
    title: `session topic ${id}`,
    firstUser: null,
    cwd: "/Users/tester/code/proj",
    project: "/Users/tester/code/proj",
    last_activity: Date.now() - id * 1000,
    duration_ms: null,
    tok_user: 100,
    tok_assistant: 200,
    tok_tool: 50,
    tok_total: 350,
    msg_count: 5,
    models: '["m"]',
    chain_id: id % 7 === 0 ? 1 : null,
    favorite: 0,
    sizePct: (id % 10) / 10,
    engagement: 0.33,
  };
}

function stateWith(rows: SessionRow[], opts: Partial<TuiState> = {}): TuiState {
  return {
    ...initialState(5),
    list: { ...initialState(5).list, rows, ...opts },
    ...opts,
  } as TuiState;
}

test("ListView renders rows, focus marker, harness colors, chain glyph", () => {
  const state = stateWith([row(1), row(2), row(3), row(7)]);
  const { lastFrame } = render(
    <ListView state={state} status={{ fresh: [], pending: 0 }} home="/Users/tester" />,
  );
  const frame = lastFrame()!;
  expect(frame).toContain("#1");
  expect(frame).toContain("session topic 1");
  expect(frame).toContain("claude");
  // Chain glyph on id 7 (chain_id set).
  expect(frame).toContain("⛓");
  // Focus marker on first row.
  expect(frame).toContain("▶");
});

test("ListView shows filter chip + message line", () => {
  const state = stateWith([row(1)], {
    filter: { harness: "codex", query: "git-hooks" },
    message: "filters cleared",
  });
  const { lastFrame } = render(
    <ListView state={state} status={{ fresh: [], pending: 0 }} home="/Users/tester" />,
  );
  const frame = lastFrame()!;
  expect(frame).toContain("codex");
  expect(frame).toContain('q:"git-hooks"');
  expect(frame).toContain("filters cleared");
});

test("ListView empty state when no rows", () => {
  const state = stateWith([]);
  const { lastFrame } = render(
    <ListView state={state} status={{ fresh: [], pending: 0 }} home="/Users/tester" />,
  );
  expect(lastFrame()!).toContain("(no sessions match)");
});

test("ListView renders harness legend hint in footer", () => {
  const state = stateWith([row(1)]);
  const { lastFrame } = render(
    <ListView state={state} status={{ fresh: [], pending: 0 }} home="/Users/tester" />,
  );
  const frame = lastFrame()!;
  expect(frame).toContain("j/k move");
  expect(frame).toContain("/ search");
  expect(frame).toContain("1/2/3 harness");
});
