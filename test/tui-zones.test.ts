import { test, expect, beforeEach } from "bun:test";
import { ZoneRegistry, extractAtoms, type Zone } from "../src/tui/zones.ts";

let reg: ZoneRegistry;
beforeEach(() => {
  reg = new ZoneRegistry();
});

test("M4 I2 — hit-test returns the topmost (last-registered) zone on overlap", () => {
  const z1: Zone = { id: "path-1", rect: { x0: 0, y0: 0, x1: 20, y1: 0 }, command: "click-path", arg: "/a", kind: "path" };
  const z2: Zone = { id: "url-1", rect: { x0: 5, y0: 0, x1: 25, y1: 0 }, command: "click-path", arg: "http://x", kind: "url" };
  reg.register(z1);
  reg.register(z2); // drawn on top (later = topmost)
  // Point (10,0) is in both; topmost (z2) wins.
  expect(reg.hitTest(10, 0)?.id).toBe("url-1");
  // Point (2,0) is only in z1.
  expect(reg.hitTest(2, 0)?.id).toBe("path-1");
  // Point (30,0) is in neither.
  expect(reg.hitTest(30, 0)).toBeNull();
});

test("M4 I2 — bubbling stops on handled (hitTest returns single zone, not a chain)", () => {
  const z1: Zone = { id: "a", rect: { x0: 0, y0: 0, x1: 10, y1: 2 }, command: "c", kind: "path" };
  const z2: Zone = { id: "b", rect: { x0: 0, y0: 1, x1: 10, y1: 3 }, command: "c", kind: "path" };
  reg.register(z1);
  reg.register(z2);
  // (5,2) is in both — but hitTest resolves to ONE (topmost), not both.
  const hit = reg.hitTest(5, 2);
  expect(hit?.id).toBe("b");
  // allContaining shows both (for debugging), but dispatch uses hitTest only.
  expect(reg.allContaining(5, 2).length).toBe(2);
});

test("M4 I2 — zones outside the point are never hit", () => {
  reg.register({ id: "a", rect: { x0: 0, y0: 0, x1: 5, y1: 5 }, command: "c", kind: "path" });
  expect(reg.hitTest(6, 0)).toBeNull();
  expect(reg.hitTest(0, 6)).toBeNull();
  expect(reg.hitTest(3, 3)?.id).toBe("a");
});

test("M4 — extractAtoms finds paths and URLs in a transcript line", () => {
  const line = 'edited src/foo.ts and see https://example.com/x for details, also ~/code/bar';
  const atoms = extractAtoms(line);
  const texts = atoms.map((a) => a.text);
  expect(texts).toContain("src/foo.ts");
  expect(texts.some((t) => t.startsWith("https://"))).toBe(true);
  expect(texts.some((t) => t.startsWith("~/code/"))).toBe(true);
  // Atoms are position-sorted, non-overlapping.
  for (let i = 1; i < atoms.length; i++) {
    expect(atoms[i]!.startCol).toBeGreaterThanOrEqual(atoms[i - 1]!.startCol + atoms[i - 1]!.text.length);
  }
});

test("M4 — extractAtoms handles edge cases (no atoms, overlapping url+path)", () => {
  expect(extractAtoms("just plain text here")).toEqual([]);
  // A URL like https://x/a/b should be detected as a URL, not a path.
  const atoms = extractAtoms("see https://x.com/a/b now");
  expect(atoms.length).toBe(1);
  expect(atoms[0]!.kind).toBe("url");
});

test("M4 I4 — yank module encodes OSC 52 correctly (unit test, no terminal)", async () => {
  // Test the encoding shape without writing to a real terminal.
  const { yank } = await import("../src/tui/yank.ts");
  // Capture stdout writes. yank writes OSC 52 then tries pbcopy on macOS.
  const orig = process.stdout.write.bind(process.stdout);
  let captured = "";
  process.stdout.write = ((chunk: any) => { captured += String(chunk); return true; }) as any;
  const res = yank("hello");
  process.stdout.write = orig;
  expect(res.ok).toBe(true);
  // Either OSC 52 or pbcopy succeeded on macOS.
  if (res.method === "osc52") {
    expect(captured).toContain("52;c;");
    const b64 = Buffer.from("hello", "utf-8").toString("base64");
    expect(captured).toContain(b64);
  }
  // pbcopy method means the local clipboard was set; both are valid.
  expect(["osc52", "pbcopy"]).toContain(res.method);
});
