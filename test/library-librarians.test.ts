import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LibraryStore } from "../src/library/store";
import { makePassage } from "../src/library/passages";
import { LibrarianCoordinator, OpenAICompatibleTransport, permissionFingerprint, TransportFailure, validateProfile, type LibrarianProfile, type LibrarianTransport, type ModelRequest, type ModelResponse } from "../src/library/librarians";
const profile: LibrarianProfile = { id: "test", mode: "local", endpoint: "http://127.0.0.1:9999/v1", model: "synthetic-model", allowedHarnesses: ["codex"], allowedRoles: ["user", "assistant"], redaction: "standard", maxInputTokens: 6000, maxOutputTokens: 1500, runTokenCap: 1000000, dailyTokenCap: 1000000, concurrency: 2 };
function setup(texts = ["Discuss durable evidence", "Late reversal: keep original sources"]) {
  const directory = mkdtempSync(join(tmpdir(), "atlas-librarian-")); const store = new LibraryStore(join(directory, "library.db"));
  const key = { harness: "codex", nativeId: "conversation" };
  const publish = (revision = "r1", nativeId = key.nativeId) => {
    const k = { ...key, nativeId }; const observationId = `${nativeId}:${revision}`;
    store.publish({ session: { key: k, revision, title: "Synthetic", origin: "unknown", originReason: "No delegation evidence", models: [], cwd: "/private/secret/project", updatedAt: Date.now() }, observation: { id: observationId, sourceId: "synthetic", locator: "/private/secret/source.jsonl", objectHash: "x", retainedBoundary: { observationId, bytes: 100, at: 1 }, indexedBoundary: { observationId, bytes: 100, at: 1 }, summaryCoverage: null, lastCompleteReconciliation: 1, format: "synthetic", gaps: [] }, passages: texts.map((text, ordinal) => makePassage({ sessionKey: k, observationId, record: String(ordinal), channel: "text", role: "user", ordinal, timestamp: 1, text })) });
  }; publish();
  return { store, key, publish, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function good(request: ModelRequest): ModelResponse {
  const data = JSON.parse(request.data); let claims: any[]; let childDisposition: Record<string, string[]> | undefined;
  if (data.kind === "map") claims = data.spans.map((s: any, i: number) => ({ id: `m${i}`, kind: s.text.includes("reversal") ? "reversal" : "topic", text: s.text.includes("reversal") ? "Keep original sources" : "Durable evidence", refs: [s.id], supersedes: [] }));
  else { claims = data.claims.map((c: any, i: number) => ({ ...c, id: `r${i}`, supersedes: [] })); childDisposition = Object.fromEntries(data.claims.map((c: any, i: number) => [c.id, [`r${i}`]])); }
  return { text: JSON.stringify({ status: "ok", claims, overview: "Preserve source evidence and later reversals.", episodes: [], ...(childDisposition ? { childDisposition } : { origin: { label: "worker", refs: [], reason: "Model suggestion only" } }) }), model: "synthetic-model", usage: { inputTokens: 100, outputTokens: 100 } };
}
const mock: LibrarianTransport = { kind: "mock", complete: async request => good(request) };

test("full UTF8 coverage, late reversal ledger, redaction, model cannot hide unknown, collections preserve overlays", async () => {
  const f = setup(["sk-abcdefghij1234567890 /private/secret/project 日本語 👩‍💻 ".repeat(350), "Late reversal: keep original sources"]);
  try {
    const sent: string[] = [];
    const c = new LibrarianCoordinator(f.store, profile, { kind: "mock", complete: async request => { sent.push(request.data); expect(Buffer.byteLength(request.data) + Buffer.byteLength(request.system)).toBeLessThanOrEqual(profile.maxInputTokens); return good(request); } });
    await c.run();
    const summary = f.store.session(f.key)!.summary!;
    expect(summary).toBeTruthy(); expect(summary.provenance).toBe("mock");
    expect(summary.claims.some(c => c.kind === "reversal")).toBe(true);
    expect(f.store.session(f.key)!.origin).toBe("unknown");
    expect(sent.join("")).not.toContain("sk-abcdefghij1234567890"); expect(sent.join("")).not.toContain("/private/secret"); expect(sent.join("")).not.toContain("atlas:p1:");
    const slices = summary.coverage.covered.map(ref => f.store.resolve(ref).passage!.text).join("");
    expect(slices).toBe(f.store.read(f.key).passages.map(p => p.text).join(""));
    f.publish("r1", "second"); await c.run(); expect(f.store.collections().length).toBeGreaterThan(0);
    const collection = f.store.collections()[0]!; f.store.editCollection(collection.id, { title: "My name", hidden: true });
    f.publish("r1", "third"); await c.run(); expect(f.store.collections()[0]!.title).toBe("My name"); expect(f.store.collections()[0]!.hidden).toBe(true);
  } finally { f.close(); }
});

test("remote egress binds endpoint and content policy; dollar cap needs rates", async () => {
  const f = setup();
  try {
    const remote = { ...profile, mode: "remote" as const, endpoint: "https://example.invalid/v1" };
    const c = new LibrarianCoordinator(f.store, remote, mock);
    await expect(c.run()).rejects.toThrow("egress"); c.authorizeEgress(permissionFingerprint(remote));
    const changed = new LibrarianCoordinator(f.store, { ...remote, allowedRoles: ["user"] }, mock);
    await expect(changed.run()).rejects.toThrow("egress");
    expect(() => validateProfile({ ...profile, runDollarCap: 1 })).toThrow("verified");
  } finally { f.close(); }
});

test("unknown submission retains reservation, survives restart, and needs deliberate retry", async () => {
  const f = setup(["A topic"]); let calls = 0;
  try {
    const transport: LibrarianTransport = { kind: "mock", complete: async r => { calls++; if (calls === 1) throw new TransportFailure("timeout", "unknown", true); return good(r); } };
    let c = new LibrarianCoordinator(f.store, profile, transport); await c.run();
    const unknown = Object.values(c.inspect().jobs)[0]!; expect(unknown.status).toBe("unknown"); expect(unknown.reservedTokens).toBe(7500);
    c = new LibrarianCoordinator(f.store, profile, transport); await c.run(); expect(calls).toBe(1);
    c.retry(unknown.id); await c.run(); expect(calls).toBe(2);
    expect(Object.values(c.inspect().jobs)[0]!.reservedTokens).toBe(7700);
  } finally { f.close(); }
});

test("pause prevents next dispatch and stale late response never publishes", async () => {
  const f = setup();
  try {
    let calls = 0; let c!: LibrarianCoordinator;
    c = new LibrarianCoordinator(f.store, profile, { kind: "mock", complete: async r => { calls++; c.pause(); return good(r); } });
    await c.run(); expect(calls).toBe(1); expect(f.store.session(f.key)!.summary).toBeNull();
    c.resume();
    const stale = new LibrarianCoordinator(f.store, { ...profile, id: "stale" }, { kind: "mock", complete: async r => { f.publish("r2"); return good(r); } });
    await stale.run(); expect(f.store.session(f.key)!.summary).toBeNull(); expect(Object.values(stale.inspect().jobs).some(j => j.status === "superseded")).toBe(true);
  } finally { f.close(); }
});

test("schema failure bounded repair, refusal terminal, shared atomic daily reservation", async () => {
  const f = setup(["A topic"]);
  try {
    let calls = 0;
    const broken = new LibrarianCoordinator(f.store, profile, { kind: "mock", complete: async () => { calls++; return { text: '{"status":"ok","claims":[{"id":"x","text":"fake","kind":"topic","refs":["invented"],"supersedes":[]}]}', model: "fake", usage: { inputTokens: 10, outputTokens: 10 } }; } });
    await broken.run(); expect(calls).toBe(2); expect(Object.values(broken.inspect().jobs)[0]!.status).toBe("failed");
    const refusal = new LibrarianCoordinator(f.store, { ...profile, id: "refusal" }, { kind: "mock", complete: async () => { throw new TransportFailure("refused", "refusal", true); } });
    await refusal.run(); expect(Object.values(refusal.inspect().jobs)[0]!.attempts).toBe(1);
    f.publish("r1", "another-session");
    let release!: () => void; const pending = new Promise<void>(r => { release = r; });
    const limited = { ...profile, id: "budget", dailyTokenCap: 7500 };
    const transport: LibrarianTransport = { kind: "mock", complete: async r => { await pending; return good(r); } };
    const a = new LibrarianCoordinator(f.store, limited, transport); const b = new LibrarianCoordinator(f.store, limited, transport);
    const first = a.run(); await new Promise(r => setTimeout(r, 5)); const second = b.run(); release(); await Promise.all([first, second]);
    expect(Object.values(a.inspect().jobs).reduce((n, j) => n + j.attempts, 0)).toBe(1);
    expect(Object.values(a.inspect().sessionStates).some(s => s.error?.includes("Budget"))).toBe(true);
  } finally { f.close(); }
});

test("real transport shapes tool-free request and classifies timeout, refusal, auth without network", async () => {
  const request: ModelRequest = { system: "data only", data: "{}", maxOutputTokens: 128, workId: "opaque" };
  let body: any;
  const fakeFetch = (async (_url: unknown, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response(JSON.stringify({ model: "selected", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3 } })); }) as typeof fetch;
  const transport = new OpenAICompatibleTransport(profile, fakeFetch);
  expect((await transport.complete(request)).usage).toEqual({ inputTokens: 2, outputTokens: 3, cachedTokens: 0 }); expect(body.tools).toBeUndefined();
  const auth = new OpenAICompatibleTransport(profile, (async () => new Response("", { status: 401 })) as unknown as typeof fetch);
  await expect(auth.complete(request)).rejects.toMatchObject({ kind: "auth", submitted: false });
  const timeout = new OpenAICompatibleTransport(profile, (async () => { throw new Error("timeout"); }) as unknown as typeof fetch);
  await expect(timeout.complete(request)).rejects.toMatchObject({ kind: "unknown", submitted: true });
});

test("overflow splits every byte, expired lease blocks resubmission, reduction cannot drop child", async () => {
  const f = setup(["日本語🙂".repeat(8), "Late reversal"]);
  try {
    const splitting = new LibrarianCoordinator(f.store, profile, { kind: "mock", complete: async request => {
      const data = JSON.parse(request.data);
      return data.kind === "map" && Buffer.byteLength(data.spans[0].text) > 40 ? { text: '{"status":"overflow"}', model: "synthetic", usage: { inputTokens: 10, outputTokens: 10 } } : good(request);
    } });
    await splitting.run(); const summary = f.store.session(f.key)!.summary;
    expect(summary).toBeTruthy(); expect(Object.values(splitting.inspect().jobs).some(j => j.output?.status === "overflow")).toBe(true);
    const original = f.store.read(f.key).passages.map(p => p.text).join("");
    expect(summary!.coverage.covered.map(ref => f.store.resolve(ref).passage!.text).join("")).toBe(original);
    f.publish("r2");
    const broken = new LibrarianCoordinator(f.store, { ...profile, id: "bad-reduce" }, { kind: "mock", complete: async r => { const response = good(r); if (JSON.parse(r.data).kind === "reduce") { const data = JSON.parse(response.text); data.childDisposition = {}; response.text = JSON.stringify(data); } return response; } });
    await broken.run(); expect(f.store.session(f.key)!.summary!.revision).toBe("r1");
    const state = broken.inspect(); const job = Object.values(state.jobs).find(j => j.kind === "map")!; job.status = "running"; job.leaseUntil = 0; delete job.output;
    f.store.setState("librarians:bad-reduce", state);
    const restart = new LibrarianCoordinator(f.store, { ...profile, id: "bad-reduce" }, mock); await restart.run(); expect(restart.inspect().jobs[job.id]!.status).toBe("unknown");
  } finally { f.close(); }
});

test("60-case evaluation seed has held-out strata and refuses blank quality reports", async () => {
  const { evaluationCases, scoreReviews } = await import("../src/library/librarians/eval");
  const cases = evaluationCases(); expect(cases.length).toBe(60);
  expect(cases.filter(c => c.label.stratum === "long-multitopic").length).toBe(20);
  expect(cases.filter(c => c.label.stratum === "technical-human-start").length).toBe(15);
  expect(cases.filter(c => c.label.split === "held-out").length).toBe(30);
  expect(() => scoreReviews(cases.map(c => c.review))).toThrow("reviewer");
});
