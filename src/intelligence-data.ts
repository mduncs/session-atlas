import type { DB } from "./db/index.js";
import type { SessionFacts, TranscriptRow } from "./tui/session-view.js";
import type { TagSessionRow } from "./tui/tag-view.js";

export interface SessionSurfaceData {
  facts: SessionFacts;
  transcript: TranscriptRow[];
}

/** Ordinal-preserving session projection for the TUI; no provider work. */
export function loadSessionSurface(db: DB, sessionId: number): SessionSurfaceData | null {
  const row = db.prepare(
    `SELECT s.id, s.harness, s.native_id, s.title, COALESCE(s.project,s.cwd) AS path,
            s.models, s.chain_id, s.duration_ms, s.tok_user, s.tok_assistant, s.tok_tool,
            (SELECT COUNT(*) FROM sessions member WHERE member.chain_id=s.chain_id) AS chain_members
     FROM sessions s WHERE s.id=?`,
  ).get(sessionId) as {
    id: number; harness: string; native_id: string; title: string | null; path: string | null;
    models: string | null; chain_id: number | null; duration_ms: number | null;
    tok_user: number; tok_assistant: number; tok_tool: number; chain_members: number;
  } | null;
  if (!row) return null;
  const tags = db.prepare(
    `SELECT t.name FROM tags t JOIN session_tags st ON st.tag_id=t.id
     WHERE st.session_id=? ORDER BY t.name`,
  ).all(sessionId) as Array<{ name: string }>;
  const transcript = db.prepare(
    `SELECT ordinal, role, text, tool_text, has_tool FROM messages
     WHERE session_id=? ORDER BY ordinal`,
  ).all(sessionId) as Array<{
    ordinal: number; role: string; text: string | null; tool_text: string | null; has_tool: number;
  }>;
  return {
    facts: {
      id: row.id,
      harness: row.harness,
      nativeId: row.native_id,
      title: row.title,
      path: row.path,
      models: parseModels(row.models),
      tags: tags.map((tag) => tag.name),
      chainMembers: row.chain_id === null ? 1 : Math.max(1, row.chain_members),
      durationMs: row.duration_ms,
      tokens: { user: row.tok_user, assistant: row.tok_assistant, tool: row.tok_tool },
    },
    transcript: transcript.map((message) => ({
      ordinal: message.ordinal,
      role: message.role,
      text: message.text,
      toolText: message.tool_text,
      hasTool: Boolean(message.has_tool),
    })),
  };
}

export function loadTagSessions(db: DB, tagName: string): TagSessionRow[] {
  const rows = db.prepare(
    `SELECT s.id, s.harness, s.native_id, sm.topic_line, s.last_activity, s.models,
            EXISTS(SELECT 1 FROM favorites f WHERE f.harness=s.harness AND f.native_id=s.native_id) AS favorite
     FROM sessions s
     JOIN session_tags st ON st.session_id=s.id
     JOIN tags t ON t.id=st.tag_id
     LEFT JOIN summaries sm ON sm.session_id=s.id AND sm.tier=1
     WHERE t.name=? ORDER BY s.last_activity DESC, s.id DESC`,
  ).all(tagName) as Array<{
    id: number; harness: string; native_id: string; topic_line: string | null;
    last_activity: number | null; models: string | null; favorite: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    harness: row.harness,
    nativeId: row.native_id,
    topic: row.topic_line,
    lastActivity: row.last_activity,
    model: parseModels(row.models)[0] ?? null,
    favorite: Boolean(row.favorite),
  }));
}

function parseModels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [raw];
  } catch {
    return [raw];
  }
}
