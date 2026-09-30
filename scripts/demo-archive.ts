#!/usr/bin/env bun
/**
 * Build the fictional Session Atlas demo archive.
 *
 *   bun scripts/demo-archive.ts --out /tmp/atlas-demo      build config + DB + layers
 *   bun scripts/demo-archive.ts --emit-sources             regenerate demo/sources from demo/story.ts
 *   bun scripts/demo-archive.ts --check-sources            fail if demo/sources drifted from the story
 *
 * The build copies demo/sources into <out>/sources, writes <out>/config.toml
 * (claude + codex roots inside <out>, every other source disabled, no
 * provider), runs the real provider-free `atlas index` and `atlas layers all`,
 * then seeds the model-derived layer tables and tier-1 summaries with
 * hand-authored rows labeled `fixture`. It never reads or writes the live archive, config, or real
 * transcript directories, and it makes no provider calls.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { defaultConfigPath, defaultDataDir, defaultDbPath, loadConfig, HARNESS_IDS } from "../src/config.js";
import { layersPathFor, openLayersDb } from "../src/layers/db.js";
import { candidateUnits, normalizeTag, sha256, FACETS } from "../src/layers/tasks.js";
import {
  EPISODE_LABELS, SESSION_TAGS, SESSIONS, SUMMARIES, TAG_MERGES, TIER2, WALL_BREAKS_AT, WALL_OF_TEXT,
  type Event, type SessionSpec,
} from "../demo/story.js";

const REPO = resolve(import.meta.dir, "..");
const SOURCES = join(REPO, "demo", "sources");
const MARKER = ".atlas-demo-archive";
/** Every fixture layer and summary row carries this in its model/source column. */
const FIXTURE = "fixture";
/** Fixed so rebuilds produce identical layer rows. */
const FIXTURE_AT = Date.parse("2026-09-25T00:00:00Z");
const SECRET = /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,})\b/;
/** Real-machine shapes: any home other than the fictional one, mounted volumes, or a non-example email. */
const STRUCTURAL: [RegExp, string][] = [
  [/\/Users\/(?!demo\b|Shared\b)[A-Za-z0-9._-]+/, "non-demo /Users path"],
  [/\/home\/[A-Za-z0-9._-]+/, "/home path"],
  [/\/Volumes\//, "mounted volume path"],
  [/[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9-]+\.[A-Za-z.]{2,}/, "email address"],
];

/**
 * The builder's own identity strings: home directory, login, and git author.
 * Derived at build time so the owner's identifiers never live in this file;
 * ATLAS_DEMO_FORBID adds more (comma-separated).
 */
export function forbiddenStrings(env: NodeJS.ProcessEnv = process.env): string[] {
  const git = (key: string) => Bun.spawnSync(["git", "config", "--get", key], { cwd: REPO, stdout: "pipe", stderr: "ignore" }).stdout.toString().trim();
  const email = git("user.email");
  const values = [homedir(), git("user.name"), email, email.split("@")[0] ?? "", ...(env.ATLAS_DEMO_FORBID ?? "").split(",")];
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length >= 4 && value !== "/Users/demo"))];
}

// ─── identities and clocks ────────────────────────────────────────────────

const hex = (seed: string) => createHash("sha256").update(`atlas-demo:${seed}`).digest("hex");
export function uuidFor(seed: string): string {
  const h = hex(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${"89ab"[parseInt(h[16]!, 16) & 3]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const agentIdFor = (key: string) => hex(`agent:${key}`).slice(0, 17);
/** Harness identity for a story session, as the archive stores it. */
export function nativeIdFor(spec: SessionSpec): string {
  return spec.harness === "claude" && spec.launch === "subagent" ? `agent-${agentIdFor(spec.key)}` : uuidFor(spec.key);
}
const byKey = new Map(SESSIONS.map((spec) => [spec.key, spec]));
const iso = (ms: number) => new Date(ms).toISOString();
/** Reading the last answer and typing the next prompt. */
const typing = (text: string) => 70_000 + Math.min(540_000, text.length * 200);
const answering = (text: string) => 25_000 + Math.min(240_000, text.length * 45);
const running = (output: string) => 9_000 + Math.min(100_000, output.length * 60);

// ─── source emission ──────────────────────────────────────────────────────

interface Emitted { files: Map<string, string>; mtimes: Map<string, number>; codexIndex: string[] }

/** Render every story session into real on-disk transcript files (relative path → content). */
export function renderSources(): Emitted {
  const out: Emitted = { files: new Map(), mtimes: new Map(), codexIndex: [] };
  for (const spec of SESSIONS) {
    if (spec.parent) continue; // workers are written when their parent spawns them
    if (!spec.start) throw new Error(`${spec.key}: top-level sessions need a start time`);
    emitSession(spec, Date.parse(spec.start), out);
  }
  out.files.set("codex/session_index.jsonl", out.codexIndex.join(""));
  return out;
}

function emitSession(spec: SessionSpec, start: number, out: Emitted): number {
  return spec.harness === "claude" ? emitClaude(spec, start, out) : emitCodex(spec, start, out);
}

function childOf(parent: SessionSpec, key: string): SessionSpec {
  const child = byKey.get(key);
  if (!child || child.parent !== parent.key) throw new Error(`${parent.key}: worker ${key} must name it as parent`);
  return child;
}

function emitClaude(spec: SessionSpec, start: number, out: Emitted): number {
  const sessionUuid = uuidFor(spec.key);
  const worker = spec.launch === "subagent";
  const parentUuid = worker ? uuidFor(spec.parent!) : null;
  const slug = spec.cwd.replace(/[^A-Za-z0-9]/g, "-");
  const rel = worker
    ? `claude/projects/${slug}/${parentUuid}/subagents/${nativeIdFor(spec)}.jsonl`
    : `claude/projects/${slug}/${sessionUuid}.jsonl`;
  const lines: string[] = [];
  let clock = start, n = 0, previous: string | null = null;
  const base = () => ({
    parentUuid: previous,
    isSidechain: worker,
    userType: "external",
    cwd: spec.cwd,
    sessionId: worker ? parentUuid : sessionUuid,
    version: "2.1.20",
    gitBranch: "main",
    ...(worker ? { agentId: agentIdFor(spec.key) } : {}),
    ...(spec.launch === "sdk" ? { entrypoint: "sdk-ts" } : { entrypoint: "cli" }),
  });
  const push = (record: Record<string, unknown>) => {
    const uuid = uuidFor(`${spec.key}:${n++}`);
    lines.push(JSON.stringify({ ...base(), ...record, uuid, timestamp: iso(clock) }));
    previous = uuid;
  };
  const user = (content: unknown, extra: Record<string, unknown> = {}) =>
    push({ type: "user", message: { role: "user", content }, ...extra });
  const assistant = (content: unknown[]) => push({
    type: "assistant",
    requestId: `req_${hex(`${spec.key}:req:${n}`).slice(0, 24)}`,
    message: {
      id: `msg_${hex(`${spec.key}:msg:${n}`).slice(0, 24)}`, type: "message", role: "assistant", model: spec.model,
      content, stop_reason: content.some((block) => (block as { type: string }).type === "tool_use") ? "tool_use" : "end_turn",
      usage: { input_tokens: 1200 + n * 40, output_tokens: 80 + n * 3 },
    },
  });
  const toolCall = (name: string, input: Record<string, unknown>, result: string) => {
    const id = `toolu_${hex(`${spec.key}:tool:${n}`).slice(0, 24)}`;
    clock += 6_000;
    assistant([{ type: "tool_use", id, name, input }]);
    clock += running(result);
    user([{ type: "tool_result", tool_use_id: id, content: result }]);
  };

  for (const event of spec.events) {
    switch (event.kind) {
      case "gap": clock += event.minutes * 60_000; break;
      case "user": clock += typing(event.text); user(event.text); break;
      case "assistant": clock += answering(event.text); assistant([{ type: "text", text: event.text }]); break;
      case "tool": toolCall(...claudeTool(spec, event)); break;
      case "task": {
        const child = childOf(spec, event.child);
        const id = `toolu_${hex(`${spec.key}:task:${n}`).slice(0, 24)}`;
        clock += 4_000;
        assistant([{ type: "tool_use", id, name: "Task", input: { description: event.description, prompt: event.prompt, subagent_type: "general-purpose" } }]);
        clock = emitSession(child, clock + 2_000, out) + 3_000;
        user([{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: event.result }] }]);
        break;
      }
      case "compact": {
        clock += typing(event.command);
        user(event.command);
        clock += 40_000;
        push({ type: "system", subtype: "compact_boundary", content: "Conversation compacted", level: "info", compactMetadata: { trigger: "manual", preTokens: 48_000 + n * 500 } });
        const boundary: string | null = previous;
        clock += 1_000;
        user(`This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\n\n<summary>\n${event.summary}\n</summary>`, { isCompactSummary: true, isVisibleInTranscriptOnly: true });
        // The next prompt continues from the boundary. Chained to the hidden
        // summary, the adapter would (correctly) file it as utility follow-up.
        previous = boundary;
        break;
      }
      case "spawn": throw new Error(`${spec.key}: spawn is a Codex event; use task for Claude`);
    }
  }
  if (spec.title) push({ type: "custom-title", customTitle: spec.title });
  out.files.set(rel, lines.map((line) => `${line}\n`).join(""));
  out.mtimes.set(rel, clock);
  return clock;
}

function claudeTool(spec: SessionSpec, event: Extract<Event, { kind: "tool" }>): [string, Record<string, unknown>, string] {
  switch (event.name) {
    case "sh": return ["Bash", { command: event.arg }, event.out];
    case "read": return ["Read", { file_path: join(spec.cwd, event.arg) }, event.out];
    case "grep": return ["Grep", { pattern: event.arg, output_mode: "content", "-n": true }, event.out];
    case "edit": return ["Edit", { file_path: join(spec.cwd, event.arg), old_string: "", new_string: event.detail ?? "" }, event.out];
  }
}

function emitCodex(spec: SessionSpec, start: number, out: Emitted): number {
  const id = uuidFor(spec.key);
  const stamp = iso(start).slice(0, 19).replace(/:/g, "-");
  const [y, m, d] = iso(start).slice(0, 10).split("-");
  const rel = `codex/sessions/${y}/${m}/${d}/rollout-${stamp}-${id}.jsonl`;
  const lines: string[] = [];
  let clock = start, n = 0;
  const push = (type: string, payload: Record<string, unknown>) => lines.push(JSON.stringify({ timestamp: iso(clock), type, payload }));
  const item = (payload: Record<string, unknown>) => push("response_item", payload);
  const message = (role: "user" | "assistant", text: string) => item({
    type: "message", id: `msg_${hex(`${spec.key}:msg:${n++}`).slice(0, 24)}`, role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  });
  const source = spec.launch === "exec" ? "exec"
    : spec.launch === "thread_spawn" ? { subagent: { thread_spawn: { parent_thread_id: uuidFor(spec.parent!), depth: 1 } } }
      : "cli";
  push("session_meta", {
    id, timestamp: iso(start), cwd: spec.cwd, originator: spec.launch === "exec" ? "codex_exec" : "codex_cli_rs",
    cli_version: "0.46.0", instructions: null, source, model_provider: "openai", git: { branch: "main" },
  });
  if (spec.launch === "exec") {
    message("user", `# AGENTS.md instructions for ${spec.cwd}\n\n<INSTRUCTIONS>\nRun tests with cargo. Never edit files under fixtures/.\n</INSTRUCTIONS>`);
  }
  message("user", `<environment_context>\n  <cwd>${spec.cwd}</cwd>\n  <approval_policy>${spec.launch === "cli" ? "on-request" : "never"}</approval_policy>\n  <sandbox_mode>workspace-write</sandbox_mode>\n  <network_access>restricted</network_access>\n  <shell>zsh</shell>\n</environment_context>`);
  const call = (name: string, args: string, output: string, custom = false) => {
    const callId = `call_${hex(`${spec.key}:call:${n++}`).slice(0, 24)}`;
    clock += 6_000;
    item(custom
      ? { type: "custom_tool_call", id: `ctc_${callId.slice(5)}`, status: "completed", call_id: callId, name, input: args }
      : { type: "function_call", id: `fc_${callId.slice(5)}`, name, arguments: args, call_id: callId });
    clock += running(output);
    item(custom
      ? { type: "custom_tool_call_output", call_id: callId, output }
      : { type: "function_call_output", call_id: callId, output: JSON.stringify({ output, metadata: { exit_code: 0, duration_seconds: 1.4 } }) });
  };
  const shell = (command: string, output: string) =>
    call("shell", JSON.stringify({ command: ["bash", "-lc", command], workdir: spec.cwd, timeout_ms: 120_000 }), output);

  for (const event of spec.events) {
    switch (event.kind) {
      case "gap": clock += event.minutes * 60_000; break;
      case "user":
        clock += typing(event.text);
        push("turn_context", { cwd: spec.cwd, approval_policy: spec.launch === "cli" ? "on-request" : "never", sandbox_policy: { mode: "workspace-write" }, model: spec.model, effort: "medium", summary: "auto" });
        message("user", event.text);
        break;
      case "assistant": clock += answering(event.text); message("assistant", event.text); break;
      case "tool":
        if (event.name === "sh") shell(event.arg, event.out);
        else if (event.name === "read") shell(`sed -n '1,120p' ${event.arg}`, event.out);
        else if (event.name === "grep") shell(`rg -n '${event.arg}' src`, event.out);
        else call("apply_patch", `*** Begin Patch\n*** Update File: ${event.arg}\n@@\n+// ${event.detail ?? ""}\n*** End Patch`, event.out, true);
        break;
      case "spawn": {
        const child = childOf(spec, event.child);
        const callId = `call_${hex(`${spec.key}:spawn:${n++}`).slice(0, 24)}`;
        clock += 4_000;
        item({ type: "function_call", id: `fc_${callId.slice(5)}`, name: "spawn_agent", arguments: JSON.stringify({ prompt: event.prompt }), call_id: callId });
        clock = emitSession(child, clock + 2_000, out) + 3_000;
        item({ type: "function_call_output", call_id: callId, output: JSON.stringify({ thread_id: uuidFor(child.key), status: "completed", result: event.result }) });
        break;
      }
      case "task":
      case "compact": throw new Error(`${spec.key}: ${event.kind} is a Claude event`);
    }
  }
  if (spec.title) out.codexIndex.push(`${JSON.stringify({ id, thread_name: spec.title, updated_at: iso(clock) })}\n`);
  out.files.set(rel, lines.map((line) => `${line}\n`).join(""));
  out.mtimes.set(rel, clock);
  return clock;
}

function writeSources(dir: string): number {
  const emitted = renderSources();
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of emitted.files) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  stampMtimes(dir, emitted);
  return emitted.files.size;
}

/** Transcript mtimes follow each session's last record, like a real harness. */
function stampMtimes(dir: string, emitted: Emitted): void {
  for (const [rel, ms] of emitted.mtimes) utimesSync(join(dir, rel), ms / 1000, ms / 1000);
}

/** Paths whose content differs between demo/sources and the story (empty = in sync). */
export function sourceDrift(dir = SOURCES): string[] {
  const emitted = renderSources();
  const onDisk = existsSync(dir) ? listFiles(dir).map((path) => relative(dir, path)) : [];
  const drift = onDisk.filter((rel) => !emitted.files.has(rel));
  for (const [rel, content] of emitted.files) {
    const path = join(dir, rel);
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) drift.push(rel);
  }
  return drift.sort();
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path));
    else if (entry.isFile() && entry.name !== ".DS_Store") out.push(path);
  }
  return out;
}

// ─── build guard ──────────────────────────────────────────────────────────

/** Resolve through symlinks, including a not-yet-existing tail. */
function canonical(path: string): string {
  let cursor = resolve(path);
  const tail: string[] = [];
  while (!existsSync(cursor)) {
    tail.unshift(cursor.slice(dirname(cursor).length + 1));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return join(realpathSync(cursor), ...tail);
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** Refuse any output location that could be (or contain) the live archive or real transcripts. */
export function assertSafeOut(out: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isAbsolute(out)) throw new Error(`--out must be absolute (got ${out})`);
  const target = canonical(out);
  const protectedRoots = [
    defaultDataDir(env), dirname(defaultConfigPath(env)), dirname(defaultDbPath(env)),
    join(homedir(), ".claude"), join(homedir(), ".codex"), join(homedir(), ".local", "share", "session-atlas"),
    join(homedir(), ".config", "session-atlas"),
  ].map(canonical);
  for (const root of protectedRoots) {
    if (inside(target, root) || inside(root, target)) throw new Error(`refusing --out ${out}: overlaps protected path ${root}`);
  }
  if (/\/\.(local\/share|config)\/session-atlas(\/|$)/.test(target)) throw new Error(`refusing --out ${out}: looks like a live Atlas data/config directory`);
  if (inside(target, canonical(REPO))) throw new Error(`refusing --out ${out}: build outside the repository`);
  if (existsSync(target) && readdirSync(target).length > 0 && !existsSync(join(target, MARKER))) {
    throw new Error(`refusing --out ${out}: directory is not empty and was not created by this builder (no ${MARKER})`);
  }
  return target;
}

// ─── build ────────────────────────────────────────────────────────────────

/** The one launcher the demo config offers; harmless by construction. */
const DEMO_LAUNCHER = { name: "next-session", cmd: "less {payload}" };

function configToml(out: string): string {
  const lines = [
    "# Session Atlas demo archive: fictional sessions only.",
    "# Built by scripts/demo-archive.ts. No providers; every root lives inside this directory.",
    `dbPath = ${JSON.stringify(join(out, "atlas.db"))}`,
    "",
    "# Demo continuation target: it only prints the exported payload.",
    "[[launchers]]", `name = ${JSON.stringify(DEMO_LAUNCHER.name)}`, `cmd = ${JSON.stringify(DEMO_LAUNCHER.cmd)}`, "",
    "[sources.claude]", 'mode = "replace"', `roots = [${JSON.stringify(join(out, "sources", "claude", "projects"))}]`, "",
    "[sources.codex]", 'mode = "replace"', `roots = [${JSON.stringify(join(out, "sources", "codex"))}]`, "",
  ];
  for (const source of HARNESS_IDS.filter((id) => id !== "claude" && id !== "codex")) {
    lines.push(`[sources.${source}]`, 'mode = "disabled"', 'reason = "demo archive ships claude and codex fixtures only"', "");
  }
  return lines.join("\n");
}

function atlas(args: string[], configPath: string): string {
  // A clean environment: no caller identity leaks into the demo search log.
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", ATLAS_SEARCH_LOG: "0", NO_COLOR: "1" };
  const run = Bun.spawnSync([process.execPath, join(REPO, "src", "cli.ts"), ...args, "--config", configPath], { cwd: REPO, env, stdout: "pipe", stderr: "pipe" });
  const stdout = run.stdout.toString(), stderr = run.stderr.toString();
  if (run.exitCode !== 0) throw new Error(`atlas ${args.join(" ")} exited ${run.exitCode}\n${stdout}${stderr}`);
  return stdout + stderr;
}

export interface BuildSummary {
  out: string;
  dbPath: string;
  sessions: Record<string, number>;
  creators: Record<string, number>;
  shapes: Record<string, number>;
  episodes: { total: number; labeled: number };
  tags: { detail: number; facets: number; merges: number };
  paragraphs: number;
  summaries: { tier1: number; tier2: number; anchors: number; fixture: number };
  rejected: number;
  privacy: { scannedFiles: number; hits: string[]; buildRootReferences: number };
}

export async function buildDemoArchive(outArg: string, log: (line: string) => void = () => {}): Promise<BuildSummary> {
  const out = assertSafeOut(outArg);
  const drift = sourceDrift();
  if (drift.length) throw new Error(`demo/sources drifted from demo/story.ts (${drift.length} files); run --emit-sources`);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, MARKER), "built by scripts/demo-archive.ts\n");
  for (const entry of readdirSync(out)) {
    if (entry === "sources" || entry === "exports" || entry === "config.toml" || entry === "summary.json" || entry.startsWith("atlas.")) rmSync(join(out, entry), { recursive: true, force: true });
  }
  cpSync(SOURCES, join(out, "sources"), { recursive: true, preserveTimestamps: true });
  stampMtimes(join(out, "sources"), renderSources());
  const configPath = join(out, "config.toml");
  writeFileSync(configPath, configToml(out), { mode: 0o600 });

  // The resolved plan must stay inside <out> before anything opens a database.
  const config = await loadConfig(configPath, { bootstrap: false });
  const dbPath = config.dbPath;
  if (dbPath !== join(out, "atlas.db")) throw new Error(`resolved dbPath ${dbPath} is not ${join(out, "atlas.db")}`);
  for (const source of HARNESS_IDS) {
    const plan = config.sources[source];
    if (plan.mode === "disabled") continue;
    if (!plan.roots.every((root) => inside(root, join(out, "sources")))) throw new Error(`${source} roots escape the demo: ${plan.roots.join(", ")}`);
  }
  if ((config.providers ?? []).length) throw new Error("demo config must not define providers");
  if (JSON.stringify(config.launchers) !== JSON.stringify([DEMO_LAUNCHER])) throw new Error(`demo config launchers drifted: ${JSON.stringify(config.launchers)}`);
  log(`config · ${configPath} · dbPath ${dbPath}`);

  log(atlas(["index"], configPath).trimEnd());
  log(atlas(["layers", "all"], configPath).trimEnd());
  const seeded = seedFixtureLayers(dbPath);
  log(`fixture layers · ${seeded.paragraphs} paragraph row · ${seeded.labeled} episode labels · ${seeded.tagRows} tag rows · ${TAG_MERGES.length} merges`);
  const summaries = seedFixtureSummaries(dbPath);
  log(`fixture summaries · ${summaries.tier1} tier-1 rows · ${summaries.tier2} tier-2 rows · ${summaries.anchors} anchors`);

  const summary = summarize(out, dbPath);
  summary.privacy = privacyScan(out);
  writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

// ─── fixture layers ───────────────────────────────────────────────────────

function seedFixtureLayers(dbPath: string): { paragraphs: number; labeled: number; tagRows: number } {
  const archive = new Database(dbPath, { readonly: true });
  const layers = openLayersDb(dbPath);
  try {
    const messageAt = archive.query(`SELECT m.ordinal, m.text, m.record_kind AS kind FROM messages m JOIN sessions s ON s.id=m.session_id AND m.construction_generation=s.construction_generation
      WHERE s.harness=? AND s.native_id=? AND m.ordinal=?`);
    const spec = (key: string) => {
      const found = byKey.get(key);
      if (!found) throw new Error(`fixture layer names unknown session ${key}`);
      return { harness: found.harness, nativeId: nativeIdFor(found) };
    };
    const tag = (raw: string) => {
      if (normalizeTag(raw) !== raw) throw new Error(`fixture tag ${raw} does not survive normalizeTag`);
      return raw;
    };
    const facet = (name: string) => {
      if (!(FACETS as readonly string[]).includes(name)) throw new Error(`unknown facet ${name}`);
      return `facet:${name}`;
    };
    let paragraphs = 0, labeled = 0, tagRows = 0;
    layers.transaction(() => {
      layers.query(`DELETE FROM message_paragraphs WHERE model=?`).run(FIXTURE);
      layers.query(`DELETE FROM episode_tags WHERE model=?`).run(FIXTURE);
      layers.query(`DELETE FROM tag_merges WHERE source=?`).run(FIXTURE);

      // Paragraph breaks for the wall-of-text message.
      const wall = spec("ledgerline-catchup");
      const row = archive.query(`SELECT m.ordinal, m.text FROM messages m JOIN sessions s ON s.id=m.session_id AND m.construction_generation=s.construction_generation
        WHERE s.harness=? AND s.native_id=? AND m.record_kind='real_user' AND m.text=?`).get(wall.harness, wall.nativeId, WALL_OF_TEXT) as { ordinal: number; text: string } | null;
      if (!row) throw new Error("wall-of-text message not found in the archive");
      const units = candidateUnits(row.text);
      const breaks = WALL_BREAKS_AT.map((phrase) => {
        const unit = units.find((candidate) => candidate.text.trimStart().startsWith(phrase));
        if (!unit) throw new Error(`no candidate unit starts with "${phrase}"`);
        return unit.start;
      });
      layers.query(`INSERT OR REPLACE INTO message_paragraphs(harness,native_id,ordinal,text_sha256,breaks,model,created_at) VALUES(?,?,?,?,?,?,?)`)
        .run(wall.harness, wall.nativeId, row.ordinal, sha256(row.text), JSON.stringify(breaks), FIXTURE, FIXTURE_AT);
      paragraphs++;

      // Episode labels and tags, matched to the provider-free spans by their opening words.
      const putTag = layers.query(`INSERT OR IGNORE INTO episode_tags(harness,native_id,episode,tag,source,model,created_at) VALUES(?,?,?,?,'model',?,?)`);
      for (const [key, labels] of Object.entries(EPISODE_LABELS)) {
        const id = spec(key);
        const episodes = layers.query(`SELECT episode, start_ordinal FROM session_episodes WHERE harness=? AND native_id=? ORDER BY episode`).all(id.harness, id.nativeId) as { episode: number; start_ordinal: number }[];
        if (episodes.length !== labels.length) throw new Error(`${key}: shape found ${episodes.length} episodes, story labels ${labels.length}`);
        for (const episode of episodes) {
          const opener = messageAt.get(id.harness, id.nativeId, episode.start_ordinal) as { text: string | null } | null;
          const label = labels.find((candidate) => opener?.text?.startsWith(candidate.startsWith));
          if (!label) throw new Error(`${key} episode ${episode.episode} starts with "${opener?.text?.slice(0, 40)}", which no fixture label claims`);
          layers.query(`UPDATE session_episodes SET label=?, label_source=?, label_model=?, labeled_at=? WHERE harness=? AND native_id=? AND episode=?`)
            .run(label.label, FIXTURE, FIXTURE, FIXTURE_AT, id.harness, id.nativeId, episode.episode);
          labeled++;
          for (const value of [facet(label.facet), ...label.tags.map(tag)]) { putTag.run(id.harness, id.nativeId, episode.episode, value, FIXTURE, FIXTURE_AT); tagRows++; }
        }
      }
      for (const [key, entry] of Object.entries(SESSION_TAGS)) {
        const id = spec(key);
        for (const value of [facet(entry.facet), ...entry.tags.map(tag)]) { putTag.run(id.harness, id.nativeId, -1, value, FIXTURE, FIXTURE_AT); tagRows++; }
      }
      const merge = layers.query(`INSERT OR REPLACE INTO tag_merges(from_tag,to_tag,action,reason,source,model,created_at) VALUES(?,?,?,?,?,?,?)`);
      for (const decision of TAG_MERGES) merge.run(decision.from, decision.to, decision.action, decision.reason, FIXTURE, FIXTURE, FIXTURE_AT);
      layers.query(`INSERT OR REPLACE INTO layer_meta(key,value) VALUES('fixture_layers', ?)`)
        .run("demo archive: paragraph breaks, episode labels, tags, and tag merges are hand-authored fixture rows (model='fixture'), not model output");
      layers.query(`INSERT OR REPLACE INTO layer_meta(key,value) VALUES('fixture_summaries', ?)`)
        .run("demo archive: every summary in atlas.db (summaries.model='fixture': tier-1 for all sessions, tier-2 with summary_anchors for the story sessions) is hand-written from demo/story.ts, not provider output");
    })();
    layers.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return { paragraphs, labeled, tagRows };
  } finally {
    layers.close();
    archive.close();
  }
}

/**
 * Tier-1 summaries for every story session and anchored tier-2 summaries for
 * the TIER2 sessions, written the way summarize.ts and tier2.ts write them
 * (dialogue-turn coverage) but with model = "fixture". Anchor ranges are
 * logical ordinals, resolved from each anchor's opening user message. The DB
 * is the demo's own <out>/atlas.db, already verified by the caller.
 */
function seedFixtureSummaries(dbPath: string): { tier1: number; tier2: number; anchors: number } {
  const db = new Database(dbPath);
  try {
    const sessionOf = db.query(`SELECT s.id, COALESCE(cm.dialogue_turn_count, 0) AS turns FROM sessions s
      LEFT JOIN construction_metrics cm ON cm.session_id=s.id WHERE s.harness=? AND s.native_id=? AND s.orphaned=0`);
    const put = db.query(`INSERT INTO summaries(session_id, tier, topic_line, body, msg_count_covered, model, generated_at, coverage_basis, needs_revalidation)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'dialogue_turn_count_v1', 0)
      ON CONFLICT(session_id, tier) DO UPDATE SET topic_line=excluded.topic_line, body=excluded.body, msg_count_covered=excluded.msg_count_covered,
        model=excluded.model, generated_at=excluded.generated_at, coverage_basis=excluded.coverage_basis, needs_revalidation=0`);
    const dialogue = db.query(`SELECT lm.logical_ordinal AS ordinal, lm.record_kind AS kind, m.text FROM sessions s
      JOIN logical_messages lm ON lm.session_id=s.id AND lm.construction_generation=s.construction_generation
      JOIN messages m ON m.id=lm.representative_message_id AND m.construction_generation=s.construction_generation
      WHERE s.id=? ORDER BY lm.logical_ordinal`);
    const tier2Id = db.query(`SELECT id FROM summaries WHERE session_id=? AND tier=2`);
    const putAnchor = db.query(`INSERT INTO summary_anchors(summary_id, ord, topic, from_ordinal, to_ordinal, body) VALUES (?, ?, ?, ?, ?, ?)`);
    let written = 0, tier2 = 0, anchors = 0;
    db.transaction(() => {
      for (const spec of SESSIONS) {
        const summary = SUMMARIES[spec.key];
        if (!summary) throw new Error(`${spec.key} has no fixture summary`);
        if (summary.topic.length > 120) throw new Error(`${spec.key} topic exceeds the 120-char tier-1 contract`);
        const row = sessionOf.get(spec.harness, nativeIdFor(spec)) as { id: number; turns: number } | null;
        if (!row) throw new Error(`${spec.key} is not in the archive`);
        put.run(row.id, 1, summary.topic, summary.body, row.turns, FIXTURE, FIXTURE_AT);
        written++;

        const anchored = TIER2[spec.key];
        if (!anchored) continue;
        const messages = dialogue.all(row.id) as { ordinal: number; kind: string; text: string | null }[];
        const starts = anchored.anchors.map((anchor) => {
          const opener = messages.find((message) => message.kind === "real_user" && message.text?.startsWith(anchor.from));
          if (!opener) throw new Error(`${spec.key}: no user message starts with "${anchor.from}"`);
          return opener.ordinal;
        });
        if (starts.some((start, index) => index > 0 && start <= starts[index - 1]!)) throw new Error(`${spec.key}: tier-2 anchors are out of order`);
        const last = messages.at(-1)!.ordinal;
        put.run(row.id, 2, summary.topic, anchored.body, row.turns, FIXTURE, FIXTURE_AT);
        const summaryId = (tier2Id.get(row.id) as { id: number }).id;
        db.query(`DELETE FROM summary_anchors WHERE summary_id=?`).run(summaryId);
        anchored.anchors.forEach((anchor, index) => {
          if (anchor.topic.length > 120 || anchor.body.length > 500) throw new Error(`${spec.key}: anchor "${anchor.topic}" exceeds the tier-2 limits`);
          putAnchor.run(summaryId, index, anchor.topic, starts[index]!, index + 1 < starts.length ? starts[index + 1]! - 1 : last, anchor.body);
          anchors++;
        });
        tier2++;
      }
      for (const key of Object.keys(TIER2)) if (!byKey.has(key)) throw new Error(`TIER2 names unknown session ${key}`);
    })();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return { tier1: written, tier2, anchors };
  } finally { db.close(); }
}

function summarize(out: string, dbPath: string): BuildSummary {
  const db = new Database(dbPath, { readonly: true });
  try {
    db.query("ATTACH DATABASE ? AS layers").run(layersPathFor(dbPath));
    const counts = (sql: string) => Object.fromEntries((db.query(sql).all() as { k: string; n: number }[]).map((row) => [row.k, row.n]));
    const one = (sql: string) => (db.query(sql).get() as { n: number }).n;
    return {
      out, dbPath,
      sessions: counts(`SELECT harness AS k, COUNT(*) AS n FROM sessions WHERE orphaned=0 GROUP BY harness`),
      creators: counts(`SELECT started_by AS k, COUNT(*) AS n FROM layers.session_creator GROUP BY started_by`),
      shapes: counts(`SELECT shape AS k, COUNT(*) AS n FROM layers.session_shape GROUP BY shape`),
      episodes: { total: one(`SELECT COUNT(*) AS n FROM layers.session_episodes`), labeled: one(`SELECT COUNT(*) AS n FROM layers.session_episodes WHERE label IS NOT NULL`) },
      tags: {
        detail: one(`SELECT COUNT(DISTINCT tag) AS n FROM layers.episode_tags WHERE tag NOT LIKE 'facet:%'`),
        facets: one(`SELECT COUNT(DISTINCT tag) AS n FROM layers.episode_tags WHERE tag LIKE 'facet:%'`),
        merges: one(`SELECT COUNT(*) AS n FROM layers.tag_merges`),
      },
      paragraphs: one(`SELECT COUNT(*) AS n FROM layers.message_paragraphs`),
      summaries: {
        tier1: one(`SELECT COUNT(*) AS n FROM summaries WHERE tier=1`),
        tier2: one(`SELECT COUNT(*) AS n FROM summaries WHERE tier=2`),
        anchors: one(`SELECT COUNT(*) AS n FROM summary_anchors`),
        fixture: one(`SELECT COUNT(*) AS n FROM summaries WHERE model='${FIXTURE}'`),
      },
      rejected: one(`SELECT COALESCE(SUM(rejected_unit_count),0) AS n FROM reconciliation_sources WHERE id IN (SELECT MAX(id) FROM reconciliation_sources GROUP BY source)`),
      privacy: { scannedFiles: 0, hits: [], buildRootReferences: 0 },
    };
  } finally { db.close(); }
}

// ─── privacy scan ─────────────────────────────────────────────────────────

/**
 * Grep every built file (raw bytes) and every text cell of both databases for
 * the owner's identifiers. The only permitted path is the build root itself,
 * which Atlas records as source/db locations; it is stripped before matching.
 */
export function privacyScan(out: string): BuildSummary["privacy"] {
  const allowed = [...new Set([out, canonical(out)])].sort((a, b) => b.length - a.length);
  const forbidden = forbiddenStrings();
  const hits: string[] = [];
  let buildRootReferences = 0;
  const check = (where: string, text: string) => {
    let stripped = text;
    for (const root of allowed) {
      const parts = stripped.split(root);
      buildRootReferences += parts.length - 1;
      stripped = parts.join("<demo-root>");
    }
    // Report which rule hit, never the owner's string itself.
    forbidden.forEach((needle, index) => { if (stripped.includes(needle)) hits.push(`${where}: builder identity #${index + 1}`); });
    for (const [pattern, name] of STRUCTURAL) { const match = stripped.match(pattern); if (match) hits.push(`${where}: ${name} (${match[0].slice(0, 12)}…)`); }
    if (SECRET.test(stripped)) hits.push(`${where}: secret-shaped token`);
  };
  const files = listFiles(out);
  for (const path of files) check(relative(out, path), readFileSync(path).toString("latin1"));
  for (const path of files.filter((file) => /\.db$/.test(file))) {
    const db = new Database(path, { readonly: true });
    try {
      const tables = db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[];
      for (const { name } of tables) {
        let rows: Record<string, unknown>[];
        try { rows = db.query(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all() as Record<string, unknown>[]; } catch { continue; }
        for (const row of rows) for (const value of Object.values(row)) if (typeof value === "string") check(`${relative(out, path)}:${name}`, value);
      }
    } finally { db.close(); }
  }
  return { scannedFiles: files.length, hits: [...new Set(hits)], buildRootReferences };
}

// ─── CLI ──────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    if (argv.includes("--emit-sources")) {
      const count = writeSources(SOURCES);
      process.stdout.write(`demo-archive · wrote ${count} source files under ${relative(REPO, SOURCES)}/\n`);
    } else if (argv.includes("--check-sources")) {
      const drift = sourceDrift();
      if (drift.length) { process.stderr.write(`demo/sources drifted:\n  ${drift.join("\n  ")}\n`); process.exit(1); }
      process.stdout.write("demo-archive · demo/sources matches demo/story.ts\n");
    } else {
      const out = flag("--out");
      if (!out) throw new Error("usage: bun scripts/demo-archive.ts --out <absolute dir> | --emit-sources | --check-sources");
      const summary = await buildDemoArchive(out, (line) => process.stdout.write(`${line}\n`));
      const fmt = (record: Record<string, number>) => Object.entries(record).map(([k, n]) => `${n} ${k}`).join(" / ");
      process.stdout.write([
        "",
        `demo archive · ${summary.dbPath}`,
        `  sessions   ${fmt(summary.sessions)}`,
        `  creators   ${fmt(summary.creators)}`,
        `  shapes     ${fmt(summary.shapes)}`,
        `  episodes   ${summary.episodes.total} (${summary.episodes.labeled} labeled, fixture)`,
        `  tags       ${summary.tags.detail} detail · ${summary.tags.facets} facets · ${summary.tags.merges} merge decisions`,
        `  paragraphs ${summary.paragraphs} message(s) spaced (fixture)`,
        `  summaries  ${summary.summaries.tier1} tier-1 · ${summary.summaries.tier2} tier-2 with ${summary.summaries.anchors} anchors (${summary.summaries.fixture} fixture rows) · launcher ${DEMO_LAUNCHER.name}`,
        `  rejected   ${summary.rejected} source unit(s)`,
        `  privacy    ${summary.privacy.hits.length ? `FAIL\n    ${summary.privacy.hits.join("\n    ")}` : `clean · ${summary.privacy.scannedFiles} files + all DB text cells · ${summary.privacy.buildRootReferences} build-root path references allowed`}`,
        `  open       bun src/cli.ts --config ${join(summary.out, "config.toml")}`,
        "",
      ].join("\n"));
      if (summary.privacy.hits.length || summary.rejected) process.exit(1);
    }
  } catch (error) {
    process.stderr.write(`demo-archive: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
