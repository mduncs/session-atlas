/**
 * Renderer-independent interaction tree. Ink supplies measured rectangles;
 * this module supplies deterministic hit testing, focus, hover set diffs, and
 * target-to-root bubbling for mouse, key, and paste events.
 */
import type { MouseButton, TerminalInputEvent } from "./input.js";

export interface InteractionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type InteractionEvent =
  | { type: "mouse"; x: number; y: number; action: "press" | "release" | "move" | "scroll"; button?: MouseButton; shift?: boolean; alt?: boolean; ctrl?: boolean }
  | { type: "key"; key: string; shift: boolean; alt: boolean; ctrl: boolean }
  | { type: "paste"; text: string }
  | { type: "focus"; focused: boolean }
  | { type: "hover"; entered: boolean; x: number; y: number };

export interface InteractionDispatchEvent {
  event: InteractionEvent;
  targetId: string;
  currentTargetId: string;
  localX: number | null;
  localY: number | null;
  stopPropagation(): void;
  readonly propagationStopped: boolean;
}

export type InteractionHandler = (event: InteractionDispatchEvent) => boolean | void;

export interface InteractionZone {
  id: string;
  rect: InteractionRect;
  parentId?: string | null;
  focusable?: boolean;
  zIndex?: number;
  onEvent?: InteractionHandler;
}

interface RegisteredZone extends InteractionZone {
  order: number;
}

export interface DispatchResult {
  targetId: string | null;
  handledBy: string | null;
  propagationStopped: boolean;
}

function contains(rect: InteractionRect, x: number, y: number): boolean {
  return rect.width > 0 && rect.height > 0
    && x >= rect.x && y >= rect.y
    && x < rect.x + rect.width && y < rect.y + rect.height;
}

export class InteractionRegistry {
  private readonly zones = new Map<string, RegisteredZone>();
  private order = 0;
  private focusedId: string | null = null;
  private hovered = new Set<string>();

  reset(): void {
    this.zones.clear();
    this.order = 0;
    this.focusedId = null;
    this.hovered.clear();
  }

  register(zone: InteractionZone): void {
    if (this.zones.has(zone.id)) throw new Error(`duplicate interaction zone: ${zone.id}`);
    this.zones.set(zone.id, { ...zone, order: this.order++ });
  }

  unregister(id: string): void {
    this.zones.delete(id);
    this.hovered.delete(id);
    if (this.focusedId === id) this.focusedId = null;
  }

  get focused(): string | null {
    return this.focusedId;
  }

  focus(id: string | null): boolean {
    if (id === null) {
      this.focusedId = null;
      return true;
    }
    const zone = this.zones.get(id);
    if (!zone?.focusable) return false;
    this.focusedId = id;
    return true;
  }

  focusNext(reverse = false): string | null {
    const focusable = [...this.zones.values()].filter((zone) => zone.focusable).sort((a, b) => a.order - b.order);
    if (focusable.length === 0) {
      this.focusedId = null;
      return null;
    }
    const current = focusable.findIndex((zone) => zone.id === this.focusedId);
    const delta = reverse ? -1 : 1;
    const next = current < 0
      ? (reverse ? focusable.length - 1 : 0)
      : (current + delta + focusable.length) % focusable.length;
    this.focusedId = focusable[next]!.id;
    return this.focusedId;
  }

  /** Topmost stacking layer wins, then its deepest/latest painted zone. */
  hitTest(x: number, y: number): string | null {
    const candidates = [...this.zones.values()].filter((zone) => contains(zone.rect, x, y));
    candidates.sort((a, b) => {
      const z = (b.zIndex ?? 0) - (a.zIndex ?? 0);
      if (z !== 0) return z;
      const depth = this.depth(b.id) - this.depth(a.id);
      return depth !== 0 ? depth : b.order - a.order;
    });
    return candidates[0]?.id ?? null;
  }

  dispatchPointer(event: Extract<InteractionEvent, { type: "mouse" }>): DispatchResult {
    const target = this.hitTest(event.x, event.y);
    if (target === null) return { targetId: null, handledBy: null, propagationStopped: false };
    if (event.action === "press") {
      const focusable = this.ancestorPath(target).find((id) => this.zones.get(id)?.focusable);
      if (focusable) this.focusedId = focusable;
    }
    return this.bubble(target, event);
  }

  dispatchFocused(event: Exclude<InteractionEvent, { type: "mouse" | "hover" }>): DispatchResult {
    if (this.focusedId === null) return { targetId: null, handledBy: null, propagationStopped: false };
    return this.bubble(this.focusedId, event);
  }

  /** Returns deterministic leave/enter ids and dispatches their hover events. */
  updateHover(x: number, y: number): { entered: string[]; left: string[] } {
    const target = this.hitTest(x, y);
    const next = new Set(target === null ? [] : this.ancestorPath(target));
    const left = [...this.hovered].filter((id) => !next.has(id));
    const enteredLeafFirst = [...next].filter((id) => !this.hovered.has(id));
    for (const id of left) this.bubbleSingle(id, id, { type: "hover", entered: false, x, y });
    // Root-to-leaf enter ordering prevents a child observing an unentered parent.
    const entered = [...enteredLeafFirst].reverse();
    for (const id of entered) this.bubbleSingle(id, id, { type: "hover", entered: true, x, y });
    this.hovered = next;
    return { entered, left };
  }

  private bubble(targetId: string, event: InteractionEvent): DispatchResult {
    let handledBy: string | null = null;
    let stopped = false;
    for (const id of this.ancestorPath(targetId)) {
      const result = this.bubbleSingle(targetId, id, event);
      if (result.handled && handledBy === null) handledBy = id;
      if (result.stopped) {
        stopped = true;
        break;
      }
    }
    return { targetId, handledBy, propagationStopped: stopped };
  }

  private bubbleSingle(targetId: string, currentTargetId: string, event: InteractionEvent): { handled: boolean; stopped: boolean } {
    const zone = this.zones.get(currentTargetId);
    if (!zone?.onEvent) return { handled: false, stopped: false };
    let stopped = false;
    const pointer = event.type === "mouse" || event.type === "hover";
    const dispatchEvent: InteractionDispatchEvent = {
      event,
      targetId,
      currentTargetId,
      localX: pointer ? event.x - zone.rect.x : null,
      localY: pointer ? event.y - zone.rect.y : null,
      stopPropagation: () => { stopped = true; },
      get propagationStopped() { return stopped; },
    };
    const handled = zone.onEvent(dispatchEvent) === true;
    return { handled, stopped };
  }

  private ancestorPath(id: string): string[] {
    const path: string[] = [];
    const seen = new Set<string>();
    let current: string | null | undefined = id;
    while (current) {
      if (seen.has(current)) throw new Error(`interaction zone parent cycle at ${current}`);
      seen.add(current);
      const zone = this.zones.get(current);
      if (!zone) break;
      path.push(current);
      current = zone.parentId;
    }
    return path;
  }

  private depth(id: string): number {
    return this.ancestorPath(id).length;
  }
}

export type KeyboardDeliveryOwner = "atlas" | "ink";

export interface TerminalEventAdapterOptions {
  registry: InteractionRegistry;
  /**
   * `atlas` is the production strategy: attach this adapter to stdin and do
   * not also install Ink `useInput`. `ink` is a migration mode that routes
   * pointer/focus only and leaves keyboard bytes to Ink. Never use both.
   */
  keyboardOwner?: KeyboardDeliveryOwner;
  /**
   * When false, keyboard input never visits zones: Tab does not move an
   * invisible focus and Enter cannot activate a zone the operator cannot
   * see. Production passes false; zones are for the pointer, keys go to the
   * command registry.
   */
  zoneKeyboard?: boolean;
  onUnhandledText?: (text: string) => void;
  onUnhandledKey?: (event: Extract<TerminalInputEvent, { type: "key" }>) => void;
  onUnhandledPaste?: (text: string) => void;
  onTerminalFocus?: (focused: boolean) => void;
}

export interface TerminalEventDispatchSummary {
  keyboardOwner: KeyboardDeliveryOwner;
  pointerEvents: number;
  keyboardEvents: number;
  focusMoves: number;
}

/**
 * One production event adapter from tokenizer output to the interaction tree.
 * Its ownership switch is the explicit duplicate-delivery barrier at the Ink
 * seam: Atlas keyboard delivery and Ink `useInput` are mutually exclusive.
 */
export class TerminalEventAdapter {
  readonly keyboardOwner: KeyboardDeliveryOwner;

  constructor(private readonly options: TerminalEventAdapterOptions) {
    this.keyboardOwner = options.keyboardOwner ?? "atlas";
  }

  dispatch(events: readonly TerminalInputEvent[]): TerminalEventDispatchSummary {
    const summary: TerminalEventDispatchSummary = {
      keyboardOwner: this.keyboardOwner,
      pointerEvents: 0,
      keyboardEvents: 0,
      focusMoves: 0,
    };
    for (const event of events) {
      if (event.type === "mouse") {
        if (event.action === "move") this.options.registry.updateHover(event.x, event.y);
        this.options.registry.dispatchPointer({
          type: "mouse",
          x: event.x,
          y: event.y,
          action: event.action,
          button: event.button,
          shift: event.shift,
          alt: event.alt,
          ctrl: event.ctrl,
        });
        summary.pointerEvents++;
        continue;
      }
      if (event.type === "focus") {
        this.options.registry.dispatchFocused({ type: "focus", focused: event.focused });
        this.options.onTerminalFocus?.(event.focused);
        continue;
      }
      if (this.keyboardOwner === "ink") continue;
      if (this.options.zoneKeyboard === false) {
        if (event.type === "paste") this.options.onUnhandledPaste?.(event.text);
        else if (event.type === "text") this.options.onUnhandledText?.(event.text);
        else this.options.onUnhandledKey?.(event);
        summary.keyboardEvents++;
        continue;
      }
      if (event.type === "key" && event.key === "tab") {
        this.options.registry.focusNext(event.shift === true);
        summary.focusMoves++;
        continue;
      }
      if (event.type === "key" && event.key === "shift-tab") {
        this.options.registry.focusNext(true);
        summary.focusMoves++;
        continue;
      }
      if (event.type === "paste") {
        const result = this.options.registry.dispatchFocused({ type: "paste", text: event.text });
        if (result.handledBy === null) this.options.onUnhandledPaste?.(event.text);
        summary.keyboardEvents++;
        continue;
      }
      if (event.type === "text") {
        const result = this.options.registry.dispatchFocused({
          type: "key",
          key: event.text,
          shift: false,
          alt: false,
          ctrl: false,
        });
        if (result.handledBy === null) this.options.onUnhandledText?.(event.text);
        summary.keyboardEvents++;
        continue;
      }
      const result = this.options.registry.dispatchFocused({
        type: "key",
        key: event.key,
        shift: event.shift ?? false,
        alt: event.alt,
        ctrl: event.ctrl ?? false,
      });
      if (result.handledBy === null) this.options.onUnhandledKey?.(event);
      summary.keyboardEvents++;
    }
    return summary;
  }
}

export const TERMINAL_INPUT_OWNERSHIP =
  "Production installs TerminalEventAdapter(keyboardOwner=atlas) and disables Ink useInput; migration mode keyboardOwner=ink routes only pointer/focus.";
