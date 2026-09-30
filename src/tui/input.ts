/** Streaming terminal tokenizer for the protocol subset Atlas owns (SPEC I1). */

export const ESC_ALT_TIMEOUT_MS = 50;
export const PASTE_TIMEOUT_MS = 2000;

export type MouseButton = "left" | "middle" | "right" | "none" | "wheel-up" | "wheel-down";

export interface MouseInputEvent {
  type: "mouse";
  protocol: "sgr" | "x10";
  action: "press" | "release" | "move" | "scroll";
  /** Zero-based terminal-cell coordinates. */
  x: number;
  y: number;
  button: MouseButton;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

export type TerminalInputEvent =
  | { type: "text"; text: string }
  | { type: "key"; key: string; alt: boolean; ctrl?: boolean; shift?: boolean; meta?: boolean }
  | { type: "paste"; text: string; timedOut: boolean }
  | { type: "focus"; focused: boolean }
  | MouseInputEvent;

const PASTE_START = bytes("\x1b[200~");
const PASTE_END = bytes("\x1b[201~");

function bytes(value: string): number[] {
  return [...Buffer.from(value, "binary")];
}

function startsWith(haystack: readonly number[], needle: readonly number[]): boolean {
  if (haystack.length < needle.length) return false;
  return needle.every((byte, index) => haystack[index] === byte);
}

function isPrefix(candidate: readonly number[], complete: readonly number[]): boolean {
  return candidate.length <= complete.length && candidate.every((byte, index) => complete[index] === byte);
}

function findSequence(haystack: readonly number[], needle: readonly number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export class TerminalInputTokenizer {
  private buffer: number[] = [];
  private paste: number[] | null = null;
  private pasteSince = 0;
  private escSince: number | null = null;

  feed(chunk: Uint8Array | string, now = Date.now()): TerminalInputEvent[] {
    const incoming = typeof chunk === "string" ? [...Buffer.from(chunk, "utf8")] : [...chunk];
    const events = this.expire(now);
    this.buffer.push(...incoming);
    events.push(...this.drain(now));
    return events;
  }

  /** Flush time-based ambiguity without inventing an incomplete UTF-8 token. */
  flush(now = Date.now()): TerminalInputEvent[] {
    const events = this.expire(now);
    events.push(...this.drain(now));
    return events;
  }

  reset(): void {
    this.buffer = [];
    this.paste = null;
    this.pasteSince = 0;
    this.escSince = null;
  }

  private expire(now: number): TerminalInputEvent[] {
    const events: TerminalInputEvent[] = [];
    if (this.paste !== null && now - this.pasteSince >= PASTE_TIMEOUT_MS) {
      this.paste.push(...this.buffer);
      this.buffer = [];
      events.push({ type: "paste", text: decodeUtf8(this.paste), timedOut: true });
      this.paste = null;
      this.pasteSince = 0;
    }
    if (this.paste === null && this.buffer.length === 1 && this.buffer[0] === 0x1b
      && this.escSince !== null && now - this.escSince >= ESC_ALT_TIMEOUT_MS) {
      this.buffer.shift();
      this.escSince = null;
      events.push({ type: "key", key: "escape", alt: false });
    }
    return events;
  }

  private drain(now: number): TerminalInputEvent[] {
    const events: TerminalInputEvent[] = [];
    while (this.buffer.length > 0) {
      if (this.paste !== null) {
        const end = findSequence(this.buffer, PASTE_END);
        if (end < 0) {
          // Retain a possible split end marker; move only the proven prefix.
          let retain = Math.min(PASTE_END.length - 1, this.buffer.length);
          while (retain > 0 && !isPrefix(this.buffer.slice(this.buffer.length - retain), PASTE_END)) retain--;
          this.paste.push(...this.buffer.splice(0, this.buffer.length - retain));
          break;
        }
        this.paste.push(...this.buffer.splice(0, end));
        this.buffer.splice(0, PASTE_END.length);
        events.push({ type: "paste", text: decodeUtf8(this.paste), timedOut: false });
        this.paste = null;
        this.pasteSince = 0;
        continue;
      }

      if (startsWith(this.buffer, PASTE_START)) {
        this.buffer.splice(0, PASTE_START.length);
        this.paste = [];
        this.pasteSince = now;
        this.escSince = null;
        continue;
      }
      if (this.buffer[0] === 0x1b) {
        if (this.buffer.length === 1) {
          if (this.escSince === null) this.escSince = now;
          break;
        }
        this.escSince = null;
        const sequence = this.readEscapeSequence();
        if (sequence === null) break;
        events.push(...sequence);
        continue;
      }

      const control = readControlKey(this.buffer[0]!);
      if (control) {
        this.buffer.shift();
        events.push(control);
        continue;
      }

      const decoded = decodeOne(this.buffer);
      if (decoded === null) break;
      this.buffer.splice(0, decoded.length);
      events.push({ type: "text", text: decoded.text });
    }
    return events;
  }

  private readEscapeSequence(): TerminalInputEvent[] | null {
    // Legacy X10 is six bytes: ESC [ M Cb Cx Cy.
    if (this.buffer[1] === 0x5b && this.buffer[2] === 0x4d) {
      if (this.buffer.length < 6) return null;
      const raw = this.buffer.splice(0, 6);
      return [decodeMouse(raw[3]! - 32, raw[4]! - 33, raw[5]! - 33, "x10", false)];
    }

    // SGR: ESC [ < button ; x ; y M/m
    if (this.buffer[1] === 0x5b && this.buffer[2] === 0x3c) {
      const end = this.buffer.findIndex((byte, index) => index >= 3 && (byte === 0x4d || byte === 0x6d));
      if (end < 0) return null;
      const raw = this.buffer.splice(0, end + 1);
      const value = Buffer.from(raw).toString("ascii");
      const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(value);
      if (!match) return [{ type: "key", key: value, alt: false }];
      return [decodeMouse(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - 1, "sgr", match[4] === "m")];
    }

    if (this.buffer[1] === 0x5b) {
      // Any CSI final byte is 0x40..0x7e. This also covers arrows and focus.
      const end = this.buffer.findIndex((byte, index) => index >= 2 && byte >= 0x40 && byte <= 0x7e);
      if (end < 0) return null;
      const raw = this.buffer.splice(0, end + 1);
      const value = Buffer.from(raw).toString("ascii");
      if (value === "\x1b[I") return [{ type: "focus", focused: true }];
      if (value === "\x1b[O") return [{ type: "focus", focused: false }];
      const names: Record<string, string> = {
        "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left", "\x1b[Z": "shift-tab",
        "\x1b[H": "home", "\x1b[F": "end",
        "\x1b[1~": "home", "\x1b[4~": "end", "\x1b[7~": "home", "\x1b[8~": "end",
        "\x1b[5~": "pageup", "\x1b[6~": "pagedown",
      };
      const modified = decodeCsiKey(value);
      return [modified ?? { type: "key", key: names[value] ?? value, alt: false }];
    }

    // SS3 application-cursor mode, used by several macOS terminal profiles.
    if (this.buffer[1] === 0x4f) {
      if (this.buffer.length < 3) return null;
      const value = Buffer.from(this.buffer.splice(0, 3)).toString("ascii");
      const names: Record<string, string> = {
        "\x1bOA": "up", "\x1bOB": "down", "\x1bOC": "right", "\x1bOD": "left",
        "\x1bOH": "home", "\x1bOF": "end",
      };
      return [{ type: "key", key: names[value] ?? value, alt: false }];
    }

    // ESC + one UTF-8 code point within 50 ms is Alt-modified input.
    const decoded = decodeOne(this.buffer.slice(1));
    if (decoded === null) return null;
    this.buffer.splice(0, decoded.length + 1);
    return [{ type: "key", key: decoded.text, alt: true }];
  }
}

function readControlKey(byte: number): Extract<TerminalInputEvent, { type: "key" }> | null {
  if (byte === 0x09) return { type: "key", key: "tab", alt: false };
  if (byte === 0x0d || byte === 0x0a) return { type: "key", key: "enter", alt: false };
  if (byte === 0x7f || byte === 0x08) return { type: "key", key: "backspace", alt: false };
  if (byte >= 1 && byte <= 26) return { type: "key", key: String.fromCharCode(96 + byte), alt: false, ctrl: true };
  return null;
}

function decodeCsiKey(value: string): Extract<TerminalInputEvent, { type: "key" }> | null {
  if (value === "\x1b[Z") return { type: "key", key: "tab", alt: false, shift: true };
  const match = /^\x1b\[1;(\d+)([ABCD])$/.exec(value);
  if (!match) return null;
  const modifier = Number(match[1]) - 1;
  const names: Record<string, string> = { A: "up", B: "down", C: "right", D: "left" };
  return {
    type: "key",
    key: names[match[2]!]!,
    alt: (modifier & 2) !== 0,
    shift: (modifier & 1) !== 0,
    ctrl: (modifier & 4) !== 0,
  };
}

function decodeMouse(
  code: number,
  x: number,
  y: number,
  protocol: "sgr" | "x10",
  explicitRelease: boolean,
): MouseInputEvent {
  const base = code & 3;
  const wheel = (code & 64) !== 0;
  const motion = (code & 32) !== 0;
  const button: MouseButton = wheel
    ? (base === 0 ? "wheel-up" : "wheel-down")
    : (["left", "middle", "right", "none"] as const)[base]!;
  const action = wheel ? "scroll" : motion ? "move" : (explicitRelease || base === 3) ? "release" : "press";
  return {
    type: "mouse",
    protocol,
    action,
    x: Math.max(0, x),
    y: Math.max(0, y),
    button,
    shift: (code & 4) !== 0,
    alt: (code & 8) !== 0,
    ctrl: (code & 16) !== 0,
  };
}

function decodeOne(input: readonly number[]): { text: string; length: number } | null {
  const lead = input[0];
  if (lead === undefined) return null;
  if (lead < 0x80) return { text: String.fromCodePoint(lead), length: 1 };
  const length = lead >= 194 && lead <= 223 ? 2 : lead <= 239 ? 3 : lead <= 244 ? 4 : 1;
  if (length === 1) return { text: "�", length: 1 };
  if (input.length < length) return null;
  for (let i = 1; i < length; i++) {
    const byte = input[i]!;
    if (byte < 128 || byte > 191) return { text: "�", length: 1 };
  }
  let codePoint = lead & (0x7f >> length);
  for (let i = 1; i < length; i++) codePoint = (codePoint << 6) | (input[i]! & 0x3f);
  return { text: String.fromCodePoint(codePoint), length };
}

function decodeUtf8(input: readonly number[]): string {
  let text = "";
  let offset = 0;
  while (offset < input.length) {
    const decoded = decodeOne(input.slice(offset));
    if (decoded === null) {
      text += "�";
      break;
    }
    text += decoded.text;
    offset += decoded.length;
  }
  return text;
}
