/**
 * Summarize pipeline — tier-1 topic line + tag candidates, one prompt per
 * session, cached with model-id + generated-at (Law 4: only validated output
 * is cached). Wires: prose-view build → redact (in provider choke point) →
 * chain → classify → cache + tag candidates. A degenerate/refusal result
 * records a pending job, never caches junk.
 */
import type { DB } from "./db/index.js";
import { bumpLastWrite } from "./db/index.js";
import type { Config } from "./config.js";
import { callChain } from "./provider.js";
import { classifyTier1 } from "./classify.js";
import { TIER1_SYSTEM, TIER1_MAX_TOKENS, tier1PromptVersion } from "./prompts/tier1.js";
import type { RedactableTurn } from "./redact.js";
import { hasUsableProvider } from "./provider.js";
import { blockWork, claimWork, ensureWork, finishWork } from "./jobs.js";
import { randomUUID } from "node:crypto";

/** Build the prose-view turns for a session: user+assistant text, tool noise
 * stripped, capped to keep the call cheap. User turns prioritized (they define
 * the topic). */
export function buildProseTurns(db: DB, sessionId: number, maxChars = 16000): RedactableTurn[] {
  const rows = db
    .prepare(
      `SELECT lm.logical_ordinal ordinal, lm.dialogue_side role, m.prose text
       FROM sessions s
       JOIN logical_messages lm ON lm.session_id=s.id AND lm.construction_generation=s.construction_generation
       JOIN messages m ON m.id=lm.representative_message_id AND m.construction_generation=s.construction_generation
       WHERE s.id=? AND s.construction_status='valid'
         AND lm.record_kind IN ('real_user','assistant_dialogue_prose')
         AND m.prose IS NOT NULL AND length(trim(m.prose))>0
       ORDER BY lm.logical_ordinal`,
    )
    .all(sessionId) as { ordinal: number; role: string; text: string }[];

  const turns: RedactableTurn[] = [];
  let budget = maxChars;
  for (const r of rows) {
    const text = r.text.slice(0, budget);
    if (budget <= 0) break;
    turns.push({ role: r.role, text, ordinal: r.ordinal });
    budget -= text.length;
  }
  return turns;
}

/**
 * Fold a transcript into ONE delimiter-fenced user turn for a summarization
 * call. This is load-bearing: if the transcript is sent as literal
 * user/assistant turns, the model reads itself as the coding assistant and
 * *continues the conversation* instead of summarizing it (it never emits the
 * JSON contract → every call classifies degenerate). Fencing the transcript as
 * DATA inside a single user turn is the same injection-hygiene pattern chat.ts
 * uses (SPEC §chat-view / QA r2.2·F4). With `withOrdinals`, each line carries
 * its `[ord N]` prefix so tier-2 anchors can reference ordinals.
 */
export function buildSummaryTurns(
  db: DB,
  sessionId: number,
  opts: { withOrdinals?: boolean; maxChars?: number } = {},
): RedactableTurn[] {
  const prose = buildProseTurns(db, sessionId, opts.maxChars ?? 16000);
  if (prose.length === 0) return [];
  const lines = prose.map((t) => {
    const prefix = opts.withOrdinals ? `[ord ${t.ordinal}] ` : "";
    return `${prefix}${t.role}: ${escapeTranscriptData(t.text ?? "")}`;
  });
  const folded = `<transcript trust="untrusted-data">\n` +
    `<<<ATLAS_TRANSCRIPT_DATA>>>\n${lines.join("\n\n")}\n` +
    `<<<END_ATLAS_TRANSCRIPT_DATA>>>\n</transcript>`;
  // Single user turn; ordinal 0 is a placeholder (redaction ignores it).
  return [{ role: "user", text: folded, ordinal: 0 }];
}

function escapeTranscriptData(text: string): string {
  return text
    .replaceAll("<<<ATLAS_TRANSCRIPT_DATA>>>", "[escaped transcript-data delimiter]")
    .replaceAll("<<<END_ATLAS_TRANSCRIPT_DATA>>>", "[escaped end delimiter]")
    .replaceAll("</transcript>", "&lt;/transcript&gt;");
}

export interface SummarizeOutcome {
  sessionId: number;
  status: "summarized" | "pending" | "skipped";
  provider?: string;
  reason?: string;
}

export interface SummarizeOptions {
  /** Re-run and replace tier-1 cache even when one already exists. */
  redo?: boolean;
  /** Caller lifetime; cancellation never creates a job or writes a summary. */
  signal?: AbortSignal;
  /** Generation guard supplied by a TaskSupervisor-owned task. */
  shouldCommit?: () => boolean;
  /** Receives the usage snapshot a `claude-cli` provider reports. */
  onUsage?: (snapshot: import("./layers/usage-gate.js").UsageSnapshot) => void;
}

/**
 * Summarize one session (tier-1). Creates the summary row only on validated
 * output; on fall-through, enqueues a pending job with the reason. Returns the
 * outcome for run accounting.
 */
export async function summarizeSession(
  db: DB,
  config: Config,
  sessionId: number,
  opts: SummarizeOptions = {},
): Promise<SummarizeOutcome> {
  // Already summarized and not flagged stale by checkStaleness? skip.
  const existing = db
    .prepare(`SELECT id, needs_revalidation FROM summaries WHERE session_id=? AND tier=1`)
    .get(sessionId) as { id: number; needs_revalidation: number } | null;
  if (existing && existing.needs_revalidation === 0 && !opts.redo) {
    return { sessionId, status: "skipped", reason: "already summarized" };
  }

  if (opts.signal?.aborted || (opts.shouldCommit && !opts.shouldCommit())) {
    return { sessionId, status: "skipped", reason: "cancelled" };
  }

  const state = db.prepare(
    `SELECT construction_generation,construction_status FROM sessions WHERE id=?`,
  ).get(sessionId) as { construction_generation: string; construction_status: string } | null;
  if (!state || state.construction_status !== "valid") {
    return { sessionId, status: "skipped", reason: "no valid construction generation" };
  }
  const turns = buildSummaryTurns(db, sessionId);
  if (turns.length === 0) return { sessionId, status: "skipped", reason: "no dialogue prose" };
  const inputVersion = `tier1:${tier1PromptVersion()}:${state.construction_generation}`;
  const workInput = { kind: "tier1", sessionId, normalizedScope: "", inputVersion, inputRevision: state.construction_generation };
  if (!hasUsableProvider(config.providers)) {
    blockWork(db, workInput, "no provider configured or authorized");
    return { sessionId, status: "pending", reason: "no provider configured or authorized" };
  }
  const workId = ensureWork(db, workInput, "pending", null, opts.redo ?? false);
  const ownerToken = randomUUID();
  const work = claimWork(db, { workId, ownerToken, leaseMs: 10 * 60_000 });
  if (!work) return { sessionId, status: "pending", reason: "work is leased or backed off" };

  const status = await callChain(
    config.providers,
    { system: TIER1_SYSTEM, turns, maxTokens: TIER1_MAX_TOKENS, signal: opts.signal, onUsage: opts.onUsage },
    (text) => classifyTier1(text),
  );

  if (!status.ok) {
    if (status.cancelled || opts.signal?.aborted || (opts.shouldCommit && !opts.shouldCommit())) {
      finishWork(db, workId, ownerToken, "failed", "cancelled");
      return { sessionId, status: "skipped", reason: "cancelled" };
    }
    // Store the full fall-through chain so doctor can show each provider's
    // reason (e.g. "zai: degenerate JSON; deepseek: no key"), not just the last.
    const chain = status.fellThrough.map((f) => `${f.provider}: ${f.reason}`).join("; ");
    finishWork(db, workId, ownerToken, "failed", chain || status.reason);
    return { sessionId, status: "pending", reason: chain || status.reason };
  }

  const parsed = classifyTier1(status.text);
  if (parsed.degenerate) {
    finishWork(db, workId, ownerToken, "failed", `degenerate: ${parsed.reason}`);
    return { sessionId, status: "pending", reason: `degenerate: ${parsed.reason}` };
  }

  // A provider may ignore abort and resolve after its owner closed. The
  // generation guard is checked immediately before the transaction.
  if (opts.signal?.aborted || (opts.shouldCommit && !opts.shouldCommit())) {
    finishWork(db, workId, ownerToken, "failed", "cancelled");
    return { sessionId, status: "skipped", reason: "cancelled" };
  }

  // Validated — cache it (Law 4).
  const now = Date.now();
  const msgCount = (
    db.prepare(`SELECT dialogue_turn_count n FROM construction_metrics WHERE session_id=?`).get(sessionId) as { n: number }
  ).n;
  let committed = false;
  const tx = db.transaction(() => {
    if (!finishWork(db, workId, ownerToken, "done")) return;
    if (opts.redo) {
      // Tier-1 tags are derived cache. A redo replaces the prior derivation;
      // retaining old candidates/links would make the operation additive.
      db.prepare(`DELETE FROM tag_candidates WHERE session_id=?`).run(sessionId);
      db.prepare(`DELETE FROM session_tags WHERE session_id=?`).run(sessionId);
    }
    db.prepare(`UPDATE job_work SET provider=? WHERE id=?`).run(status.provider, workId);
    db.prepare(`UPDATE job_attempts SET provider=? WHERE work_id=? AND attempt_ordinal=(SELECT attempt_count FROM job_work WHERE id=?)`).run(status.provider, workId, workId);
    db.prepare(
      `INSERT INTO summaries(session_id, tier, topic_line, msg_count_covered, model, generated_at, coverage_basis, needs_revalidation)
       VALUES (?, 1, ?, ?, ?, ?, 'dialogue_turn_count_v1', 0)
       ON CONFLICT(session_id, tier) DO UPDATE SET
         topic_line=excluded.topic_line, msg_count_covered=excluded.msg_count_covered,
         model=excluded.model, generated_at=excluded.generated_at,
         coverage_basis=excluded.coverage_basis, needs_revalidation=0`,
    ).run(sessionId, parsed.result.topic_line, msgCount, status.model, now);

    // Tag candidates (1–3) — accumulate for promotion later.
    const insCand = db.prepare(
      `INSERT INTO tag_candidates(name, session_id) VALUES (?, ?)
       ON CONFLICT(name, session_id) DO NOTHING`,
    );
    for (const tag of parsed.result.tags) insCand.run(tag, sessionId);

    bumpLastWrite(db);
    committed = true;
  });
  // IMMEDIATE takes the write lock up front: a deferred read-then-write fails at once (no busy wait) when the index committed in between.
  tx.immediate();
  if (!committed) return { sessionId, status: "skipped", reason: "summary input became stale before commit" };
  return { sessionId, status: "summarized", provider: status.provider };
}

/** Compatibility enqueue surface backed only by canonical work/attempt tables. */
export function enqueueJob(db: DB, sessionId: number | null, kind: string, reason: string, scope?: string): void {
  let revision = "scope-only-v1";
  if (sessionId !== null) {
    const row = db.prepare(`SELECT construction_generation FROM sessions WHERE id=?`).get(sessionId) as
      | { construction_generation: string } | null;
    if (!row) throw new Error(`job target session missing: ${sessionId}`);
    revision = row.construction_generation;
  }
  blockWork(db, {
    kind,
    sessionId,
    normalizedScope: scope ?? "",
    inputVersion: `${kind}:${revision}`,
    inputRevision: revision,
  }, reason);
}

/**
 * Promote candidates: a candidate reaching tag_promotion_count distinct
 * sessions becomes a real tag, linked retroactively. Unpromoted pool as Misc
 * (just unpromoted candidates — no separate table needed; the TUI shows them
 * under Misc). (SPEC §3.)
 */
export function promoteTags(db: DB, promotionCount: number): { promoted: string[] } {
  const candidates = db
    .prepare(
      `SELECT name, COUNT(DISTINCT session_id) AS c FROM tag_candidates GROUP BY name HAVING c >= ?`,
    )
    .all(promotionCount) as { name: string; c: number }[];

  const promoted: string[] = [];
  const now = Date.now();
  const tx = db.transaction(() => {
    const insTag = db.prepare(
      `INSERT INTO tags(name, promoted_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING`,
    );
    const tagId = db.prepare(`SELECT id FROM tags WHERE name=?`);
    const link = db.prepare(
      `INSERT INTO session_tags(session_id, tag_id) SELECT DISTINCT c.session_id, ? FROM tag_candidates c WHERE c.name=? ON CONFLICT DO NOTHING`,
    );
    for (const c of candidates) {
      // Every qualifying tag is re-linked (new sessions join it); only a first insert counts as a promotion.
      if ((tagId.get(c.name) as { id: number } | null) === null) {
        insTag.run(c.name, now);
        promoted.push(c.name);
      }
      const tid = (tagId.get(c.name) as { id: number }).id;
      link.run(tid, c.name);
    }
  });
  tx.immediate();
  return { promoted };
}

export { tier1PromptVersion };
