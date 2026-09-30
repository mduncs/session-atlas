import { expect, test } from "bun:test";
import { InteractionRegistry } from "../src/tui/interaction.js";
import {
  ESC_ALT_TIMEOUT_MS,
  PASTE_TIMEOUT_MS,
  TerminalInputTokenizer,
} from "../src/tui/input.js";

test("tokenizer holds partial UTF-8, CSI, and bracketed-paste sequences", () => {
  const tokenizer = new TerminalInputTokenizer();
  const snowman = Buffer.from("☃", "utf8");
  expect(tokenizer.feed(snowman.subarray(0, 2), 0)).toEqual([]);
  expect(tokenizer.feed(snowman.subarray(2), 1)).toEqual([{ type: "text", text: "☃" }]);

  expect(tokenizer.feed("\x1b[<0;12", 2)).toEqual([]);
  expect(tokenizer.feed(";4M", 3)).toEqual([expect.objectContaining({
    type: "mouse", protocol: "sgr", action: "press", button: "left", x: 11, y: 3,
  })]);

  expect(tokenizer.feed("\x1b[200~hello\x1b[20", 4)).toEqual([]);
  expect(tokenizer.feed("1~", 5)).toEqual([{ type: "paste", text: "hello", timedOut: false }]);
});

test("Esc is disambiguated from Alt at 50 ms and paste expires at 2000 ms", () => {
  const tokenizer = new TerminalInputTokenizer();
  expect(tokenizer.feed("\x1b", 100)).toEqual([]);
  expect(tokenizer.flush(100 + ESC_ALT_TIMEOUT_MS - 1)).toEqual([]);
  expect(tokenizer.flush(100 + ESC_ALT_TIMEOUT_MS)).toEqual([{ type: "key", key: "escape", alt: false }]);

  expect(tokenizer.feed("\x1bx", 200)).toEqual([{ type: "key", key: "x", alt: true }]);
  expect(tokenizer.feed("\x1b[200~unfinished", 300)).toEqual([]);
  expect(tokenizer.flush(300 + PASTE_TIMEOUT_MS)).toEqual([
    { type: "paste", text: "unfinished", timedOut: true },
  ]);
});

test("SGR and legacy X10 mouse decode zero-based coordinates and modifiers", () => {
  const tokenizer = new TerminalInputTokenizer();
  const sgr = tokenizer.feed("\x1b[<52;9;6M", 0)[0]; // motion + ctrl + left
  expect(sgr).toMatchObject({
    type: "mouse", protocol: "sgr", action: "move", button: "left", x: 8, y: 5, ctrl: true,
  });
  expect(tokenizer.feed("\x1b[<0;9;6m", 1)[0]).toMatchObject({ action: "release", x: 8, y: 5 });

  const x10 = new Uint8Array([0x1b, 0x5b, 0x4d, 32, 33 + 8, 33 + 5]);
  expect(tokenizer.feed(x10, 2)[0]).toMatchObject({
    type: "mouse", protocol: "x10", action: "press", x: 8, y: 5,
  });
});

test("navigation CSI and SS3 sequences decode to obvious list keys", () => {
  const tokenizer = new TerminalInputTokenizer();
  expect(tokenizer.feed("\x1b[5~\x1b[6~\x1b[H\x1b[F\x1bOH\x1bOF", 0)).toEqual([
    { type: "key", key: "pageup", alt: false },
    { type: "key", key: "pagedown", alt: false },
    { type: "key", key: "home", alt: false },
    { type: "key", key: "end", alt: false },
    { type: "key", key: "home", alt: false },
    { type: "key", key: "end", alt: false },
  ]);
});

test("interaction dispatch picks topmost/deepest, focuses, bubbles, and stops", () => {
  const registry = new InteractionRegistry();
  const calls: string[] = [];
  registry.register({
    id: "root", rect: { x: 0, y: 0, width: 30, height: 10 }, focusable: true,
    onEvent: (event) => { calls.push(`root:${event.localX},${event.localY}`); },
  });
  registry.register({
    id: "child", parentId: "root", rect: { x: 5, y: 2, width: 10, height: 3 },
    onEvent: (event) => { calls.push(`child:${event.localX},${event.localY}`); event.stopPropagation(); return true; },
  });
  const result = registry.dispatchPointer({ type: "mouse", action: "press", x: 7, y: 3 });
  expect(result).toEqual({ targetId: "child", handledBy: "child", propagationStopped: true });
  expect(calls).toEqual(["child:2,1"]);
  expect(registry.focused).toBe("root");

  registry.register({ id: "overlay", rect: { x: 5, y: 2, width: 10, height: 3 }, zIndex: 10 });
  expect(registry.hitTest(7, 3)).toBe("overlay");
});

test("widget focus traverses and focused keys bubble through ancestors", () => {
  const registry = new InteractionRegistry();
  const calls: string[] = [];
  registry.register({ id: "form", rect: { x: 0, y: 0, width: 20, height: 5 }, onEvent: () => { calls.push("form"); } });
  registry.register({
    id: "search", parentId: "form", rect: { x: 0, y: 0, width: 10, height: 1 }, focusable: true,
    onEvent: () => { calls.push("search"); return true; },
  });
  registry.register({ id: "chat", parentId: "form", rect: { x: 0, y: 2, width: 10, height: 1 }, focusable: true });
  expect(registry.focusNext()).toBe("search");
  expect(registry.dispatchFocused({ type: "key", key: "a", shift: false, alt: false, ctrl: false }).handledBy).toBe("search");
  expect(calls).toEqual(["search", "form"]);
  expect(registry.focusNext()).toBe("chat");
  expect(registry.focusNext(true)).toBe("search");
});
