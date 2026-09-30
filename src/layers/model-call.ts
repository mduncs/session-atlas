/**
 * One headless Claude Code call (`claude -p`) with stream-json, returning the
 * answer text, token usage, cost, and the rate-limit snapshot it reported.
 *
 * Calls are isolated from md's environment: no tools, no MCP, no slash
 * commands, no settings hooks, and no session persistence, so pilot calls
 * never show up as sessions in the archive they are describing.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLimitError, parseRateLimitEvent, type UsageSnapshot } from "./usage-gate.js";

export interface ModelUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costUsd: number }
export interface ModelResult {
  ok: boolean;
  text: string;
  usage: ModelUsage;
  snapshot: UsageSnapshot | null;
  /** The call was refused or cut off by a usage limit: retry after the gate opens. */
  limited: boolean;
  error: string | null;
}

/** `thinking: false` turns off the extended thinking Claude Code enables by default (it roughly triples output tokens). */
export type ModelCaller = (request: { model: string; system: string; prompt: string; thinking?: boolean; signal?: AbortSignal }) => Promise<ModelResult>;

const CALL_TIMEOUT_MS = 5 * 60_000;

export const claudeHeadless: ModelCaller = async ({ model, system, prompt, thinking = true, signal }) => {
  const cwd = join(tmpdir(), "atlas-layers-runner");
  mkdirSync(cwd, { recursive: true });
  const child = Bun.spawn([
    process.env.ATLAS_CLAUDE_BIN ?? "claude", "-p",
    "--model", model,
    "--output-format", "stream-json", "--verbose",
    "--no-session-persistence",
    "--tools", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources", "",
    "--system-prompt", system,
  ], { cwd, env: thinking ? process.env : { ...process.env, MAX_THINKING_TOKENS: "0" }, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
  const kill = () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } };
  const timer = setTimeout(kill, CALL_TIMEOUT_MS);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return parseStream(stdout, stderr, code, signal?.aborted === true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
};

/** Exported for tests: fold a stream-json transcript into one result. */
export function parseStream(stdout: string, stderr: string, exitCode: number, aborted = false): ModelResult {
  const usage: ModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  let snapshot: UsageSnapshot | null = null, text = "", resultError: string | null = null, sawResult = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    snapshot = parseRateLimitEvent(event) ?? snapshot;
    if (event.type !== "result") continue;
    sawResult = true;
    const u = (event.usage ?? {}) as Record<string, number>;
    usage.inputTokens = u.input_tokens ?? 0;
    usage.outputTokens = u.output_tokens ?? 0;
    usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
    usage.costUsd = typeof event.total_cost_usd === "number" ? event.total_cost_usd : 0;
    if (event.is_error === true) resultError = String(event.result ?? event.subtype ?? "error");
    else text = String(event.result ?? "");
  }
  const error = aborted ? "aborted" : resultError ?? (sawResult && exitCode === 0 ? null : (stderr.trim() || `claude exited ${exitCode}`).slice(0, 500));
  const limited = !aborted && (snapshot?.status === "rejected" || (error !== null && isLimitError(error)));
  return { ok: error === null, text, usage, snapshot, limited, error };
}
