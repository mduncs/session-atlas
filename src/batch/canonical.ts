import { createHash } from "node:crypto";

/** Stable JSON with recursively sorted object keys; arrays retain order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
}

export function sha256(value: unknown): string {
  const hash = createHash("sha256");
  hash.update(typeof value === "string" ? value : stableStringify(value));
  return hash.digest("hex");
}

/** Contract estimates use UTF-8 bytes / 4, rounded up (never under-budget). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(new TextEncoder().encode(text).byteLength / 4);
}

export function usdForTokens(tokens: number, usdPerMillionTokens: number): number {
  return Number(((tokens * usdPerMillionTokens) / 1_000_000).toFixed(8));
}

export function sumCost(costs: readonly { inputTokens: number; outputTokens: number; inputDollars: number; outputDollars: number }[]): {
  inputTokens: number;
  outputTokens: number;
  inputDollars: number;
  outputDollars: number;
  totalDollars: number;
} {
  const inputTokens = costs.reduce((sum, cost) => sum + cost.inputTokens, 0);
  const outputTokens = costs.reduce((sum, cost) => sum + cost.outputTokens, 0);
  const inputDollars = Number(costs.reduce((sum, cost) => sum + cost.inputDollars, 0).toFixed(8));
  const outputDollars = Number(costs.reduce((sum, cost) => sum + cost.outputDollars, 0).toFixed(8));
  return { inputTokens, outputTokens, inputDollars, outputDollars, totalDollars: Number((inputDollars + outputDollars).toFixed(8)) };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
