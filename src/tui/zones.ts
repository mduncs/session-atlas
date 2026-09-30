/**
 * Zone registry (SPEC I2) — interactive components register their rects
 * (measured from Ink's Yoga layout); hit-testing resolves the topmost zone
 * and bubbles the click event. Synthetic clicks (keyboard) reuse the same
 * path as real mouse clicks.
 *
 * The registry is rebuilt on every render (zones are cheap), then a mouse
 * event hit-tests against it. Topmost = last-registered (drawn on top).
 */
export interface ZoneRect {
  x0: number;
  y0: number;
  x1: number; // inclusive
  y1: number; // inclusive
}

export interface Zone {
  id: string;
  rect: ZoneRect;
  /** command to dispatch on click (resolved through the command registry) */
  command: string;
  /** argument passed to the command (e.g. the path, tag, session id) */
  arg?: string;
  /** kind label for hover/peek display */
  kind: "path" | "url" | "session" | "tag" | "badge" | "header" | "star";
}

/**
 * A per-frame zone buffer. Ink renders top-down, so later zones are drawn on
 * top — hit-testing iterates in reverse (topmost first) and stops at the
 * first containing zone (Law 6: bubbling stops on handled).
 */
export class ZoneRegistry {
  private zones: Zone[] = [];

  reset(): void {
    this.zones = [];
  }

  register(zone: Zone): void {
    this.zones.push(zone);
  }

  /** Resolve the topmost zone containing (x, y). Returns null if none. */
  hitTest(x: number, y: number): Zone | null {
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const z = this.zones[i]!;
      const { x0, y0, x1, y1 } = z.rect;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return z;
    }
    return null;
  }

  /** All zones containing a point (for debugging / overlap tests). */
  allContaining(x: number, y: number): Zone[] {
    return this.zones.filter((z) => {
      const { x0, y0, x1, y1 } = z.rect;
      return x >= x0 && x <= x1 && y >= y0 && y <= y1;
    });
  }

  size(): number {
    return this.zones.length;
  }
}

/** Extract clickable atoms (paths, URLs) from a text line. Returns spans
 * with their character offsets, so the renderer can register zones for each. */
export interface Atom {
  kind: "path" | "url";
  text: string;
  /** absolute column where the atom starts (0-based, within the line) */
  startCol: number;
}

const PATH_RE =
  /(?:~\/[^\s'"`<>|]+|(?:\/[\w.@-]+)+\/[^\s'"`<>|]*|[\w][\w.@-]*\/[\w@.\-/]+\.[\w]{1,8})/g;
const URL_RE = /https?:\/\/[^\s'"`<>]+/g;

export function extractAtoms(line: string): Atom[] {
  const atoms: Atom[] = [];
  for (const re of [URL_RE, PATH_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      atoms.push({ kind: re === URL_RE ? "url" : "path", text: m[0], startCol: m.index });
    }
  }
  // Sort by position; if a URL and path overlap, URL (scanned first) wins by
  // keeping the earlier push and deduping overlaps.
  atoms.sort((a, b) => a.startCol - b.startCol);
  const out: Atom[] = [];
  let end = -1;
  for (const a of atoms) {
    if (a.startCol >= end) {
      out.push(a);
      end = a.startCol + a.text.length;
    }
  }
  return out;
}
