/**
 * Command registry — Law 6: keys, clicks, and the palette are three doors to
 * ONE action, never three implementations. This is the single dispatch table;
 * every keybinding, clickable zone, and palette entry resolves to a Command
 * object here. Built in M4, retrofit forbidden (SPEC BUILD trap #4).
 *
 * A Command is an id + a handler that mutates TuiState (pure reducer style).
 * State-aware visibility: a command can declare when it's disabled and why
 * (palette shows disabled verbs with their reason).
 */
import type { TuiState } from "./store.js";
import type { FilterTerm } from "./queries.js";
import type { SessionKey } from "./domain.js";

export type CommandContext =
  | "list" // at the session list
  | "session" // inside a session view
  | "chat"
  | "tag"
  | "search"; // search input open

export interface CommandResult {
  state: TuiState;
  /** human-readable feedback for the status line (reversal hints live here) */
  message?: string;
  /** signal to exit the app */
  exit?: boolean;
}

export type CommandHandler = (state: TuiState, arg?: string) => CommandResult;

export type ExportScope =
  | { kind: "session"; session: SessionKey }
  | { kind: "chain"; chainId: number }
  | { kind: "selection"; sessions: readonly SessionKey[] }
  | { kind: "tag"; tag: string };

export type CommandPayload =
  | { kind: "none" }
  | { kind: "text"; value: string }
  | { kind: "filter"; operation: "set"; term: FilterTerm }
  | { kind: "filter"; operation: "remove"; filterKind: FilterTerm["kind"] }
  | { kind: "filter"; operation: "clear" }
  | {
      kind: "favorite";
      operation: "toggle" | "add" | "remove";
      sessions: readonly SessionKey[];
      span?: { fromOrdinal: number; toOrdinal: number };
      topic?: string;
    }
  | { kind: "export"; scope: ExportScope; launcher?: string }
  | {
      kind: "navigation";
      destination: "list" | "session" | "chat" | "tag" | "export";
      session?: SessionKey;
      sessionId?: number;
      ordinal?: number;
      tag?: string;
      delta?: -1 | 1;
    };

export type CommandOrigin = "key" | "click" | "palette" | "system";

export interface CommandInvocation<P extends CommandPayload = CommandPayload> {
  id: string;
  payload: P;
  origin: CommandOrigin;
}

export type TypedCommandHandler<P extends CommandPayload = CommandPayload> =
  (state: TuiState, payload: P, origin: CommandOrigin) => CommandResult;

export interface Command {
  id: string;
  /** palette label */
  label: string;
  /** which contexts this command is available in */
  contexts: CommandContext[];
  /** Canonical keybindings; lookup and help both read this field. */
  keys?: string[];
  /** disabled predicate: returns a reason string, or null if enabled */
  disabled?: (state: TuiState) => string | null;
  run: CommandHandler;
  /** Typed path used by new key/click/palette adapters. `run` remains the Wave 0 compatibility path. */
  runPayload?: TypedCommandHandler;
  payloadKinds?: readonly CommandPayload["kind"][];
}

const registry = new Map<string, Command>();
const byLabel = new Map<string, Command>();
const byContextAndKey = new Map<string, Command>();

export interface KeyInput {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  "↵": "enter",
  "return": "enter",
  " ": "space",
  "spacebar": "space",
  "↓": "down",
  "↑": "up",
  "→": "right",
  "←": "left",
  "esc": "escape",
};

export function normalizeKeyChord(input: string | KeyInput): string {
  const event: KeyInput = typeof input === "string" ? parseDeclaredChord(input) : input;
  let key = event.key;
  const inferredShift = key.length === 1 && key >= "A" && key <= "Z";
  key = KEY_ALIASES[key.toLowerCase()] ?? KEY_ALIASES[key] ?? key.toLowerCase();
  const modifiers = [
    (event.ctrl ? "ctrl" : null),
    (event.alt ? "alt" : null),
    (event.meta ? "meta" : null),
    ((event.shift || inferredShift) ? "shift" : null),
  ].filter(Boolean);
  return [...modifiers, key].join("+");
}

function parseDeclaredChord(chord: string): KeyInput {
  if (chord.length === 1) return { key: chord };
  const parts = chord.replaceAll("-", "+").split("+");
  const key = parts.pop() ?? chord;
  return {
    key,
    ctrl: parts.includes("ctrl") || parts.includes("control"),
    alt: parts.includes("alt") || parts.includes("option"),
    shift: parts.includes("shift"),
    meta: parts.includes("meta") || parts.includes("cmd") || parts.includes("command"),
  };
}

function contextKey(context: CommandContext, key: string): string {
  return `${context}\u0000${key}`;
}

export function register(cmd: Command): void {
  if (registry.has(cmd.id)) throw new Error(`duplicate command id: ${cmd.id}`);
  for (const context of cmd.contexts) {
    for (const declared of cmd.keys ?? []) {
      const chord = normalizeKeyChord(declared);
      const indexKey = contextKey(context, chord);
      const conflict = byContextAndKey.get(indexKey);
      if (conflict) throw new Error(`duplicate key ${declared} in ${context}: ${conflict.id} and ${cmd.id}`);
    }
  }
  registry.set(cmd.id, cmd);
  byLabel.set(cmd.label.toLowerCase(), cmd);
  for (const context of cmd.contexts) {
    for (const declared of cmd.keys ?? []) byContextAndKey.set(contextKey(context, normalizeKeyChord(declared)), cmd);
  }
}

/** Test-only: clear the registry. (Prod registers once at import.) */
export function _resetRegistry(): void {
  registry.clear();
  byLabel.clear();
  byContextAndKey.clear();
}

export function get(id: string): Command | undefined {
  return registry.get(id);
}

export function findByLabel(label: string): Command | undefined {
  return byLabel.get(label.toLowerCase().trim());
}

/** The authoritative key lookup used by the terminal adapter/integration shell. */
export function findByKey(input: string | KeyInput, context: CommandContext): Command | undefined {
  return byContextAndKey.get(contextKey(context, normalizeKeyChord(input)));
}

export function contextForState(state: TuiState): CommandContext {
  if (state.searchInput !== null) return "search";
  return state.view;
}

/** Fuzzy-search commands for the palette, filtered to the current context. */
export function search(
  query: string,
  context: CommandContext,
  state: TuiState,
): { cmd: Command; disabled: string | null }[] {
  const q = query.toLowerCase().trim();
  const all = [...registry.values()].filter((c) => c.contexts.includes(context));
  const matched = q
    ? all.filter((c) => c.label.toLowerCase().includes(q) || c.id.includes(q))
    : all;
  return matched.map((cmd) => ({
    cmd,
    disabled: cmd.disabled ? cmd.disabled(state) : null,
  }));
}

export function listAll(): Command[] {
  return [...registry.values()];
}

// ---- execute helper (the single dispatch path) ----

export function execute(id: string, state: TuiState, arg?: string, context = contextForState(state)): CommandResult {
  const cmd = registry.get(id);
  if (!cmd) return { state, message: `unknown command: ${id}` };
  if (!cmd.contexts.includes(context)) return { state, message: `${cmd.label}: unavailable in ${context}` };
  const disabled = cmd.disabled?.(state) ?? null;
  if (disabled) return { state, message: `${cmd.label}: ${disabled}` };
  return cmd.run(state, arg);
}

/** The sole typed dispatch path. Origins are metadata, never separate implementations. */
export function executeInvocation(invocation: CommandInvocation, state: TuiState): CommandResult {
  const cmd = registry.get(invocation.id);
  if (!cmd) return { state, message: `unknown command: ${invocation.id}` };
  const context = contextForState(state);
  if (!cmd.contexts.includes(context)) return { state, message: `${cmd.label}: unavailable in ${context}` };
  const disabled = cmd.disabled?.(state) ?? null;
  if (disabled) return { state, message: `${cmd.label}: ${disabled}` };
  if (cmd.payloadKinds && !cmd.payloadKinds.includes(invocation.payload.kind)) {
    return { state, message: `${cmd.label}: invalid ${invocation.payload.kind} payload` };
  }
  if (cmd.runPayload) return cmd.runPayload(state, invocation.payload, invocation.origin);
  if (invocation.payload.kind === "none") return cmd.run(state);
  if (invocation.payload.kind === "text") return cmd.run(state, invocation.payload.value);
  return { state, message: `${cmd.label}: typed payload not supported` };
}

/** Resolve and execute a physical key through the same invocation path as clicks/palette. */
export function executeKey(
  input: string | KeyInput,
  state: TuiState,
  payload: CommandPayload = { kind: "none" },
): CommandResult {
  const context = contextForState(state);
  const cmd = findByKey(input, context);
  if (!cmd) return { state };
  return executeInvocation({ id: cmd.id, payload, origin: "key" }, state);
}

/**
 * Palette Enter is one transaction: close first, then invoke. A command can
 * reopen the palette intentionally, but stale palette state cannot survive.
 */
export function executePalette(
  id: string,
  state: TuiState,
  payload: CommandPayload = { kind: "none" },
): CommandResult {
  const closed = { ...state, paletteInput: null, paletteIndex: 0 };
  return executeInvocation({ id, payload, origin: "palette" }, closed);
}
