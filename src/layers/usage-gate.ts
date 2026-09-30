/**
 * Usage gate for model jobs run through Claude Code headless (`claude -p`).
 *
 * md (2026-09-28): "session limits will hit, make sure the processing continues
 * if that happens, 95%, make sure everything is graceful." Every stream-json
 * call reports a `rate_limit_event` with the five-hour and seven-day windows.
 * Jobs stop issuing calls once any window reaches the threshold, never run on
 * overage, sleep until that window resets, and then resume from their ledger.
 * The last snapshot is persisted so a restarted runner waits instead of probing.
 */
import type { Database } from "bun:sqlite";

export const DEFAULT_USAGE_THRESHOLD = 0.95;
/** Slack after a reset before the first call, so the window has really rolled. */
const RESET_SLACK_MS = 90_000;

export interface UsageWindow { utilization: number; resetsAtMs: number }
export interface UsageSnapshot {
  status: string;
  overage: boolean;
  windows: Record<string, UsageWindow>;
  seenAtMs: number;
}

export type GateDecision = { ok: true } | { ok: false; untilMs: number; reason: string };

/** Parse one stream-json object; null unless it is a rate-limit event. */
export function parseRateLimitEvent(event: unknown, nowMs = Date.now()): UsageSnapshot | null {
  if (!event || typeof event !== "object" || (event as { type?: unknown }).type !== "rate_limit_event") return null;
  const info = (event as { rate_limit_info?: Record<string, unknown> }).rate_limit_info ?? {};
  const windows: Record<string, UsageWindow> = {};
  const unified = (info.unifiedWindows ?? {}) as Record<string, { utilization?: unknown; resetsAt?: unknown }>;
  for (const [name, window] of Object.entries(unified)) {
    if (typeof window?.utilization === "number" && typeof window.resetsAt === "number") {
      windows[name] = { utilization: window.utilization, resetsAtMs: window.resetsAt * 1000 };
    }
  }
  // Older payloads carry only the binding window at top level.
  if (typeof info.rateLimitType === "string" && typeof info.utilization === "number" && typeof info.resetsAt === "number" && !windows[info.rateLimitType]) {
    windows[info.rateLimitType] = { utilization: info.utilization, resetsAtMs: info.resetsAt * 1000 };
  }
  return { status: String(info.status ?? "unknown"), overage: info.isUsingOverage === true, windows, seenAtMs: nowMs };
}

/** Whether another call may be issued now. */
export function gateDecision(snapshot: UsageSnapshot | null, threshold = DEFAULT_USAGE_THRESHOLD, nowMs = Date.now()): GateDecision {
  if (!snapshot) return { ok: true };
  const blocking = Object.entries(snapshot.windows).filter(([, window]) => window.resetsAtMs > nowMs && window.utilization >= threshold);
  const rejected = snapshot.status === "rejected" || snapshot.overage;
  if (!blocking.length && !rejected) return { ok: true };
  // A rejection with no saturated window backs off fifteen minutes from when it
  // was seen, then lets one call re-read the windows; it never blocks forever.
  const untilMs = blocking.length
    ? Math.max(...blocking.map(([, window]) => window.resetsAtMs)) + RESET_SLACK_MS
    : snapshot.seenAtMs + 15 * 60_000;
  if (untilMs <= nowMs) return { ok: true };
  const reason = blocking.length
    ? blocking.map(([name, window]) => `${name} ${Math.round(window.utilization * 100)}%`).join(", ")
    : snapshot.overage ? "overage in use" : "rejected";
  return { ok: false, untilMs, reason };
}

/** Error text from a failed call that means a usage limit, not a bad request. */
export function isLimitError(text: string): boolean {
  return /usage limit|limit reached|rate limit|rate_limit|\b429\b|quota|out of (extra )?usage/i.test(text);
}

export function readGate(layers: Database): UsageSnapshot | null {
  const row = layers.query(`SELECT value FROM layer_meta WHERE key='usage_gate'`).get() as { value: string } | null;
  if (!row) return null;
  try { return JSON.parse(row.value) as UsageSnapshot; } catch { return null; }
}

export function writeGate(layers: Database, snapshot: UsageSnapshot): void {
  layers.query(`INSERT OR REPLACE INTO layer_meta(key,value) VALUES('usage_gate',?)`).run(JSON.stringify(snapshot));
}
