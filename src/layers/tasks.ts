/**
 * Model task kinds for interpretation layers. Each kind plans items from the
 * provider-free layers, builds a compact prompt, and validates the answer
 * before writing. Models only choose among candidates the code computed
 * (paragraph break points, episode spans, tag vocabularies), so a bad answer
 * can mislabel but never corrupt text or invent spans.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { DB } from "../db/index.js";
import { classifyUserText } from "./authorship.js";
import { effectiveCreatorSql } from "./creator-sql.js";
import type { Applied, BuiltBatch, LayerTask } from "./runner.js";

export const HAIKU = "claude-haiku-4-5-20251001";
export const SONNET = "claude-sonnet-5-5";
const SEP = "\u001f";
const key = (...parts: (string | number)[]) => parts.join(SEP);
const unkey = (value: string) => value.split(SEP);

/** Top-level facets are fixed; emergent tags must be more specific than these. */
export const FACETS = ["code", "design", "research", "ops", "writing", "life", "health", "money", "learning", "agents"] as const;
const TAG = /^[a-z0-9][a-z0-9+.-]{1,38}[a-z0-9]$/;
/** Model names and build numbers are never subjects (md's rule 3 sanity check, enforced before the rubric). */
// "opus-5-5", "claude-sonnet-4-6", "gpt-6-astra": a model id, optionally with one codename word after its version.
const NOISE_TAG = /^(?:(?:claude-)?(?:opus|sonnet|haiku|fable|glm|gpt|gemini|kimi|deepseek|k\d)(?:(?:-[\d.]+)+(?:-[a-z]+)?)?|v\d+)$/;

/** Drop date/number suffixes ("parity-exploration-202609") and noise tags. */
export function normalizeTag(raw: unknown): string | null {
  const value = String(raw).toLowerCase().trim().replace(/[\s_]+/g, "-").replace(/^#/, "").replace(/(?:-\d{3,})+$/, "");
  return TAG.test(value) && !NOISE_TAG.test(value) && !(FACETS as readonly string[]).includes(value) ? value : null;
}

interface SessionRow { id: number; gen: number; title: string | null; origin_detail: string | null }
function sessionFor(archive: DB, harness: string, nativeId: string): SessionRow | null {
  return archive.query(`SELECT id, construction_generation AS gen, title, origin_detail FROM sessions WHERE harness=? AND native_id=?`)
    .get(harness, nativeId) as SessionRow | null;
}

function scopeSql(sinceMs: number | null, alias = "s"): string {
  return sinceMs === null ? "1=1" : `COALESCE(${alias}.last_activity, ${alias}.end_ts, ${alias}.start_ts, 0) >= ${Math.floor(sinceMs)}`;
}

// ---------------------------------------------------------------------------
// Paragraphs (C): display-only breaks for md's walls of text.

/** Break candidates: sentence starts, plus soft clause boundaries inside run-ons. */
export function candidateUnits(text: string): { start: number; text: string }[] {
  const starts = [0];
  for (const match of text.matchAll(/[.?!…]+["')\]]*\s+|\n+/g)) {
    const next = (match.index ?? 0) + match[0].length;
    if (next < text.length) starts.push(next);
  }
  // Inline enumerations md types without punctuation: "…i like it 3 yes i like it…".
  for (const match of text.matchAll(/\s(?=\d{1,2}[.):]?\s+[A-Za-z])/g)) starts.push((match.index ?? 0) + 1);
  const units: { start: number; text: string }[] = [];
  const bounded = [...new Set(starts)].sort((a, b) => a - b);
  bounded.forEach((start, i) => {
    const end = bounded[i + 1] ?? text.length;
    const sentence = text.slice(start, end);
    if (sentence.split(/\s+/).length <= 60) { units.push({ start, text: sentence }); return; }
    // Run-on: split at a soft boundary once ~25 words have passed.
    let from = 0, words = 0, last = 0;
    for (const match of sentence.matchAll(/,\s+|\s+(?=(?:so|but|also|and then|btw|anyway|ok|okay|then|because|though|which|or maybe|like if)\b)/gi)) {
      const at = (match.index ?? 0) + match[0].length;
      words += sentence.slice(last, at).split(/\s+/).filter(Boolean).length;
      last = at;
      if (words >= 25 && sentence.length - at > 60) { units.push({ start: start + from, text: sentence.slice(from, at) }); from = at; words = 0; }
    }
    units.push({ start: start + from, text: sentence.slice(from) });
  });
  return units.filter((unit) => unit.text.trim());
}

/** Apply stored breaks for display. Offsets are UTF-16 indices into the exact text. */
export function paragraphize(text: string, breaks: number[]): string {
  let out = "", from = 0;
  for (const at of breaks) {
    if (at <= from || at >= text.length) continue;
    out += `${text.slice(from, at).trimEnd()}\n\n`;
    from = at;
  }
  return out + text.slice(from);
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function isWall(text: string): boolean {
  if (text.length < 600 || text.length > 40_000 || text.includes("```")) return false;
  const blankLines = text.split(/\n\s*\n/).length - 1;
  if (blankLines >= text.length / 900) return false;
  const prose = (text.match(/[A-Za-z ,.'?!]/g) ?? []).length;
  return prose / text.length >= 0.85 && classifyUserText(text).rule === "human:typed";
}

export const paragraphsTask: LayerTask = {
  kind: "paragraphs",
  batch: 8,
  system: `You add paragraph breaks to messages a person typed as one unbroken wall of text. You never change words; you only choose where new paragraphs start.
Each message is split into numbered units. Return the unit numbers that should START a new paragraph.
Break where the writer shifts topic, intent, or step (a new request, a new question, a change of subject, a "btw", a list of separate asks). Keep a single thought together even when it is long. Typical paragraphs are 2-6 units; a short message may need no breaks.
Answer with JSON only: {"<message id>": [unit numbers], ...}. Never include unit 0.`,
  plan(archive, layers, scope) {
    const done = new Set((layers.query(`SELECT harness||char(31)||native_id||char(31)||ordinal AS k, text_sha256 AS h FROM message_paragraphs`).all() as { k: string; h: string }[]).map((row) => `${row.k}${SEP}${row.h}`));
    const rows = archive.query(
      `SELECT s.harness, s.native_id, m.ordinal, m.text FROM messages m JOIN sessions s ON s.id=m.session_id
        WHERE m.record_kind='real_user' AND m.construction_generation=s.construction_generation
          AND length(m.text) >= 600 AND ${scopeSql(scope.sinceMs)} AND ${effectiveCreatorSql("s")} <> 'agent'`,
    ).all() as { harness: string; native_id: string; ordinal: number; text: string }[];
    return rows.filter((row) => isWall(row.text) && !done.has(`${key(row.harness, row.native_id, row.ordinal)}${SEP}${sha256(row.text)}`))
      .map((row) => key(row.harness, row.native_id, row.ordinal));
  },
  build(archive, _layers, keys) {
    const parts: string[] = [], used: string[] = [], skipped: string[] = [];
    let chars = 0;
    for (const itemKey of keys) {
      const [harness, nativeId, ordinal] = unkey(itemKey);
      const text = messageText(archive, harness!, nativeId!, Number(ordinal));
      if (text === null) { skipped.push(itemKey); continue; }
      if (used.length && chars + text.length > 16_000) break;
      const units = candidateUnits(text);
      parts.push(`<message id="m${used.length}">\n${units.map((unit, n) => `[${n}] ${unit.text.trim()}`).join("\n")}\n</message>`);
      used.push(itemKey);
      chars += text.length;
    }
    return { prompt: parts.join("\n\n"), keys: used, skipped };
  },
  apply(layers, archive, keys, answer, model, now) {
    const result: Applied = { applied: [], rejected: [] };
    const map = (answer && typeof answer === "object" ? answer : {}) as Record<string, unknown>;
    const insert = layers.query(`INSERT OR REPLACE INTO message_paragraphs(harness,native_id,ordinal,text_sha256,breaks,model,created_at) VALUES(?,?,?,?,?,?,?)`);
    keys.forEach((itemKey, n) => {
      const picks = map[`m${n}`];
      const [harness, nativeId, ordinal] = unkey(itemKey);
      const text = messageText(archive, harness!, nativeId!, Number(ordinal));
      if (text === null) return result.rejected.push({ key: itemKey, error: "source vanished" });
      if (!Array.isArray(picks)) return result.rejected.push({ key: itemKey, error: "missing from answer" });
      const units = candidateUnits(text);
      const offsets = [...new Set(picks.filter((v): v is number => Number.isInteger(v) && v > 0 && v < units.length))]
        .sort((a, b) => a - b).map((unit) => units[unit]!.start);
      insert.run(harness!, nativeId!, Number(ordinal), sha256(text), JSON.stringify(offsets), model, now);
      result.applied.push(itemKey);
    });
    return result;
  },
};

function messageText(archive: DB, harness: string, nativeId: string, ordinal: number): string | null {
  const row = archive.query(`SELECT m.text FROM messages m JOIN sessions s ON s.id=m.session_id AND m.construction_generation=s.construction_generation
    WHERE s.harness=? AND s.native_id=? AND m.ordinal=?`).get(harness, nativeId, ordinal) as { text: string | null } | null;
  return row?.text ?? null;
}

// ---------------------------------------------------------------------------
// Episodes (2) + emergent tags (3): name provider-found episodes, tag them.

const TAG_RULES = `Tags are the detail layer, like Obsidian tags: lowercase kebab-case, 1-4 per episode, the most specific true thing first (a named project, tool, person, place, feature, decision, or concrete subject). Never use a tag as broad as a facet (no "coding", "ai", "debugging", "planning", "chat", "misc"). Never tag a model name or version ("opus-5-5", "haiku"), a version or build number ("v100"), or a date. Reuse an existing tag from the vocabulary when it fits exactly; otherwise coin a precise one.
Also pick exactly one facet per episode from: ${FACETS.join(", ")}.`;

export const episodesTask: LayerTask = {
  kind: "episodes",
  batch: 1,
  system: `You name the episodes of one long conversation between md (a person) and AI agents. Episode spans were found already; you only name and tag them.
Labels: at most 7 words, concrete — name the actual thing worked on or discussed (repo, feature, bug, decision, life topic). No filler like "discussion of" or "working on".
${TAG_RULES}
Answer with JSON only: {"episodes":[{"n":0,"label":"...","facet":"...","tags":["..."]}]}`,
  plan(archive, layers, scope) {
    const sessions = new Set((archive.query(`SELECT harness||char(31)||native_id AS k FROM sessions s WHERE ${scopeSql(scope.sinceMs)}`).all() as { k: string }[]).map((row) => row.k));
    return (layers.query(`SELECT DISTINCT e.harness||char(31)||e.native_id AS k FROM session_episodes e JOIN session_shape sh USING(harness,native_id)
      WHERE sh.shape IN ('conversation','wanderer','marathon') AND e.label IS NULL`).all() as { k: string }[])
      .map((row) => row.k).filter((k) => sessions.has(k));
  },
  build(archive, layers, keys) {
    const [itemKey] = keys;
    const [harness, nativeId] = unkey(itemKey!);
    const session = sessionFor(archive, harness!, nativeId!);
    const episodes = layers.query(`SELECT episode,start_ordinal,end_ordinal,keywords FROM session_episodes WHERE harness=? AND native_id=? ORDER BY episode`)
      .all(harness!, nativeId!) as { episode: number; start_ordinal: number; end_ordinal: number; keywords: string }[];
    if (!session || !episodes.length) return { prompt: "", keys: [], skipped: [itemKey!] };
    const budget = Math.max(700, Math.floor(28_000 / episodes.length));
    const blocks = episodes.map((episode) => {
      const turns = (archive.query(`SELECT text FROM messages WHERE session_id=? AND construction_generation=? AND record_kind='real_user' AND ordinal BETWEEN ? AND ? ORDER BY ordinal`)
        .all(session.id, session.gen, episode.start_ordinal, episode.end_ordinal) as { text: string | null }[])
        .map((row) => row.text ?? "").filter((text) => classifyUserText(text).author === "human");
      return `<episode n="${episode.episode}" turns="${turns.length}" keywords="${(JSON.parse(episode.keywords) as string[]).join(", ")}">\n${sample(turns, budget)}\n</episode>`;
    });
    return { prompt: `${vocabularyHint(layers)}Session title: ${session.title ?? "(none)"}\n\n${blocks.join("\n\n")}`, keys: [itemKey!], skipped: [] };
  },
  apply(layers, _archive, keys, answer, model, now) {
    const [itemKey] = keys;
    const [harness, nativeId] = unkey(itemKey!);
    const list = (answer as { episodes?: unknown })?.episodes;
    if (!Array.isArray(list)) return { applied: [], rejected: [{ key: itemKey!, error: "no episodes array" }] };
    const known = new Set((layers.query(`SELECT episode FROM session_episodes WHERE harness=? AND native_id=?`).all(harness!, nativeId!) as { episode: number }[]).map((row) => row.episode));
    const label = layers.query(`UPDATE session_episodes SET label=?, label_source='model', label_model=?, labeled_at=? WHERE harness=? AND native_id=? AND episode=?`);
    const tag = layers.query(`INSERT OR IGNORE INTO episode_tags(harness,native_id,episode,tag,source,model,created_at) VALUES(?,?,?,?, 'model',?,?)`);
    let named = 0;
    layers.transaction(() => {
      layers.query(`DELETE FROM episode_tags WHERE harness=? AND native_id=? AND source='model'`).run(harness!, nativeId!);
      for (const item of list as { n?: unknown; label?: unknown; facet?: unknown; tags?: unknown }[]) {
        if (!Number.isInteger(item?.n) || !known.has(item.n as number) || typeof item.label !== "string" || !item.label.trim()) continue;
        label.run(item.label.trim().slice(0, 80), model, now, harness!, nativeId!, item.n as number);
        named++;
        for (const value of cleanTags(item.tags, item.facet)) tag.run(harness!, nativeId!, item.n as number, value, model, now);
      }
    })();
    // Sessions can repeat content under fresh record ids; the model names such a
    // repeat once. Unnamed episodes keep their keywords, so partial is still done.
    return named > 0 ? { applied: [itemKey!], rejected: [] } : { applied: [], rejected: [{ key: itemKey!, error: `named 0/${known.size} episodes` }] };
  },
};

/** Even sample of md's turns within a character budget, marking elisions. */
function sample(turns: string[], budget: number): string {
  if (!turns.length) return "(no typed turns)";
  const per = Math.max(160, Math.floor(budget / Math.min(turns.length, 8)));
  const picks = turns.length <= 8 ? turns : Array.from({ length: 8 }, (_, i) => turns[Math.floor((i * (turns.length - 1)) / 7)]!);
  return picks.map((text) => `- ${text.replace(/\s+/g, " ").slice(0, per)}${text.length > per ? "…" : ""}`).join("\n");
}

function cleanTags(tags: unknown, facet: unknown): string[] {
  const out = new Set<string>();
  if (typeof facet === "string" && (FACETS as readonly string[]).includes(facet)) out.add(`facet:${facet}`);
  if (Array.isArray(tags)) for (const raw of tags.slice(0, 4)) {
    const value = normalizeTag(raw);
    if (value) out.add(value);
  }
  return [...out];
}

function vocabularyHint(layers: Database): string {
  const rows = layers.query(`SELECT tag, COUNT(DISTINCT harness||native_id) AS n FROM episode_tags WHERE tag NOT LIKE 'facet:%' GROUP BY tag HAVING n >= 2 ORDER BY n DESC LIMIT 150`).all() as { tag: string; n: number }[];
  return rows.length ? `Existing tag vocabulary (reuse when exact): ${rows.map((row) => row.tag).join(", ")}\n\n` : "";
}

// Small human sessions: tags only, many per call.
export const tinyTagsTask: LayerTask = {
  kind: "tiny-tags",
  batch: 20,
  system: `You tag short conversations md (a person) started with AI agents, from their opening message.
${TAG_RULES}
Answer with JSON only: {"<session id>": {"facet":"...","tags":["..."]}, ...}`,
  plan(archive, layers, scope) {
    const sessions = new Set((archive.query(`SELECT harness||char(31)||native_id AS k FROM sessions s WHERE ${scopeSql(scope.sinceMs)} AND ${effectiveCreatorSql("s")}='human'`).all() as { k: string }[]).map((row) => row.k));
    const tagged = new Set((layers.query(`SELECT DISTINCT harness||char(31)||native_id AS k FROM episode_tags WHERE episode=-1`).all() as { k: string }[]).map((row) => row.k));
    return (layers.query(`SELECT harness||char(31)||native_id AS k FROM session_shape WHERE shape='tiny' AND topic IS NOT NULL`).all() as { k: string }[])
      .map((row) => row.k).filter((k) => sessions.has(k) && !tagged.has(k));
  },
  build(archive, layers, keys) {
    const lines: string[] = [], used: string[] = [], skipped: string[] = [];
    for (const itemKey of keys) {
      const [harness, nativeId] = unkey(itemKey);
      const session = sessionFor(archive, harness!, nativeId!);
      const opener = session ? (archive.query(`SELECT text FROM messages WHERE session_id=? AND construction_generation=? AND record_kind='real_user' ORDER BY ordinal`).all(session.id, session.gen) as { text: string | null }[])
        .map((row) => row.text ?? "").find((text) => classifyUserText(text).author === "human") : undefined;
      if (!opener) { skipped.push(itemKey); continue; }
      lines.push(`<session id="s${used.length}">${opener.replace(/\s+/g, " ").slice(0, 700)}</session>`);
      used.push(itemKey);
    }
    return { prompt: `${vocabularyHint(layers)}${lines.join("\n")}`, keys: used, skipped };
  },
  apply(layers, _archive, keys, answer, model, now) {
    const map = (answer && typeof answer === "object" ? answer : {}) as Record<string, { facet?: unknown; tags?: unknown }>;
    const result: Applied = { applied: [], rejected: [] };
    const tag = layers.query(`INSERT OR IGNORE INTO episode_tags(harness,native_id,episode,tag,source,model,created_at) VALUES(?,?,-1,?, 'model',?,?)`);
    layers.transaction(() => {
      keys.forEach((itemKey, n) => {
        const [harness, nativeId] = unkey(itemKey);
        const item = map[`s${n}`];
        const tags = cleanTags(item?.tags, item?.facet);
        if (!tags.length) { result.rejected.push({ key: itemKey, error: "no usable tags" }); return; }
        for (const value of tags) tag.run(harness!, nativeId!, value, model, now);
        result.applied.push(itemKey);
      });
    })();
    return result;
  },
};

// ---------------------------------------------------------------------------
// Creator residue (1): sessions the evidence rules left unknown.

export const creatorTask: LayerTask = {
  kind: "creator",
  batch: 8,
  system: `Decide who started each AI-agent session: "human" if md (a person) typed the opening request themselves, "agent" if another program or agent launched it with a generated brief, "unknown" if the records cannot tell.
md's tells: casual lowercase, typos, greetings, questions, stream-of-consciousness. Agent tells: role briefs ("You are…"), templated instructions, file paths to briefs, rigid headings, "execute exactly", machine relays.
Answer with JSON only: {"<session id>": {"started_by":"human|agent|unknown","reason":"<12 words max>"}, ...}`,
  plan(archive, layers, scope) {
    const sessions = new Set((archive.query(`SELECT harness||char(31)||native_id AS k FROM sessions s WHERE ${scopeSql(scope.sinceMs)}`).all() as { k: string }[]).map((row) => row.k));
    return (layers.query(`SELECT sc.harness||char(31)||sc.native_id AS k FROM session_creator sc
      LEFT JOIN creator_model cm USING(harness,native_id) LEFT JOIN creator_corrections cc USING(harness,native_id)
      WHERE sc.started_by='unknown' AND sc.human_turns+sc.agent_turns>0 AND cm.native_id IS NULL AND cc.native_id IS NULL`).all() as { k: string }[])
      .map((row) => row.k).filter((k) => sessions.has(k));
  },
  build(archive, _layers, keys) {
    const blocks: string[] = [], used: string[] = [], skipped: string[] = [];
    for (const itemKey of keys) {
      const [harness, nativeId] = unkey(itemKey);
      const session = sessionFor(archive, harness!, nativeId!);
      if (!session) { skipped.push(itemKey); continue; }
      const records = (archive.query(`SELECT text FROM messages WHERE session_id=? AND construction_generation=? AND record_kind='real_user' ORDER BY ordinal`).all(session.id, session.gen) as { text: string | null }[])
        .map((row) => row.text ?? "").filter((text) => classifyUserText(text).author !== "harness");
      blocks.push(`<session id="s${used.length}" harness="${harness}" launch="${session.origin_detail ?? "?"}" user_records="${records.length}">\n${records.slice(0, 3).map((text, i) => `[${i}] ${text.replace(/\s+/g, " ").slice(0, 800)}`).join("\n")}\n</session>`);
      used.push(itemKey);
    }
    return { prompt: blocks.join("\n\n"), keys: used, skipped };
  },
  apply(layers, _archive, keys, answer, model, now) {
    const map = (answer && typeof answer === "object" ? answer : {}) as Record<string, { started_by?: unknown; reason?: unknown }>;
    const result: Applied = { applied: [], rejected: [] };
    const insert = layers.query(`INSERT OR REPLACE INTO creator_model(harness,native_id,started_by,reason,model,decided_at) VALUES(?,?,?,?,?,?)`);
    keys.forEach((itemKey, n) => {
      const item = map[`s${n}`];
      const verdict = item?.started_by;
      if (verdict !== "human" && verdict !== "agent" && verdict !== "unknown") { result.rejected.push({ key: itemKey, error: "no verdict" }); return; }
      const [harness, nativeId] = unkey(itemKey);
      insert.run(harness!, nativeId!, verdict, `model: ${String(item?.reason ?? "").slice(0, 120)}`, model, now);
      result.applied.push(itemKey);
    });
    return result;
  },
};

// ---------------------------------------------------------------------------
// Tag rubric (3, Sonnet): keep broad tags from swallowing the detail.

export const TAG_RUBRIC = `Rubric — apply in order, one decision per tag. The goal is md's own vocabulary with its detail intact; the fixed facets are the only top level.
1. Noise: model names or versions (opus-5-5, glm), version/build numbers (v100), dates, ids → "demote" to the episode's most likely "facet:<facet>".
2. Facet-level: a tag as broad as a facet (${FACETS.join(", ")}) or a generic activity ("coding", "debugging", "performance", "ui-critique", "refactor", "ai") → "demote" to "facet:<facet>".
3. Same thing: spelling, plural, abbreviation, word-order, or truncated variants that a reader would call the SAME thing → "merge" into the most common form. Nothing else merges.
4. Subtopic: a tag that is a specific part of a broader existing tag (tmux-scrolling, tmux-session-resume under tmux; music-fetcher-database under music-fetcher) → "nest" with "to" = the parent. The child keeps its detail. Never merge a subtopic.
5. Swallowing: a tag on more than 10% of tagged sessions whose examples span clearly different subjects → "split" into the narrower tags named in "to" (comma-separated, existing tags preferred); if none exist, "keep" and say what it hides.
6. No merging by association: distinct projects, repos, tools, people, or places never merge or nest into each other, and a generic tag never merges into a project because one example happens to be about it (demote it instead).
7. Concrete singletons: omit (they stay as they are). Vague singletons → "demote".
Only list tags that need an action other than a plain keep, plus keeps under rule 5.`;

export const rubricTask: LayerTask = {
  kind: "tag-rubric",
  batch: 1,
  thinking: true,
  system: `You are the sanity checker for an auto-tagging system over md's AI-agent conversations. Tags must stay detailed; top-level structure comes from fixed facets, not from broad tags.
${TAG_RUBRIC}
Answer with JSON only: {"decisions":[{"from":"tag","action":"merge|nest|demote|split|keep","to":"tag or facet:x or a,b","reason":"<15 words"}]}`,
  plan(_archive, layers) {
    const tags = layers.query(`SELECT COUNT(DISTINCT tag) AS n FROM episode_tags WHERE tag NOT LIKE 'facet:%' AND source='model'`).get() as { n: number };
    return tags.n ? [`vocabulary${SEP}${Date.now()}`] : [];
  },
  build(_archive, layers, keys) {
    const total = (layers.query(`SELECT COUNT(DISTINCT harness||native_id) AS n FROM episode_tags`).get() as { n: number }).n;
    const rows = layers.query(`SELECT t.tag, COUNT(DISTINCT t.harness||t.native_id) AS n,
        (SELECT group_concat(label, ' | ') FROM (SELECT e.label FROM episode_tags t2 JOIN session_episodes e ON e.harness=t2.harness AND e.native_id=t2.native_id AND e.episode=t2.episode
          WHERE t2.tag=t.tag AND e.label IS NOT NULL LIMIT 3)) AS examples
      FROM episode_tags t WHERE t.tag NOT LIKE 'facet:%' GROUP BY t.tag ORDER BY n DESC LIMIT 900`).all() as { tag: string; n: number; examples: string | null }[];
    const lines = rows.map((row) => `${row.tag}\t${row.n}\t${row.examples ?? ""}`);
    return { prompt: `Tagged sessions: ${total}\ntag\tsessions\texample episode labels\n${lines.join("\n")}`, keys, skipped: [] };
  },
  apply(layers, _archive, keys, answer, model, now) {
    const list = (answer as { decisions?: unknown })?.decisions;
    if (!Array.isArray(list)) return { applied: [], rejected: keys.map((k) => ({ key: k, error: "no decisions" })) };
    const insert = layers.query(`INSERT OR REPLACE INTO tag_merges(from_tag,to_tag,action,reason,source,model,created_at) VALUES(?,?,?,?, 'rubric',?,?)`);
    layers.transaction(() => {
      layers.query(`DELETE FROM tag_merges WHERE source='rubric'`).run();
      for (const item of list as { from?: unknown; to?: unknown; action?: unknown; reason?: unknown }[]) {
        if (typeof item.from !== "string" || !["merge", "nest", "demote", "split", "keep"].includes(String(item.action))) continue;
        insert.run(item.from, String(item.to ?? item.from), String(item.action), String(item.reason ?? "").slice(0, 200), model, now);
      }
    })();
    return { applied: keys, rejected: [] };
  },
};

export const LAYER_TASKS: Record<string, LayerTask> = {
  [paragraphsTask.kind]: paragraphsTask,
  [episodesTask.kind]: episodesTask,
  [tinyTagsTask.kind]: tinyTagsTask,
  [creatorTask.kind]: creatorTask,
  [rubricTask.kind]: rubricTask,
};

/** Default model per kind: Haiku 4.5 for bulk, Sonnet 5.5 only for the checker (md, 2026-09-28). */
export const TASK_MODEL: Record<string, string> = { paragraphs: HAIKU, episodes: HAIKU, "tiny-tags": HAIKU, creator: HAIKU, "tag-rubric": SONNET };
