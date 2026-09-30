import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_CATALOG } from "../src/conformance/fixture-catalog.js";

const fixtureRoot = join(import.meta.dir, "fixtures", "phase3a");

test("F01-F20 shape manifest exactly binds frozen (G,X) vectors", () => {
  const manifest = JSON.parse(readFileSync(join(fixtureRoot, "shape-manifest.json"), "utf8")) as {
    version: string;
    fixtures: Array<{ fixture_id: string; opaque_provenance_token: string; expected_gx: number[][] }>;
  };
  expect(manifest.version).toBe("phase3a-synthetic-v1");
  expect(manifest.fixtures.map((entry) => entry.fixture_id)).toEqual(
    Array.from({ length: 20 }, (_, index) => `F${String(index + 1).padStart(2, "0")}`),
  );
  for (const entry of manifest.fixtures) {
    const frozen = FIXTURE_CATALOG.find((candidate) => candidate.id === entry.fixture_id);
    if (!frozen) throw new Error(`missing frozen fixture ${entry.fixture_id}`);
    expect(entry.opaque_provenance_token).toBe(`P-${entry.fixture_id}`);
    expect(entry.expected_gx).toEqual(
      frozen.expectedStates.map((state) => [...state.metrics, state.unknownIdentityRawRowCount]),
    );
  }
});

test("Phase 3A committed fixtures contain synthetic structure only", () => {
  const files = readdirSync(fixtureRoot).sort();
  const before = files.map((file) => createHash("sha256").update(readFileSync(join(fixtureRoot, file))).digest("hex"));
  const text = files.map((file) => readFileSync(join(fixtureRoot, file), "utf8")).join("\n");
  const forbidden = [
    /\/(?:Users|Volumes|home)\//,
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
    /\b[0-9a-f]{64}\b/i,
    /\b019f[0-9a-f-]{20,}\b/i,
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    /(?:api[_-]?key|secret|bearer|password)\s*[:=]/i,
  ];
  for (const pattern of forbidden) expect(text).not.toMatch(pattern);
  expect(text).not.toContain("native_id");
  expect(text).not.toContain("source_hash");
  expect(text).not.toContain("absolute_path");
  const after = files.map((file) => createHash("sha256").update(readFileSync(join(fixtureRoot, file))).digest("hex"));
  expect(after).toEqual(before);
});
