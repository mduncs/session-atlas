import { createCliRenderer, TextRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { LibraryReader } from "../contracts";
import { LibraryController, type LibraryActions, type FrameRow } from "./controller";
export { LibraryController, type LibraryActions } from "./controller";

/** Only this renderer owns mouse/raw/alternate-screen modes. No legacy Ink startup. */
export function mountLibrary(renderer: CliRenderer, reader: LibraryReader, actions: LibraryActions = {}): { controller: LibraryController; destroy: () => void } {
  const controller = new LibraryController(reader, actions);
  let nodes: TextRenderable[] = [];
  let rows: FrameRow[] = [];
  let auxiliaryTop = 0;
  let focus = -1;
  let textMode = false;
  let disposed = false;
  const draw = () => {
    if (disposed) return;
    controller.resize(renderer.width, renderer.height);
    rows = controller.frame();
    const visible = rows.slice(auxiliaryTop, auxiliaryTop + Math.max(1, renderer.height - 2));
    const needed = visible.length + 2;
    while (nodes.length < needed) {
      const node = new TextRenderable(renderer, { id: `atlas-row-${nodes.length}`, position: "absolute", left: 2, height: 1, wrapMode: "none", selectable: false });
      nodes.push(node); renderer.root.add(node);
    }
    const footer = controller.editing
      ? (renderer.width < 52 ? "Enter apply · Esc cancel" : "Enter apply · Esc cancel · Ctrl-C quit")
      : `${textMode ? "Text selection ON · T returns · " : ""}${renderer.width < 52 ? "Tab/Enter · Esc back · Ctrl-C quit" : "Tab actions · Enter open · wheel scroll · Esc back · Ctrl-C quit"}`;
    nodes.forEach((node, index) => {
      node.top = index; node.width = Math.max(1, renderer.width - 4);
      const row = visible[index];
      node.content = row ? `${row.action ? "› " : ""}${row.text}` : index === visible.length ? controller.status : index === visible.length + 1 ? footer : "";
      node.fg = row?.kind === "title" ? "#f1f5f9" : row?.kind === "action" ? "#7dd3fc" : row?.kind === "muted" ? "#94a3b8" : "#e2e8f0";
      node.bg = focus === index + auxiliaryTop ? "#243448" : "#0f172a";
      node.onMouseDown = () => {
        if (row?.action) { auxiliaryTop = 0; focus = -1; row.action(); draw(); }
        else if (row?.line) { const p = controller.lines.indexOf(row.line) - controller.top; controller.select(p, 0); }
      };
      node.onMouse = event => {
        if (row?.line && (event.type === "down" || event.type === "drag")) {
          const p = controller.lines.indexOf(row.line) - controller.top;
          controller.select(p, Math.max(0, event.x - 2), event.type === "drag"); draw();
        }
      };
      node.onMouseScroll = event => {
        const delta = event.scroll?.direction === "up" ? -3 : 3;
        if (controller.screen === "reader") controller.scroll(delta);
        else auxiliaryTop = Math.max(0, Math.min(Math.max(0, rows.length - renderer.height + 2), auxiliaryTop + delta));
        draw();
      };
    });
    renderer.requestRender();
  };
  const keypress = (key: KeyEvent) => {
    // Some PTY/terminal combinations deliver ETX without the normalized
    // ctrl+c fields (notably after a large list render). Honor the raw byte so
    // quit and terminal restoration stay reliable under corpus-scale loads.
    if ((key.ctrl && key.name === "c") || key.sequence === "\x03") { destroy(); return; }
    if (controller.editing) {
      if (key.name === "escape") controller.editing = null;
      else if (key.name === "return") controller.submit();
      else if (key.name === "backspace") controller.input = Array.from(controller.input).slice(0, -1).join("");
      else if (!key.ctrl && !key.meta && key.sequence && !key.sequence.startsWith("\x1b")) controller.input += key.sequence;
    } else if (key.name === "t") { textMode = !textMode; renderer.useMouse = !textMode; }
    else if (key.name === "escape") { controller.screen = "library"; auxiliaryTop = 0; }
    else if (key.name === "tab") {
      const available = rows.flatMap((r, i) => r.action ? [i] : []);
      const at = available.indexOf(focus); focus = available[(at + (key.shift ? available.length - 1 : 1)) % available.length] ?? -1;
      if (focus >= auxiliaryTop + renderer.height - 2) auxiliaryTop = Math.max(0, focus - renderer.height + 3);
      if (focus < auxiliaryTop) auxiliaryTop = Math.max(0, focus);
    } else if (key.name === "return" && focus >= 0) { const row = rows[focus]; auxiliaryTop = 0; focus = -1; row?.action?.(); }
    else if (key.name === "/" && controller.screen === "library") controller.filter("search");
    else if (["down", "up", "pagedown", "pageup"].includes(key.name)) {
      const delta = (key.name === "up" || key.name === "pageup" ? -1 : 1) * (key.name.startsWith("page") ? controller.viewportHeight : 1);
      if (controller.screen === "reader") controller.scroll(delta);
      else auxiliaryTop = Math.max(0, Math.min(Math.max(0, rows.length - renderer.height + 2), auxiliaryTop + delta));
    } else if (key.name === "home") controller.top = 0;
    else if (key.name === "end") controller.top = Math.max(0, controller.lines.length - controller.viewportHeight);
    draw();
  };
  const paste = (event: { bytes: Uint8Array }) => { if (controller.editing) { controller.input += new TextDecoder().decode(event.bytes); draw(); } };
  const destroy = () => {
    if (disposed) return; disposed = true;
    clearInterval(progressTimer);
    renderer.keyInput.off("keypress", keypress); renderer.keyInput.off("paste", paste); renderer.off("resize", draw);
    renderer.destroy();
  };
  const progressTimer = setInterval(() => { if (controller.screen === "processing" || controller.screen === "sources") draw(); }, 500);
  progressTimer.unref();
  controller.onChange = draw;
  renderer.keyInput.on("keypress", keypress); renderer.keyInput.on("paste", paste); renderer.on("resize", draw);
  draw();
  return { controller, destroy };
}

export async function launchLibrary(reader: LibraryReader, actions: LibraryActions = {}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Library requires an interactive terminal. Use atlas library list/read for structured output.");
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: true, enableMouseMovement: true, consoleMode: "disabled", backgroundColor: "#0f172a", onDestroy: () => finish() });
  try {
    mountLibrary(renderer, reader, {
      clipboard: async text => {
        if (process.platform !== "darwin") throw new Error("Local clipboard unsupported here; use Export conversation.");
        const proc = Bun.spawn(["/usr/bin/pbcopy"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
        proc.stdin.write(text); proc.stdin.end();
        if (await proc.exited !== 0) throw new Error("Clipboard rejected copy; use Export conversation.");
      },
      exportConversation: async key => {
        const directory = join(homedir(), "Downloads", "Atlas exports"); await mkdir(directory, { recursive: true });
        const path = join(directory, `conversation-${crypto.randomUUID()}.txt`);
        const writer = Bun.file(path).writer();
        try { for (const chunk of reader.streamCopy(key)) writer.write(chunk); await writer.end(); }
        catch (error) { await writer.end(); throw error; }
        return path;
      },
      ...actions,
    });
    await done;
  } finally { renderer.destroy(); }
}
