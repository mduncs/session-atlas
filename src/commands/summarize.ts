import { withCtx, flagValue, hasFlag } from "./ctx.js";
import { summarizeSession, promoteTags, enqueueJob, tier1PromptVersion } from "../summarize.js";
import { bumpLastWrite } from "../db/index.js";

const RATE_MS = 600; // polite spacing between provider calls during backfill

/**
 * atlas summarize:
 *   atlas summarize <session-id>       summarize one session (by surrogate id)
 *   atlas summarize --backfill         walk unsummarized history newest-first
 *   atlas summarize --backfill --limit N
 *   atlas summarize --redo             re-run where prompt/model differ
 *   atlas summarize --redo --older-than 30d --model-was glm-4.5-air
 */
export async function summarizeCmd(argv: string[]): Promise<number> {
  const backfill = hasFlag(argv, "--backfill");
  const redo = hasFlag(argv, "--redo");
  // Backfill defaults to a polite batch; redo means the matching archive.
  // SQLite LIMIT -1 is intentionally unbounded and remains overrideable.
  const limit = Number(flagValue(argv, "--limit") ?? (backfill ? 100 : redo ? -1 : 1));
  const modelWas = flagValue(argv, "--model-was");
  const olderThan = flagValue(argv, "--older-than");
  const concurrency = parseConcurrency(flagValue(argv, "--concurrency"));
  const sessionArg = argv.find((a) => !a.startsWith("-") && !Number.isNaN(Number(a)));

  await withCtx(argv, async ({ db, config }) => {
    let ids: number[] = [];
    if (backfill || redo) {
      ids = collectBackfillIds(db, { redo, limit, modelWas: modelWas ?? null, olderThan: olderThan ?? null });
    } else if (sessionArg) {
      ids = [Number(sessionArg)];
    } else {
      // Default: summarize the N newest unsummarized.
      ids = collectBackfillIds(db, { redo: false, limit, modelWas: null, olderThan: null });
    }
    process.stdout.write(
      `atlas summarize · prompt v${tier1PromptVersion()} · ${ids.length} session(s) · ` +
        `${config.providers.map((p) => p.name).join(" → ")} · concurrency ${concurrency}\n`,
    );

    let ok = 0,
      pending = 0,
      skipped = 0;
    let cursor = 0;
    let completed = 0;
    let fatal: unknown = null;
    const worker = async () => {
      while (fatal === null) {
        const index = cursor++;
        if (index >= ids.length) return;
        const id = ids[index]!;
        try {
          const out = await summarizeSession(db, config, id, { redo });
          completed++;
          if (out.status === "summarized") {
            ok++;
            const line = (
              db.prepare(`SELECT topic_line FROM summaries WHERE session_id=? AND tier=1`).get(id) as
                | { topic_line: string }
                | null
            )?.topic_line;
            process.stdout.write(`  [${completed}/${ids.length}] #${id} ${out.provider} · ${line ?? ""}\n`);
          } else if (out.status === "pending") {
            pending++;
            process.stdout.write(`  [${completed}/${ids.length}] #${id} pending · ${out.reason}\n`);
          } else {
            skipped++;
          }
        } catch (error) {
          fatal = error;
          return;
        }
        if (cursor < ids.length) await sleep(RATE_MS);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
    if (fatal !== null) throw fatal;

    // Promote tags after a batch.
    const { promoted } = promoteTags(db, config.tunables.tag_promotion_count);
    process.stdout.write(
      `atlas summarize · ${ok} summarized · ${pending} pending · ${skipped} skipped · ` +
        `${promoted.length} tag(s) promoted\n`,
    );
  });
  return 0;
}

function parseConcurrency(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new RangeError("--concurrency must be an integer from 1 to 64");
  }
  return value;
}

function collectBackfillIds(
  db: import("../db/index.js").DB,
  opts: { redo: boolean; limit: number; modelWas: string | null; olderThan: string | null },
): number[] {
  if (opts.redo) {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.modelWas) {
      clauses.push("s.model = ?");
      params.push(opts.modelWas);
    }
    if (opts.olderThan) {
      const days = parseDays(opts.olderThan);
      if (days !== null) {
        clauses.push("s.generated_at < ?");
        params.push(Date.now() - days * 86_400_000);
      }
    }
    const where = clauses.length ? `AND ${clauses.join(" AND ")}` : "";
    return (
      db
        .prepare(
          `SELECT s.session_id AS id FROM summaries s JOIN sessions se ON se.id=s.session_id
           WHERE s.tier=1 ${where} ORDER BY se.last_activity DESC LIMIT ?`,
        )
        .all(...params, opts.limit) as { id: number }[]
    ).map((r) => r.id);
  }
  // Newest-first unsummarized, plus summaries flagged stale (kept readable until replaced).
  return (
    db
      .prepare(
        `SELECT s.id FROM sessions s
         JOIN construction_metrics cm ON cm.session_id=s.id AND cm.construction_generation=s.construction_generation
         LEFT JOIN summaries sm ON sm.session_id=s.id AND sm.tier=1
         WHERE (sm.id IS NULL OR sm.needs_revalidation=1) AND s.construction_status='valid' AND cm.dialogue_turn_count > 0
         ORDER BY s.last_activity DESC LIMIT ?`,
      )
      .all(opts.limit) as { id: number }[]
  ).map((r) => r.id);
}

function parseDays(s: string): number | null {
  const m = s.match(/^(\d+)\s*([dD]ays?)?$/);
  return m ? Number(m[1]) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { enqueueJob, bumpLastWrite };
