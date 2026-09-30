import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseNoteArgs } from "../src/commands/note.js";
import { callChain } from "../src/provider.js";
import { TaskSupervisor } from "../src/runtime/tasks.js";
import type { ProviderConfig } from "../src/config.js";

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temp(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `atlas-wave3-${name}-`));
  roots.push(root);
  return root;
}

function provider(
  kind: ProviderConfig["kind"],
  base: string,
  name = kind,
): ProviderConfig {
  return { name, kind, base, model: `${kind}-fixture`, key_env: `${kind.toUpperCase()}_KEY` };
}

test("custom missing config bootstraps and opens an isolated DB without touching the default DB", () => {
  const root = temp("custom-config");
  const customConfig = join(root, "clone", "config.toml");
  const defaultData = join(root, "default-data");
  const script = `
    import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
    import { dirname } from "node:path";
    const configMod = await import("./src/config.ts");
    const dbMod = await import("./src/db/index.ts");
    mkdirSync(dirname(configMod.DEFAULT_DB_PATH), { recursive: true });
    writeFileSync(configMod.DEFAULT_DB_PATH, "DEFAULT_DB_SENTINEL", "utf8");
    const config = await configMod.loadConfig(${JSON.stringify(customConfig)});
    const db = await dbMod.openDb(config.dbPath);
    db.close();
    process.stdout.write(JSON.stringify({
      dbPath: config.dbPath,
      opened: existsSync(config.dbPath),
      sentinel: readFileSync(configMod.DEFAULT_DB_PATH, "utf8"),
      template: readFileSync(${JSON.stringify(customConfig)}, "utf8"),
    }));
  `;
  const child = Bun.spawnSync({
    cmd: [process.execPath, "--eval", script],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, XDG_DATA_HOME: defaultData },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const result = JSON.parse(child.stdout.toString()) as {
    dbPath: string;
    opened: boolean;
    sentinel: string;
    template: string;
  };
  expect(result.dbPath).toBe(join(root, "clone", "atlas.db"));
  expect(result.opened).toBe(true);
  expect(result.sentinel).toBe("DEFAULT_DB_SENTINEL");
  expect(result.template).toContain(`dbPath = ${JSON.stringify(result.dbPath)}`);
});

test("an existing custom config without dbPath also defaults beside itself", async () => {
  const root = temp("implicit-custom");
  const configPath = join(root, "profile", "config.toml");
  await Bun.write(configPath, "[tunables]\nexport_budget_tokens = 1234\n");
  const { loadConfig } = await import("../src/config.js");
  const config = await loadConfig(configPath);
  expect(config.dbPath).toBe(join(root, "profile", "atlas.db"));
  expect(config.tunables.export_budget_tokens).toBe(1234);
});

test("note argument parsing leaves harness absent instead of aliasing the session id", () => {
  expect(parseNoteArgs(["native-session-id"])).toEqual({
    target: "native-session-id",
    harness: undefined,
  });
  expect(parseNoteArgs(["--config", "/tmp/clone.toml", "native-session-id"])).toEqual({
    target: "native-session-id",
    harness: undefined,
  });
  expect(parseNoteArgs(["native-session-id", "--harness", "codex"])).toEqual({
    target: "native-session-id",
    harness: "codex",
  });
});

test("TaskSupervisor replacement admits only the newest request after prior cleanup", async () => {
  const supervisor = new TaskSupervisor();
  const events: string[] = [];
  let firstWasCurrentAfterAbort = true;
  const first = supervisor.run(async (ctx) => {
    events.push("first:start");
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
    events.push("first:abort");
    await new Promise((resolve) => setTimeout(resolve, 15));
    firstWasCurrentAfterAbort = ctx.isCurrent();
    events.push("first:settled");
    return "first";
  });
  await Promise.resolve();

  const obsolete = supervisor.replace(async () => {
    events.push("obsolete:started");
    return "obsolete";
  }, "selection changed");
  const newest = supervisor.replace(async (ctx) => {
    events.push("newest:start");
    expect(ctx.isCurrent()).toBe(true);
    return "newest";
  }, "selection changed again");

  await expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
  expect(await first).toBe("first");
  expect(await newest).toBe("newest");
  expect(firstWasCurrentAfterAbort).toBe(false);
  expect(events).toEqual(["first:start", "first:abort", "first:settled", "newest:start"]);
  expect(supervisor.activeCount).toBe(0);
  await supervisor.close();
});

test("TaskSupervisor close supersedes a queued replacement and leaves no work", async () => {
  const supervisor = new TaskSupervisor();
  const first = supervisor.run(async (ctx) => {
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  await Promise.resolve();
  let replacementStarted = false;
  const replacement = supervisor.replace(async () => {
    replacementStarted = true;
  });
  await supervisor.close();
  await first;
  await expect(replacement).rejects.toMatchObject({ name: "AbortError" });
  expect(replacementStarted).toBe(false);
  expect(supervisor.activeCount).toBe(0);
  await expect(supervisor.run(async () => undefined)).rejects.toMatchObject({ name: "AbortError" });
});

test("provider kinds use distinct endpoints, auth headers, bodies, extraction, and redaction", async () => {
  const requests: Array<{ path: string; headers: Headers; body: any }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({ path: url.pathname, headers: request.headers, body: await request.json() });
      if (url.pathname === "/v1/chat/completions") {
        return Response.json({ choices: [{ message: { content: "openai answer" } }] });
      }
      return Response.json({ content: [{ type: "text", text: "anthropic answer" }] });
    },
  });
  servers.push(server);
  const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
  const common = {
    system: "fixture system",
    turns: [{ role: "user", text: `keep context but hide ${secret}`, toolText: "tool output", ordinal: 0 }],
    maxTokens: 77,
  };

  const openai = await callChain(
    [{ ...provider("openai", server.url.toString()), thinking: "disabled" }],
    common,
    () => ({ degenerate: false }),
    { OPENAI_KEY: "openai-secret" },
  );
  const anthropic = await callChain(
    [provider("anthropic", server.url.toString())],
    common,
    () => ({ degenerate: false }),
    { ANTHROPIC_KEY: "anthropic-secret" },
  );

  expect(openai).toMatchObject({ ok: true, text: "openai answer" });
  expect(anthropic).toMatchObject({ ok: true, text: "anthropic answer" });
  expect(requests).toHaveLength(2);
  const [openaiReq, anthropicReq] = requests;
  expect(openaiReq!.path).toBe("/v1/chat/completions");
  expect(openaiReq!.headers.get("authorization")).toBe("Bearer openai-secret");
  expect(openaiReq!.headers.get("x-api-key")).toBeNull();
  expect(openaiReq!.headers.get("anthropic-version")).toBeNull();
  expect(openaiReq!.body).toEqual({
    model: "openai-fixture",
    max_tokens: 77,
    messages: [
      { role: "system", content: "fixture system" },
      { role: "user", content: "keep context but hide [redacted:api-token]\ntool output" },
    ],
    thinking: { type: "disabled" },
  });
  expect(JSON.stringify(openaiReq!.body)).not.toContain(secret);

  expect(anthropicReq!.path).toBe("/v1/messages");
  expect(anthropicReq!.headers.get("x-api-key")).toBe("anthropic-secret");
  expect(anthropicReq!.headers.get("anthropic-version")).toBe("2023-06-01");
  expect(anthropicReq!.headers.get("authorization")).toBeNull();
  expect(anthropicReq!.body).toEqual({
    model: "anthropic-fixture",
    max_tokens: 77,
    system: "fixture system",
    messages: [{ role: "user", content: "keep context but hide [redacted:api-token]\ntool output" }],
  });
  expect(JSON.stringify(anthropicReq!.body)).not.toContain(secret);
});

test("known Coding Plan endpoints are blocked before fetch unless explicitly authorized", () => {
  const script = `
    const mod = await import("./src/provider.ts");
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; throw new Error("fetch must not run"); };
    const provider = { name: "zai-coding", kind: "anthropic", base: "https://api.z.ai/api/anthropic", model: "glm", key_env: "ZAI_KEY" };
    const result = await mod.callChain([provider], { system: "s", turns: [{ role: "user", text: "private", ordinal: 0 }], maxTokens: 1 }, () => ({ degenerate: false }), { ZAI_KEY: "present" });
    process.stdout.write(JSON.stringify({ result, fetches, readiness: mod.providerReadiness(provider, { ZAI_KEY: "present" }) }));
  `;
  const child = Bun.spawnSync({ cmd: [process.execPath, "--eval", script], cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  const value = JSON.parse(child.stdout.toString()) as { result: { ok: boolean; reason: string }; fetches: number; readiness: { ready: boolean; reason: string } };
  expect(value.fetches).toBe(0);
  expect(value.result.ok).toBe(false);
  expect(value.result.reason).toContain("Coding Plan endpoint blocked");
  expect(value.readiness.ready).toBe(false);
});

test("OpenAI-compatible failure falls through to Anthropic-compatible success", async () => {
  const paths: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path === "/v1/chat/completions") return new Response("busy", { status: 503 });
      return Response.json({ content: [{ type: "text", text: "fallback answer" }] });
    },
  });
  servers.push(server);
  const status = await callChain(
    [provider("openai", server.url.toString(), "primary"), provider("anthropic", server.url.toString(), "fallback")],
    { system: "system", turns: [{ role: "user", text: "question", ordinal: 0 }], maxTokens: 20 },
    () => ({ degenerate: false }),
    { OPENAI_KEY: "one", ANTHROPIC_KEY: "two" },
  );
  expect(status).toMatchObject({ ok: true, text: "fallback answer", provider: "fallback" });
  expect(paths).toEqual(["/v1/chat/completions", "/v1/messages"]);
});

test("OpenAI-compatible cancellation stops the chain before fallback", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return Response.json({ choices: [{ message: { content: "late answer" } }] });
    },
  });
  servers.push(server);
  const controller = new AbortController();
  const pending = callChain(
    [provider("openai", server.url.toString(), "primary"), provider("anthropic", server.url.toString(), "must-not-run")],
    { system: "system", turns: [{ role: "user", text: "question", ordinal: 0 }], maxTokens: 20, signal: controller.signal },
    () => ({ degenerate: false }),
    { OPENAI_KEY: "one", ANTHROPIC_KEY: "two" },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort("view closed");
  const status = await pending;
  expect(status).toMatchObject({ ok: false, reason: "cancelled", cancelled: true });
  expect(requests).toBe(1);
});
