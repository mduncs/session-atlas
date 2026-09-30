import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_TUNABLES, type Config } from "../src/config.js";
import { openDb, type DB } from "../src/db/index.js";
import { TITLE_DISPLAY_MAX, displayTitle, ingest } from "../src/ingest.js";
import { repairSessionTitles } from "../src/title-repair.js";
import {
  loadPreparedConstruction,
  resolveIngestSidecar,
  type SidecarHeader,
} from "../src/ingest-sidecar.js";
import type {
  Adapter,
  DiscoveredSource,
  IngestRecord,
  NormalizedMessage,
  NormalizedToolActivity,
  RecordKind,
} from "../src/adapters/types.js";

interface FixtureSpec {
  nativeId: string;
  relPath: string;
  initial: string;
}

interface FixtureHarness {
  adapter: Adapter;
  specs: FixtureSpec[];
  paths: string[];
  state: { parseCount: number };
}

const ownedDirs: string[] = [];
let db: DB | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  for (const dir of ownedDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(name: string): { dir: string; sourceRoot: string; dbPath: string; sidecarDir: string } {
  const dir = mkdtempSync(join(tmpdir(), `atlas-wave8-sidecars-${name}-`));
  ownedDirs.push(dir);
  const sourceRoot = join(dir, "source");
  mkdirSync(sourceRoot, { recursive: true });
  return {
    dir,
    sourceRoot,
    dbPath: join(dir, "atlas.db"),
    sidecarDir: join(dir, "sidecars"),
  };
}

function config(sourceRoot: string, dbPath: string): Config {
  return {
    sources: {
      fixture: {
        mode: "replace",
        roots: [sourceRoot],
        disabledReason: null,
      },
    } as Config["sources"],
    providers: [],
    launchers: [],
    tunables: { ...DEFAULT_TUNABLES },
    dbPath,
  };
}

function makeFixture(
  sourceRoot: string,
  specs: FixtureSpec[],
  makeRecord: (source: DiscoveredSource, raw: string) => IngestRecord,
): FixtureHarness {
  const paths = specs.map((spec) => {
    const path = join(sourceRoot, spec.relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, spec.initial);
    return path;
  });
  const state = { parseCount: 0 };
  const adapter: Adapter = {
    source: "fixture",
    sidecarVersion: "fixture-contract-v1",
    continuitySupport: "supported",
    discover: (roots) => specs.map((spec) => ({
      root: roots[0]!,
      relPath: spec.relPath,
      fullPath: join(roots[0]!, spec.relPath),
      nativeId: spec.nativeId,
      candidateKind: "fixture-transcript",
    })),
    parse: (source) => {
      state.parseCount++;
      const raw = readFileSync(source.fullPath, "utf8");
      return { record: makeRecord(source, raw), consumed: Buffer.byteLength(raw) };
    },
  };
  return { adapter, specs, paths, state };
}

function oneSource(harness: FixtureHarness, index = 0): DiscoveredSource {
  const spec = harness.specs[index]!;
  return {
    root: dirname(harness.paths[index]!),
    relPath: spec.relPath,
    fullPath: harness.paths[index]!,
    nativeId: spec.nativeId,
    candidateKind: "fixture-transcript",
  };
}

function recordFor(
  source: DiscoveredSource,
  raw: string,
  messages: NormalizedMessage[] = [message(0, "m1", "real_user", raw.trim(), 100)],
  overrides: Partial<IngestRecord> = {},
): IngestRecord {
  const first = messages[0]!;
  const last = messages.at(-1)!;
  const visible = messages.some((item) =>
    (item.recordKind === "real_user" || item.recordKind === "assistant_dialogue_prose")
      && Boolean(item.prose?.trim()),
  );
  const title = overrides.title === undefined ? first.prose ?? first.text : overrides.title;
  return {
    nativeId: source.nativeId,
    cwd: "/fixture",
    project: "/fixture",
    title,
    startTs: first.eventTs ?? first.ts,
    endTs: last.eventTs ?? last.ts,
    models: ["fixture-model"],
    messages,
    transcriptBytes: Buffer.byteLength(raw),
    origin: "human",
    continuitySupport: "supported",
    continuityEvents: [],
    construction: {
      artifactKind: "dialogue_history",
      historyCompleteness: "complete",
      defaultSessionVisible: visible,
      sourceValidationStatus: "current",
      sourceObservedTs: null,
      project: {
        originalProjectKey: "/fixture",
        canonicalProjectKey: "/fixture",
        canonicalizationRuleVersion: "fixture-project-v1",
      },
      titleCandidates: title
        ? [{
            value: title,
            authority: "real_user_fallback",
            harnessSourceClass: "fixture-user",
            sourceRecordId: first.sourceRecordId ?? null,
            sourceReference: null,
            sourceOrdinal: first.sourceOrdinal ?? first.ordinal,
            eligibilityRuleVersion: "fixture-title-v1",
          }]
        : [],
      classificationRuleVersion: "fixture-classification-v1",
      replayRuleVersion: "fixture-replay-v1",
    },
    ...overrides,
  };
}

function message(
  ordinal: number,
  sourceRecordId: string | null,
  kind: RecordKind,
  prose: string | null,
  ts: number,
  toolActivities: NormalizedToolActivity[] = [],
): NormalizedMessage {
  const dialogueSide = kind === "real_user" ? "user" : kind === "assistant_dialogue_prose" ? "assistant" : null;
  const role = dialogueSide ?? (kind === "tool" ? "tool" : "system");
  return {
    ordinal,
    sourceOrdinal: ordinal,
    role,
    ts,
    text: dialogueSide ? prose : null,
    toolText: null,
    hasTool: toolActivities.length > 0,
    recordKind: kind,
    dialogueSide,
    prose: dialogueSide ? prose : null,
    eventTs: ts,
    toolActivities,
    sourceRecordId,
    sourceRecordUuid: null,
    sourceRecordTs: sourceRecordId === null ? null : ts,
    sourceIdentityKind: sourceRecordId === null ? "none" : "record-id",
  };
}

function toolActivity(secret: string): NormalizedToolActivity {
  return {
    activityOrdinal: 0,
    activityKind: "result",
    toolName: "fixture-tool",
    toolText: secret,
    sourceActivityId: "activity-1",
  };
}

function sidecarFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...sidecarFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".atlas-ingest")) found.push(path);
  }
  return found;
}

function readSidecar(path: string): { header: SidecarHeader; payload: any; bytes: Buffer; payloadOffset: number } {
  const bytes = readFileSync(path);
  const prefix = bytes.subarray(0, 16).toString("ascii");
  const match = /^ATLAS1:([0-9a-f]{8})\n$/.exec(prefix);
  if (!match) throw new Error(`sidecar has no valid prefix: ${path}`);
  const headerBytes = Number.parseInt(match[1]!, 16);
  const payloadOffset = 16 + headerBytes;
  const header = JSON.parse(bytes.subarray(16, payloadOffset).toString("utf8")) as SidecarHeader;
  const payloadText = bytes.subarray(payloadOffset).toString("utf8");
  return { header, payload: payloadText ? JSON.parse(payloadText) : null, bytes, payloadOffset };
}

function onlySidecar(root: string): string {
  const files = sidecarFiles(root);
  expect(files).toHaveLength(1);
  return files[0]!;
}

function dbHasBytes(path: string, value: string): boolean {
  if (!existsSync(path)) return false;
  return readFileSync(path).includes(Buffer.from(value));
}

test("sidecar miss then header-only hit avoids reparse and payload reads", async () => {
  const f = fixture("warm");
  const harness = makeFixture(f.sourceRoot, [{ nativeId: "warm-1", relPath: "warm.txt", initial: "warm transcript\n" }], (source, raw) => recordFor(source, raw));
  const sourceBefore = readFileSync(harness.paths[0]!);
  db = await openDb(f.dbPath);
  const options = { adapters: { fixture: harness.adapter }, sidecarDir: f.sidecarDir };

  const first = await ingest(db, config(f.sourceRoot, f.dbPath), options);
  expect(first[0]).toMatchObject({ sidecarMisses: 1, sidecarHits: 0, sourceParses: 1, inserted: 1 });
  expect(readFileSync(harness.paths[0]!)).toEqual(sourceBefore);

  // The header reader checks size/fingerprint but intentionally does not verify
  // the payload checksum. A warm reconciliation must not touch this payload;
  // making it invalid therefore still permits a hit and unchanged publication.
  const sidecar = onlySidecar(f.sidecarDir);
  const original = readFileSync(sidecar);
  const { payloadOffset } = readSidecar(sidecar);
  const damaged = Buffer.from(original);
  damaged[payloadOffset] = damaged[payloadOffset] === 0x7b ? 0x5b : 0x7b;
  writeFileSync(sidecar, damaged);

  harness.state.parseCount = 0;
  const second = await ingest(db, config(f.sourceRoot, f.dbPath), options);
  expect(second[0]).toMatchObject({ sidecarHits: 1, sidecarMisses: 0, sourceParses: 0, unchanged: 1 });
  expect(harness.state.parseCount).toBe(0);
});

test("same-size source mutation invalidates a sidecar by its source fingerprint", async () => {
  const f = fixture("invalidation");
  const harness = makeFixture(f.sourceRoot, [{ nativeId: "mutable-1", relPath: "mutable.txt", initial: "v1\n" }], (source, raw) => recordFor(source, raw));
  db = await openDb(f.dbPath);
  const options = { adapters: { fixture: harness.adapter }, sidecarDir: f.sidecarDir };
  await ingest(db, config(f.sourceRoot, f.dbPath), options);
  expect(harness.state.parseCount).toBe(1);

  writeFileSync(harness.paths[0]!, "v2\n");
  const future = new Date(Date.now() + 2_000);
  utimesSync(harness.paths[0]!, future, future);
  const second = await ingest(db, config(f.sourceRoot, f.dbPath), options);

  expect(second[0]).toMatchObject({ sidecarHits: 0, sidecarMisses: 1, sourceParses: 1, replaced: 1 });
  expect(harness.state.parseCount).toBe(2);
  expect((db.prepare(`SELECT title,transcript_bytes FROM sessions WHERE native_id='mutable-1'`).get() as { title: string; transcript_bytes: number })).toMatchObject({ title: "v2", transcript_bytes: 3 });
  const { header } = readSidecar(onlySidecar(f.sidecarDir));
  expect(header.source.fingerprint).toMatch(/^[0-9a-f]{64}$/);
});

test("compact sidecars retain dialogue evidence but omit full tool payloads from sidecar and DB", async () => {
  const f = fixture("compact");
  const secret = "THIS_TOOL_PAYLOAD_MUST_NOT_PERSIST_987654321";
  const harness = makeFixture(f.sourceRoot, [{ nativeId: "compact-1", relPath: "compact.txt", initial: "fixture source\n" }], (source, raw) => recordFor(source, raw, [
    message(0, "u1", "real_user", "please inspect", 100),
    message(1, "a1", "assistant_dialogue_prose", "inspection complete", 200, [toolActivity(secret)]),
  ]));
  db = await openDb(f.dbPath);
  await ingest(db, config(f.sourceRoot, f.dbPath), { adapters: { fixture: harness.adapter }, sidecarDir: f.sidecarDir });

  const sidecar = onlySidecar(f.sidecarDir);
  const { header, payload, bytes } = readSidecar(sidecar);
  expect(header.outcome).toMatchObject({ kind: "admitted", rawRecordCount: 2, rawToolActivityCount: 1 });
  expect(payload.record.messages[0]).toMatchObject({ prose: "please inspect", contentBytes: Buffer.byteLength("please inspect") });
  const compactTool = payload.record.messages[1].toolActivities[0];
  expect(compactTool).toMatchObject({ toolText: null, payloadBytes: Buffer.byteLength(secret) });
  expect(compactTool.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(compactTool.payloadTokenEstimate).toBeGreaterThan(0);
  expect(bytes.includes(Buffer.from(secret))).toBe(false);

  const session = db.prepare(`SELECT id FROM sessions WHERE native_id='compact-1'`).get() as { id: number };
  const storedMessage = db.prepare(`SELECT text,tool_text,content_digest,content_bytes,content_token_estimate FROM messages WHERE session_id=? AND ordinal=1`).get(session.id) as {
    text: string | null;
    tool_text: string | null;
    content_digest: string | null;
    content_bytes: number;
    content_token_estimate: number;
  };
  const storedTool = db.prepare(`SELECT tool_text,payload_digest,payload_bytes,payload_token_estimate FROM tool_activities WHERE raw_record_id=(SELECT id FROM messages WHERE session_id=? AND ordinal=1)`).get(session.id) as {
    tool_text: string | null;
    payload_digest: string | null;
    payload_bytes: number;
    payload_token_estimate: number;
  };
  expect(storedMessage).toMatchObject({ text: "inspection complete", tool_text: null, content_bytes: Buffer.byteLength("inspection complete") });
  expect(storedMessage.content_digest).toMatch(/^[0-9a-f]{64}$/);
  expect(storedMessage.content_token_estimate).toBeGreaterThan(0);
  expect(storedTool).toMatchObject({ tool_text: null, payload_bytes: Buffer.byteLength(secret) });
  expect(storedTool.payload_digest).toMatch(/^[0-9a-f]{64}$/);
  expect(storedTool.payload_token_estimate).toBeGreaterThan(0);
  expect(dbHasBytes(f.dbPath, secret) || dbHasBytes(`${f.dbPath}-wal`, secret)).toBe(false);
});

test("truncated sidecar cache is recaptured atomically without touching the source", async () => {
  const f = fixture("corrupt");
  const harness = makeFixture(f.sourceRoot, [{ nativeId: "corrupt-1", relPath: "corrupt.txt", initial: "cache me\n" }], (source, raw) => recordFor(source, raw));
  const sourceBefore = readFileSync(harness.paths[0]!);
  db = await openDb(f.dbPath);
  const options = { adapters: { fixture: harness.adapter }, sidecarDir: f.sidecarDir };
  await ingest(db, config(f.sourceRoot, f.dbPath), options);
  const sidecar = onlySidecar(f.sidecarDir);
  writeFileSync(sidecar, readFileSync(sidecar).subarray(0, 11));

  harness.state.parseCount = 0;
  const recovered = await ingest(db, config(f.sourceRoot, f.dbPath), options);
  expect(recovered[0]).toMatchObject({ sidecarHits: 0, sidecarMisses: 1, sourceParses: 1, unchanged: 1 });
  expect(harness.state.parseCount).toBe(1);
  expect(readFileSync(harness.paths[0]!)).toEqual(sourceBefore);
  const { header, payload, bytes } = readSidecar(sidecar);
  expect(header.outcome.kind).toBe("admitted");
  expect(payload.record.nativeId).toBe("corrupt-1");
  expect(bytes.byteLength).toBeGreaterThan(header.payloadBytes);
});

test("durable sidecars let an interrupted publication restart without reparsing", async () => {
  const f = fixture("restart");
  const harness = makeFixture(f.sourceRoot, [
    { nativeId: "restart-a", relPath: "a.txt", initial: "first\n" },
    { nativeId: "restart-b", relPath: "b.txt", initial: "second\n" },
  ], (source, raw) => recordFor(source, raw));
  db = await openDb(f.dbPath);
  const base = { adapters: { fixture: harness.adapter }, sidecarDir: f.sidecarDir, publicationChunkSize: 1 };
  const interrupted = await ingest(db, config(f.sourceRoot, f.dbPath), {
    ...base,
    faultAfterPublicationChunk: (completedChunks) => {
      if (completedChunks === 1) throw new Error("simulated publication interruption");
    },
  });
  expect(interrupted[0]?.roots[0]?.error).toContain("simulated publication interruption");
  expect(harness.state.parseCount).toBe(2);
  expect(sidecarFiles(f.sidecarDir)).toHaveLength(2);
  expect((db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE harness='fixture'`).get() as { n: number }).n).toBe(1);

  harness.state.parseCount = 0;
  const restarted = await ingest(db, config(f.sourceRoot, f.dbPath), base);
  expect(restarted[0]).toMatchObject({ sidecarHits: 2, sidecarMisses: 0, sourceParses: 0, inserted: 1 });
  expect(restarted[0]?.unchanged).toBe(1);
  expect(harness.state.parseCount).toBe(0);
  expect((db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE harness='fixture' AND orphaned=0`).get() as { n: number }).n).toBe(2);
});

test("sidecar contract metrics, title, continuity, lineage, replay, and session aggregates stay in parity", async () => {
  const f = fixture("parity");
  const assistantUuid = "12345678-1234-4234-8234-123456789abc";
  const parityMessages = [
    message(0, "u1", "real_user", "same user turn", 100),
    message(1, "u1", "real_user", "same user turn", 100),
    {
      ...message(2, assistantUuid, "assistant_dialogue_prose", "assistant answer", 200, [toolActivity("parity tool output")]),
      sourceRecordUuid: assistantUuid,
      sourceIdentityKind: "uuid" as const,
    },
  ];
  const harness = makeFixture(f.sourceRoot, [{ nativeId: "parity-1", relPath: "parity.txt", initial: "parity fixture bytes\n" }], (source, raw) => recordFor(source, raw, parityMessages, {
    title: "Parity fixture",
    parentNativeId: "missing-parent",
    continuityEvents: [{
      kind: "compaction",
      sourceOrdinal: 2,
      sourceRecordId: "a1",
      sourceRecordUuid: null,
      sourceRecordTs: 200,
      sourceIdentityKind: "record-id",
      detail: "explicit source checkpoint",
    }],
    construction: {
      ...recordFor(source, raw, parityMessages).construction!,
      titleCandidates: [{
        value: "Parity fixture",
        authority: "source_explicit",
        harnessSourceClass: "fixture-title",
        sourceRecordId: "a1",
        sourceReference: "fixture://title",
        sourceOrdinal: 2,
        eligibilityRuleVersion: "fixture-title-v2",
      }],
    },
  }));
  db = await openDb(f.dbPath);
  const options = { adapters: { fixture: harness.adapter }, sidecarDir: f.sidecarDir };
  await ingest(db, config(f.sourceRoot, f.dbPath), options);

  const sidecarPath = onlySidecar(f.sidecarDir);
  const { header, payload } = readSidecar(sidecarPath);
  expect(header.outcome).toMatchObject({
    kind: "admitted",
    nativeId: "parity-1",
    rawRecordCount: payload.record.messages.length,
    logicalRecordCount: payload.logicalRecords.length,
    rawToolActivityCount: payload.constructionMetrics.rawToolActivityCount,
    continuityEvidenceCount: 1,
    lineageClaimCount: 1,
    titleCandidateCount: 1,
  });

  const session = db.prepare(`SELECT * FROM sessions WHERE harness='fixture' AND native_id='parity-1'`).get() as {
    id: number;
    title: string;
    parent_native_id: string;
    construction_generation: string;
    tok_user: number;
    tok_assistant: number;
    tok_tool: number;
    msg_count: number;
    transcript_bytes: number;
    construction_status: string;
  };
  expect(session).toMatchObject({
    title: "Parity fixture",
    parent_native_id: "missing-parent",
    construction_generation: header.outcome.kind === "admitted" ? header.outcome.constructionGeneration : "",
    msg_count: 3,
    transcript_bytes: Buffer.byteLength("parity fixture bytes\n"),
    construction_status: "valid",
    tok_user: payload.aggregate.tokUser,
    tok_assistant: payload.aggregate.tokAssistant,
    tok_tool: payload.aggregate.tokTool,
  });

  const metrics = db.prepare(`SELECT * FROM construction_metrics WHERE session_id=?`).get(session.id) as Record<string, number>;
  expect(metrics).toMatchObject({
    raw_provenance_row_count: payload.constructionMetrics.rawProvenanceRowCount,
    logical_record_count: payload.constructionMetrics.logicalRecordCount,
    raw_tool_activity_count: payload.constructionMetrics.rawToolActivityCount,
    logical_tool_activity_count: payload.constructionMetrics.logicalToolActivityCount,
    raw_prose_bearing_record_count: payload.constructionMetrics.rawProseBearingRecordCount,
    logical_prose_bearing_record_count: payload.constructionMetrics.logicalProseBearingRecordCount,
    dialogue_turn_count: payload.constructionMetrics.dialogueTurnCount,
    user_dialogue_turn_count: payload.constructionMetrics.userDialogueTurnCount,
    assistant_dialogue_turn_count: payload.constructionMetrics.assistantDialogueTurnCount,
    logical_replay_count: payload.constructionMetrics.logicalReplayCount,
    unknown_identity_raw_row_count: payload.constructionMetrics.unknownIdentityRawRowCount,
  });
  const logicalMetrics = db.prepare(`SELECT * FROM logical_metrics WHERE session_id=?`).get(session.id) as Record<string, unknown>;
  expect(logicalMetrics).toMatchObject({
    logical_tok_user: payload.logicalMetrics.tokUser,
    logical_tok_assistant: payload.logicalMetrics.tokAssistant,
    logical_tok_tool: payload.logicalMetrics.tokTool,
    logical_tool_call_count: payload.logicalMetrics.toolActivityCount,
    logical_msg_count: payload.logicalMetrics.logicalRecordCount,
    logical_replay_count: payload.logicalMetrics.logicalReplayCount,
    logical_identity_count: payload.logicalMetrics.logicalIdentityCount,
    logical_unknown_count: payload.logicalMetrics.logicalUnknownCount,
    identity_status: payload.logicalMetrics.identityStatus,
  });
  expect(logicalMetrics).toMatchObject({ logical_identity_count: 2, logical_unknown_count: 0, identity_status: "complete" });

  expect((db.prepare(`SELECT member_count,replay_count FROM logical_messages WHERE session_id=? ORDER BY logical_ordinal`).all(session.id) as Array<{ member_count: number; replay_count: number }>)).toEqual([
    { member_count: 2, replay_count: 1 },
    { member_count: 1, replay_count: 0 },
  ]);
  expect((db.prepare(`SELECT COUNT(*) AS n FROM logical_message_members WHERE logical_message_id IN (SELECT id FROM logical_messages WHERE session_id=?)`).get(session.id) as { n: number }).n).toBe(3);

  expect((db.prepare(`SELECT value,selected,authority FROM title_evidence WHERE session_id=?`).get(session.id) as { value: string; selected: number; authority: string })).toEqual({ value: "Parity fixture", selected: 1, authority: "source_explicit" });
  expect((db.prepare(`SELECT support FROM continuity_state WHERE session_id=?`).get(session.id) as { support: string }).support).toBe("supported");
  expect((db.prepare(`SELECT COUNT(*) AS n FROM continuity_evidence WHERE session_id=?`).get(session.id) as { n: number }).n).toBe(1);
  expect((db.prepare(`SELECT COUNT(*) AS n FROM continuity_projection WHERE session_id=?`).get(session.id) as { n: number }).n).toBe(1);
  expect((db.prepare(`SELECT parent_native_id,resolution_status FROM lineage_claims WHERE session_id=?`).get(session.id) as { parent_native_id: string; resolution_status: string })).toEqual({ parent_native_id: "missing-parent", resolution_status: "unresolved" });

  // Deliberately read the payload only here, after the DB parity assertions,
  // through the public loader to cover checksum and header/payload validation.
  const source = oneSource(harness);
  const resolved = resolveIngestSidecar({
    root: f.sidecarDir,
    adapter: harness.adapter,
    source,
    parse: () => { throw new Error("parity sidecar unexpectedly missed"); },
    validate: () => {},
  });
  expect(resolved.cache).toBe("hit");
  expect(loadPreparedConstruction(resolved).constructionMetrics).toMatchObject(payload.constructionMetrics);
});

test("a cached rejection is re-checked when admission rules change, without a parser version bump", () => {
  const dir = mkdtempSync(join(tmpdir(), "atlas-admission-")); ownedDirs.push(dir);
  const sourceRoot = join(dir, "source"); mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "unit.jsonl"), "{}\n");
  const source: DiscoveredSource = { root: sourceRoot, relPath: "unit.jsonl", fullPath: join(sourceRoot, "unit.jsonl"), nativeId: "unit" };
  const adapter = (admissionVersion: string) => ({ source: "fixture", sidecarVersion: "parser-v1", admissionVersion, discover: () => [], parse: () => { throw new Error("unused"); } }) as unknown as Adapter;
  let parses = 0;
  const resolve = (admissionVersion: string) => resolveIngestSidecar({
    root: join(dir, "sidecars"), adapter: adapter(admissionVersion), source, validate: () => {},
    parse: () => { parses++; return { admitted: false, reason: "identity_mismatch", detail: "fixture" }; },
  });
  expect(resolve("rules-v1").cache).not.toBe("hit");
  expect(resolve("rules-v1").cache).toBe("hit");
  expect(parses).toBe(1);
  expect(resolve("rules-v2").cache).not.toBe("hit");
  expect(parses).toBe(2);
});

test("the session title is a capped one-line projection of the full selected evidence", async () => {
  expect(displayTitle(null)).toBeNull();
  expect(displayTitle("  one\n\n\ttwo  ")).toBe("one two");
  expect(displayTitle(`${"🛰".repeat(TITLE_DISPLAY_MAX)}tail`)).toBe("🛰".repeat(TITLE_DISPLAY_MAX));

  const f = fixture("title-cap");
  const long = `Fix the parser\n\n${"context ".repeat(80)}END`;
  const messages = [message(0, "u1", "real_user", long, 100)];
  const harness = makeFixture(f.sourceRoot, [{ nativeId: "title-cap-1", relPath: "cap.txt", initial: "cap fixture bytes\n" }], (source, raw) => recordFor(source, raw, messages, {
    title: long,
    construction: {
      ...recordFor(source, raw, messages).construction!,
      titleCandidates: [{
        value: long,
        authority: "source_explicit",
        harnessSourceClass: "fixture-title",
        sourceRecordId: "u1",
        sourceReference: "fixture://title",
        sourceOrdinal: 0,
        eligibilityRuleVersion: "fixture-title-v2",
      }],
    },
  }));
  db = await openDb(f.dbPath);
  await ingest(db, config(f.sourceRoot, f.dbPath), { adapters: { fixture: harness.adapter }, sidecarDir: f.sidecarDir });
  const session = db.prepare(`SELECT id,title FROM sessions WHERE native_id='title-cap-1'`).get() as { id: number; title: string };
  expect(session.title).toBe(displayTitle(long));
  expect([...session.title].length).toBeLessThanOrEqual(TITLE_DISPLAY_MAX);
  expect(session.title.startsWith("Fix the parser context")).toBe(true);
  // Title search reads the evidence, which keeps every byte.
  expect((db.prepare(`SELECT value FROM title_evidence WHERE session_id=? AND selected=1`).get(session.id) as { value: string }).value).toBe(long);

  // Rows published before the cap are rewritten by the repair, and only on --yes.
  db.prepare(`UPDATE sessions SET title=? WHERE id=?`).run(long, session.id);
  expect(repairSessionTitles(db, { confirmed: false })).toMatchObject({ scanned: 1, stale: 1, repaired: 0 });
  expect((db.prepare(`SELECT title FROM sessions WHERE id=?`).get(session.id) as { title: string }).title).toBe(long);
  expect(repairSessionTitles(db, { confirmed: true })).toMatchObject({ stale: 1, repaired: 1 });
  expect((db.prepare(`SELECT title FROM sessions WHERE id=?`).get(session.id) as { title: string }).title).toBe(session.title);
  expect(repairSessionTitles(db, { confirmed: true })).toMatchObject({ stale: 0, repaired: 0 });
});
