/**
 * OSC 52 yank — one module for every copy action (SPEC I4). Terminals that
 * support OSC 52 get `ESC]52;c;<base64>BEL`; tmux/screen get DCS passthrough;
 * `pbcopy` is the local fallback on macOS. Every `y`/`Y`/copy-command routes
 * here.
 *
 * This is a side-effecting module (writes to stdout / spawns pbcopy). The
 * decision of WHAT to yank lives in the command registry; this just encodes.
 */

export interface Osc52Environment {
  tmux?: boolean;
  term?: string;
}

/** Pure protocol encoder, separated from stdout/pbcopy for exact tests. */
export function encodeOsc52(text: string, environment: Osc52Environment = {}): string {
  const b64 = Buffer.from(text, "utf-8").toString("base64");
  const osc = `\x1b]52;c;${b64}\x07`;
  if (environment.tmux) {
    // tmux passthrough identifies itself and doubles embedded ESC bytes.
    // TERM commonly starts with "screen" inside tmux; tmux wins so the OSC
    // is wrapped exactly once, never screen(tmux(OSC)).
    return `\x1bPtmux;${osc.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
  }
  if (environment.term?.startsWith("screen")) return `\x1bP${osc}\x1b\\`;
  return osc;
}

/**
 * Yank `text` to the terminal clipboard via OSC 52, with pbcopy fallback.
 * Returns the method used (for status-line feedback). Synchronous pbcopy
 * fallback keeps the TUI simple (no async yank queue needed for M4).
 */
export function yank(text: string): { ok: boolean; method: string } {
  const osc52 = encodeOsc52(text, { tmux: !!process.env.TMUX, term: process.env.TERM });

  // Try OSC 52 first (works on Ghostty, iTerm2, Kitty, Alacritty, Windows
  // Terminal). Many terminals silently ignore it if unsupported — so we also
  // try pbcopy on macOS as a belt-and-suspenders.
  try {
    process.stdout.write(osc52);
  } catch {
    /* fall through to pbcopy */
  }

  // macOS local fallback: pbcopy is reliable and immediate.
  if (process.platform === "darwin") {
    try {
      const { execSync } = require("node:child_process");
      execSync("pbcopy", { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 1000 });
      return { ok: true, method: "pbcopy" };
    } catch {
      /* pbcopy failed; OSC 52 was our best shot */
    }
  }

  return { ok: true, method: "osc52" };
}

/** Probe whether OSC 52 is likely supported (best-effort heuristic for the
 * status line; not authoritative). */
export function osc52LikelySupported(): boolean {
  const term = process.env.TERM_PROGRAM ?? process.env.TERM ?? "";
  return (
    /ghostty|iterm|wezterm|kitty|alacritty|windows terminal/i.test(term) ||
    !!process.env.TMUX ||
    process.platform === "darwin" // pbcopy fallback always works
  );
}
