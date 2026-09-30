import { hashText } from "../passages";
import type { Role } from "../contracts";
export interface LibrarianProfile {
  id: string;
  mode: "disabled" | "local" | "remote";
  endpoint: string;
  model: string;
  credentialEnv?: string;
  allowedHarnesses: string[];
  allowedRoles: Role[];
  redaction: "standard";
  maxInputTokens: number;
  maxOutputTokens: number;
  runTokenCap: number;
  dailyTokenCap: number;
  concurrency: number;
  runDollarCap?: number;
  dailyDollarCap?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  ratesVerifiedAt?: string;
  timeoutMs?: number;
}
export function validateProfile(input: unknown): LibrarianProfile {
  if (!input || typeof input !== "object") throw new Error("A librarian profile is required");
  const p = input as LibrarianProfile;
  if (!p.id || !["disabled", "local", "remote"].includes(p.mode)) throw new Error("Profile id/mode required");
  if (!p.model || typeof p.model !== "string") throw new Error("An exact model identifier is required");
  const url = new URL(p.endpoint);
  if (url.username || url.password || url.search || url.hash) throw new Error("Endpoint must not embed credentials or query parameters");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (p.mode === "local" && !local) throw new Error("Local inference must use a loopback endpoint");
  if (p.mode === "remote" && url.protocol !== "https:") throw new Error("Remote endpoint must use HTTPS");
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported endpoint protocol");
  if (!Array.isArray(p.allowedHarnesses) || p.allowedHarnesses.some(h => typeof h !== "string") || !Array.isArray(p.allowedRoles) || !p.allowedRoles.length || p.allowedRoles.some(r => !["user", "assistant", "tool", "system"].includes(r))) throw new Error("Explicit harness and content-role policy required");
  if (p.redaction !== "standard") throw new Error("Standard redaction is required");
  for (const field of ["maxInputTokens", "maxOutputTokens", "runTokenCap", "dailyTokenCap", "concurrency"] as const) if (!Number.isSafeInteger(p[field]) || p[field] <= 0) throw new Error(`Invalid ${field}`);
  if (p.maxInputTokens < 1500 || p.maxOutputTokens < 128 || p.concurrency > 16) throw new Error("Input budget must be >=1500, output >=128, concurrency <=16");
  if (p.credentialEnv && !/^[A-Z_][A-Z0-9_]*$/i.test(p.credentialEnv)) throw new Error("Credential must name an environment variable");
  for (const field of ["runDollarCap", "dailyDollarCap", "inputUsdPerMillion", "outputUsdPerMillion"] as const) if (p[field] !== undefined && (!Number.isFinite(p[field]) || p[field]! < 0)) throw new Error(`Invalid ${field}`);
  if ((p.runDollarCap !== undefined || p.dailyDollarCap !== undefined) && (p.inputUsdPerMillion === undefined || p.outputUsdPerMillion === undefined || !p.ratesVerifiedAt || !Number.isFinite(Date.parse(p.ratesVerifiedAt)))) throw new Error("Dollar caps require explicitly verified input/output rates and date");
  if (p.timeoutMs !== undefined && (!Number.isSafeInteger(p.timeoutMs) || p.timeoutMs < 1 || p.timeoutMs > 600000)) throw new Error("Invalid timeoutMs");
  return structuredClone(p);
}
export function permissionFingerprint(profile: LibrarianProfile): string {
  return hashText(JSON.stringify({ version: 1, endpoint: profile.endpoint, model: profile.model, mode: profile.mode, credentialEnv: profile.credentialEnv, harnesses: [...profile.allowedHarnesses].sort(), roles: [...profile.allowedRoles].sort(), redaction: profile.redaction }));
}
