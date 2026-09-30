import type { LibrarianProfile } from "./profile";
export interface ModelRequest { system: string; data: string; maxOutputTokens: number; workId: string }
export interface ModelResponse { text: string; model: string; usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number } }
export interface LibrarianTransport { readonly kind: "mock" | "provider"; complete(request: ModelRequest): Promise<ModelResponse> }
export class TransportFailure extends Error {
  constructor(message: string, readonly kind: "refusal" | "auth" | "transient" | "unknown" | "schema", readonly submitted = false) { super(message); }
}
/** Tool-free, bounded OpenAI-compatible chat-completions protocol, not a provider capability guarantee. */
export class OpenAICompatibleTransport implements LibrarianTransport {
  readonly kind = "provider" as const;
  constructor(readonly profile: LibrarianProfile, private readonly fetcher: typeof fetch = fetch) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const secret = this.profile.credentialEnv ? process.env[this.profile.credentialEnv] : undefined;
    if (this.profile.credentialEnv && !secret) throw new TransportFailure(`Missing credential environment variable ${this.profile.credentialEnv}`, "auth");
    let response: Response;
    try {
      response = await this.fetcher(`${this.profile.endpoint.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(this.profile.timeoutMs ?? 60000),
        headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
        body: JSON.stringify({ model: this.profile.model, messages: [{ role: "system", content: request.system }, { role: "user", content: request.data }], max_tokens: request.maxOutputTokens, response_format: { type: "json_object" }, stream: false }),
      });
    } catch { throw new TransportFailure("Submission outcome unknown; reservation retained. Inspect provider before deliberate retry.", "unknown", true); }
    if (response.status === 401 || response.status === 403) throw new TransportFailure("Provider authentication rejected", "auth");
    if (response.status === 429) throw new TransportFailure("Provider rate limit", "transient");
    if (!response.ok) throw new TransportFailure(`Provider HTTP ${response.status}; outcome may be billable`, "unknown", true);
    const maximum = Math.max(65536, request.maxOutputTokens * 32);
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      if (!response.body) throw new Error("Empty response");
      const stream = response.body.getReader();
      while (true) { const next = await stream.read(); if (next.done) break; length += next.value.length; if (length > maximum) { await stream.cancel(); throw new Error("Oversized response"); } chunks.push(next.value); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const choice = body.choices?.[0];
      if (choice?.message?.refusal) throw new TransportFailure("Provider refusal", "refusal", true);
      if (choice?.finish_reason === "length") throw new TransportFailure("Output budget exhausted; split input", "schema", true);
      if (typeof choice?.message?.content !== "string" || typeof body.model !== "string") throw new Error("Invalid compatible response");
      const u = body.usage;
      const valid = u && Number.isSafeInteger(u.prompt_tokens) && u.prompt_tokens >= 0 && Number.isSafeInteger(u.completion_tokens) && u.completion_tokens >= 0;
      return { text: choice.message.content, model: body.model, ...(valid ? { usage: { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0 } } : {}) };
    } catch (error) { if (error instanceof TransportFailure) throw error; throw new TransportFailure("Unreadable provider response; charge unknown", "unknown", true); }
  }
}
