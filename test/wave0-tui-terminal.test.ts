import { expect, test } from "bun:test";
import {
  ENTER_BASE_MODES,
  ENTER_FULL_MOUSE,
  LEAVE_BASE_MODES,
  LEAVE_FULL_MOUSE,
  TerminalResourceManager,
  TerminalEventPump,
  type TerminalTimer,
  type TerminalSignal,
  type TerminalSignalSource,
} from "../src/tui/terminal.js";
import { InteractionRegistry, TerminalEventAdapter } from "../src/tui/interaction.js";

class FakeSignals implements TerminalSignalSource {
  handlers = new Map<TerminalSignal, Set<() => void>>();
  on(signal: TerminalSignal, handler: () => void): void {
    const handlers = this.handlers.get(signal) ?? new Set();
    handlers.add(handler);
    this.handlers.set(signal, handlers);
  }
  off(signal: TerminalSignal, handler: () => void): void {
    this.handlers.get(signal)?.delete(handler);
  }
  emit(signal: TerminalSignal): void {
    for (const handler of this.handlers.get(signal) ?? []) handler();
  }
}

function fixture() {
  const writes: string[] = [];
  const raw: boolean[] = [];
  const lifecycle: string[] = [];
  const signals = new FakeSignals();
  const manager = new TerminalResourceManager({
    stdin: {
      isTTY: true,
      setRawMode: (value) => { raw.push(value); },
      resume: () => { lifecycle.push("stdin:resume"); },
      pause: () => { lifecycle.push("stdin:pause"); },
    },
    stdout: { write: (value) => { writes.push(value); } },
    signals,
    repaint: () => { lifecycle.push("repaint"); },
    onSuspend: () => { lifecycle.push("suspend"); },
    processControl: { suspendSelf: () => { lifecycle.push("process:suspend"); } },
    onInterrupt: () => { lifecycle.push("interrupt"); },
    onTeardown: (reason) => { lifecycle.push(`teardown:${reason}`); },
  });
  return { manager, writes, raw, lifecycle, signals };
}

test("resource manager exposes the two-tier mouse knob and idempotent normal teardown", () => {
  const f = fixture();
  f.manager.acquire();
  f.manager.acquire();
  expect(f.manager.mouseTier).toBe("scroll");
  expect(f.writes).toEqual([ENTER_BASE_MODES]);
  expect(f.raw).toEqual([true]);

  f.manager.setHoverDependentSurface(true);
  expect(f.manager.mouseTier).toBe("full");
  f.manager.setHoverSurface("popover", true);
  f.manager.setHoverDependentSurface(false); // popover still owns full tier
  expect(f.manager.mouseTier).toBe("full");
  f.manager.setHoverSurface("popover", false);
  expect(f.writes.slice(-2)).toEqual([ENTER_FULL_MOUSE, LEAVE_FULL_MOUSE]);

  f.manager.teardown("normal");
  f.manager.teardown("error");
  expect(f.writes.at(-1)).toBe(LEAVE_BASE_MODES);
  expect(f.raw).toEqual([true, false]);
  expect(f.lifecycle.filter((entry) => entry.startsWith("teardown:"))).toEqual(["teardown:normal"]);
  expect([...f.signals.handlers.values()].every((handlers) => handlers.size === 0)).toBe(true);
});

test("SIGTSTP releases everything; SIGCONT restores tier and repaints", () => {
  const f = fixture();
  f.manager.setHoverDependentSurface(true);
  f.manager.acquire();
  f.signals.emit("SIGTSTP");
  expect(f.manager.isSuspended).toBe(true);
  expect(f.manager.mouseTier).toBe("off");
  expect(f.writes.slice(-2)).toEqual([LEAVE_FULL_MOUSE, LEAVE_BASE_MODES]);
  expect(f.raw.at(-1)).toBe(false);
  expect(f.lifecycle).toContain("process:suspend");

  f.signals.emit("SIGCONT");
  expect(f.manager.mouseTier).toBe("full");
  expect(f.writes.slice(-2)).toEqual([ENTER_BASE_MODES, ENTER_FULL_MOUSE]);
  expect(f.raw.at(-1)).toBe(true);
  expect(f.lifecycle).toContain("repaint");
  f.manager.teardown();
});

test("normal, error, and interrupt exit paths all restore terminal modes once", () => {
  for (const reason of ["normal", "error"] as const) {
    const f = fixture();
    f.manager.acquire();
    f.manager.teardown(reason);
    expect(f.writes.at(-1)).toBe(LEAVE_BASE_MODES);
    expect(f.raw).toEqual([true, false]);
    expect(f.lifecycle).toContain(`teardown:${reason}`);
  }

  const interrupted = fixture();
  interrupted.manager.acquire();
  interrupted.signals.emit("SIGINT");
  expect(interrupted.writes.at(-1)).toBe(LEAVE_BASE_MODES);
  expect(interrupted.raw).toEqual([true, false]);
  expect(interrupted.lifecycle).toContain("teardown:interrupt");
  expect(interrupted.lifecycle).toContain("interrupt");
});

test("fake TTY event pump is the sole subscriber and flushes a lone Esc deadline", () => {
  let listener: ((chunk: Uint8Array | string) => void) | null = null;
  const stdin = {
    isTTY: true,
    setRawMode: () => {}, resume: () => {}, pause: () => {},
    on: (_event: "data", handler: (chunk: Uint8Array | string) => void) => { listener = handler; },
    off: (_event: "data", handler: (chunk: Uint8Array | string) => void) => { if (listener === handler) listener = null; },
  };
  let now = 100;
  let nextHandle = 1;
  const scheduled = new Map<number, { delay: number; callback: () => void }>();
  const timer: TerminalTimer = {
    set: (delay, callback) => {
      const id = nextHandle++;
      scheduled.set(id, { delay, callback: () => { scheduled.delete(id); callback(); } });
      return id;
    },
    clear: (handle) => { scheduled.delete(handle as number); },
  };
  const terminal = new TerminalResourceManager({
    stdin, stdout: { write: () => {} }, processControl: { suspendSelf: () => {} },
  });
  const keys: string[] = [];
  const adapter = new TerminalEventAdapter({
    registry: new InteractionRegistry(),
    onUnhandledKey: (event) => keys.push(event.key),
  });
  const pump = new TerminalEventPump({ terminal, adapter, stdin, timer, now: () => now });
  pump.start();
  expect(listener).not.toBeNull();
  listener!("\x1b");
  expect(keys).toEqual([]);
  now += 50;
  const escDeadline = [...scheduled.values()].find((item) => item.delay === 50);
  escDeadline?.callback();
  expect(keys).toEqual(["escape"]);
  pump.stop();
  expect(listener).toBeNull();
  expect(scheduled.size).toBe(0);
});
