/**
 * The Atlas terminal skin, shared by the list dashboard and the reader.
 * Ink measures every frame line with string-width, whose
 * non-ASCII path segments graphemes and costs ~0.6 ms per wide line; ASCII
 * lines take its fast path. So Atlas-owned chrome is strictly printable ASCII
 * and all visual weight comes from 256-color SGR: background-painted cells
 * draw bars, meters, swatches, and panels; underlined spaces draw rules.
 * Only user content (titles, paths, labels) may carry other characters.
 */
export const fg = (code: number): string => `\x1b[38;5;${code}m`;
export const bg = (code: number): string => `\x1b[48;5;${code}m`;
export const SKIN = {
  accent: fg(214),
  accentSoft: fg(172),
  tan: fg(137),
  faint: fg(237),
  text: fg(252),
  bright: `${fg(255)}\x1b[1m`,
  label: `${fg(246)}\x1b[1m`,
  muted: fg(245),
  dim: fg(240),
  rule: `${fg(238)}\x1b[4m`,
  good: fg(108),
  warn: fg(179),
  bad: fg(167),
  badge: `${bg(214)}${fg(232)}\x1b[1m`,
  chip: `${bg(237)}${fg(252)}`,
  pill: `${bg(214)}${fg(232)}`,
  focusMark: `${fg(214)}\x1b[1m`,
  panel: bg(234),
  focusRow: bg(236),
  selectRow: bg(235),
} as const;
export const END_FG = "\x1b[39;22;24m";
export const END_BG = "\x1b[49m";
export const END_ALL = "\x1b[0m";

export const HARNESS_SKIN: Record<string, HarnessSkin> = {
  claude: { color: 173, code: "cl", letter: "C" },
  codex: { color: 73, code: "cx", letter: "X" },
  prime: { color: 111, code: "pr", letter: "P" },
  kilo: { color: 141, code: "ki", letter: "K" },
  kimi: { color: 211, code: "km", letter: "M" },
  hermes: { color: 179, code: "he", letter: "H" },
  zcode: { color: 108, code: "zc", letter: "Z" },
};
export interface HarnessSkin { color: number; code: string; letter: string }


export type Span = readonly [text: string, style?: string];

const STICKY = new Map<string, boolean>();
/** Whether leaving `style` takes more than the next foreground: weight, underline, or background. */
function sticky(style: string): boolean {
  let value = STICKY.get(style);
  if (value === undefined) {
    value = /\x1b\[(?:1|4)m|\[48;/.test(style);
    STICKY.set(style, value);
  }
  return value;
}

function leave(style: string, base: string): string {
  return style.includes("[48;") ? `${END_ALL}${base}` : END_FG;
}

const BLANK = /^ +$/;

/**
 * Serialize spans with SGR only at style transitions. Ink re-tokenizes every
 * escape on every frame, so transitions, not spans, are the cost. Unstyled
 * blanks inherit a plain foreground (invisible on spaces) instead of paying a
 * reset. Background spans restore `base` so they can sit inside a panel or row.
 */
export function serialize(spans: readonly Span[], base = ""): string {
  let out = "";
  let current = "";
  for (const [text, style = ""] of spans) {
    if (text.length === 0) continue;
    if (style === current) { out += text; continue; }
    if (style === "") {
      if (!sticky(current) && BLANK.test(text)) { out += text; continue; }
      out += leave(current, base);
      current = "";
      out += text;
      continue;
    }
    if (current && sticky(current)) out += leave(current, base);
    out += style + text;
    current = style;
  }
  return current ? out + leave(current, base) : out;
}

export function paint(text: string, style = "", base = ""): string {
  return serialize([[text, style]], base);
}

export const ASCII = /^[\x20-\x7e]*$/;
const SEGMENTER = new Intl.Segmenter();

/** Hard cut to a display width. No ellipsis: a marker would push the line off string-width's ASCII path. */
export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (ASCII.test(text)) return text.length <= width ? text : text.slice(0, width);
  if (Bun.stringWidth(text) <= width) return text;
  let out = "";
  let used = 0;
  for (const { segment } of SEGMENTER.segment(text)) {
    const next = Bun.stringWidth(segment);
    if (used + next > width) break;
    out += segment;
    used += next;
  }
  return out;
}

export function spanWidth(spans: readonly Span[]): number {
  let total = 0;
  for (const [text] of spans) total += Bun.stringWidth(text);
  return total;
}

/** Fit spans to an exact width; `priority` decides which side clips first. */
export function fit(width: number, left: readonly Span[], right: readonly Span[] = [], pad = 0, priority: "left" | "right" = "left"): Span[] {
  const inner = Math.max(0, width - pad * 2);
  const place = (spans: readonly Span[], budget: number): [Span[], number] => {
    const out: Span[] = [];
    let used = 0;
    for (const [text, style] of spans) {
      if (used >= budget) break;
      const fitted = clip(text, budget - used);
      if (!fitted) continue;
      out.push([fitted, style]);
      used += Bun.stringWidth(fitted);
    }
    return [out, used];
  };
  let leftOut: Span[], leftUsed: number, rightOut: Span[], rightUsed: number;
  if (priority === "right") {
    [rightOut, rightUsed] = place(right, Math.min(inner, spanWidth(right)));
    [leftOut, leftUsed] = place(left, inner - rightUsed - (rightUsed > 0 ? 1 : 0));
  } else {
    [leftOut, leftUsed] = place(left, inner);
    [rightOut, rightUsed] = place(right, inner - leftUsed);
  }
  const edge: Span = [" ".repeat(pad)];
  return [edge, ...leftOut, [" ".repeat(Math.max(0, inner - leftUsed - rightUsed))], ...rightOut, edge];
}

/** One exact-width painted line. */
export function compose(width: number, left: readonly Span[], right: readonly Span[] = [], pad = 0, priority: "left" | "right" = "left", base = ""): string {
  return serialize(fit(width, left, right, pad, priority), base);
}

export function cell(value: string, width: number, style = "", align: "left" | "right" | "center" = "left"): Span {
  return [fixed(value, width, align), style];
}

export function harnessSkin(source: string): HarnessSkin {
  const value = source.toLowerCase();
  return HARNESS_SKIN[value] ?? { color: 245, code: value.slice(0, 2), letter: value.slice(0, 1).toUpperCase() };
}

/** Atlas-owned text (messages, buckets, providers) folds common punctuation to ASCII. */
export function asciiLabel(value: string): string {
  return ASCII.test(value) ? value : value.replace(/[–—·]/g, "-").replace(/[“”]/g, "\"").replace(/[‘’]/g, "'").replace(/…/g, "...").replace(/×/g, "x");
}

export function fixed(value: string, width: number, align: "left" | "right" | "center" = "left"): string {
  if (width <= 0) return "";
  const clipped = clip(value, width);
  const padding = Math.max(0, width - Bun.stringWidth(clipped));
  if (align === "right") return `${" ".repeat(padding)}${clipped}`;
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
  }
  return `${clipped}${" ".repeat(padding)}`;
}

export function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}
