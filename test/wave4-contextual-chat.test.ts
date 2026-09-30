import { describe, expect, test } from "bun:test";
import { contextualChatLayout, offsetInteractionZones } from "../src/tui/chat-workspace.js";

describe("contextual grounded chat", () => {
  test("keeps archive and chat visible side by side on wide terminals", () => {
    const layout = contextualChatLayout(140, 32);
    expect(layout.direction).toBe("row");
    expect(layout.archive.width).toBeGreaterThanOrEqual(48);
    expect(layout.chat.width).toBeGreaterThanOrEqual(40);
    expect(layout.archive.width + layout.chat.width).toBe(140);
    expect(layout.chat.x).toBe(layout.archive.width);
  });

  test("keeps a compact archive context above chat on narrow terminals", () => {
    const layout = contextualChatLayout(80, 24);
    expect(layout.direction).toBe("column");
    expect(layout.archive.height).toBeGreaterThanOrEqual(8);
    expect(layout.chat.height).toBeGreaterThanOrEqual(10);
    expect(layout.archive.height + layout.chat.height).toBe(24);
  });

  test("offsets scoped child controls into the shared terminal coordinate plane", () => {
    const [zone] = offsetInteractionZones([{ id: "citation", rect: { x: 2, y: 4, width: 5, height: 1 } }], 84, 0, "chat");
    expect(zone?.id).toBe("chat:citation");
    expect(zone?.rect).toEqual({ x: 86, y: 4, width: 5, height: 1 });
  });
});
