import { expect, test } from "bun:test";
import { dashboardSurfaceLayout } from "../src/tui/dashboard.js";
import { viewportGenerationKey } from "../src/tui/app.js";
import { viewportFrameMarker } from "../src/tui/viewport.js";
import { displayWidth } from "../src/tui/transcript-layout.js";

test("TUI-04 keys the complete render surface by exact viewport geometry", () => {
  const sequence = [[120, 24], [100, 24], [80, 24], [60, 24], [120, 24]] as const;
  const keys = sequence.map(([width, height]) => viewportGenerationKey(width, height));
  expect(keys).toEqual(["viewport:120x24", "viewport:100x24", "viewport:80x24", "viewport:60x24", "viewport:120x24"]);
  expect(keys.at(-1)).toBe(keys[0]);
  expect(viewportFrameMarker(0)).not.toBe(viewportFrameMarker(1));
  expect(displayWidth(viewportFrameMarker(0))).toBe(1);
  expect(displayWidth(viewportFrameMarker(1))).toBe(1);
});

test("120→100→80→60→120 recomputes from width without retaining resized cells", () => {
  const widths = [120, 100, 80, 60, 120];
  const layouts = widths.map((width) => dashboardSurfaceLayout(width, 24, true, false));
  expect(layouts.map((layout) => layout.width)).toEqual(widths);
  expect(layouts.at(-1)).toEqual(layouts[0]);
  for (const layout of layouts) {
    const gaps = (layout.leftWidth > 0 ? 1 : 0) + (layout.rightWidth > 0 ? 1 : 0);
    expect(layout.leftWidth + layout.centerWidth + layout.rightWidth + gaps).toBe(layout.width);
  }
});
