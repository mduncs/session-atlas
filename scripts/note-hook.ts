#!/usr/bin/env bun
/**
 * Claude/Codex SessionEnd hook adapter. The safe default updates the local
 * index without provider traffic. Set SESSION_ATLAS_HOOK_SUMMARIZE=1 only
 * after configuring a provider explicitly permitted for this custom app.
 */
import { join } from "node:path";

export function hookSessionId(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  for (const key of ["session_id", "thread_id"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function noteHookArgs(harness: string, sessionId: string, summarize: boolean, repo = join(import.meta.dir, "..")): string[] {
  return [process.execPath, join(repo, "src/cli.ts"), "note", sessionId, "--harness", harness, ...(summarize ? [] : ["--ingest-only"])];
}

export function spawnNoteHook(args: string[]): Bun.Subprocess {
  const child = Bun.spawn(args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();
  return child;
}

async function main(): Promise<void> {
  const harness = process.argv[2];
  if (harness !== "claude" && harness !== "codex") return;
  let input: unknown;
  try { input = JSON.parse(await Bun.stdin.text()); } catch { return; }
  const sessionId = hookSessionId(input);
  if (!sessionId) return;
  const summarize = process.env.SESSION_ATLAS_HOOK_SUMMARIZE === "1";
  try {
    spawnNoteHook(noteHookArgs(harness, sessionId, summarize));
  } catch {
    // Hook failure must never block or corrupt harness shutdown. `atlas doctor`
    // remains the operator-visible health surface.
  }
}

if (import.meta.main) await main();
