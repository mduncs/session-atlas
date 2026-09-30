import { readFileSync } from "node:fs";
import type { LibraryStore } from "./store.js";
import { LibrarianCoordinator, OpenAICompatibleTransport, permissionFingerprint, validateProfile, type LibrarianProfile } from "./librarians/index.js";
function getCoordinator(store: LibraryStore): LibrarianCoordinator {
  const saved = store.getState<LibrarianProfile>("provider-profile");
  if (!saved) throw new Error("No provider configured. Save a BYOK profile first; reading remains available.");
  const profile = validateProfile(saved); return new LibrarianCoordinator(store, profile, new OpenAICompatibleTransport(profile));
}
export async function processingCommand(store: LibraryStore, command: string, args: string[]): Promise<void> {
  if (command === "provider") {
    if (!args[0]) throw new Error("profile JSON file required");
    const profile = validateProfile(JSON.parse(readFileSync(args[0], "utf8"))); store.setState("provider-profile", profile);
    process.stdout.write(JSON.stringify({ configured: profile.id, model: profile.model, contentPolicy: { harnesses: profile.allowedHarnesses, roles: profile.allowedRoles, redaction: profile.redaction }, permissionFingerprint: permissionFingerprint(profile), next: "Explicitly run process --authorize FINGERPRINT --limit N after reviewing endpoint, scope and caps. No request sent." }, null, 2) + "\n"); return;
  }
  const c = getCoordinator(store); const authIndex = args.indexOf("--authorize"); if (authIndex >= 0) c.authorizeEgress(args[authIndex + 1]!);
  const limitIndex = args.indexOf("--limit"); const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("limit must be 1..10000");
  process.stdout.write(JSON.stringify(await c.run({ limit }), null, 2) + "\n");
}
function processingSummary(store: LibraryStore): unknown {
  const c = getCoordinator(store); const state = c.inspect(); const jobs = Object.values(state.jobs); const sessions = Object.values(state.sessionStates);
  return { profile: c.profile, paused: state.paused, authorized: state.permission === permissionFingerprint(c.profile), phase: jobs.some(j => j.status === "running") ? "processing" : "idle", knownSessions: sessions.length, completedSessions: sessions.filter(s => s.status === "complete").length, knownJobs: jobs.length, completeJobs: jobs.filter(j => j.status === "complete").length, failures: jobs.filter(j => ["failed", "unknown", "incomplete"].includes(j.status)).slice(-12).map(j => ({ id: j.id, status: j.status, error: j.error, nextRetry: j.nextRetry })), budgets: state.budgets };
}
export function processingActions(store: LibraryStore) {
  return { processing: () => store.getState("provider-profile") ? processingSummary(store) : { phase: "provider missing", note: "Capture/search/read remain available. Configure an explicit BYOK profile through atlas-library provider FILE.json." }, configureProvider: (input: { endpoint: string; model: string; credentialEnv: string; runTokenCap: number }) => {
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(input.endpoint).hostname);
      const profile = validateProfile({ id: "default", mode: local ? "local" : "remote", endpoint: input.endpoint, model: input.model, credentialEnv: input.credentialEnv || undefined, allowedHarnesses: store.sources().filter(s => s.enabled).map(s => s.harness), allowedRoles: ["user", "assistant"], redaction: "standard", maxInputTokens: 6000, maxOutputTokens: 1500, runTokenCap: input.runTokenCap, dailyTokenCap: input.runTokenCap, concurrency: 1 });
      store.setState("provider-profile", profile); return { profile, permissionFingerprint: permissionFingerprint(profile), note: "Saved only. Authorize and start after reviewing endpoint, selected sources, dialogue policy and token caps." };
    }, authorizeProcessing: () => { const c = getCoordinator(store); c.authorizeEgress(permissionFingerprint(c.profile)); c.resume(); return c.run({ limit: 10 }); }, processingControl: (action: "pause" | "resume" | "retry") => { const c = getCoordinator(store); if (action === "pause") return c.pause(); if (action === "retry") c.retry(); c.resume(); return c.run({ limit: 10 }); } };
}
