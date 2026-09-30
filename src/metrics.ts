/**
 * Derived metrics computed at ingest, no LLM (SPEC §1).
 * Token estimates use chars/4: consistency over precision (Law 5).
 */

export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  // Integer ceil division by 4 — comparable across the corpus, not exact.
  return Math.ceil([...text].length / 4);
}

export interface TokenSplit {
  user: number;
  assistant: number;
  tool: number;
}

/**
 * Engagement ratio = user tokens / (user + assistant tokens). Tool tokens
 * excluded: low-ratio rows are delegations (tool grind), high-ratio rows
 * are the actual conversations. The TUI renders this as a second channel.
 */
export function engagementRatio(split: TokenSplit): number {
  const denom = split.user + split.assistant;
  if (denom <= 0) return 0;
  return split.user / denom;
}
