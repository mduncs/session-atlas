import { expect, test } from "bun:test";
import { walkChurnOnly } from "../src/commands/index.js";

type Summary = Parameters<typeof walkChurnOnly>[0];
const root = (over: Partial<Summary["roots"][number]> = {}): Summary["roots"][number] => ({
  root: "/r", reachable: true, sessionsSeen: 1, bytesConsumed: 1, physicalUnits: 1, canonicalCandidates: 1,
  sidecarHits: 0, sidecarMisses: 0, sourceParses: 0, unitErrors: 0, changedDuringWalk: false, ...over,
});
const summary = (roots: Summary["roots"]): Summary => ({ source: "claude", mode: "builtin", uniqueIdentities: null, roots } as unknown as Summary);

test("a source left incomplete only by a live root changing mid-walk is not an index failure", () => {
  expect(walkChurnOnly(summary([root({ changedDuringWalk: true }), root()]))).toBe(true);
});

test("unreachable roots, root errors, and unit errors stay failures even when a root also churned", () => {
  expect(walkChurnOnly(summary([root({ changedDuringWalk: true }), root({ reachable: false })]))).toBe(false);
  expect(walkChurnOnly(summary([root({ changedDuringWalk: true, error: "EACCES" })]))).toBe(false);
  expect(walkChurnOnly(summary([root({ changedDuringWalk: true, unitErrors: 1 })]))).toBe(false);
  expect(walkChurnOnly(summary([root()]))).toBe(false);
  expect(walkChurnOnly(summary([]))).toBe(false);
});
