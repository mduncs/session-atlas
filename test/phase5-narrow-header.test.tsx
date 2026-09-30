import { expect, test } from "bun:test";
import React from "react";
import { renderToString } from "ink";
import { projectListRows, type SessionRow } from "../src/tui/domain.js";
import { dashboardListHeaderLayout, DashboardListView } from "../src/tui/list-view.js";
import { displayWidth } from "../src/tui/transcript-layout.js";

const row: SessionRow = {
  id: 1, harness: "prime", native_id: "fixture-phase5-list", title: "Synthetic list fixture", firstUser: null,
  cwd: null, project: null, last_activity: null, duration_ms: null,
  tok_user: 0, tok_assistant: 0, tok_tool: 0, tok_total: 0, msg_count: 7,
  models: null, chain_id: null, favorite: 0, sizePct: 0, engagement: null,
};

test("TUI-03 narrow search context cannot overwrite the result count", () => {
  const header = dashboardListHeaderLayout(60, 18, 31, "q:atlas");
  expect(header.countText).toBe("SESSIONS 18/31");
  expect(header.contextText).toContain("q:atlas");
  expect(header.countWidth + header.gap + header.contextWidth).toBeLessThanOrEqual(header.interiorWidth);
  const value = renderToString(
    <DashboardListView width={60} height={8} projections={projectListRows([row], new Set())}
      totalCount={31} filterSummary="q:atlas" />,
    { columns: 60, rows: 8 },
  );
  const first = value.split("\n")[0]!;
  expect(first).toContain("SESSIONS 1/31");
  expect(first).toContain("q:atlas");
  expect(first).not.toContain("31q:");
  expect(displayWidth(first)).toBeLessThanOrEqual(60);
});
