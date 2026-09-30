/**
 * Output classification — Law 4: a 200 is not a summary. Two classifiers
 * share one doctrine: a poisoned result is strictly worse than a pending one,
 * so questionable output falls through the chain (→ pending) rather than
 * being cached.
 *
 *   - refusal(): the model balked (incl. Chinese-provider political refusals —
 *     the motivating case, SPEC §2). Fall through, record, never cache.
 *   - degenerateTier1(): the structured JSON is missing/empty/malformed.
 */

/** A refusal is broad-spectrum: explicit apologies, policy cites, partials. */
const REFUSAL_PATTERNS: RegExp[] = [
  /I(?:'m| am) (?:sorry|unable|not able)/i,
  /I (?:can(?:no|')t|cannot|won't|will not) (?:help|assist|provide|generate|create|comply)/i,
  /against (?:my|the) (?:guidelines|policy|policies|principles)/i,
  /(?:content|safety) (?:policy|guidelines|filter)/i,
  /I(?:'m| am) (?:programmed|designed|configured) (?:not|to decline)/i,
  /(?:politically|politically-)?(?:sensitive|controversial) topic/i,
  // The verb is required: bare "law"/"terms" matched topic lines about flaws, lawns, and clawd.
  /\b(?:violates?|breach(?:es|ing)?) (?:the )?(?:applicable )?(?:laws?|regulations|terms)\b/i,
  /(?:请|抱歉|对不起|我无法|我不能|涉及|违反|敏感话题|政治|根据相关规定)/, // Chinese refusal shapes
];

export interface ClassifyResult {
  refusal: boolean;
  reason?: string;
}

export function isRefusal(text: string): ClassifyResult {
  const stripped = text.trim();
  if (!stripped) return { refusal: true, reason: "empty response" };
  for (const re of REFUSAL_PATTERNS) {
    if (re.test(stripped)) return { refusal: true, reason: `matched ${re.source.slice(0, 40)}` };
  }
  // A refusal that is MOSTLY apology + refusal words and very short on substance.
  return { refusal: false };
}

/** Tier-1 topic line + tag candidates, parsed from the model's JSON. */
export interface Tier1Result {
  topic_line: string;
  tags: string[];
}

export type Degenerate =
  | { degenerate: false; result: Tier1Result }
  | { degenerate: true; reason: string };

/**
 * Parse + validate the tier-1 JSON `{topic_line, tags[]}`. Degenerate triggers
 * (SPEC §2 F3): topic line under a floor length, zero topics, zero tag
 * candidates, unparseable structure. Degenerate === fall through (Law 4).
 */
export function classifyTier1(raw: string): Degenerate {
  // The model may wrap JSON in prose or fences; extract the first {...} block.
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch ? jsonMatch[0] : raw.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { degenerate: true, reason: "unparseable JSON" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { degenerate: true, reason: "not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  const topicLine = typeof obj.topic_line === "string" ? obj.topic_line.trim() : "";
  const tagsRaw = Array.isArray(obj.tags) ? obj.tags : [];

  if (topicLine.length < 8) {
    return { degenerate: true, reason: "topic_line under floor" };
  }
  const tags = tagsRaw
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
    .map((t) => t.trim().toLowerCase().slice(0, 40))
    .slice(0, 3);
  if (tags.length === 0) {
    return { degenerate: true, reason: "zero tag candidates" };
  }

  return {
    degenerate: false,
    result: { topic_line: topicLine.slice(0, 120), tags },
  };
}
