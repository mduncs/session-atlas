import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type ProviderConfig } from "../src/config.js";
import { callChain, providerReadiness, setClaudeCliCaller } from "../src/provider.js";
import type { ModelCaller } from "../src/layers/model-call.js";
import type { UsageSnapshot } from "../src/layers/usage-gate.js";

const CLI: ProviderConfig = { name: "haiku-cli", base: "", kind: "claude-cli", model: "claude-haiku-4-5-20251001", key_env: "" };
const SNAPSHOT: UsageSnapshot = { status: "allowed", overage: false, windows: { five_hour: { utilization: 0.4, resetsAtMs: 1 } }, seenAtMs: 1 };
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
const dirs: string[] = [];

afterEach(() => {
  setClaudeCliCaller(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("claude-cli sends redacted turns without thinking and reports the usage snapshot", async () => {
  const seen: Parameters<ModelCaller>[0][] = [];
  setClaudeCliCaller(async (request) => {
    seen.push(request);
    return { ok: true, text: '{"topic_line":"x"}', usage, snapshot: SNAPSHOT, limited: false, error: null };
  });
  const reported: UsageSnapshot[] = [];
  const secret = "sk-ant-api03-" + "A".repeat(40);
  const status = await callChain(
    [CLI],
    { system: "summarize", turns: [{ role: "user", text: `deploy with ${secret}` }, { role: "assistant", text: "done" }], maxTokens: 100, onUsage: (s) => reported.push(s) },
    () => ({ degenerate: false }),
    { ATLAS_CLAUDE_BIN: "/bin/sh" },
  );
  expect(status).toEqual({ ok: true, text: '{"topic_line":"x"}', provider: "haiku-cli", model: "claude-haiku-4-5-20251001" });
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ model: "claude-haiku-4-5-20251001", system: "summarize", thinking: false });
  expect(seen[0]!.prompt).toContain("[user]\ndeploy with");
  expect(seen[0]!.prompt).toContain("[assistant]\ndone");
  expect(seen[0]!.prompt).not.toContain(secret);
  expect(reported).toEqual([SNAPSHOT]);
});

test("a usage-limited claude-cli call falls through and never counts as output", async () => {
  setClaudeCliCaller(async () => ({ ok: false, text: "", usage, snapshot: { ...SNAPSHOT, status: "rejected" }, limited: true, error: "usage limit reached" }));
  const status = await callChain([CLI], { system: "s", turns: [{ role: "user", text: "hi" }], maxTokens: 10 }, () => ({ degenerate: false }), { ATLAS_CLAUDE_BIN: "/bin/sh" });
  expect(status.ok).toBe(false);
  expect(status.ok ? null : status.fellThrough).toEqual([{ provider: "haiku-cli", reason: "usage limit: usage limit reached" }]);
});

test("claude-cli readiness needs the binary, not a key", () => {
  expect(providerReadiness(CLI, { ATLAS_CLAUDE_BIN: "/bin/sh" })).toEqual({ ready: true, reason: null });
  expect(providerReadiness(CLI, { ATLAS_CLAUDE_BIN: "/nonexistent/claude" }).ready).toBe(false);
});

test("config accepts kind claude-cli and rejects unknown kinds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-cli-provider-"));
  dirs.push(dir);
  const path = join(dir, "config.toml");
  const db = JSON.stringify(join(dir, "atlas.db"));
  writeFileSync(path, `dbPath = ${db}\n[[providers]]\nname="haiku-cli"\nkind="claude-cli"\nmodel="claude-haiku-4-5-20251001"\n`);
  expect((await loadConfig(path, { bootstrap: false })).providers[0]).toMatchObject({ kind: "claude-cli", model: "claude-haiku-4-5-20251001" });
  writeFileSync(path, `dbPath = ${db}\n[[providers]]\nname="x"\nkind="grpc"\nmodel="m"\n`);
  await expect(loadConfig(path, { bootstrap: false })).rejects.toThrow("provider kind");
});
