import { withCtx, hasFlag } from "./ctx.js";
import { promoteTags } from "../summarize.js";
import { synthesizeTag } from "../tier2.js";
import { consolidateTags, listTagMergeLog, undoTagMerge } from "../tag-intelligence.js";
import { hasUsableProvider } from "../provider.js";

/** Promoted-tag list/page, cited synthesis, and reversible synonym log. */
export async function tagsCmd(argv: string[]): Promise<number> {
  const positional = positionalArgs(argv);
  const action = positional[0];

  await withCtx(argv, async ({ db, config }) => {
    if (hasFlag(argv, "--promote")) {
      const { promoted } = promoteTags(db, config.tunables.tag_promotion_count);
      process.stdout.write(`promoted ${promoted.length} tag(s): ${promoted.join(", ") || "(none)"}\n`);
      return;
    }

    if (action === "consolidate") {
      if (!hasUsableProvider(config.providers)) {
        process.stdout.write("tag consolidation pending: no permitted provider available\n");
        return;
      }
      const outcome = await consolidateTags(db, config);
      if (outcome.status === "merged") {
        for (const event of outcome.events) {
          process.stdout.write(`merged ${event.sources.join(" + ")} → ${event.target} · log #${event.id}\n`);
        }
      } else {
        process.stdout.write(`tag consolidation ${outcome.status}: ${outcome.reason}\n`);
      }
      return;
    }

    if (action === "log") {
      const undoId = positional[1] === "undo" ? Number(positional[2]) : Number.NaN;
      if (Number.isSafeInteger(undoId) && undoId > 0) {
        process.stdout.write(undoTagMerge(db, undoId) ? `reverted tag merge #${undoId}\n` : `cannot revert tag merge #${undoId}\n`);
        return;
      }
      const events = listTagMergeLog(db);
      if (events.length === 0) {
        process.stdout.write("atlas tags log · no consolidation merges recorded\n");
        return;
      }
      for (const event of events) {
        process.stdout.write(
          `#${event.id} ${event.sources.join(" + ")} → ${event.target} · ${event.model}` +
          `${event.revertedAt ? " · reverted" : " · active"}\n`,
        );
      }
      return;
    }

    if (action) {
      const tag = db.prepare(`SELECT id, name, promoted_at FROM tags WHERE name=?`).get(action) as
        | { id: number; name: string; promoted_at: number }
        | undefined;
      if (!tag) {
        process.stdout.write(`atlas tags · no tag named "${action}"\n`);
        return;
      }

      const sessions = db.prepare(
        `SELECT s.id, sm.topic_line, s.last_activity FROM sessions s
         JOIN session_tags st ON st.session_id=s.id
         LEFT JOIN summaries sm ON sm.session_id=s.id AND sm.tier=1
         WHERE st.tag_id=? ORDER BY s.last_activity DESC`,
      ).all(tag.id) as Array<{ id: number; topic_line: string | null; last_activity: number | null }>;

      process.stdout.write(`#${tag.name} · ${sessions.length} session(s)\n`);
      if (hasFlag(argv, "--refresh")) db.prepare(`DELETE FROM tag_syntheses WHERE tag_id=?`).run(tag.id);
      if (hasUsableProvider(config.providers)) {
        const synthesis = await synthesizeTag(db, config, tag.name);
        if (synthesis.status === "ready" || synthesis.status === "cached") {
          process.stdout.write(`${synthesis.result.body}\n`);
          process.stdout.write(`cites: ${synthesis.result.citations.map(formatCitation).join(" ")} · ${synthesis.result.model}\n\n`);
        } else if ("reason" in synthesis) {
          process.stdout.write(`(synthesis ${synthesis.status}: ${synthesis.reason})\n\n`);
        }
      } else {
        process.stdout.write("(synthesis unavailable: no permitted provider available)\n\n");
      }
      for (const session of sessions) {
        process.stdout.write(`  #${String(session.id).padStart(5)}  ${(session.topic_line ?? "(unsummarized)").slice(0, 70)}\n`);
      }
      return;
    }

    const tags = db.prepare(
      `SELECT t.name, ts.body, COUNT(st.session_id) AS n
       FROM tags t
       LEFT JOIN session_tags st ON st.tag_id=t.id
       LEFT JOIN tag_syntheses ts ON ts.tag_id=t.id
       GROUP BY t.id ORDER BY n DESC, t.name`,
    ).all() as Array<{ name: string; body: string | null; n: number }>;
    const candidateCount = (db.prepare(`SELECT COUNT(DISTINCT name) n FROM tag_candidates`).get() as { n: number }).n;

    if (tags.length === 0) {
      process.stdout.write(`atlas tags · no promoted tags yet (${candidateCount} candidates pooling under Misc)\n`);
      return;
    }
    process.stdout.write(`atlas tags · ${tags.length} promoted (${candidateCount} in Misc pool)\n`);
    for (const tag of tags) {
      process.stdout.write(`  ${String(tag.n).padStart(4)}  ${tag.name}${tag.body ? ` · ${tag.body.slice(0, 60)}` : ""}\n`);
    }
  });
  return 0;
}

function positionalArgs(argv: string[]): string[] {
  const takesValue = new Set(["--config"]);
  const out: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (takesValue.has(arg)) {
      index++;
      continue;
    }
    if (!arg.startsWith("-")) out.push(arg);
  }
  return out;
}

function formatCitation(citation: { sessionId: number; ordinal: number | null }): string {
  return `[${citation.sessionId}${citation.ordinal === null ? "" : `:${citation.ordinal}`}]`;
}
