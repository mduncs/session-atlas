import stringWidth from "string-width";
import type { Passage } from "../contracts";

export interface Line { passage: number; start: number; end: number; header?: boolean }
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** UTF-16 offsets are private layout coordinates, never public passage addresses. */
export function layoutPassages(passages: Passage[], width: number): Line[] {
  width = Math.max(1, width);
  const rows: Line[] = [];
  passages.forEach((passage, index) => {
    rows.push({ passage: index, start: 0, end: 0, header: true });
    const text = passage.text;
    let start = 0, cells = 0, end = 0, breakAt = -1;
    // Segment one physical line at a time: avoids pathological Segmenter cost on a MiB input.
    let physicalStart = 0;
    while (physicalStart <= text.length) {
      const newline = text.indexOf("\n", physicalStart);
      const physicalEnd = newline < 0 ? text.length : newline;
      const raw = text.slice(physicalStart, physicalEnd);
      start = physicalStart; cells = 0; breakAt = -1;
      for (const item of segmenter.segment(raw)) {
        const pos = physicalStart + item.index;
        const count = item.segment === "\t" ? 4 - cells % 4 : stringWidth(item.segment.replace(/\r/g, ""));
        if (cells + count > width && pos > start) {
          // Keep code indentation untouched; word wrapping only changes row boundaries.
          const boundary = breakAt > start && !/^\s/.test(raw) ? breakAt : pos;
          rows.push({ passage: index, start, end: boundary });
          start = boundary;
          cells = stringWidth(displayText(text.slice(start, pos)));
          breakAt = -1;
        }
        cells += count; end = pos + item.segment.length;
        if (/\s/u.test(item.segment)) breakAt = end;
      }
      rows.push({ passage: index, start, end: physicalEnd });
      if (newline < 0) break;
      physicalStart = newline + 1;
    }
  });
  return rows;
}
export function displayText(text: string): string {
  let column = 0;
  return Array.from(segmenter.segment(text), ({ segment }) => {
    if (segment === "\t") { const n = 4 - column % 4; column += n; return " ".repeat(n); }
    if (segment === "\r") return "";
    // Never feed source escape/control sequences to the terminal renderer.
    const safe = segment.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "�");
    column += stringWidth(safe); return safe;
  }).join("");
}
export function offsetAt(text: string, line: Line, column: number): number {
  let cells = 0;
  for (const item of segmenter.segment(text.slice(line.start, line.end))) {
    const n = item.segment === "\t" ? 4 - cells % 4 : stringWidth(item.segment);
    if (cells + n > column) return line.start + item.index;
    cells += n;
  }
  return line.end;
}
