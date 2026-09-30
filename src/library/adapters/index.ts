import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { claudeAdapter } from "../../adapters/claude.js";
import { codexAdapter } from "../../adapters/codex.js";
import { primeAdapter } from "../../adapters/prime.js";
import { hermesAdapter } from "../../adapters/hermes.js";
import { kimiAdapter } from "../../adapters/kimi.js";
import { kiloAdapter } from "../../adapters/kilo.js";
import { zcodeAdapter } from "../../adapters/zcode.js";
import type { Adapter, IngestRecord, NormalizedMessage, Role } from "../../adapters/types.js";
import { evidenceHash } from "../evidence.js";

export const legacyAdapters: Record<string, Adapter> = { claude: claudeAdapter, codex: codexAdapter, prime: primeAdapter, hermes: hermesAdapter, kimi: kimiAdapter, kilo: kiloAdapter, zcode: zcodeAdapter };
export const adapterCapabilities = [
  ...Object.keys(legacyAdapters).map(harness => ({ harness, formatVersion: legacyAdapters[harness]!.sidecarVersion!, mode: "live", certification: "existing parser compatibility; new capture fixture gates separate", continuation: false })),
  ...["gemini", "opencode", "chatgpt-export", "claude-export", "cursor-export"].map(harness => ({ harness, formatVersion: harness === "gemini" ? "gemini-85aca163-recording-v1" : harness === "opencode" ? "opencode-v1.2.15-sqlite-export-v1" : `${harness}-shape-v1`, mode: harness.endsWith("export") ? "import" : "live", certification: harness === "gemini" || harness === "opencode" ? "upstream source-pinned synthetic conformance; installed-app lifecycle not certified" : "explicit export shape only; account-version not certified", continuation: false })),
];
type Obj = Record<string, any>;
const object = (value: unknown): Obj => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Needs adapter update: expected object");
  return value as Obj;
};
const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(item => typeof item === "string" ? item : typeof item?.text === "string" ? item.text : "").join("");
  return "";
};
function message(role: string, content: unknown, id: unknown, ordinal: number, timestamp?: unknown): NormalizedMessage {
  if (!["user", "assistant", "system", "tool", "gemini", "model", "human", "info", "error", "warning"].includes(role)) throw new Error(`Needs adapter update: unknown role ${role}`);
  const normalized: Role = ["info", "error", "warning"].includes(role) ? "system" : role === "gemini" || role === "model" ? "assistant" : role === "human" ? "user" : role as Role;
  const value = text(content);
  const time = typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  return { ordinal, sourceOrdinal: ordinal, sourceRecordId: typeof id === "string" ? id : null, role: normalized, ts: Number.isFinite(time) ? time : null, text: value, prose: normalized === "tool" ? null : value, toolText: normalized === "tool" ? value : null, hasTool: normalized === "tool", recordKind: normalized === "user" ? "real_user" : normalized === "assistant" ? "assistant_dialogue_prose" : normalized === "tool" ? "tool" : "developer_system" };
}
function record(nativeId: string, title: unknown, rows: NormalizedMessage[], extra: Partial<IngestRecord> = {}): IngestRecord {
  return { nativeId, title: typeof title === "string" ? title : null, cwd: null, project: null, startTs: rows[0]?.ts ?? null, endTs: rows.at(-1)?.ts ?? null, models: [], messages: rows, transcriptBytes: 0, origin: "unknown", ...extra };
}
export function parseExport(harness: string, bytes: Buffer): IngestRecord[] {
  const identity = `import:${evidenceHash(bytes)}`;
  if (harness === "cursor-export") {
    const markdown = bytes.toString("utf8");
    if (!/^# .+/m.test(markdown) || !/^\*\*(User|Cursor)\*\*\s*$/m.test(markdown)) throw new Error("Needs adapter update: expected Cursor Markdown export with **User** / **Cursor** turns");
    const matches = [...markdown.matchAll(/^\*\*(User|Cursor)\*\*\s*\r?\n/gm)];
    const rows = matches.map((match, i) => message(match[1] === "User" ? "user" : "assistant", markdown.slice(match.index! + match[0].length, matches[i + 1]?.index ?? markdown.length).replace(/\n---\s*$/, ""), null, i));
    return [record(identity, markdown.match(/^# (.+)/m)?.[1], rows)];
  }
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (harness === "chatgpt-export") {
    if (!Array.isArray(parsed)) throw new Error("Needs adapter update: ChatGPT conversations array required");
    return parsed.map((entry, n) => {
      const data = object(entry), mapping = object(data.mapping);
      if (typeof data.current_node !== "string") throw new Error("Needs adapter update: ChatGPT current_node required (branch authority)");
      const chain: Obj[] = [], seen = new Set<string>();
      let cursor: string | null = data.current_node;
      while (cursor) {
        if (seen.has(cursor)) throw new Error("Invalid ChatGPT branch cycle");
        seen.add(cursor);
        const node = object(mapping[cursor]); chain.unshift(node);
        cursor = typeof node.parent === "string" ? node.parent : null;
      }
      const rows = chain.filter(node => node.message).map((node, i) => {
        const m = object(node.message), author = object(m.author), content = object(m.content);
        if (content.content_type !== "text" || !Array.isArray(content.parts)) throw new Error("Needs adapter update: unsupported ChatGPT content type");
        return message(author.role, content.parts.join("\n"), m.id, i, typeof m.create_time === "number" ? m.create_time * 1000 : null);
      });
      return record(typeof data.id === "string" ? data.id : `${identity}:${n}`, data.title, rows);
    });
  }
  if (harness === "claude-export") {
    if (!Array.isArray(parsed)) throw new Error("Needs adapter update: Claude conversations array required");
    return parsed.map((entry, n) => {
      const data = object(entry);
      if (!Array.isArray(data.chat_messages) || typeof data.uuid !== "string") throw new Error("Needs adapter update: Claude uuid/chat_messages required");
      return record(data.uuid || `${identity}:${n}`, data.name, data.chat_messages.map((m: Obj, i: number) => message(m.sender, m.text ?? m.content, m.uuid, i, m.created_at)));
    });
  }
  if (harness === "gemini") {
    const data = object(parsed);
    if (typeof data.sessionId !== "string" || typeof data.projectHash !== "string" || !Array.isArray(data.messages)) throw new Error("Needs adapter update: Gemini sessionId/messages snapshot required");
    return [record(data.sessionId, data.summary, data.messages.map((m: Obj, i: number) => { const row = message(m.type, m.content, m.id, i, m.timestamp); if (Array.isArray(m.toolCalls) && m.toolCalls.length) { row.toolText = JSON.stringify(m.toolCalls); row.hasTool = true; } return row; }), { models: [...new Set<string>(data.messages.map((m: Obj) => m.model).filter((m: unknown) => typeof m === "string"))] })];
  }
  if (harness === "opencode") {
    const data = object(parsed), info = object(data.info);
    if (typeof info.id !== "string" || !Array.isArray(data.messages)) throw new Error("Needs adapter update: OpenCode info/messages export required");
    return [record(info.id, info.title, data.messages.map((entry: Obj, i: number) => {
      const meta = object(entry.info);
      if (!Array.isArray(entry.parts)) throw new Error("Needs adapter update: OpenCode parts required");
      const row = message(meta.role, entry.parts.filter((part: Obj) => part.type === "text"), meta.id, i, meta.time?.created);
      const tools = entry.parts.filter((part: Obj) => part.type !== "text");
      if (tools.length) { row.toolText = JSON.stringify(tools); row.hasTool = true; }
      return row;
    }), { cwd: typeof info.directory === "string" ? info.directory : null })];
  }
  throw new Error(`Needs adapter update: unsupported harness ${harness}`);
}

export function discoverFiles(root: string, harness: string): string[] {
  if (statSync(root).isFile()) return [root];
  const result: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git", "log", "logs", "auth"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && (harness !== "gemini" || /^session-.*\.jsonl?$/.test(entry.name)) && (harness !== "opencode" || entry.name === "opencode.db") && (harness === "cursor-export" ? /\.md$/.test(entry.name) : /\.json$|\.jsonl$|opencode\.db$/.test(entry.name)) && !/auth|credential|token/i.test(entry.name)) result.push(path);
    }
  }
  walk(root);
  return result.sort();
}
/** Explicit schema probe; no resemblance-based reuse of Kilo. */
export function parseOpenCodeSqlite(path: string): IngestRecord[] {
  const db = new Database(path, { readonly: true });
  try {
    const columns = (table: string) => new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name));
    for (const [table, required] of [["session", ["id", "title", "directory"]], ["message", ["id", "session_id", "data", "time_created"]], ["part", ["id", "message_id", "data"]]] as const) {
      const known = columns(table);
      if (required.some(name => !known.has(name))) throw new Error(`Needs adapter update: OpenCode ${table} schema unsupported`);
    }
    if (columns("session_message").size && db.query("SELECT 1 FROM session_message LIMIT 1").get()) throw new Error("Needs adapter update: newer OpenCode session_message storage present");
    return (db.query("SELECT * FROM session ORDER BY id").all() as Obj[]).map(session => {
      const rows = (db.query("SELECT * FROM message WHERE session_id=? ORDER BY time_created,id").all(session.id) as Obj[]).map((row, i) => {
        const meta = object(JSON.parse(row.data));
        const parts = (db.query("SELECT data FROM part WHERE message_id=? ORDER BY id").all(row.id) as Obj[]).map(part => object(JSON.parse(part.data)));
        const parsed = message(meta.role, parts.filter(part => part.type === "text"), row.id, i, meta.time?.created);
        const tools = parts.filter(part => part.type !== "text");
        if (tools.length) { parsed.toolText = JSON.stringify(tools); parsed.hasTool = true; }
        return parsed;
      });
      return record(session.id, session.title, rows, { cwd: session.directory });
    });
  } finally { db.close(); }
}

/** Gemini chatRecordingService loadConversationRecord contract, upstream
 * inspected 2026-09-05: id upsert, $set checkpoint, exclusive $rewindTo. */
export function parseGeminiStream(bytes: Buffer): IngestRecord[] {
  const end = bytes.lastIndexOf(10) + 1;
  const events = bytes.subarray(0, end).toString("utf8").split("\n").filter(Boolean).map(line => object(JSON.parse(line)));
  let metadata: Obj = {};
  const messages = new Map<string, Obj>();
  const insert = (m: Obj) => { if (typeof m.id !== "string") throw new Error("Needs adapter update: Gemini message id missing"); messages.set(m.id, m); };
  for (const event of events) {
    if (typeof event.$rewindTo === "string") {
      const ids = [...messages.keys()];
      const index = ids.indexOf(event.$rewindTo);
      for (const id of index < 0 ? ids : ids.slice(index)) messages.delete(id);
    } else if (typeof event.id === "string") insert(event);
    else if (event.$set && typeof event.$set === "object") {
      const update = object(event.$set);
      if (Array.isArray(update.messages)) { messages.clear(); for (const m of update.messages) insert(object(m)); }
      metadata = { ...metadata, ...update };
    } else if (typeof event.sessionId === "string" && typeof event.projectHash === "string") {
      metadata = { ...metadata, ...event };
      if (Array.isArray(event.messages)) for (const m of event.messages) insert(object(m));
    } else throw new Error("Needs adapter update: unsupported Gemini stream event");
  }
  if (typeof metadata.sessionId !== "string" || typeof metadata.projectHash !== "string") throw new Error("Needs adapter update: Gemini stream metadata missing");
  return parseExport("gemini", Buffer.from(JSON.stringify({ ...metadata, messages: [...messages.values()] })));
}
