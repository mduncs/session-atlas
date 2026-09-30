import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { hookSessionId, noteHookArgs } from "../scripts/note-hook.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

test("SessionEnd adapter accepts both harness ids and defaults to ingest-only", () => {
  expect(hookSessionId({ session_id: " claude-id " })).toBe("claude-id");
  expect(hookSessionId({ thread_id: "codex-id" })).toBe("codex-id");
  expect(hookSessionId({ session_id: "" })).toBeNull();
  expect(noteHookArgs("claude", "id", false, "/repo")).toEqual([
    process.execPath, "/repo/src/cli.ts", "note", "id", "--harness", "claude", "--ingest-only",
  ]);
  expect(noteHookArgs("codex", "id", true, "/repo")).not.toContain("--ingest-only");
});

test("real hook invocation ingests the target while a configured provider remains untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-note-hook-")); roots.push(root);
  const source = join(root, "claude");
  const project = join(source, "-repo");
  const configHome = join(root, "config");
  const dataHome = join(root, "data");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(configHome, "session-atlas"), { recursive: true });
  const id = "hook-session";
  const record = (role: "user" | "assistant", text: string, offset: number) => JSON.stringify({
    type: role,
    sessionId: id,
    cwd: "/repo",
    timestamp: new Date(1_700_000_000_000 + offset).toISOString(),
    message: { role, content: role === "assistant" ? [{ type: "text", text }] : text, ...(role === "assistant" ? { model: "opus" } : {}) },
  });
  writeFileSync(join(project, `${id}.jsonl`), `${record("user", "hook question", 0)}\n${record("assistant", "hook answer", 1)}\n`);
  writeFileSync(join(configHome, "session-atlas/config.toml"), [
    `dbPath = ${JSON.stringify(join(dataHome, "session-atlas/atlas.db"))}`,
    `[sources.claude]`,
    `roots = [${JSON.stringify(source)}]`,
    `[[providers]]`,
    `name = "must-not-run"`,
    `base = "http://127.0.0.1:1"`,
    `kind = "openai"`,
    `model = "forbidden"`,
    `key_env = "HOOK_PROVIDER_KEY"`,
    "",
  ].join("\n"));

  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../scripts/note-hook.ts"), "claude"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome, HOOK_PROVIDER_KEY: "present" },
  });
  child.stdin.write(JSON.stringify({ session_id: id }));
  child.stdin.end();
  expect(await child.exited).toBe(0);

  // The hook is deliberately fire-and-forget: its wrapper exits before the
  // detached note process finishes. Wait for the durable terminal evidence
  // instead of making the integration test depend on scheduler timing.
  const db = await waitForTargetedIngest(join(dataHome, "session-atlas/atlas.db"), id);
  expect((db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE native_id=?`).get(id) as { n: number }).n).toBe(1);
  expect((db.prepare(`SELECT COUNT(*) AS n FROM summaries`).get() as { n: number }).n).toBe(0);
  expect((db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get() as { n: number }).n).toBe(0);
  db.close();
});

async function waitForTargetedIngest(dbPath: string, nativeId: string): Promise<Database> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const row = db.prepare(`
        SELECT s.id,
               r.status,
               r.finished_at
          FROM sessions s
          LEFT JOIN targeted_ingest_runs r
            ON r.native_id=s.native_id
         WHERE s.native_id=?
         ORDER BY r.id DESC
         LIMIT 1
      `).get(nativeId) as { id: number; status: string | null; finished_at: number | null } | null;
      if (row?.id && row.status !== "running" && row.finished_at !== null) return db;
      db.close();
    } catch {
      db?.close();
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for targeted ingest ${nativeId}`);
}
