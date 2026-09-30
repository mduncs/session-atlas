/**
 * Provider chain — the load-bearing resilience layer (SPEC §2). Every LLM
 * call walks the ordered chain from config; the first healthy, non-refusing,
 * non-degenerate provider wins.
 *
 * Fall-through triggers: HTTP errors, rate limits, timeouts, refusal
 * detection, degenerate-output detection (Laws 4 & 10).
 *
 * THE CHOKE POINT (Law 3): `sendRequest()` is the ONLY function that issues
 * a network fetch for LLM traffic, and it redacts every outbound turn before
 * building the body. Grep-provable: `rg -n 'fetch\(' src/provider.ts` shows
 * exactly one site; every caller goes through `callChain()`.
 *
 * No SDK: plain fetch against Anthropic- or OpenAI-compatible endpoints. The
 * `claude-cli` kind is the one non-fetch transport: headless `claude -p` on
 * md's subscription, fed the same redacted turns and gated by the 95% usage
 * snapshot the caller persists through `onUsage`.
 */
import type { ProviderConfig } from "./config.js";
import { redactTurns, type RedactableTurn } from "./redact.js";
import { claudeHeadless, type ModelCaller } from "./layers/model-call.js";
import type { UsageSnapshot } from "./layers/usage-gate.js";

export type ProviderStatus =
  | { ok: true; text: string; provider: string; model: string }
  | {
      ok: false;
      reason: string;
      fellThrough: { provider: string; reason: string }[];
      cancelled?: boolean;
    };

export interface ChainCall {
  /** System prompt. */
  system: string;
  /** Conversation turns (will be REDACTED — never send raw transcript). */
  turns: RedactableTurn[];
  /** Max output tokens. */
  maxTokens: number;
  /** Caller-owned cancellation (view close, app exit, or command abort). */
  signal?: AbortSignal;
  /** `claude-cli` only: the rate-limit snapshot each call reports. */
  onUsage?: (snapshot: UsageSnapshot) => void;
}

/** Test seam for the `claude-cli` transport. */
let cliCaller: ModelCaller = claudeHeadless;
export function setClaudeCliCaller(caller: ModelCaller | null): void {
  cliCaller = caller ?? claudeHeadless;
}

const REQUEST_TIMEOUT_MS = 60_000;
export const UNSUPPORTED_PROVIDER_OVERRIDE = "SESSION_ATLAS_ALLOW_UNSUPPORTED_PROVIDER";

export interface ProviderReadiness {
  ready: boolean;
  reason: string | null;
}

/** Local policy gate: configured credentials never imply authorization. */
export function providerReadiness(
  provider: ProviderConfig,
  env: Record<string, string | undefined> = process.env,
): ProviderReadiness {
  if (provider.kind === "claude-cli") {
    const bin = env.ATLAS_CLAUDE_BIN ?? "claude";
    return Bun.which(bin) ? { ready: true, reason: null } : { ready: false, reason: `claude CLI not found (${bin})` };
  }
  if (isKnownCodingPlanEndpoint(provider.base) && env[UNSUPPORTED_PROVIDER_OVERRIDE] !== "1") {
    return { ready: false, reason: `Coding Plan endpoint blocked for custom-app traffic; use a permitted general API or set ${UNSUPPORTED_PROVIDER_OVERRIDE}=1 after provider authorization` };
  }
  if (!env[provider.key_env]) return { ready: false, reason: `no key in ${provider.key_env}` };
  return { ready: true, reason: null };
}

export function hasUsableProvider(providers: readonly ProviderConfig[], env: Record<string, string | undefined> = process.env): boolean {
  return providers.some((provider) => providerReadiness(provider, env).ready);
}

function isKnownCodingPlanEndpoint(base: string): boolean {
  try {
    const url = new URL(base);
    return url.hostname.toLowerCase() === "api.z.ai"
      && (/^\/api\/anthropic(?:\/|$)/.test(url.pathname) || /^\/api\/coding(?:\/|$)/.test(url.pathname));
  } catch {
    return false;
  }
}

/**
 * Walk the chain. Returns the first provider that yields a non-refusal,
 * non-degenerate response, or a structured failure with the fall-through log.
 */
export async function callChain(
  providers: ProviderConfig[],
  call: ChainCall,
  classify: (text: string) => { degenerate: boolean; reason?: string },
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderStatus> {
  const fellThrough: { provider: string; reason: string }[] = [];

  for (const p of providers) {
    if (call.signal?.aborted) {
      return { ok: false, reason: "cancelled", fellThrough, cancelled: true };
    }
    const readiness = providerReadiness(p, env);
    if (!readiness.ready) {
      fellThrough.push({ provider: p.name, reason: readiness.reason ?? "provider unavailable" });
      continue;
    }
    const res = p.kind === "claude-cli" ? await sendCli(p, call) : await sendRequest(p, env[p.key_env]!, call);
    if (!res.ok) {
      if (res.cancelled) {
        return { ok: false, reason: "cancelled", fellThrough, cancelled: true };
      }
      fellThrough.push({ provider: p.name, reason: res.reason! });
      continue;
    }
    // Refusal? fall through (record), never cache.
    const refuse = isRefusalLike(res.text);
    if (refuse.refusal) {
      fellThrough.push({ provider: p.name, reason: `refusal: ${refuse.reason}` });
      continue;
    }
    // Degenerate output? fall through (record).
    const deg = classify(res.text);
    if (deg.degenerate) {
      fellThrough.push({ provider: p.name, reason: `degenerate: ${deg.reason}` });
      continue;
    }
    return { ok: true, text: res.text, provider: p.name, model: p.model };
  }

  return {
    ok: false,
    reason: fellThrough.length ? fellThrough[fellThrough.length - 1]!.reason : "no providers configured",
    fellThrough,
  };
}

// Re-export the refusal classifier so the provider layer is self-contained.
import { isRefusal } from "./classify.js";
function isRefusalLike(text: string) {
  return isRefusal(text);
}

interface SendResult {
  ok: boolean;
  text: string;
  reason?: string;
  cancelled?: boolean;
}

/**
 * THE CHOKE POINT. The single fetch site for LLM traffic. Redacts the turns
 * BEFORE serializing — no code path bypasses this. (Law 3.)
 */
async function sendRequest(p: ProviderConfig, key: string, call: ChainCall): Promise<SendResult> {
  const redacted = redactTurns(call.turns);
  const body = buildBody(p, call.system, redacted, call.maxTokens);

  const ctrl = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => ctrl.abort(call.signal?.reason);
  if (call.signal?.aborted) abortFromCaller();
  else call.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort("provider timeout");
  }, REQUEST_TIMEOUT_MS);
  try {
    const isOpenAi = p.kind === "openai";
    const endpoint = isOpenAi ? "/v1/chat/completions" : "/v1/messages";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(isOpenAi
        ? { authorization: `Bearer ${key}` }
        : { "x-api-key": key, "anthropic-version": "2023-06-01" }),
    };
    const resp = await fetch(`${p.base.replace(/\/$/, "")}${endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    if (resp.status === 429 || resp.status >= 500) {
      return { ok: false, text: "", reason: `http ${resp.status}` };
    }
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, text: "", reason: `auth ${resp.status}` };
    }
    if (!resp.ok) {
      return { ok: false, text: "", reason: `http ${resp.status}` };
    }

    let json: any;
    try {
      json = await resp.json();
    } catch (e) {
      if (call.signal?.aborted) {
        return { ok: false, text: "", reason: "cancelled", cancelled: true };
      }
      return { ok: false, text: "", reason: `bad json: ${(e as Error).message}` };
    }

    const text = extractText(p.kind, json);
    if (!text) return { ok: false, text: "", reason: "empty content" };
    return { ok: true, text };
  } catch (e) {
    if (call.signal?.aborted) return { ok: false, text: "", reason: "cancelled", cancelled: true };
    if (timedOut) return { ok: false, text: "", reason: "network/timeout: provider timeout" };
    return { ok: false, text: "", reason: `network/timeout: ${(e as Error).message}` };
  } finally {
    clearTimeout(timer);
    call.signal?.removeEventListener("abort", abortFromCaller);
  }
}

/** The `claude-cli` transport. Redacts before rendering, exactly like sendRequest. */
async function sendCli(p: ProviderConfig, call: ChainCall): Promise<SendResult> {
  const transcript = redactTurns(call.turns)
    .filter((t) => t.text !== null || t.toolText)
    .map((t) => `[${t.role === "assistant" ? "assistant" : "user"}]\n${[t.text, t.toolText].filter(Boolean).join("\n")}`)
    .join("\n\n");
  const result = await cliCaller({
    model: p.model,
    system: call.system,
    prompt: `<transcript>\n${transcript}\n</transcript>`,
    thinking: false,
    signal: call.signal,
  });
  if (result.snapshot) call.onUsage?.(result.snapshot);
  if (call.signal?.aborted) return { ok: false, text: "", reason: "cancelled", cancelled: true };
  if (result.limited) return { ok: false, text: "", reason: `usage limit: ${result.error ?? "rejected"}` };
  if (!result.ok) return { ok: false, text: "", reason: `claude-cli: ${result.error}` };
  if (!result.text.trim()) return { ok: false, text: "", reason: "empty content" };
  return { ok: true, text: result.text };
}

function buildBody(
  p: ProviderConfig,
  system: string,
  turns: RedactableTurn[],
  maxTokens: number,
): Record<string, unknown> {
  const messages = turns
    .filter((t) => t.text !== null || t.toolText)
    .map((t) => ({
      role: t.role === "assistant" ? "assistant" : "user",
      content: [t.text, t.toolText].filter(Boolean).join("\n"),
    }));
  if (p.kind === "openai") {
    return {
      model: p.model,
      max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, ...messages],
      ...(p.thinking ? { thinking: { type: p.thinking } } : {}),
    };
  }
  return {
    model: p.model,
    max_tokens: maxTokens,
    system,
    messages,
  };
}

function extractText(kind: ProviderConfig["kind"], json: any): string {
  if (kind === "anthropic" && Array.isArray(json?.content)) {
    return json.content
      .map((b: any) => (b && b.type === "text" ? String(b.text ?? "") : ""))
      .join("")
      .trim();
  }
  if (kind === "openai" && Array.isArray(json?.choices) && json.choices[0]?.message?.content) {
    return String(json.choices[0].message.content).trim();
  }
  return "";
}

/** Dry-run the redaction a chain call WOULD send — for the human-in-the-loop
 * eyeball (SPEC §2 redaction boundary, M2 exit criterion). Returns the exact
 * string bytes headed for the wire, secrets scrubbed. Never fetches. */
export function previewRedacted(call: ChainCall): string {
  const redacted = redactTurns(call.turns);
  return redacted
    .filter((t) => t.text !== null || t.toolText)
    .map((t) => `[${t.role}] ${[t.text, t.toolText].filter(Boolean).join("\n")}`)
    .join("\n\n");
}
