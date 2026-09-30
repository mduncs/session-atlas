/**
 * Session shape and episode boundaries, provider-free.
 *
 * md's rule set (2026-07-02, confirmed 2026-09-28): tiny sessions (under ten of
 * md's turns) take md's first message as their topic and never reach a model;
 * worker sessions take their brief's headline; long wandering conversations
 * (megachat/life) split into episodes, each with its own topic; coding
 * marathons split on work boundaries. A model only ever *names* episodes found
 * here, so labeling cost scales with episodes, not tokens.
 */
import type { Database } from "bun:sqlite";
import type { DB } from "../db/index.js";
import { classifyUserText } from "./authorship.js";

export type Shape = "tiny" | "worker" | "conversation" | "wanderer" | "marathon";
export const SHAPE_RULE_VERSION = 1;

export interface Unit {
  ordinal: number;
  ts: number | null;
  /** md's words for this turn. */
  human: string;
  /** md's words plus the assistant prose answering them, for lexical shift. */
  context: string;
  compactBefore: boolean;
}

export interface Episode {
  startOrdinal: number;
  endOrdinal: number;
  startTs: number | null;
  endTs: number | null;
  humanTurns: number;
  boundary: string;
  keywords: string[];
}

const MIN_EPISODE_UNITS = 3;
const MAX_EPISODES = 40;
const WINDOW = 3;
const STOP = new Set(("the and for that this with you your are was were have has had not but can could would should will just like what when where which who how why its it's there their them they then than into from about also some more most very really been being does did doing done here make made want need know think going okay yeah yes sure thing things well much many only even still back over after before because while each other same such these those again get got see look one two lets let's use using used want wanted way work working file files code").split(" "));

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9_-]{2,24}/g) ?? []).filter((word) => !STOP.has(word));
}

/** Document frequencies over units; `n` is the number of units seen. */
export interface Corpus { df: Map<string, number>; n: number }

export function buildCorpus(unitsBySession: Iterable<Unit[]>): Corpus {
  const df = new Map<string, number>();
  let n = 0;
  for (const units of unitsBySession) for (const unit of units) {
    n++;
    for (const word of new Set(tokenize(unit.context))) df.set(word, (df.get(word) ?? 0) + 1);
  }
  return { df, n };
}

function vector(texts: string[], corpus: Corpus): Map<string, number> {
  const tf = new Map<string, number>();
  for (const text of texts) for (const word of tokenize(text)) tf.set(word, (tf.get(word) ?? 0) + 1);
  const out = new Map<string, number>();
  for (const [word, count] of tf) {
    const df = corpus.df.get(word) ?? 0;
    // Ignore corpus-wide filler and one-off noise alike.
    if (df > corpus.n * 0.2) continue;
    out.set(word, (1 + Math.log(count)) * Math.log((corpus.n + 1) / (df + 1)));
  }
  return out;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [word, weight] of a) { na += weight * weight; const other = b.get(word); if (other) dot += weight * other; }
  for (const weight of b.values()) nb += weight * weight;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const CUE = /^(new topic|different (question|topic)|unrelated|switching|changing gears|ok next|next up|next:|now let'?s|also,? (can|could|what)|btw\b|random q)/i;

/** Score each gap between units; higher is a stronger topic boundary. */
export function boundaryScores(units: Unit[], corpus: Corpus): { index: number; score: number; reasons: string[] }[] {
  const scores: { index: number; score: number; reasons: string[] }[] = [];
  for (let i = 1; i < units.length; i++) {
    const reasons: string[] = [];
    let score = 0;
    if (units[i]!.compactBefore) { score += 3; reasons.push("compaction"); }
    const gap = units[i]!.ts !== null && units[i - 1]!.ts !== null ? units[i]!.ts! - units[i - 1]!.ts! : 0;
    if (gap >= 2 * 3_600_000) { score += 3; reasons.push(`gap:${Math.round(gap / 3_600_000)}h`); }
    else if (gap >= 45 * 60_000) { score += 2; reasons.push(`gap:${Math.round(gap / 60_000)}m`); }
    if (i >= 2 && units.length - i >= 2) {
      const before = vector(units.slice(Math.max(0, i - WINDOW), i).map((u) => u.context), corpus);
      const after = vector(units.slice(i, i + WINDOW).map((u) => u.context), corpus);
      const similarity = cosine(before, after);
      if (similarity < 0.06) { score += 2; reasons.push(`shift:${similarity.toFixed(2)}`); }
      else if (similarity < 0.12) { score += 1; reasons.push(`shift:${similarity.toFixed(2)}`); }
    }
    if (CUE.test(units[i]!.human.trim())) { score += 1; reasons.push("cue"); }
    if (score > 0) scores.push({ index: i, score, reasons });
  }
  return scores;
}

/** Greedy strongest-first boundaries that keep every episode at least MIN_EPISODE_UNITS long. */
export function segment(units: Unit[], corpus: Corpus, threshold = 3): Episode[] {
  if (units.length === 0) return [];
  const accepted: { index: number; reasons: string[] }[] = [];
  const candidates = boundaryScores(units, corpus).filter((c) => c.score >= threshold).sort((a, b) => b.score - a.score || a.index - b.index);
  for (const candidate of candidates) {
    if (accepted.length >= MAX_EPISODES - 1) break;
    const cuts = [0, ...accepted.map((a) => a.index), units.length].sort((a, b) => a - b);
    const left = Math.max(...cuts.filter((cut) => cut < candidate.index));
    const right = Math.min(...cuts.filter((cut) => cut > candidate.index));
    if (candidate.index - left >= MIN_EPISODE_UNITS && right - candidate.index >= MIN_EPISODE_UNITS) accepted.push(candidate);
  }
  accepted.sort((a, b) => a.index - b.index);
  const starts = [{ index: 0, reasons: ["start"] }, ...accepted];
  return starts.map((start, n) => {
    const end = n + 1 < starts.length ? starts[n + 1]!.index : units.length;
    const span = units.slice(start.index, end);
    return {
      startOrdinal: span[0]!.ordinal,
      endOrdinal: span.at(-1)!.ordinal,
      startTs: span[0]!.ts,
      endTs: span.at(-1)!.ts,
      humanTurns: span.length,
      boundary: start.reasons.join(","),
      keywords: keywords(span, corpus),
    };
  });
}

function keywords(span: Unit[], corpus: Corpus, count = 4): string[] {
  // md's own words count double: they say what the episode was about.
  const weights = vector([...span.map((u) => u.human), ...span.map((u) => u.human), ...span.map((u) => u.context)], corpus);
  return [...weights].sort((a, b) => b[1] - a[1]).slice(0, count).map(([word]) => word);
}

export interface ShapeInput { humanTurns: number; startedBy: "human" | "agent" | "unknown"; toolCalls: number; totalTokens: number; compactions: number; episodes: number }

export function classifyShape(input: ShapeInput): Shape {
  if (input.startedBy === "agent") return "worker";
  if (input.humanTurns < 10) return "tiny";
  const toolPerTurn = input.toolCalls / Math.max(1, input.humanTurns);
  if (input.toolCalls >= 300 || input.totalTokens >= 20_000_000 || input.compactions >= 2) return "marathon";
  if (toolPerTurn < 3 || input.episodes >= 3) return "wanderer";
  return "conversation";
}

/** Provider-free topic for sessions that never go to a model. */
export function plainTopic(text: string): string {
  const cleaned = text
    .replace(/<command-(name|message|args)>([^<]*)<\/command-\1>/g, (_m, _k, value: string) => ` ${value.trim()} `)
    .replace(/<[^>]{1,40}>/g, " ")
    .replace(/\[Image[^\]]*\]/g, " ")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = cleaned.match(/^.{12,}?[.?!](\s|$)/)?.[0] ?? cleaned;
  return sentence.length > 90 ? `${sentence.slice(0, 89).trimEnd()}…` : sentence.trim();
}

interface Head { id: number; harness: string; native_id: string; total: number }
export interface ShapeReport { sessions: number; shapes: Record<Shape, number>; episodes: number; ms: number }

/** Recompute shapes and episodes; model-written episode labels survive when their span is unchanged. */
export function computeShapes(archive: DB, layers: Database, options: { now?: number } = {}): ShapeReport {
  const started = performance.now();
  const now = options.now ?? Date.now();
  const heads = archive.query(`SELECT id,harness,native_id,(tok_user+tok_assistant+tok_tool) AS total FROM sessions`).all() as Head[];
  const creators = new Map((layers.query(`SELECT harness||char(31)||native_id AS k, started_by FROM session_creator`).all() as { k: string; started_by: ShapeInput["startedBy"] }[]).map((r) => [r.k, r.started_by]));
  const toolCalls = new Map((archive.query(
    `SELECT m.session_id AS sid, COUNT(*) AS n FROM tool_activities t JOIN messages m ON m.id=t.raw_record_id
      JOIN sessions s ON s.id=m.session_id AND t.construction_generation=s.construction_generation
     WHERE t.activity_kind='call' GROUP BY m.session_id`,
  ).all() as { sid: number; n: number }[]).map((r) => [r.sid, r.n]));
  const rows = archive.query(
    `SELECT m.session_id AS sid, m.ordinal, m.ts, m.record_kind AS kind, m.role, m.text FROM messages m
       JOIN sessions s ON s.id=m.session_id AND m.construction_generation=s.construction_generation
      WHERE m.record_kind IN ('real_user','assistant_dialogue_prose')
         OR (m.role='user' AND m.text LIKE '<command-name>/compact%')
      ORDER BY m.session_id, m.ordinal`,
  ).all() as { sid: number; ordinal: number; ts: number | null; kind: string; role: string; text: string | null }[];

  // Source-enumerated compaction seams (Claude compact_boundary, Prime, Kimi).
  // Real /compact commands rarely leave a matching user row, so text alone
  // undercounted about half of them. These only raise the count; episode
  // placement still keys off the text signal so existing spans (and their
  // labels) do not move.
  const boundaries = new Map((archive.query(
    `SELECT p.session_id AS sid, COUNT(*) AS n FROM continuity_projection p
       JOIN continuity_evidence e ON e.id=p.evidence_id
       JOIN sessions s ON s.id=p.session_id AND p.construction_generation=s.construction_generation
      WHERE e.kind='compaction' GROUP BY p.session_id`,
  ).all() as { sid: number; n: number }[]).map((r) => [r.sid, r.n]));
  const unitsBySession = new Map<number, Unit[]>();
  const openers = new Map<number, string>();
  const compactions = new Map<number, number>();
  let pendingCompact = false, currentSid = -1;
  for (const row of rows) {
    if (row.sid !== currentSid) { currentSid = row.sid; pendingCompact = false; }
    const text = row.text ?? "";
    const units = unitsBySession.get(row.sid) ?? [];
    if (row.kind === "assistant_dialogue_prose") {
      const last = units.at(-1);
      if (last && last.context.length < 6000) last.context += `\n${text.slice(0, 2000)}`;
      continue;
    }
    const verdict = row.kind === "real_user" ? classifyUserText(text) : { author: "harness" as const, rule: "harness:compaction" };
    if (verdict.rule === "harness:compaction" || /^\/compact\b/.test(text)) {
      pendingCompact = true;
      compactions.set(row.sid, (compactions.get(row.sid) ?? 0) + 1);
      continue;
    }
    if (verdict.author !== "harness" && !openers.has(row.sid)) openers.set(row.sid, text.slice(0, 2000));
    if (verdict.author !== "human") continue;
    units.push({ ordinal: row.ordinal, ts: row.ts, human: text.slice(0, 4000), context: text.slice(0, 4000), compactBefore: pendingCompact });
    pendingCompact = false;
    unitsBySession.set(row.sid, units);
  }
  for (const [sid, n] of boundaries) if (n > (compactions.get(sid) ?? 0)) compactions.set(sid, n);
  const corpus = buildCorpus(unitsBySession.values());

  const labels = new Map((layers.query(
    `SELECT harness||char(31)||native_id||char(31)||start_ordinal||char(31)||end_ordinal AS k, label, label_source, label_model, labeled_at FROM session_episodes WHERE label IS NOT NULL`,
  ).all() as { k: string; label: string; label_source: string; label_model: string; labeled_at: number }[]).map((r) => [r.k, r]));
  const report: ShapeReport = { sessions: 0, shapes: { tiny: 0, worker: 0, conversation: 0, wanderer: 0, marathon: 0 }, episodes: 0, ms: 0 };
  const upsertShape = layers.query(
    `INSERT OR REPLACE INTO session_shape(harness,native_id,session_id,shape,topic,human_turns,tool_calls,total_tokens,compactions,episodes,rule_version,computed_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const clearEpisodes = layers.query(`DELETE FROM session_episodes WHERE harness=? AND native_id=?`);
  // Model tags follow their episode's span: renumbered when the span survives,
  // dropped (and re-planned) when it changed. md's tags are never touched.
  const oldSpans = new Map<string, Map<number, string>>();
  for (const row of layers.query(`SELECT e.harness||char(31)||e.native_id AS k, e.episode, e.start_ordinal||':'||e.end_ordinal AS span FROM session_episodes e
      WHERE EXISTS (SELECT 1 FROM episode_tags t WHERE t.harness=e.harness AND t.native_id=e.native_id AND t.episode=e.episode AND t.source='model')`).all() as { k: string; episode: number; span: string }[]) {
    const spans = oldSpans.get(row.k) ?? new Map<number, string>();
    spans.set(row.episode, row.span);
    oldSpans.set(row.k, spans);
  }
  const readTags = layers.query(`SELECT episode, tag, model, created_at FROM episode_tags WHERE harness=? AND native_id=? AND source='model' AND episode>=0`);
  const dropTags = layers.query(`DELETE FROM episode_tags WHERE harness=? AND native_id=? AND source='model' AND episode>=0`);
  const putTag = layers.query(`INSERT OR IGNORE INTO episode_tags(harness,native_id,episode,tag,source,model,created_at) VALUES(?,?,?,?, 'model',?,?)`);
  const insertEpisode = layers.query(
    `INSERT INTO session_episodes(harness,native_id,episode,start_ordinal,end_ordinal,start_ts,end_ts,human_turns,boundary,keywords,label,label_source,label_model,labeled_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  layers.transaction(() => {
    for (const head of heads) {
      const units = unitsBySession.get(head.id) ?? [];
      const startedBy = creators.get(`${head.harness}\u001f${head.native_id}`) ?? "unknown";
      const episodes = startedBy === "agent" || units.length < 10 ? [] : segment(units, corpus);
      const shape = classifyShape({ humanTurns: units.length, startedBy, toolCalls: toolCalls.get(head.id) ?? 0, totalTokens: head.total, compactions: compactions.get(head.id) ?? 0, episodes: episodes.length });
      const topic = shape === "tiny" || shape === "worker" ? plainTopic(openers.get(head.id) ?? "") || null : null;
      upsertShape.run(head.harness, head.native_id, head.id, shape, topic, units.length, toolCalls.get(head.id) ?? 0, head.total, compactions.get(head.id) ?? 0, episodes.length, SHAPE_RULE_VERSION, now);
      clearEpisodes.run(head.harness, head.native_id);
      episodes.forEach((episode, n) => {
        const kept = labels.get(`${head.harness}\u001f${head.native_id}\u001f${episode.startOrdinal}\u001f${episode.endOrdinal}`);
        insertEpisode.run(head.harness, head.native_id, n, episode.startOrdinal, episode.endOrdinal, episode.startTs, episode.endTs, episode.humanTurns,
          episode.boundary, JSON.stringify(episode.keywords), kept?.label ?? null, kept?.label_source ?? null, kept?.label_model ?? null, kept?.labeled_at ?? null);
      });
      const spans = oldSpans.get(`${head.harness}\u001f${head.native_id}`);
      if (spans) {
        const tags = readTags.all(head.harness, head.native_id) as { episode: number; tag: string; model: string | null; created_at: number }[];
        const renumber = new Map<string, number>(episodes.map((episode, n) => [`${episode.startOrdinal}:${episode.endOrdinal}`, n]));
        dropTags.run(head.harness, head.native_id);
        for (const tag of tags) {
          const next = renumber.get(spans.get(tag.episode) ?? "");
          if (next !== undefined) putTag.run(head.harness, head.native_id, next, tag.tag, tag.model, tag.created_at);
        }
      }
      report.sessions++;
      report.shapes[shape]++;
      report.episodes += episodes.length;
    }
  })();
  report.ms = Math.round(performance.now() - started);
  return report;
}

export function formatShapes(shapes: Record<Shape, number>): string {
  return (Object.keys(shapes) as Shape[]).map((shape) => `${shapes[shape]} ${shape}`).join(" / ");
}
