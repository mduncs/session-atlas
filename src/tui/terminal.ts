import {
  ESC_ALT_TIMEOUT_MS,
  PASTE_TIMEOUT_MS,
  TerminalInputTokenizer,
  type TerminalInputEvent,
} from "./input.js";
import type { TerminalEventAdapter, TerminalEventDispatchSummary } from "./interaction.js";

export const ENTER_BASE_MODES = [
  "\x1b[?1049h", // alternate screen
  "\x1b[2J\x1b[H", // clear + home
  "\x1b[?25l", // hide cursor
  "\x1b[?1004h", // terminal focus events
  "\x1b[?2004h", // bracketed paste
  "\x1b[?1000h", // resting click + scroll mouse mode
  "\x1b[?1006h", // SGR mouse coordinates
].join("");

export const LEAVE_BASE_MODES = [
  "\x1b[?1000l",
  "\x1b[?1006l",
  "\x1b[?2004l",
  "\x1b[?1004l",
  "\x1b[?25h",
  "\x1b[?1049l",
].join("");

export const ENTER_FULL_MOUSE = "\x1b[?1002h\x1b[?1003h";
export const LEAVE_FULL_MOUSE = "\x1b[?1003l\x1b[?1002l";

export interface TerminalStdin {
  isTTY?: boolean;
  setRawMode?(raw: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  on?(event: "data", handler: (chunk: Uint8Array | string) => void): unknown;
  off?(event: "data", handler: (chunk: Uint8Array | string) => void): unknown;
}

export interface TerminalTimer {
  set(delayMs: number, callback: () => void): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMER: TerminalTimer = {
  set(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clear(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

export interface TerminalStdout {
  write(chunk: string): unknown;
}

export type TerminalSignal = "SIGTSTP" | "SIGCONT" | "SIGINT";

export interface TerminalSignalSource {
  on(signal: TerminalSignal, handler: () => void): unknown;
  off(signal: TerminalSignal, handler: () => void): unknown;
}

export type TeardownReason = "normal" | "error" | "interrupt";

export interface TerminalResourceOptions {
  stdin: TerminalStdin;
  stdout: TerminalStdout;
  signals?: TerminalSignalSource;
  repaint?: () => void;
  onSuspend?: () => void;
  onInterrupt?: () => void;
  onTeardown?: (reason: TeardownReason) => void;
  tokenizer?: TerminalInputTokenizer;
  /** Injectable because tests must never suspend the test runner. */
  processControl?: { suspendSelf(): void };
}

const DEFAULT_PROCESS_CONTROL = {
  suspendSelf(): void {
    // The process group, as a terminal Ctrl-Z would: a production re-exec
    // parent (or a `bun run` wrapper) must stop too, or the shell never
    // regains the terminal.
    process.kill(0, "SIGTSTP");
  },
};

/**
 * Single owner for every terminal mode. Acquire/release are deliberately
 * idempotent so normal exit, error boundaries, and Ctrl-C may all call cleanup.
 */
export class TerminalResourceManager {
  readonly tokenizer: TerminalInputTokenizer;
  private active = false;
  private suspended = false;
  private disposed = false;
  private wantsFullMouse = false;
  private fullMouseActive = false;
  private readonly hoverSurfaces = new Set<string>();
  private signalsBound = false;
  private readonly handlers: Record<TerminalSignal, () => void>;

  constructor(private readonly options: TerminalResourceOptions) {
    this.tokenizer = options.tokenizer ?? new TerminalInputTokenizer();
    this.handlers = {
      SIGTSTP: () => this.suspendFromSignal(),
      SIGCONT: () => this.resume(),
      SIGINT: () => {
        this.teardown("interrupt");
        this.options.onInterrupt?.();
      },
    };
  }

  get isActive(): boolean { return this.active; }
  get isSuspended(): boolean { return this.suspended; }
  get mouseTier(): "off" | "scroll" | "full" {
    if (!this.active) return "off";
    return this.fullMouseActive ? "full" : "scroll";
  }

  acquire(): void {
    if (this.disposed || this.active) return;
    this.suspended = false;
    this.acquireModes();
    this.bindSignals();
  }

  setHoverDependentSurface(active: boolean): void {
    this.setHoverSurface("legacy", active);
  }

  /** Reference-counted hover ownership for overlapping popovers/tooltips. */
  setHoverSurface(id: string, active: boolean): void {
    if (active) this.hoverSurfaces.add(id); else this.hoverSurfaces.delete(id);
    this.wantsFullMouse = this.hoverSurfaces.size > 0;
    if (!this.active || this.fullMouseActive === this.wantsFullMouse) return;
    this.options.stdout.write(this.wantsFullMouse ? ENTER_FULL_MOUSE : LEAVE_FULL_MOUSE);
    this.fullMouseActive = this.wantsFullMouse;
  }

  clearHoverSurfaces(): void {
    this.hoverSurfaces.clear();
    this.wantsFullMouse = false;
    if (this.active && this.fullMouseActive) {
      this.options.stdout.write(LEAVE_FULL_MOUSE);
      this.fullMouseActive = false;
    }
  }

  feed(chunk: Uint8Array | string, now = Date.now()): TerminalInputEvent[] {
    return this.tokenizer.feed(chunk, now);
  }

  feedAndDispatch(
    adapter: Pick<TerminalEventAdapter, "dispatch">,
    chunk: Uint8Array | string,
    now = Date.now(),
  ): TerminalEventDispatchSummary {
    return adapter.dispatch(this.feed(chunk, now));
  }

  flushInput(now = Date.now()): TerminalInputEvent[] {
    return this.tokenizer.flush(now);
  }

  suspend(): void {
    if (this.disposed || this.suspended) return;
    this.suspended = true;
    this.releaseModes();
    this.options.onSuspend?.();
  }

  private suspendFromSignal(): void {
    if (this.disposed || this.suspended) return;
    this.suspend();
    const signals = this.options.signals;
    // Node installs a JS handler for SIGTSTP; temporarily remove this handler
    // so the re-raised signal performs the OS default stop instead of recursing.
    signals?.off("SIGTSTP", this.handlers.SIGTSTP);
    try {
      (this.options.processControl ?? DEFAULT_PROCESS_CONTROL).suspendSelf();
    } finally {
      queueMicrotask(() => {
        if (!this.disposed) signals?.on("SIGTSTP", this.handlers.SIGTSTP);
      });
    }
  }

  resume(): void {
    if (this.disposed || !this.suspended) return;
    this.suspended = false;
    this.acquireModes();
    this.options.repaint?.();
  }

  requestRepaint(): void {
    if (this.active) this.options.repaint?.();
  }

  teardown(reason: TeardownReason = "normal"): void {
    if (this.disposed) return;
    this.releaseModes();
    this.unbindSignals();
    this.tokenizer.reset();
    this.disposed = true;
    this.suspended = false;
    this.options.onTeardown?.(reason);
  }

  private acquireModes(): void {
    if (this.active) return;
    if (this.options.stdin.isTTY !== false) this.options.stdin.setRawMode?.(true);
    this.options.stdin.resume?.();
    this.options.stdout.write(ENTER_BASE_MODES);
    this.active = true;
    this.fullMouseActive = false;
    if (this.wantsFullMouse) {
      this.options.stdout.write(ENTER_FULL_MOUSE);
      this.fullMouseActive = true;
    }
  }

  private releaseModes(): void {
    if (!this.active) return;
    if (this.fullMouseActive) this.options.stdout.write(LEAVE_FULL_MOUSE);
    this.options.stdout.write(LEAVE_BASE_MODES);
    if (this.options.stdin.isTTY !== false) this.options.stdin.setRawMode?.(false);
    this.options.stdin.pause?.();
    this.active = false;
    this.fullMouseActive = false;
  }

  private bindSignals(): void {
    if (!this.options.signals || this.signalsBound) return;
    for (const signal of Object.keys(this.handlers) as TerminalSignal[]) {
      this.options.signals.on(signal, this.handlers[signal]);
    }
    this.signalsBound = true;
  }

  private unbindSignals(): void {
    if (!this.options.signals || !this.signalsBound) return;
    for (const signal of Object.keys(this.handlers) as TerminalSignal[]) {
      this.options.signals.off(signal, this.handlers[signal]);
    }
    this.signalsBound = false;
  }
}

export interface TerminalEventPumpOptions {
  terminal: TerminalResourceManager;
  adapter: Pick<TerminalEventAdapter, "dispatch">;
  stdin: TerminalStdin;
  timer?: TerminalTimer;
  now?: () => number;
}

/**
 * The sole stdin subscriber for Atlas-owned input. It feeds raw chunks through
 * the tokenizer/adapter and schedules the otherwise silent Esc and paste
 * deadlines. When this pump is started, Ink `useInput` must be disabled.
 */
export class TerminalEventPump {
  private started = false;
  private escTimer: unknown = null;
  private pasteTimer: unknown = null;
  private readonly timer: TerminalTimer;
  private readonly now: () => number;
  private readonly onData = (chunk: Uint8Array | string) => { this.push(chunk); };

  constructor(private readonly options: TerminalEventPumpOptions) {
    this.timer = options.timer ?? DEFAULT_TIMER;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.started) return;
    if (!this.options.stdin.on || !this.options.stdin.off) throw new Error("terminal stdin does not support data subscription");
    this.options.stdin.on("data", this.onData);
    this.started = true;
  }

  stop(): void {
    if (this.started) {
      this.options.stdin.off?.("data", this.onData);
      this.started = false;
    }
    this.cancelTimers();
  }

  push(chunk: Uint8Array | string): TerminalEventDispatchSummary {
    const result = this.options.terminal.feedAndDispatch(this.options.adapter, chunk, this.now());
    this.scheduleDeadlines();
    return result;
  }

  flush(): TerminalEventDispatchSummary {
    return this.options.adapter.dispatch(this.options.terminal.flushInput(this.now()));
  }

  private scheduleDeadlines(): void {
    this.cancelTimers();
    this.escTimer = this.timer.set(ESC_ALT_TIMEOUT_MS, () => {
      this.escTimer = null;
      this.flush();
    });
    this.pasteTimer = this.timer.set(PASTE_TIMEOUT_MS, () => {
      this.pasteTimer = null;
      this.flush();
    });
  }

  private cancelTimers(): void {
    if (this.escTimer !== null) this.timer.clear(this.escTimer);
    if (this.pasteTimer !== null) this.timer.clear(this.pasteTimer);
    this.escTimer = null;
    this.pasteTimer = null;
  }
}
