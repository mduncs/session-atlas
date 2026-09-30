import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { LibraryController, mountLibrary } from "../src/library/terminal";
import { layoutPassages, offsetAt } from "../src/library/terminal/layout";
import { makePassage } from "../src/library/passages";
import type { LibraryReader, LibrarySession, Passage, ReadPage } from "../src/library/contracts";
const session: LibrarySession = { key: { harness: "codex", nativeId: "synthetic" }, revision: "r1", title: "Synthetic reader", origin: "unknown", originReason: "No origin evidence", models: [], cwd: null, updatedAt: 1, passageCount: 100000 };
const passage = (text: string, ordinal = 0) => makePassage({ sessionKey: session.key, observationId: "o1", record: `r${ordinal}`, channel: "text", role: "assistant", ordinal, timestamp: null, text });
function fixture(text = "    code\n\né 日本語 👩‍💻\tend\r\n") {
  let reads = 0;
  const coverage = { sources: [], observations: [], scope: {}, method: "literal" as const, partial: false, limitations: [] };
  const reader: LibraryReader = {
    list: () => ({ sessions: [session], nextCursor: null }), session: () => session,
    search: () => ({ version: 1, hits: [{ session, passage: passage(text), match: "literal", rationale: "exact" }], nextCursor: null, coverage, exhaustion: "literal" }),
    read: (_key, limit = 64, cursor) => { reads++; const start = Number(cursor ?? 0); const passages = Array.from({ length: Math.min(limit, 100000 - start) }, (_, i) => passage(start + i === 0 ? text : `turn ${start + i}`, start + i)); return { version: 1, session, passages, nextCursor: start + limit < 100000 ? String(start + limit) : null, coverage }; },
    context: () => ({ version: 1, session, passages: [passage(text)], nextCursor: null, coverage }),
    resolve: () => ({ status: "current", passage: passage(text) }),
    streamCopy: function* () { yield "assistant\n"; yield text; },
    sources: () => [], coverage: () => coverage, favorites: () => [], collections: () => [],
  };
  return { reader, reads: () => reads };
}
test("source layout preserves blank lines, indentation and grapheme coordinates", () => {
  const p = passage("    code\n\né 日本語 👩‍💻\tend\r\n");
  const lines = layoutPassages([p], 12);
  expect(lines.some(l => p.text.slice(l.start, l.end) === "    code")).toBe(true);
  expect(lines.filter(l => !l.header && l.start === l.end).length).toBeGreaterThan(0);
  const emojiLine = lines.find(l => p.text.slice(l.start, l.end).includes("👩‍💻"))!;
  const offset = offsetAt(p.text, emojiLine, 1);
  expect(offset === 0 || !/[\uDC00-\uDFFF]/.test(p.text[offset]!)).toBe(true);
});
test("100k turns and 1 MiB message use cached line viewport and bounded page reads", async () => {
  const huge = "    preserve code 👩‍💻\n\n".repeat(42000);
  const { reader, reads } = fixture(huge);
  let copied = "";
  const controller = new LibraryController(reader, { clipboard: async text => { copied = text; } });
  controller.open(session);
  const cached = controller.lines;
  for (let i = 0; i < 1000; i++) { controller.scroll(1); controller.resize(80, 24); expect(controller.frame().length).toBeLessThanOrEqual(24); }
  expect(controller.lines).toBe(cached); expect(reads()).toBe(1); expect(controller.page!.passages.length).toBe(64);
  const anchor = controller.lines[controller.top]!;
  controller.resize(54, 24);
  expect(controller.lines[controller.top]!.passage).toBe(anchor.passage);
  expect(controller.lines[controller.top]!.start).toBeLessThanOrEqual(anchor.start);
  await controller.copy("conversation"); expect(copied).toBe("assistant\n" + huge);
}, 30000);
test("shipping OpenTUI mount handles native mouse open, wheel, exact copy, back and teardown", async () => {
  const { reader } = fixture("    exact code\n\n" + "long paragraph\n".repeat(200));
  const setup = await createTestRenderer({ width: 80, height: 24 });
  let copied = "";
  const mounted = mountLibrary(setup.renderer, reader, { clipboard: async t => { copied = t; } });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("Uncertain");
  await setup.mockMouse.click(8, 8); await setup.renderOnce();
  expect(mounted.controller.screen).toBe("reader");
  await setup.mockMouse.scroll(10, 12, "down"); await setup.renderOnce();
  expect(mounted.controller.top).toBeGreaterThan(0);
  await setup.mockMouse.click(5, 2); await setup.renderOnce();
  expect(copied).toStartWith("assistant\n    exact code\n\n");
  await setup.mockMouse.click(5, 1); await setup.renderOnce(); expect(mounted.controller.screen).toBe("library");
  mounted.destroy();
});
