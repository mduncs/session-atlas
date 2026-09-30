import { withReadOnlyCtx, flagValue } from "./ctx.js";
import { logSearch } from "../layers/search-log.js";

type Mode = "full" | "stubs" | "prose";

/**
 * atlas read <id> [--mode full|stubs|prose] [--around N]
 * Modes mirror the TUI (SPEC §5): full · stubs (tool activity collapsed) ·
 * prose-only (tool noise gone).
 */
export async function readCmd(argv: string[]): Promise<number> {
  const idArg = argv.find((a) => !a.startsWith("-") && !Number.isNaN(Number(a)));
  if (!idArg) {
    process.stderr.write("atlas read <id> [--mode full|stubs|prose] [--around N]\n");
    return 2;
  }
  const id = Number(idArg);
  const mode = (flagValue(argv, "--mode") as Mode) ?? "stubs";
  const around = flagValue(argv, "--around") ? Number(flagValue(argv, "--around")) : null;

  await withReadOnlyCtx(argv, async ({ db, dbPath }) => {
    const sess = db
      .prepare(`SELECT harness, native_id, cwd, title, start_ts, end_ts FROM sessions WHERE id=?`)
      .get(id) as
      | { harness: string; native_id: string; cwd: string | null; title: string | null; start_ts: number; end_ts: number }
      | null;
    if (!sess) {
      process.stderr.write(`atlas read: no session #${id}\n`);
      return;
    }

    // Reads complete the search trail: what an agent opened after searching.
    logSearch(dbPath, { surface: "cli-read", query: `#${id}`, syntax: "literal", scope: {}, total: 1,
      refs: [[sess.harness, sess.native_id, around !== null ? [around] : []]], uncovered: {} });

    const topic = (
      db.prepare(`SELECT topic_line FROM summaries WHERE session_id=? AND tier=1`).get(id) as
        | { topic_line: string }
        | null
    )?.topic_line;

    process.stdout.write(
      `# ${sess.harness}/${sess.native_id}\n` +
        `${topic ? `topic: ${topic}\n` : ""}${sess.cwd ? `cwd:   ${sess.cwd}\n` : ""}\n`,
    );

    let rows = db
      .prepare(
        `SELECT ordinal, role, ts, text, tool_text, has_tool FROM messages WHERE session_id=? ORDER BY ordinal`,
      )
      .all(id) as {
      ordinal: number;
      role: string;
      ts: number | null;
      text: string | null;
      tool_text: string | null;
      has_tool: number;
    }[];

    if (around !== null) {
      const idx = rows.findIndex((r) => r.ordinal === around);
      if (idx >= 0) rows = rows.slice(Math.max(0, idx - 5), idx + 6);
    }

    for (const r of rows) {
      const glyph = r.role === "user" ? "◆" : r.role === "assistant" ? "◇" : "·";
      if (mode === "prose") {
        if (r.role === "system" || r.role === "tool") continue;
        if (r.text) process.stdout.write(`${glyph} ${indent(r.text)}\n\n`);
      } else if (mode === "stubs") {
        if (r.role === "system") continue;
        if (r.has_tool && !r.text) {
          process.stdout.write(`${glyph} [tool] ${stub(r.tool_text)}\n\n`);
        } else if (r.text) {
          process.stdout.write(`${glyph} ${indent(r.text)}\n\n`);
        }
      } else {
        // full
        process.stdout.write(`${glyph} ${r.role} #${r.ordinal}\n`);
        if (r.text) process.stdout.write(indent(r.text) + "\n");
        if (r.tool_text) process.stdout.write(`  [tool] ${indent(r.tool_text)}\n`);
        process.stdout.write("\n");
      }
    }
  });
  return 0;
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
}

function stub(toolText: string | null): string {
  if (!toolText) return "(tool activity)";
  const first = toolText.split("\n")[0] ?? "";
  return first.slice(0, 100);
}
