/**
 * Redaction — Law 3: the network is the boundary. No transcript text reaches
 * a provider unredacted; the local disk is trusted, the wire is not.
 *
 * One module, applied at the single choke point where outbound prompts are
 * assembled (the provider fetch wrapper — see src/provider.ts). Redactions
 * become `[redacted:kind]` placeholders. The local index is deliberately NOT
 * redacted (the boundary is the network, not the disk — QA r2.2/F2).
 *
 * Pattern set (SPEC §2):
 *   - AWS keys (AKIA…, secret access keys), `sk-`/`ghp_`-style tokens, JWTs,
 *     PEM blocks, `KEY=value` env pairs, plus a high-entropy catch.
 *   - High-entropy threshold: `redact_entropy_threshold` bits/char (default
 *     4.8) for strings ≥ 20 chars that are b64/hex-shaped (no spaces).
 */

export interface RedactOptions {
  /** bits/char Shannon entropy threshold for the high-entropy catch. */
  entropyThreshold: number;
  /** minimum length for a token to be considered high-entropy. */
  minEntropyLength: number;
}

export const DEFAULT_REDACT_OPTIONS: RedactOptions = {
  entropyThreshold: 4.8,
  minEntropyLength: 20,
};

export type RedactKind =
  | "aws-access-key"
  | "aws-secret"
  | "api-token"
  | "jwt"
  | "pem"
  | "env-pair"
  | "high-entropy"
  | "private-key-words";

interface Rule {
  kind: RedactKind;
  re: RegExp;
  /** group index within `re` that holds the secret span to replace. 0 = whole match. */
  group: number;
}

// Ordered: most specific first. Each replaces only the secret-bearing group;
// surrounding context (e.g. "AWS_SECRET_ACCESS_KEY=") is preserved so the
// prose still reads, but the value is gone.
const RULES: Rule[] = [
  // PEM / private key blocks (DER armor) — multi-line.
  {
    kind: "pem",
    re: /-----BEGIN (?:[A-Z0-9 ]+) PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+) PRIVATE KEY-----/g,
    group: 0,
  },
  // AWS access key id: AKIA + 16 base32-ish chars.
  { kind: "aws-access-key", re: /\b(AKIA[0-9A-Z]{16})\b/g, group: 1 },
  // AWS secret access key: 40 base64-ish, typically after a known var name.
  {
    kind: "aws-secret",
    re: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"]?([A-Za-z0-9/+=]{40})\b/g,
    group: 1,
  },
  // Generic API tokens: sk-..., ghp_..., github_pat_..., xoxb-..., aiza...,
  // glpat-..., etc. The prefix anchors; the body is [A-Za-z0-9_-]{16,}.
  {
    kind: "api-token",
    re: /\b((?:sk|sk-ant|sk-proj|ghp|gho|github_pat|glpat|xox[bp]|aiza|ya29|AKIA|DATABRICKS)[_-]?[A-Za-z0-9_-]{16,})\b/g,
    group: 1,
  },
  // JWT: three base64url segments, dots between, middle segment decodes to JSON.
  {
    kind: "jwt",
    re: /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    group: 1,
  },
  // KEY=value / KEY: value env pairs where the value looks secret (long, no
  // spaces, alphanumeric-ish). Common var names get priority.
  {
    kind: "env-pair",
    re: /\b([A-Z][A-Z0-9_]{2,}(?:_TOKEN|_KEY|_SECRET|_PASSWORD|_PASS|_AUTH|_API_KEY))\s*[=:]\s*['"]?([A-Za-z0-9_\-./+=]{16,})['"]?/g,
    group: 2,
  },
];

const PRIVATE_KEY_WORDS: RedactKind = "private-key-words";

/**
 * Redact a single string. Returns the redacted text. Idempotent in the sense
 * that a `[redacted:kind]` placeholder will not be re-matched (no colons /
 * brackets in the secret shapes).
 */
export function redactString(input: string, opts: RedactOptions = DEFAULT_REDACT_OPTIONS): string {
  let out = input;

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (match, ...args) => {
      const groups = args as unknown[];
      // For env-pair the secret is group 2; generic rule.group handles it.
      const secret = rule.group === 0 ? match : (groups[rule.group - 1] as string);
      return match.replace(secret, `[redacted:${rule.kind}]`);
    });
  }

  // high-entropy catch: scan remaining word-like tokens.
  out = redactHighEntropy(out, opts);
  return out;
}

const TOKEN_RE = /[A-Za-z0-9_\-+/=]{20,}/g;

function redactHighEntropy(input: string, opts: RedactOptions): string {
  return input.replace(TOKEN_RE, (tok) => {
    if (tok.includes("[redacted:")) return tok; // already a placeholder run
    // Skip if it has a vowel structure suggesting natural language / words
    // (e.g. a long camelCase identifier is fine to keep). Heuristic: tokens
    // that are pure base64/hex have low vowel ratio.
    if (looksLikeProse(tok)) return tok;
    const e = shannonEntropy(tok);
    if (e >= opts.entropyThreshold) return `[redacted:${PRIVATE_KEY_WORDS}]`;
    return tok;
  });
}

/** A token "looks like prose" if it has a plausible vowel/consonant rhythm. */
function looksLikeProse(tok: string): boolean {
  const vowels = (tok.match(/[aeiouAEIOU]/g) ?? []).length;
  const ratio = vowels / tok.length;
  // Natural words: ~35-55% vowels. Pure b64/hex: ~15-25%. Threshold at 0.28.
  // Also reject if it's all hex (0-9a-f) — definitely a hash/key.
  if (/^[0-9a-fA-F]+$/.test(tok) && tok.length >= 20) return false;
  return ratio >= 0.28;
}

/** Shannon entropy in bits/char. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  const n = s.length;
  for (const count of freq.values()) {
    const p = count / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Redact an array of message turns (the shape outbound prompts carry). Returns
 * a deep copy with every text field scrubbed; tool_text too (it leaves the
 * disk, so it crosses the boundary). This is the function the provider wrapper
 * calls — the single choke point (grep-provable).
 */
export interface RedactableTurn {
  role: string;
  text: string | null;
  toolText?: string | null;
  /** ordinal for tier-2 anchor prompts (optional; ignored by redaction) */
  ordinal?: number;
}

export function redactTurns(turns: RedactableTurn[], opts: RedactOptions = DEFAULT_REDACT_OPTIONS): RedactableTurn[] {
  return turns.map((t) => ({
    role: t.role,
    text: t.text ? redactString(t.text, opts) : t.text,
    toolText: t.toolText ? redactString(t.toolText, opts) : t.toolText,
  }));
}
