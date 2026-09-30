import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { LibraryStore } from "../src/library/store.js";
import { LibraryService } from "../src/library/service.js";
import { runMcp } from "../src/library/mcp.js";
import { hashText, makePassage } from "../src/library/passages.js";
import type { SourceObservation } from "../src/library/contracts.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "atlas-coverage-")); roots.push(root);
  const store = new LibraryStore(join(root, "library.db"));
  store.putSource({ id: "source", harness: "codex", root: "/fixture", enabled: true, reachable: true, capability: "live", error: null, lastCompleteReconciliation: 1 });
  return { store, service: new LibraryService(store) };
}
function observation(id: string, gaps: string[] = []): SourceObservation {
  return { id, sourceId: "source", locator: `/fixture/${id}`, objectHash: hashText(id), retainedBoundary: { observationId: id, bytes: 100, at: 1 }, indexedBoundary: { observationId: id, bytes: 100, at: 1 }, summaryCoverage: null, lastCompleteReconciliation: 1, format: "fixture", gaps };
}

test("real-sized 11,590 observation coverage keeps one-hit search/read and MCP below cap with honest global gaps", async () => {
  const { store, service } = fixture();
  try {
    const key = { harness: "codex", nativeId: "exact" };
    const passage = makePassage({ sessionKey: key, observationId: "main", record: "raw:1", channel: "prose", text: "needle exact 日本語", role: "user", ordinal: 1, timestamp: 1 });
    store.publish({ session: { key, revision: "r1", title: "Exact", origin: "human_started", originReason: "fixture", models: [], cwd: null, updatedAt: 1 }, observation: observation("main"), passages: [passage] });
    store.transaction(() => { const insert = store.db.query("INSERT INTO library_observations VALUES(?,?)"); for (let i = 0; i < 11589; i++) { const o = observation(`o${String(i).padStart(5, "0")}`, ["not fully verified " + "x".repeat(520)]); insert.run(o.id, JSON.stringify(o)); } });
    expect(Buffer.byteLength(JSON.stringify(store.observations()))).toBeGreaterThan(9_000_000);
    const coverage = store.coverage();
    expect(coverage.totals?.observations).toBe(11590); expect(coverage.totals?.observationIssues).toBe(11589); expect(coverage.partial).toBe(true);
    expect(coverage.observations.length).toBeLessThanOrEqual(24); expect(coverage.samples?.observations.truncated).toBe(true); expect(coverage.samples?.limitations.truncated).toBe(true);
    const search = store.search("needle", {}, 1); const read = store.read(key, 1);
    expect(search.hits[0]?.passage?.ref).toBe(passage.ref); expect(read.passages[0]?.text).toBe(passage.text);
    expect(Buffer.byteLength(JSON.stringify(search))).toBeLessThan(1_000_000); expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThan(1_000_000);
    let output = "";
    const requests = [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "needle", limit: 1 } } }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read", arguments: { sessionKey: key, limit: 1 } } }];
    await runMcp(service, Readable.from(requests.map(r => JSON.stringify(r) + "\n")), new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } }));
    const responses = output.trim().split("\n").map(line => JSON.parse(line));
    for (const response of responses) { expect(response.result.isError).toBe(false); expect(JSON.parse(response.result.content[0].text).coverage.totals.observations).toBe(11590); }
  } finally { store.close(); }
});

test("coverage pages expose every latest observation and exact oversized source error bytes", () => {
  const { store, service } = fixture();
  try {
    store.transaction(() => { for (let i = 0; i < 55; i++) store.putObservation(observation(`o${String(i).padStart(2, "0")}`)); });
    const previous = { ...observation("older"), locator: "/fixture/o54", retainedBoundary: { observationId: "older", bytes: 1, at: 0 }, gaps: ["stale issue"] }; store.putObservation(previous);
    let cursor: string | undefined; const ids: string[] = [];
    do { const page = store.coverageRecords("observations", 24, cursor); ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor ?? undefined; } while (cursor);
    expect(ids).toHaveLength(55); expect(new Set(ids).size).toBe(55); expect(ids).not.toContain("older"); expect(store.coverage().partial).toBe(false);
    expect(store.observation("o54")?.locator).toBe("/fixture/o54"); expect(store.observation("missing")).toBeNull();
    const source = { ...store.sources()[0]!, error: "日本語 error ".repeat(120000) }; store.putSource(source);
    const coverage = store.coverage(); expect(coverage.partial).toBe(true); expect(coverage.samples?.limitations.textTruncated).toBe(true);
    expect(coverage.samples?.sources.detailRequiredIds).toEqual(["source"]); expect(Buffer.byteLength(JSON.stringify(service.execute({ operation: "sources.inspect" })))).toBeLessThan(1_000_000);
    const page = store.coverageRecords("sources"); expect(page.items[0]?.detailRequired).toBe(true);
    const bytes: Buffer[] = []; cursor = undefined;
    do { const detail = store.coverageDetail("sources", "source", 65536, cursor); bytes.push(Buffer.from(detail.data, "base64")); cursor = detail.nextCursor ?? undefined; } while (cursor);
    expect(JSON.parse(Buffer.concat(bytes).toString("utf8"))).toEqual(source);
    // Mutating through a second connection invalidates global coverage cache.
    const other = new LibraryStore(store.path); other.putSource({ ...source, error: null }); other.close(); expect(store.coverage().partial).toBe(false);
  } finally { store.close(); }
});

test("large lineage is section-paged without losing stable keys and oversized rows have exact detail", () => {
  const { store, service } = fixture();
  try {
    const lineage = Array.from({ length: 4000 }, (_, i) => ({ sessionKey: { harness: "codex", nativeId: String(i) }, parentKey: { harness: "codex", nativeId: "parent" }, provenance: "preserved authority " + "x".repeat(150) }));
    const classifications = Array.from({ length: 4000 }, (_, i) => ({ harness: "codex", native_id: String(i), reason: "historical " + "x".repeat(100) }));
    const chain = { headKey: { harness: "codex", nativeId: "head" }, members: Array.from({ length: 2000 }, (_, i) => ({ harness: "codex", nativeId: String(i) })) };
    store.setState("legacy-lineage", { lineage, chains: [chain] }); store.setState("legacy-classifications", classifications);
    expect(Buffer.byteLength(JSON.stringify({ lineage, classifications }))).toBeGreaterThan(1_000_000);
    const first = service.execute({ operation: "lineage.inspect", args: { section: "lineage", limit: 24 } }) as any;
    expect(first.totals).toEqual({ lineage: 4000, chains: 1, classifications: 4000 }); expect(first.items[0].record.sessionKey).toEqual(lineage[0]!.sessionKey); expect(first.nextCursor).toBeString();
    const second = service.execute({ operation: "lineage.inspect", args: { section: "lineage", limit: 24, cursor: first.nextCursor } }) as any;
    expect(second.items[0].record.sessionKey).toEqual(lineage[24]!.sessionKey); expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1_000_000);
    const oversized = service.execute({ operation: "lineage.inspect", args: { section: "chains" } }) as any; expect(oversized.items[0].detailRequired).toBe(true);
    const bytes: Buffer[] = []; let cursor: string | undefined;
    do { const detail = service.execute({ operation: "lineage.detail", args: { section: "chains", index: 0, cursor, limit: 65536 } }) as any; bytes.push(Buffer.from(detail.data, "base64")); cursor = detail.nextCursor ?? undefined; } while (cursor);
    expect(JSON.parse(Buffer.concat(bytes).toString("utf8"))).toEqual(chain);
  } finally { store.close(); }
});
