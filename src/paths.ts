import { homedir } from "node:os";

/** Expand a leading `~` to the home directory; leave other paths intact. */
export function expandPath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return homedir() + p.slice(1);
  return p;
}

/**
 * Fish-style path truncation: middle segments collapse to their first char,
 * the final segment stays full. `~/c/session-atlas`. Returns the input
 * unchanged for non-home, short, or single-segment paths.
 */
export function fishPath(p: string, home: string = homedir()): string {
  let work = p;
  if (work === home) return "~";
  if (work.startsWith(home + "/")) work = "~" + work.slice(home.length);
  const parts = work.split("/");
  // Keep leading sigil (e.g. "~") intact as parts[0].
  const sigil = work.startsWith("~") ? parts[0] : "";
  const segs = work.startsWith("~") ? parts.slice(1) : parts;
  if (segs.length <= 1) return work;
  const last = segs[segs.length - 1];
  const collapsed = segs.slice(0, -1).map((s) => (s ? s[0]! : ""));
  return sigil ? `${sigil}/${collapsed.join("/")}/${last}` : `${collapsed.join("/")}/${last}`;
}
