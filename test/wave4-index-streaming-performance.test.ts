import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MalformedJsonlLineError,
  visitCompleteJsonl,
  visitCompleteJsonlFile,
  type Adapter,
  type IngestRecord,
} from "../src/adapters/types.js";
import type { Config } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { ingest } from "../src/ingest.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "atlas-index-streaming-"));
  dirs.push(dir);
  return dir;
}

test("visitCompleteJsonl streams complete rows with byte offsets and leaves a torn tail retryable", () => {
  const rows = [
    JSON.stringify({ text: "ascii" }),
    JSON.stringify({ text: "héllø 🌎" }),
    "   ",
    JSON.stringify({ text: "last complete" }),
  ];
  const complete = `${rows.join("\n")}\n`;
  const tornTail = JSON.stringify({ text: "not complete yet" }).slice(0, 17);
  const visited: Array<{ value: unknown; byteOffset: number }> = [];

  const consumed = visitCompleteJsonl(
    Buffer.from(complete + tornTail),
    "/fixture/stream.jsonl",
    (line) => visited.push(line),
  );

  expect(consumed).toBe(Buffer.byteLength(complete));
  expect(visited).toEqual([
    { value: { text: "ascii" }, byteOffset: 0 },
    { value: { text: "héllø 🌎" }, byteOffset: Buffer.byteLength(`${rows[0]}\n`) },
    {
      value: { text: "last complete" },
      byteOffset: Buffer.byteLength(`${rows[0]}\n${rows[1]}\n${rows[2]}\n`),
    },
  ]);
});

test("visitCompleteJsonl stops incrementally at the first malformed complete row", () => {
  const first = JSON.stringify({ ordinal: 0 });
  const malformed = "{this is not json}";
  const neverVisited = JSON.stringify({ ordinal: 2 });
  const visited: unknown[] = [];
  const malformedOffset = Buffer.byteLength(`${first}\n`);

  let thrown: unknown;
  try {
    visitCompleteJsonl(
      Buffer.from(`${first}\n${malformed}\n${neverVisited}\n`),
      "/fixture/malformed.jsonl",
      ({ value }) => visited.push(value),
    );
  } catch (error) {
    thrown = error;
  }

  expect(visited).toEqual([{ ordinal: 0 }]);
  expect(thrown).toBeInstanceOf(MalformedJsonlLineError);
  expect(thrown).toMatchObject({
    sourcePath: "/fixture/malformed.jsonl",
    byteOffset: malformedOffset,
  });
  expect((thrown as Error).message).toContain(`byte ${malformedOffset}`);
});

test("visitCompleteJsonlFile bounds raw reads while preserving UTF-8, offsets, and a torn tail", () => {
  const dir = temp();
  const path = join(dir, "split.jsonl");
  const first = JSON.stringify({ text: "héllo 🌌" });
  const second = JSON.stringify({ n: 2 });
  writeFileSync(path, `${first}\n${second}\n{"torn":"later"}`);
  const seen: Array<{ value: unknown; byteOffset: number }> = [];

  const consumed = visitCompleteJsonlFile(path, (line) => seen.push(line), 5);

  expect(seen).toEqual([
    { value: { text: "héllo 🌌" }, byteOffset: 0 },
    { value: { n: 2 }, byteOffset: Buffer.byteLength(first) + 1 },
  ]);
  expect(consumed).toBe(Buffer.byteLength(`${first}\n${second}\n`));
});

test("visitCompleteJsonlFile reports the exact malformed complete-line byte", () => {
  const dir = temp();
  const path = join(dir, "bad.jsonl");
  const valid = JSON.stringify({ ok: true });
  writeFileSync(path, `${valid}\n{"bad":}\n`);
  let error: unknown;

  try {
    visitCompleteJsonlFile(path, () => {}, 4);
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(MalformedJsonlLineError);
  expect((error as MalformedJsonlLineError).byteOffset).toBe(Buffer.byteLength(valid) + 1);
});

test("ingest reports bounded progress before source completion on a 501-identity walk", async () => {
  const dir = temp();
  const sourcePath = join(dir, "source.fixture");
  writeFileSync(sourcePath, "fixture");
  const identityCount = 501;
  let parseCount = 0;
  const adapter: Adapter = {
    source: "fixture",
    discover: ([root]) =>
      Array.from({ length: identityCount }, (_, index) => ({
        root: root!,
        relPath: `session-${index}`,
        fullPath: sourcePath,
        nativeId: `session-${index}`,
      })),
    parse(src) {
      parseCount++;
      const record: IngestRecord = {
        nativeId: src.nativeId,
        cwd: "/fixture",
        project: "/fixture",
        title: src.nativeId,
        startTs: null,
        endTs: null,
        models: [],
        messages: [],
        transcriptBytes: 7,
        origin: "unknown",
        construction: {
          artifactKind: "metadata_shell",
          historyCompleteness: "complete",
          defaultSessionVisible: false,
          sourceValidationStatus: "current",
          sourceObservedTs: null,
          project: {
            originalProjectKey: "/fixture",
            canonicalProjectKey: "/fixture",
            canonicalizationRuleVersion: "fixture-project-v1",
          },
          titleCandidates: [],
          classificationRuleVersion: "fixture-class-v1",
          replayRuleVersion: "fixture-replay-v1",
        },
      };
      return { record, consumed: 7 };
    },
  };
  const dbPath = join(dir, "atlas.db");
  const config: Config = {
    sources: { fixture: { roots: [sourcePath] } },
    providers: [],
    launchers: [],
    tunables: {
      tag_promotion_count: 3,
      export_budget_tokens: 20_000,
      fav_default_span: 6,
      summary_stale_pct: 25,
      redact_entropy_threshold: 4.8,
    },
    dbPath,
  };
  const events: string[] = [];
  const db = await openDb(dbPath);

  try {
    const summaries = await ingest(db, config, {
      adapters: { fixture: adapter },
      onProgress: ({ source, processed, total }) =>
        events.push(`progress:${source}:${processed}/${total}`),
      onSourceComplete: ({ source, inserted }) =>
        events.push(`complete:${source}:${inserted}`),
    });

    expect(parseCount).toBe(identityCount);
    expect(events).toEqual([
      `progress:fixture:500/${identityCount}`,
      `complete:fixture:${identityCount}`,
    ]);
    expect(summaries[0]).toMatchObject({
      source: "fixture",
      inserted: identityCount,
      replaced: 0,
      unchanged: 0,
    });
    expect(
      (db.prepare("SELECT COUNT(*) count FROM sessions").get() as { count: number }).count,
    ).toBe(identityCount);
  } finally {
    db.close();
  }
});
