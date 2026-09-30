export type SearchSyntax = "literal" | "raw_fts5";

export interface CompiledFtsQuery {
  /** Parameter value for `session_search_fts MATCH ?`. */
  match: string;
  /** Lossless, trimmed user text for result headings and diagnostics. */
  display: string;
  syntax: SearchSyntax;
}

export class SearchQueryCompileError extends Error {
  readonly code = "invalid_query";
}

/**
 * Compile ordinary user text into safe FTS5 literals. Whitespace-delimited
 * atoms are ANDed; a balanced double-quoted atom is one exact phrase. Common
 * code/path punctuation stays inside the literal and is tokenized by v12's
 * `_+./-` tokenchars rather than being interpreted as MATCH grammar.
 */
export function literalFtsQuery(input: string): string {
  return literalAtoms(input)
    .map((atom) => `"${atom.replaceAll('"', '""')}"`)
    .join(" ");
}

/**
 * The sole query compiler used by the service, CLI, and TUI/list adapter.
 * Ordinary search is always dialogue-scoped. Raw FTS5 remains dialogue-scoped
 * unless the operator explicitly labels `prose:` or `title:` in the grammar.
 */
export function compileFtsQuery(input: string, syntax: SearchSyntax = "literal"): CompiledFtsQuery {
  const display = input.trim();
  if (!display) throw new SearchQueryCompileError("Search query must not be blank");
  if (syntax === "literal") {
    const literal = literalFtsQuery(display);
    if (!literal) throw new SearchQueryCompileError("Search query has no searchable text");
    return { match: `prose : (${literal})`, display, syntax };
  }
  if (syntax !== "raw_fts5") throw new SearchQueryCompileError("Unknown search syntax");
  // A column scope is an explicit labeled request. Merely selecting raw mode
  // does not make title-only metadata leak into ordinary dialogue results.
  const explicitScope = /(?:^|[\s(])(?:prose|title)\s*:/iu.test(display);
  return {
    match: explicitScope ? display : `prose : (${display})`,
    display,
    syntax,
  };
}

interface LiteralAtom {
  value: string;
  phrase: boolean;
}

function literalAtoms(input: string): string[] {
  const text = input.trim();
  const atoms: LiteralAtom[] = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/u.test(text[index]!)) index++;
    if (index >= text.length) break;

    // Quotes become phrase delimiters only when a complete, atom-bounded pair
    // exists. Unmatched/embedded quotes remain literal punctuation, so the
    // default compiler cannot surface an FTS syntax error.
    if (text[index] === '"') {
      const close = text.indexOf('"', index + 1);
      if (close > index + 1 && (close + 1 === text.length || /\s/u.test(text[close + 1]!))) {
        const value = text.slice(index + 1, close).trim();
        if (value) atoms.push({ value, phrase: true });
        index = close + 1;
        continue;
      }
    }

    let end = index + 1;
    while (end < text.length && !/\s/u.test(text[end]!)) end++;
    const value = text.slice(index, end);
    if (value) atoms.push({ value, phrase: false });
    index = end;
  }
  // Both phrase and term atoms compile to an FTS quoted string. The semantic
  // difference is that phrase atoms retain internal whitespace in one string.
  return atoms.map((atom) => atom.value);
}
