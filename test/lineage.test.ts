import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "../src/db/index.js";
import { rebuildLogicalMetrics } from "../src/logical-metrics.js";
import { humanText, projectRoot, resolveLineage, splitEras, type CwdStat, type LineageSession } from "../src/lineage.js";

const DAY = 86_400_000;

function stat(cwd: string, sessions = 1, first = 0): CwdStat {
  return { cwd, sessions, first, last: first, harnesses: { claude: sessions } };
}

function reasons(scope: ReturnType<typeof resolveLineage>): Record<string, string> {
  return Object.fromEntries([...scope.included, ...scope.nearby].map((path) => [path.cwd, path.reason]));
}

test("a moved project rejoins its old location, including subdirectory-only history", () => {
  const scope = resolveLineage([
    stat("/Users/dev/code/caduca/web"),
    stat("/Volumes/Data/code/caduca"),
    stat("/Volumes/Data/code/caduca/packages/shared"),
    stat("/Volumes/Data/code/other"),
  ], "/Volumes/Data/code/caduca");
  expect(reasons(scope)).toEqual({
    "/Users/dev/code/caduca/web": "moved",
    "/Volumes/Data/code/caduca": "exact",
    "/Volumes/Data/code/caduca/packages/shared": "inside",
  });
  expect(scope.name).toBe("caduca");
});

test("a same-named directory counts as moved only where projects live", () => {
  const collection = Array.from({ length: 8 }, (_, index) => stat(`/Users/dev/code/p${index}`));
  const scope = resolveLineage([
    ...collection,
    stat("/private/tmp"),
    stat("/Users/dev/code/spatial-audio-sim-ios/demo-visual/ghidra"),
    stat("/Volumes/External/code/ghidra"),
    stat("/Users/dev/.codex/worktrees/876e/ghidra"),
  ], "/Users/dev/code/ghidra");
  expect(scope.included.map((path) => [path.cwd, path.reason])).toEqual([
    ["/Users/dev/.codex/worktrees/876e/ghidra", "moved"],
    ["/Volumes/External/code/ghidra", "moved"],
  ]);
  expect(reasons(scope)["/Users/dev/code/spatial-audio-sim-ios/demo-visual/ghidra"]).toBe("similar");
  expect(resolveLineage([...collection, stat("/private/tmp")], "/Users/dev/code/tmp").included).toEqual([]);
});

test("an included cwd keeps its stored spelling", () => {
  expect(resolveLineage([stat("/Users/dev/code/caduca/")], "/Volumes/Data/code/caduca").included[0]?.cwd).toBe("/Users/dev/code/caduca/");
});

test("renames between x-y and x/y resolve in both directions", () => {
  const stats = [stat("/Users/dev/code/spatial-audio-engine"), stat("/Volumes/Data/code/spatial-audio/engine")];
  expect(reasons(resolveLineage(stats, "/Volumes/Data/code/spatial-audio/engine"))["/Users/dev/code/spatial-audio-engine"]).toBe("renamed");
  expect(reasons(resolveLineage(stats, "/Users/dev/code/spatial-audio-engine"))["/Volumes/Data/code/spatial-audio/engine"]).toBe("renamed");
});

test("worktrees and role directories resolve to the project root", () => {
  expect(projectRoot("/Volumes/Data/code/kinetic/worktrees/concave-world")).toBe("/Volumes/Data/code/kinetic");
  expect(projectRoot("/Volumes/Data/code/app/.claude/worktrees/fix")).toBe("/Volumes/Data/code/app");
  expect(projectRoot("/Volumes/Data/code/nodraw/source")).toBe("/Volumes/Data/code/nodraw");
  expect(projectRoot("/Volumes/Data/code/splay/worktrees/interactions/prototype/app")).toBe("/Volumes/Data/code/splay");
  expect(projectRoot("/Volumes/Data/code/unicode-space-wt-c3")).toBe("/Volumes/Data/code/unicode-space");
  expect(projectRoot("/Users/dev/.codex/worktrees/876e/nodraw/Sources")).toBe("/Users/dev/.codex/worktrees/876e/nodraw");
  // A collection root never swallows the project, however common its name.
  expect(projectRoot("/Volumes/Data/code")).toBe("/Volumes/Data/code");

  const scope = resolveLineage([
    stat("/Users/dev/code/nodraw"),
    stat("/Volumes/Data/code/nodraw/source"),
    stat("/Volumes/Data/code/sunpaper/source"),
    stat("/Volumes/Data/code/unicode-space-wt-c3"),
  ], "/Volumes/Data/code/nodraw/source");
  expect(scope.target).toBe("/Volumes/Data/code/nodraw");
  expect(scope.requested).toBe("/Volumes/Data/code/nodraw/source");
  expect(reasons(scope)).toEqual({ "/Users/dev/code/nodraw": "moved", "/Volumes/Data/code/nodraw/source": "inside" });

  expect(reasons(resolveLineage([stat("/Volumes/Data/code/unicode-space-wt-c3")], "/Volumes/Data/code/unicode-space")))
    .toEqual({ "/Volumes/Data/code/unicode-space-wt-c3": "worktree" });
});

test("prefix names and small parents are suggested, never included; collections are not parents", () => {
  const collection = Array.from({ length: 9 }, (_, index) => stat(`/Volumes/Data/code/p${index}`));
  const scope = resolveLineage([
    ...collection,
    stat("/Volumes/Data/code"),
    stat("/Volumes/Data/code/research"),
    stat("/Users/dev/code/research/hydraulic-immigration"),
  ], "/Volumes/Data/code/research/hydraulic-immigration-BROKEN");
  expect(scope.included).toEqual([]);
  expect(reasons(scope)).toEqual({
    "/Volumes/Data/code/research": "parent",
    "/Users/dev/code/research/hydraulic-immigration": "similar",
  });
});

test("--also adds a path and --exclude removes one the resolver chose", () => {
  const stats = [stat("/Volumes/Data/code/kinetic-tiles"), stat("/Users/dev/code/kinetic"), stat("/Volumes/Data/code/kinetic")];
  const scope = resolveLineage(stats, "/Volumes/Data/code/kinetic", {
    also: ["/Volumes/Data/code/kinetic-tiles/"],
    exclude: ["/Users/dev/code/kinetic"],
  });
  expect(reasons(scope)).toEqual({ "/Volumes/Data/code/kinetic-tiles": "also", "/Volumes/Data/code/kinetic": "exact" });
});

test("human text drops harness-injected records and keeps slash-command arguments", () => {
  expect(humanText("<task-notification> <task-id>x</task-id>")).toBeNull();
  expect(humanText("# AGENTS.md instructions for /x\n<INSTRUCTIONS>")).toBeNull();
  expect(humanText("<recommended_plugins> Here is a list")).toBeNull();
  expect(humanText("Base directory for this skill: /Users/dev/.claude/skills/fav")).toBeNull();
  expect(humanText("<subagent_notification>{\"agent_path\":\"x\"}</subagent_notification>")).toBeNull();
  expect(humanText("{\"agent_path\":\"019d\",\"status\":{\"completed\":\"**Findings**\"}}")).toBeNull();
  expect(humanText("<goal_context>ship it</goal_context>")).toBeNull();
  expect(humanText("Stop hook feedback: vibe check failed")).toBeNull();
  expect(humanText("The TodoWrite tool hasn't been used recently. If you're working")).toBeNull();
  expect(humanText("<send_user_message_question_reply>use the blue one</send_user_message_question_reply>")).not.toBeNull();
  expect(humanText("<command-name>/clear</command-name> <command-message>clear</command-message> <command-args></command-args>")).toBeNull();
  expect(humanText("<command-name>/spec</command-name>\n<command-message>spec</command-message>\n<command-args>build the canvas</command-args>"))
    .toBe("/spec build the canvas");
  expect(humanText("  make it less uggo pls  ")).toBe("make it less uggo pls");
});

test("eras split only after the idle gap, measured from the latest activity so far", () => {
  const session = (id: number, start: number, last = start): LineageSession =>
    ({ id, harness: "claude", nativeId: String(id), cwd: "/p", start, last, msgCount: 1, title: null, origin: "human" });
  const eras = splitEras([session(1, 0, 5 * DAY), session(2, 2 * DAY), session(3, 7 * DAY), session(4, 20 * DAY)], 3);
  expect(eras.map((era) => era.sessions.map((s) => s.id))).toEqual([[1, 2, 3], [4]]);
});

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

test("atlas lineage reads across moved paths, hides subagents, and leaves the archive untouched", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-lineage-cli-")); roots.push(root);
  const dbPath = join(root, "atlas.db");
  const configPath = join(root, "config.toml");
  const db = new Database(dbPath); runMigrations(db);
  const generation = "fixture-v11:lineage";
  const start = Date.parse("2026-06-06T12:00:00Z");
  const addSession = (nativeId: string, cwd: string, at: number, origin: string, turns: Array<["user" | "assistant", string]>): number => {
    const id = Number(db.prepare(
      `INSERT INTO sessions(
         harness,native_id,source_path,cwd,title,start_ts,last_activity,models,ingested_at,msg_count,transcript_bytes,origin,
         artifact_kind,history_completeness,construction_generation,construction_status,default_session_visible,
         source_validation_status,source_observed_ts
       ) VALUES ('claude',?,?,?,?,?,?,'[]',?,?,30,?,'dialogue_history','complete',?,'valid',1,'current',?)`,
    ).run(nativeId, `/fixture/${nativeId}`, cwd, `${nativeId} title`, at, at, at, turns.length, origin, generation, at).lastInsertRowid);
    turns.forEach(([side, text], ordinal) => {
      db.prepare(
        `INSERT INTO messages(
           session_id,ordinal,source_ordinal,role,ts,text,prose,event_ts,has_tool,tok_estimate,
           record_kind,dialogue_side,source_record_id,source_record_ts,source_identity_kind,construction_generation
         ) VALUES (?,?,?,?,?,?,?,?,0,10,?,?,?,?,'record-id',?)`,
      ).run(id, ordinal, ordinal, side, at, text, text, at, side === "user" ? "real_user" : "assistant_dialogue_prose", side,
        `${nativeId}-${ordinal}`, at, generation);
    });
    rebuildLogicalMetrics(db, id, generation);
    return id;
  };
  const origin = addSession("origin", "/Users/dev/code/caduca", start, "human", [
    ["user", "build a whiteboard where every variant is an immutable fork"],
    ["assistant", "Scaffolded the variant tree."],
    ["user", "<task-notification> <task-id>x</task-id>"],
  ]);
  addSession("worker", "/Users/dev/code/caduca", start + DAY, "agent", [["user", "You are lane 3: build the MCP stub"]]);
  const resumed = addSession("resumed", "/Volumes/Data/code/caduca", start + 90 * DAY, "human", [
    ["user", "build a whiteboard where every variant is an immutable fork"],
    ["user", "make LiveFrames editable"],
    ["assistant", "Done."],
    ["user", "make LiveFrames editable"],
  ]);
  db.close();
  const disabledSources = ["claude", "codex", "prime", "hermes", "kimi", "zcode", "kilo"]
    .map((source) => `[sources.${source}]\nmode = "disabled"\nreason = "lineage fixture owns no source"\n`)
    .join("\n");
  writeFileSync(configPath, `dbPath = ${JSON.stringify(dbPath)}\n\n${disabledSources}`);
  const before = fingerprint(dbPath);

  const overview = await run(["lineage", "/Volumes/Data/code/caduca", "--config", configPath]);
  expect(overview.code).toBe(0);
  expect(overview.stdout).toContain("2 session(s) · 1 agent-launched session(s) hidden");
  expect(overview.stdout).toMatch(/moved\s+\/Users\/dev\/code\/caduca/u);
  expect(overview.stdout).toMatch(/exact\s+\/Volumes\/Data\/code\/caduca/u);
  expect(overview.stdout).toContain("--messages --from 2026-06-06 --to 2026-06-07");
  expect(overview.stdout).not.toContain("worker title");

  const messages = await run(["lineage", "/Volumes/Data/code/caduca", "--replies", "--config", configPath]);
  expect(messages.code).toBe(0);
  expect(messages.stdout).toContain(`◆ #${origin}:0  build a whiteboard where every variant is an immutable fork`);
  expect(messages.stdout).toContain("↳ Scaffolded the variant tree.");
  expect(messages.stdout).toContain(`◆ #${resumed}:1  make LiveFrames editable`);
  expect(messages.stdout).toContain("1 message(s) replayed from an earlier session skipped");
  expect(messages.stdout).toContain(`◆ #${resumed}:3  make LiveFrames editable`);
  expect(messages.stdout).not.toContain("task-notification");
  expect(messages.stdout).not.toContain("lane 3");

  const help = await run(["lineage", "--help", "--config", join(root, "missing.toml")]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("Usage: atlas lineage");
  const inherited = await run(["constructor", "--help"]);
  expect(inherited.code).toBe(0);
  expect(inherited.stdout).toContain("atlas — Session Atlas");

  expect(fingerprint(dbPath)).toEqual(before);
});

async function run(args: string[]): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn([Bun.which("bun") ?? "bun", join(import.meta.dir, "../src/cli.ts"), ...args], {
    stdout: "pipe", stderr: "pipe", env: { ...cleanEnv(), ATLAS_SEARCH_LOG: "0" },
  });
  const stdout = await new Response(child.stdout).text();
  return { code: await child.exited, stdout };
}

function fingerprint(path: string): { size: number; sha256: string } {
  return { size: statSync(path).size, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}

function cleanEnv(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "FORCE_COLOR" && value !== undefined)) as Record<string, string>;
  env.NO_COLOR = "1";
  return env;
}
