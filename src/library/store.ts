import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactEvidence, CapturedSession, Collection, Coverage, CoverageRecordPage, Favorite, Interpretation, LibraryReader, LibrarySession, Origin, Passage, PassageRef, QueryScope, ReadPage, SearchPage, SessionKey, SourceEntry, SourceObservation } from "./contracts.js";
import { hashText, keyToken, makePassage, parseRef, selectPassage } from "./passages.js";
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const cap = (n: number, max = 500): number => { if (!Number.isSafeInteger(n) || n < 1) throw new Error("limit must be a positive integer"); return Math.min(n, max); };
function cursorOffset(cursor: string | undefined, signature: string): number {
  if (!cursor) return 0;
  try { const v = JSON.parse(Buffer.from(cursor, "base64url").toString()); if (v.signature !== signature || !Number.isSafeInteger(v.offset) || v.offset < 0) throw 0; return v.offset; } catch { throw new Error("invalid cursor or changed query scope"); }
}
const cursorFor = (offset: number, signature: string): string => Buffer.from(JSON.stringify({ offset, signature })).toString("base64url");
const latestObservationSql = `WITH ranked AS (
  SELECT id,data,ROW_NUMBER() OVER (
    PARTITION BY json_extract(data,'$.sourceId'),json_extract(data,'$.locator')
    ORDER BY json_extract(data,'$.retainedBoundary.at') DESC,id DESC
  ) rank FROM library_observations
), latest AS (SELECT id,data FROM ranked WHERE rank=1)`;
const sourceIssueSql = "(NOT json_extract(data,'$.enabled') OR NOT json_extract(data,'$.reachable') OR json_extract(data,'$.capability')='unsupported' OR COALESCE(json_extract(data,'$.error'),'')!='')";
const observationIssueSql = "(COALESCE(json_extract(data,'$.admission.status'),'')!='excluded' AND (json_extract(data,'$.indexedBoundary') IS NULL OR COALESCE(json_array_length(data,'$.gaps'),0)>0))";
const COVERAGE_SAMPLE_LIMIT = 24;
const COVERAGE_RECORD_BYTES = 8192;
export interface UserEvent { id: string; at: number; kind: string; target: string; before: unknown; after: unknown; undone?: boolean }
/** Isolated v1 library. Transactions serialize all publication; readers never bootstrap. */
export class LibraryStore implements LibraryReader {
  readonly db: Database;
  readonly path: string;
  readonly readOnly: boolean;
  private leasePath: string | null = null;
  private coverageCache: { revision: string; value: Coverage } | null = null;
  constructor(path: string, options: { readOnly?: boolean } = {}) {
    if (!path || !path.startsWith("/")) throw new Error("library database requires an explicit absolute path");
    this.path = resolve(path); this.readOnly = !!options.readOnly;
    let opened: Database | null = null;
    try {
      if (!this.readOnly) {
        this.assertWritable();
        mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
        const leases = `${this.path}.connections`;
        mkdirSync(leases, { recursive: true, mode: 0o700 });
        this.leasePath = `${leases}/${process.pid}-${randomUUID()}`;
        writeFileSync(this.leasePath, `${Date.now()}\n`, { flag: "wx", mode: 0o600 });
        // Close the fence/lease race before SQLite can perform write-side effects.
        this.assertWritable();
      }
      this.db = opened = new Database(this.path, { readonly: this.readOnly, create: !this.readOnly, strict: true });
      if (!this.readOnly) this.assertWritable();
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
      if (!this.readOnly) {
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS library_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS library_sources(id TEXT PRIMARY KEY,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS library_observations(id TEXT PRIMARY KEY,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS library_sessions(key TEXT PRIMARY KEY,revision TEXT NOT NULL,title TEXT NOT NULL,origin TEXT NOT NULL,updated INTEGER NOT NULL,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS library_passages(ref TEXT PRIMARY KEY,session_key TEXT NOT NULL,observation TEXT NOT NULL,record TEXT NOT NULL,channel TEXT NOT NULL,ordinal INTEGER NOT NULL,role TEXT NOT NULL,text TEXT NOT NULL,data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS library_passages_order ON library_passages(session_key,observation,ordinal);
          CREATE TABLE IF NOT EXISTS library_active(session_key TEXT PRIMARY KEY,observation TEXT NOT NULL);
          CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(ref UNINDEXED,text,tokenize='unicode61');
          CREATE TABLE IF NOT EXISTS library_favorites(id TEXT PRIMARY KEY,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS library_corrections(key TEXT PRIMARY KEY,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS library_collections(id TEXT PRIMARY KEY,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS library_collection_overlays(id TEXT PRIMARY KEY,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS library_artifacts(id TEXT PRIMARY KEY,session_key TEXT NOT NULL,ref TEXT NOT NULL,path TEXT NOT NULL,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS library_journal(id TEXT PRIMARY KEY,at INTEGER NOT NULL,data TEXT NOT NULL);
          INSERT OR IGNORE INTO library_meta VALUES('schema','1');`);
        const currentKind = this.db.query("SELECT type FROM sqlite_master WHERE name='library_current'").get() as { type: string } | null;
        if (currentKind?.type === "table") this.transaction(() => {
          this.db.exec("INSERT OR REPLACE INTO library_active SELECT c.session_key,p.observation FROM library_current c JOIN library_passages p ON p.ref=c.ref GROUP BY c.session_key; DROP TABLE library_current;");
        });
        this.db.exec("CREATE VIEW IF NOT EXISTS library_current AS SELECT p.session_key,p.ref,p.ordinal FROM library_passages p JOIN library_active a ON a.session_key=p.session_key AND a.observation=p.observation");
        chmodSync(this.path, 0o600);
      }
      const version = this.db.query("SELECT value FROM library_meta WHERE key='schema'").get() as { value: string } | null;
      if (version?.value !== "1") throw new Error("unsupported library schema; use a compatible version");
      if (!this.readOnly) this.assertWritable();
    } catch (error) {
      try { opened?.close(); } finally { this.releaseLease(); }
      throw error;
    }
  }
  private assertWritable(): void {
    if (this.readOnly) throw new Error("read-only library");
    if (existsSync(`${this.path}.maintenance.lock`)) throw new Error(`library database is under maintenance: ${this.path}`);
  }
  private releaseLease(): void {
    if (this.leasePath) { rmSync(this.leasePath, { force: true }); this.leasePath = null; }
  }
  close(): void { this.db.close(); this.releaseLease(); }
  transaction<T>(work: () => T): T {
    this.assertWritable();
    return this.db.transaction(() => { this.assertWritable(); return work(); }).immediate();
  }
  getState<T>(key: string): T | null { const row = this.db.query("SELECT value FROM library_meta WHERE key=?").get(key) as { value: string } | null; return row ? json<T>(row.value) : null; }
  setState(key: string, value: unknown): void { this.transaction(() => this.db.query("INSERT OR REPLACE INTO library_meta VALUES(?,?)").run(key, JSON.stringify(value))); }
  putSource(source: SourceEntry): void { this.transaction(() => this.db.query("INSERT OR REPLACE INTO library_sources VALUES(?,?)").run(source.id, JSON.stringify(source))); }
  sources(): SourceEntry[] { return (this.db.query("SELECT data FROM library_sources ORDER BY id").all() as { data: string }[]).map(r => json(r.data)); }
  putObservation(observation: SourceObservation): void { this.transaction(() => this.db.query("INSERT OR REPLACE INTO library_observations VALUES(?,?)").run(observation.id, JSON.stringify(observation))); }
  observation(id: string): SourceObservation | null { const row = this.db.query("SELECT data FROM library_observations WHERE id=?").get(id) as { data: string } | null; return row ? json<SourceObservation>(row.data) : null; }
  observations(): SourceObservation[] { return (this.db.query("SELECT data FROM library_observations ORDER BY id").all() as { data: string }[]).map(r => json(r.data)); }
  private planCapture(input: CapturedSession): { input: CapturedSession; key: string; elect: boolean } {
    const baseKey = keyToken(input.session.key);
    const existing = this.session(input.session.key);
    let elect = true;
    if (existing && !input.session.key.variant) {
      const previous = this.db.query("SELECT o.data FROM library_active a JOIN library_observations o ON o.id=a.observation WHERE a.session_key=?").get(baseKey) as {data:string} | null;
      const previousObservation = previous ? json<SourceObservation>(previous.data) : undefined;
      if (previousObservation && previousObservation.format !== "legacy-index-projection" && (previousObservation.sourceId !== input.observation.sourceId || previousObservation.locator !== input.observation.locator)) {
        const current = this.db.query("SELECT p.data FROM library_current c JOIN library_passages p ON p.ref=c.ref WHERE c.session_key=? ORDER BY c.ordinal,p.ref").all(baseKey) as { data: string }[];
        const old = current.map(r => json<Passage>(r.data));
        const identity = (p: Passage) => JSON.stringify([p.record, p.channel, p.role, p.text]);
        const oldText = old.map(identity); const nextText = input.passages.map(identity);
        const prefix = (a: string[], b: string[]) => a.length <= b.length && a.every((v, i) => v === b[i]);
        if (prefix(nextText, oldText)) { elect = false; input = {...input,observation:{...input.observation,indexedVia:previousObservation.id}}; } // verified prefix copy shares the existing index
        else if (!prefix(oldText, nextText)) {
          const variant = hashText(JSON.stringify(nextText)).slice(0, 16);
          const key = { ...input.session.key, variant };
          const refs = new Map<string, string>();
          const passages = input.passages.map(p => { const next = makePassage({ ...p, sessionKey: key }); refs.set(p.ref, next.ref); return next; });
          input = { ...input, session: { ...input.session, key, title: `${input.session.title} [conflicting copy]`, originReason: "Divergent native-ID copy retained separately; no identity merge inferred" }, passages, artifacts: input.artifacts?.map(a => ({ ...a, id: `${a.id}:${variant}`, sessionKey: key, ref: refs.get(a.ref) ?? a.ref })), observation: { ...input.observation, gaps: [...input.observation.gaps, "Divergent native-ID variant; primary history preserved separately"] } };
        }
      }
    }
    const key = keyToken(input.session.key);
    return { input, key, elect };
  }
  private validatePassages(input: CapturedSession, passages: Passage[]): void {
    const key = keyToken(input.session.key);
    for (const p of passages) {
      if (keyToken(p.sessionKey) !== key || p.observationId !== input.observation.id || hashText(p.text) !== p.textHash) throw new Error("invalid captured passage provenance");
      const fields = parseRef(p.ref);
      if (fields.textHash !== p.textHash || fields.observationId !== p.observationId || fields.record !== p.record || fields.channel !== p.channel || fields.startByte !== p.startByte || fields.endByte !== p.endByte || keyToken(fields.sessionKey) !== key) throw new Error("invalid captured reference");
    }
  }
  private stagePassages(key: string, passages: Passage[]): void {
    for (const p of passages) {
      const inserted = this.db.query("INSERT OR IGNORE INTO library_passages VALUES(?,?,?,?,?,?,?,?,?)").run(p.ref, key, p.observationId, p.record, p.channel, p.ordinal, p.role, p.text, JSON.stringify(p));
      if (inserted.changes) this.db.query("INSERT INTO library_fts VALUES(?,?)").run(p.ref, p.text);
    }
  }
  private stageArtifacts(key: string, artifacts: ArtifactEvidence[]): void {
    for (const a of artifacts) this.db.query("INSERT OR REPLACE INTO library_artifacts VALUES(?,?,?,?,?)").run(a.id, key, a.ref, a.path, JSON.stringify(a));
  }
  private activate(plan: { input: CapturedSession; key: string; elect: boolean }, passageCount: number): void {
    const { input, key, elect } = plan;
    const prior = this.session(input.session.key);
    const session: LibrarySession = { ...input.session, passageCount, summary: input.session.summary ?? prior?.summary ?? null };
    this.db.query("INSERT OR REPLACE INTO library_observations VALUES(?,?)").run(input.observation.id, JSON.stringify(input.observation));
    if (elect) {
      this.db.query("INSERT OR REPLACE INTO library_sessions VALUES(?,?,?,?,?,?)").run(key, session.revision, session.title, session.origin, session.updatedAt, JSON.stringify(session));
      this.db.query("INSERT OR REPLACE INTO library_active VALUES(?,?)").run(key, input.observation.id);
    }
  }
  publish(input: CapturedSession): void {
    const plan = this.planCapture(input); this.validatePassages(plan.input, plan.input.passages);
    const count = plan.input.passages.filter(p => p.role === "user" || p.role === "assistant").length;
    this.transaction(() => { if (plan.elect) { this.stagePassages(plan.key, plan.input.passages); this.stageArtifacts(plan.key, plan.input.artifacts ?? []); } this.activate(plan, count); });
  }
  /** Capture stages <=64 passages / ~256KiB per commit (one oversized passage is atomic).
   * Only the final constant-row pointer switch exposes a complete new revision.
   * Interrupted staging is invisible, content addressed and idempotently resumed. */
  async publishBounded(input: CapturedSession, options: { signal?: AbortSignal; afterChunk?: (count: number) => void } = {}): Promise<void> {
    const plan = this.planCapture(input); let count = 0; let staged = 0;
    for (let at = 0; at < plan.input.passages.length;) {
      if (options.signal?.aborted) throw new Error("Capture publication cancelled; prior revision remains active");
      const chunk: Passage[] = []; let bytes = 0;
      while (at < plan.input.passages.length && chunk.length < 64 && (bytes < 256 * 1024 || !chunk.length)) {
        const p = plan.input.passages[at]!; const size = Buffer.byteLength(p.text);
        if (chunk.length && bytes + size > 256 * 1024) break;
        at++; chunk.push(p); bytes += size;
        if (p.role === "user" || p.role === "assistant") count++;
      }
      this.validatePassages(plan.input, chunk);
      if (plan.elect) this.transaction(() => this.stagePassages(plan.key, chunk)); staged += chunk.length;
      options.afterChunk?.(staged);
      await new Promise<void>(done => setImmediate(done));
    }
    const artifacts = plan.elect ? plan.input.artifacts ?? [] : [];
    for (let at = 0; at < artifacts.length; at += 64) {
      if (options.signal?.aborted) throw new Error("Capture publication cancelled; prior revision remains active");
      this.transaction(() => this.stageArtifacts(plan.key, artifacts.slice(at, at + 64)));
      await new Promise<void>(done => setImmediate(done));
    }
    if (options.signal?.aborted) throw new Error("Capture publication cancelled; prior revision remains active");
    this.transaction(() => this.activate(plan, count));
  }
  session(key: SessionKey): LibrarySession | null {
    const row = this.db.query("SELECT data FROM library_sessions WHERE key=?").get(keyToken(key)) as { data: string } | null;
    if (!row) return null;
    const value = json<LibrarySession>(row.data);
    const titles = this.getState<Record<string,string>>("legacy-title-overrides");
    if (typeof titles?.[keyToken(key)] === "string") value.title = titles[keyToken(key)]!;
    const overlay = this.db.query("SELECT data FROM library_corrections WHERE key=?").get(keyToken(key)) as { data: string } | null;
    if (overlay) { value.origin = json<{ origin: Origin }>(overlay.data).origin; value.originReason = "Your classification correction"; }
    return value;
  }
  private filters(scope: QueryScope, alias = "s"): { sql: string; args: (string | number)[] } {
    const clauses: string[] = []; const args: (string | number)[] = [];
    const origin = `COALESCE(json_extract(co.data,'$.origin'),${alias}.origin)`;
    if (scope.view === "direct") clauses.push(`${origin}='human_started'`);
    else if (scope.view !== "everything") clauses.push(`${origin}!='worker'`);
    if (scope.harness) { clauses.push(`json_extract(${alias}.data,'$.key.harness')=?`); args.push(scope.harness); }
    if (scope.model) { clauses.push(`EXISTS(SELECT 1 FROM json_each(${alias}.data,'$.models') WHERE value=?)`); args.push(scope.model); }
    if (scope.since !== undefined) { clauses.push(`${alias}.updated>=?`); args.push(scope.since); }
    if (scope.until !== undefined) { clauses.push(`${alias}.updated<=?`); args.push(scope.until); }
    if (scope.path) { clauses.push(`instr(COALESCE(json_extract(${alias}.data,'$.cwd'),''),?)>0`); args.push(scope.path); }
    if (scope.collection) {
      const c = this.collections().find(c => c.id === scope.collection);
      const keys = c?.sessionKeys.map(keyToken) ?? [];
      clauses.push(keys.length ? `${alias}.key IN (${keys.map(() => "?").join(",")})` : "0"); args.push(...keys);
    }
    return { sql: clauses.length ? clauses.join(" AND ") : "1", args };
  }
  list(scope: QueryScope = {}, limit = 100, cursor?: string): { sessions: LibrarySession[]; nextCursor: string | null } {
    limit = cap(limit); const signature = hashText(JSON.stringify(["list", scope])); const offset = cursorOffset(cursor, signature); const f = this.filters(scope);
    const rows = this.db.query(`SELECT s.data FROM library_sessions s LEFT JOIN library_corrections co ON co.key=s.key WHERE ${f.sql} ORDER BY s.updated DESC,s.key LIMIT ? OFFSET ?`).all(...f.args, limit + 1, offset) as { data: string }[];
    return { sessions: rows.slice(0, limit).map(r => this.session(json<LibrarySession>(r.data).key)!), nextCursor: rows.length > limit ? cursorFor(offset + limit, signature) : null };
  }
  /** Bounded summaries retain global truth; exact records remain cursor-addressable. */
  coverage(scope: QueryScope = {}): Coverage {
    const revision = JSON.stringify([this.db.query("PRAGMA data_version").get(), this.db.query("SELECT total_changes() changes").get()]);
    if (this.coverageCache?.revision === revision) return { ...this.coverageCache.value, scope, method: scope.match === "related" ? "topic" : "literal" };
    const sourceCounts = this.db.query(`SELECT count(*) total,COALESCE(sum(${sourceIssueSql}),0) issues FROM library_sources`).get() as { total: number; issues: number };
    const observationCounts = this.db.query(`${latestObservationSql} SELECT count(*) total,
      COALESCE(sum(json_extract(data,'$.indexedBoundary') IS NOT NULL),0) indexedCount,
      COALESCE(sum(json_extract(data,'$.admission.status')='excluded'),0) excluded,
      COALESCE(sum(${observationIssueSql}),0) issues FROM latest`).get() as { total: number; indexedCount: number; excluded: number; issues: number };
    const sourcePage = this.coverageRecords("sources", COVERAGE_SAMPLE_LIMIT);
    const observationPage = this.coverageRecords("observations", COVERAGE_SAMPLE_LIMIT);
    const sources = sourcePage.items.flatMap(item => item.record ? [item.record as SourceEntry] : []);
    const observations = observationPage.items.flatMap(item => item.record ? [item.record as SourceObservation] : []);
    const limitations: string[] = [];
    let textTruncated = false;
    if (!sourceCounts.total) limitations.push("No accepted sources; discovery has not established archive coverage.");
    const sourceIssues = this.db.query(`SELECT substr(json_extract(data,'$.harness') || ': ' || COALESCE(json_extract(data,'$.error'),CASE WHEN NOT json_extract(data,'$.enabled') THEN 'excluded' ELSE 'unavailable or unsupported' END),1,1025) text FROM library_sources WHERE ${sourceIssueSql} ORDER BY id LIMIT ?`).all(COVERAGE_SAMPLE_LIMIT) as { text: string }[];
    const observationIssues = this.db.query(`${latestObservationSql} SELECT substr(id || ': ' || CASE WHEN json_array_length(data,'$.gaps')>0 THEN (SELECT group_concat(value,'; ') FROM json_each(data,'$.gaps')) ELSE 'retained but not indexed' END,1,1025) text FROM latest WHERE ${observationIssueSql} ORDER BY id LIMIT ?`).all(Math.max(0, COVERAGE_SAMPLE_LIMIT - sourceIssues.length - limitations.length)) as { text: string }[];
    for (const row of [...sourceIssues, ...observationIssues]) {
      if (row.text.length > 1024) { limitations.push(row.text.slice(0, 1024) + "… [full detail available via coverage.detail]"); textTruncated = true; }
      else limitations.push(row.text);
    }
    const limitationTotal = sourceCounts.issues + observationCounts.issues + (sourceCounts.total ? 0 : 1);
    const value: Coverage = {
      sources, observations, scope, method: scope.match === "related" ? "topic" : "literal", partial: limitationTotal > 0, limitations,
      totals: { sources: sourceCounts.total, sourceIssues: sourceCounts.issues, observations: observationCounts.total, indexedObservations: observationCounts.indexedCount, excludedObservations: observationCounts.excluded, observationIssues: observationCounts.issues, limitations: limitationTotal },
      samples: {
        sources: { returned: sources.length, truncated: sources.length < sourceCounts.total, nextCursor: sourcePage.nextCursor, detailRequiredIds: sourcePage.items.filter(item => item.detailRequired).map(item => item.id), operation: "coverage.sources" },
        observations: { returned: observations.length, truncated: observations.length < observationCounts.total, nextCursor: observationPage.nextCursor, detailRequiredIds: observationPage.items.filter(item => item.detailRequired).map(item => item.id), operation: "coverage.observations" },
        limitations: { returned: limitations.length, truncated: limitations.length < limitationTotal, textTruncated }, detailOperation: "coverage.detail",
      },
    };
    this.coverageCache = { revision, value }; return value;
  }
  coverageRecords(kind: "sources" | "observations", limit = COVERAGE_SAMPLE_LIMIT, cursor?: string): CoverageRecordPage<SourceEntry | SourceObservation> {
    limit = cap(limit, COVERAGE_SAMPLE_LIMIT);
    const prefix = kind === "observations" ? latestObservationSql : "";
    const table = kind === "observations" ? "latest" : "library_sources";
    const total = (this.db.query(`${prefix} SELECT count(*) total FROM ${table}`).get() as { total: number }).total;
    const signature = hashText(JSON.stringify(["coverage", kind, total])); const offset = cursorOffset(cursor, signature);
    const rows = this.db.query(`${prefix} SELECT id,length(CAST(data AS BLOB)) bytes,CASE WHEN length(CAST(data AS BLOB))<=? THEN data ELSE NULL END data FROM ${table} ORDER BY id LIMIT ? OFFSET ?`).all(COVERAGE_RECORD_BYTES, limit, offset) as { id: string; bytes: number; data: string | null }[];
    return { version: 1, kind, total, items: rows.map(row => ({ id: row.id, bytes: row.bytes, record: row.data === null ? null : json<SourceEntry | SourceObservation>(row.data), detailRequired: row.data === null })), nextCursor: offset + rows.length < total ? cursorFor(offset + rows.length, signature) : null, detailOperation: "coverage.detail" };
  }
  /** Exact JSON bytes, including oversized errors/gaps/summary refs, without envelope overflow. */
  coverageDetail(kind: "sources" | "observations", id: string, limit = 32768, cursor?: string): { version: 1; kind: string; id: string; encoding: "base64-json-utf8"; data: string; totalBytes: number; offset: number; nextCursor: string | null } {
    limit = cap(limit, 65536);
    const table = kind === "observations" ? "library_observations" : "library_sources";
    const row = this.db.query(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string } | null;
    if (!row) throw new Error("coverage record unavailable");
    const bytes = Buffer.from(row.data, "utf8"); const signature = hashText(JSON.stringify(["coverage-detail", kind, id, hashText(row.data)])); const offset = cursorOffset(cursor, signature);
    if (offset > bytes.length) throw new Error("coverage detail cursor out of range");
    const end = Math.min(offset + limit, bytes.length);
    return { version: 1, kind, id, encoding: "base64-json-utf8", data: bytes.subarray(offset, end).toString("base64"), totalBytes: bytes.length, offset, nextCursor: end < bytes.length ? cursorFor(end, signature) : null };
  }
  lineagePage(section: "lineage" | "chains" | "classifications", limit = 24, cursor?: string): unknown {
    limit = cap(limit, 24);
    const totals = this.db.query(`SELECT
      COALESCE((SELECT json_array_length(value,'$.lineage') FROM library_meta WHERE key='legacy-lineage'),0) lineage,
      COALESCE((SELECT json_array_length(value,'$.chains') FROM library_meta WHERE key='legacy-lineage'),0) chains,
      COALESCE((SELECT json_array_length(value) FROM library_meta WHERE key='legacy-classifications'),0) classifications`).get() as Record<typeof section, number>;
    const key = section === "classifications" ? "legacy-classifications" : "legacy-lineage";
    const path = section === "classifications" ? "$" : `$.${section}`;
    const signature = hashText(JSON.stringify(["lineage", section, totals[section]])); const offset = cursorOffset(cursor, signature);
    const rows = this.db.query(`SELECT j.key ordinal,length(CAST(j.value AS BLOB)) bytes,CASE WHEN length(CAST(j.value AS BLOB))<=8192 THEN j.value ELSE NULL END data FROM library_meta m,json_each(m.value,?) j WHERE m.key=? ORDER BY j.key LIMIT ? OFFSET ?`).all(path, key, limit, offset) as { ordinal: number; bytes: number; data: string | null }[];
    return { version: 1, section, totals, total: totals[section], items: rows.map(row => ({ index: row.ordinal, bytes: row.bytes, record: row.data === null ? null : json<unknown>(row.data), detailRequired: row.data === null })), nextCursor: offset + rows.length < totals[section] ? cursorFor(offset + rows.length, signature) : null, detailOperation: "lineage.detail" };
  }
  lineageDetail(section: "lineage" | "chains" | "classifications", index: number, limit = 32768, cursor?: string): unknown {
    limit = cap(limit, 65536);
    if (!Number.isSafeInteger(index) || index < 0) throw new Error("lineage index must be a nonnegative integer");
    const key = section === "classifications" ? "legacy-classifications" : "legacy-lineage";
    const path = section === "classifications" ? `$[${index}]` : `$.${section}[${index}]`;
    const row = this.db.query("SELECT json_extract(value,?) data FROM library_meta WHERE key=?").get(path, key) as { data: string | null } | null;
    if (!row?.data) throw new Error("lineage record unavailable");
    const bytes = Buffer.from(row.data, "utf8"); const signature = hashText(JSON.stringify(["lineage-detail", section, index, hashText(row.data)])); const offset = cursorOffset(cursor, signature);
    if (offset > bytes.length) throw new Error("lineage detail cursor out of range");
    const end = Math.min(offset + limit, bytes.length);
    return { version: 1, section, index, encoding: "base64-json-utf8", data: bytes.subarray(offset, end).toString("base64"), totalBytes: bytes.length, offset, nextCursor: end < bytes.length ? cursorFor(end, signature) : null };
  }
  search(query: string, scope: QueryScope = {}, limit = 50, cursor?: string): SearchPage {
    if (typeof query !== "string" || query.length > 4096) throw new Error("query exceeds 4096 characters");
    limit = cap(limit, 100); const signature = hashText(JSON.stringify([query, scope])); const offset = cursorOffset(cursor, signature); const f = this.filters(scope); const match = scope.match ?? "dialogue";
    let rows: { session_data: string; passage_data: string | null }[];
    if (match === "dialogue") {
      rows = this.db.query(`SELECT s.data session_data,p.data passage_data FROM library_sessions s LEFT JOIN library_corrections co ON co.key=s.key JOIN library_current c ON c.session_key=s.key JOIN library_passages p ON p.ref=c.ref WHERE ${f.sql} AND ${scope.role ? "p.role=?" : "p.role IN ('user','assistant')"} AND instr(lower(p.text),lower(?))>0 ORDER BY s.updated DESC,s.key,c.ordinal,p.ref LIMIT ? OFFSET ?`).all(...f.args, ...(scope.role ? [scope.role] : []), query, limit + 1, offset) as typeof rows;
    } else {
      const expression = match === "title" ? "s.title" : match === "summary" ? "COALESCE(json_extract(s.data,'$.summary.overview'),'')" : "COALESCE(json_extract(s.data,'$.summary.episodes'),'')";
      rows = this.db.query(`SELECT s.data session_data,NULL passage_data FROM library_sessions s LEFT JOIN library_corrections co ON co.key=s.key WHERE ${f.sql} AND instr(lower(${expression}),lower(?))>0 ORDER BY s.updated DESC,s.key LIMIT ? OFFSET ?`).all(...f.args, query, limit + 1, offset) as typeof rows;
    }
    const more = rows.length > limit;
    return { version: 1, hits: rows.slice(0, limit).map(r => ({ session: this.session(json<LibrarySession>(r.session_data).key)!, passage: r.passage_data ? json<Passage>(r.passage_data) : null, match, rationale: match === "dialogue" ? "Literal source dialogue match" : `${match} interpretation/metadata match; not a transcript quotation` })), nextCursor: more ? cursorFor(offset + limit, signature) : null, coverage: this.coverage(scope), exhaustion: more ? null : match === "related" ? "No further indexed topic matches; related recall is not exhaustive." : "No further literal matches in this scope." };
  }
  read(key: SessionKey, limit = 100, cursor?: string): ReadPage {
    limit = cap(limit); const session = this.session(key); if (!session) throw new Error("session unavailable");
    const signature = hashText(JSON.stringify(["read", key, session.revision])); const offset = cursorOffset(cursor, signature);
    const rows = this.db.query("SELECT p.data FROM library_current c JOIN library_passages p ON p.ref=c.ref WHERE c.session_key=? AND p.role IN ('user','assistant') ORDER BY c.ordinal,p.ref LIMIT ? OFFSET ?").all(keyToken(key), limit + 1, offset) as { data: string }[];
    return { version: 1, session, passages: rows.slice(0, limit).map(r => json(r.data)), nextCursor: rows.length > limit ? cursorFor(offset + limit, signature) : null, coverage: this.coverage() };
  }
  resolve(ref: PassageRef): { status: "current" | "pinned" | "unavailable"; passage: Passage | null; reason?: string } {
    const fields = parseRef(ref);
    const row = this.db.query("SELECT data FROM library_passages WHERE ref=?").get(ref) as { data: string } | null;
    let passage: Passage | null = row ? json(row.data) : null;
    if (!passage) {
      const parents = this.db.query("SELECT data FROM library_passages WHERE session_key=? AND observation=? AND record=? AND channel=?").all(keyToken(fields.sessionKey), fields.observationId, fields.record, fields.channel) as { data: string }[];
      for (const r of parents) { const p = json<Passage>(r.data); if (fields.startByte >= p.startByte && fields.endByte <= p.endByte) { try { const selected = selectPassage(p, fields.startByte - p.startByte, fields.endByte - p.startByte); if (selected.ref === ref) { passage = selected; break; } } catch { /* invalid range remains unavailable */ } } }
    }
    if (!passage || hashText(passage.text) !== fields.textHash) return { status: "unavailable", passage: null, reason: "Pinned evidence missing or failed its text hash; no ordinal substitution attempted." };
    const current = this.db.query("SELECT 1 FROM library_current c JOIN library_passages p ON p.ref=c.ref WHERE c.session_key=? AND p.observation=? AND p.record=? AND p.channel=? LIMIT 1").get(keyToken(fields.sessionKey), fields.observationId, fields.record, fields.channel);
    return { status: current ? "current" : "pinned", passage };
  }
  context(ref: PassageRef, before = 3, after = 3): ReadPage {
    before = Math.max(0, Math.min(50, before)); after = Math.max(0, Math.min(50, after));
    const resolved = this.resolve(ref); if (!resolved.passage) throw new Error(resolved.reason);
    const p = resolved.passage; const session = this.session(p.sessionKey); if (!session) throw new Error("session unavailable");
    const prior = this.db.query("SELECT data FROM library_passages WHERE session_key=? AND observation=? AND role IN ('user','assistant') AND ordinal<? ORDER BY ordinal DESC,ref DESC LIMIT ?").all(keyToken(p.sessionKey), p.observationId, p.ordinal, before) as { data: string }[];
    const next = this.db.query("SELECT data FROM library_passages WHERE session_key=? AND observation=? AND role IN ('user','assistant') AND ordinal>=? ORDER BY ordinal,ref LIMIT ?").all(keyToken(p.sessionKey), p.observationId, p.ordinal, after + 1) as { data: string }[];
    const passages = [...prior.reverse(), ...next].map(r => json<Passage>(r.data));
    const last = passages.at(-1);
    let nextCursor: string | null = null;
    if (resolved.status === "current" && last) {
      const offset = (this.db.query("SELECT count(*) n FROM library_current c JOIN library_passages p ON p.ref=c.ref WHERE c.session_key=? AND p.role IN ('user','assistant') AND p.ordinal<=?").get(keyToken(p.sessionKey), last.ordinal) as { n: number }).n;
      if (offset < session.passageCount) nextCursor = cursorFor(offset, hashText(JSON.stringify(["read", p.sessionKey, session.revision])));
    }
    return { version: 1, session, passages, nextCursor, coverage: this.coverage() };
  }
  *streamCopy(key: SessionKey): Iterable<string> {
    if (!this.session(key)) throw new Error("session unavailable");
    for (const row of this.db.query("SELECT p.data FROM library_current c JOIN library_passages p ON p.ref=c.ref WHERE c.session_key=? AND p.role IN ('user','assistant') ORDER BY c.ordinal,p.ref").iterate(keyToken(key))) {
      const p = json<Passage>((row as { data: string }).data); yield `[${p.role}]\n`; yield p.text; yield "\n\n";
    }
  }
  private event(kind: string, target: string, before: unknown, after: unknown, id = randomUUID()): string {
    const event: UserEvent = { id, at: Date.now(), kind, target, before, after };
    this.db.query("INSERT INTO library_journal VALUES(?,?,?)").run(id, event.at, JSON.stringify(event)); return id;
  }
  favorites(): Favorite[] { return (this.db.query("SELECT data FROM library_favorites ORDER BY rowid DESC").all() as { data: string }[]).map(r => json(r.data)); }
  saveFavorite(input: { sessionKey: SessionKey; refs?: PassageRef[]; note?: string; idempotencyKey?: string }): Favorite {
    return this.transaction(() => {
      const id = input.idempotencyKey ?? randomUUID(); const prior = this.db.query("SELECT data FROM library_favorites WHERE id=?").get(id) as { data: string } | null;
      if (prior) return json<Favorite>(prior.data);
      const refs = input.refs ?? []; let text: string;
      if (refs.length) text = refs.map(ref => { const result = this.resolve(ref); if (!result.passage || keyToken(result.passage.sessionKey) !== keyToken(input.sessionKey)) throw new Error("favorite reference unavailable or belongs to another session"); return result.passage.text; }).join("\n\n");
      else text = [...this.streamCopy(input.sessionKey)].join("");
      const favorite: Favorite = { id, sessionKey: input.sessionKey, refs, text, textHash: hashText(text), createdAt: Date.now(), note: input.note ?? "" };
      this.db.query("INSERT INTO library_favorites VALUES(?,?)").run(id, JSON.stringify(favorite)); this.event("favorite", id, null, favorite); return favorite;
    });
  }
  removeFavorite(id: string): string { return this.transaction(() => { const prior = this.favorites().find(f => f.id === id); if (!prior) throw new Error("favorite unavailable"); this.db.query("DELETE FROM library_favorites WHERE id=?").run(id); return this.event("favorite", id, prior, null); }); }
  correctClassification(key: SessionKey, origin: Origin): string {
    if (!["human_started", "worker", "mixed", "unknown"].includes(origin)) throw new Error("invalid classification");
    return this.transaction(() => { const session = this.session(key); if (!session) throw new Error("session unavailable"); const target = keyToken(key); const before = this.db.query("SELECT data FROM library_corrections WHERE key=?").get(target) as { data: string } | null; const after = { origin, revision: session.revision, at: Date.now() }; this.db.query("INSERT OR REPLACE INTO library_corrections VALUES(?,?)").run(target, JSON.stringify(after)); return this.event("classification", target, before ? json(before.data) : null, after); });
  }
  collections(): Collection[] {
    return (this.db.query("SELECT c.data,o.data overlay FROM library_collections c LEFT JOIN library_collection_overlays o ON o.id=c.id ORDER BY c.id").all() as { data: string; overlay: string | null }[]).map(r => ({ ...json<Collection>(r.data), ...(r.overlay ? json<Partial<Collection>>(r.overlay) : {}) }));
  }
  putCollection(collection: Collection): void { this.transaction(() => this.db.query("INSERT OR REPLACE INTO library_collections VALUES(?,?)").run(collection.id, JSON.stringify(collection))); }
  editCollection(id: string, patch: Partial<Pick<Collection, "title" | "hidden" | "pinned" | "sessionKeys">>): string {
    return this.transaction(() => { if (!this.collections().some(c => c.id === id)) throw new Error("collection unavailable"); const row = this.db.query("SELECT data FROM library_collection_overlays WHERE id=?").get(id) as { data: string } | null; const before = row ? json<Record<string, unknown>>(row.data) : null; const after = { ...before, ...patch }; this.db.query("INSERT OR REPLACE INTO library_collection_overlays VALUES(?,?)").run(id, JSON.stringify(after)); return this.event("collection", id, before, after); });
  }
  undo(id: string): void {
    this.transaction(() => { const event = this.journal().find(e => e.id === id); if (!event || event.undone) throw new Error("undo unavailable"); const table = event.kind === "favorite" ? "library_favorites" : event.kind === "classification" ? "library_corrections" : event.kind === "collection" ? "library_collection_overlays" : null; if (!table) throw new Error("event cannot be undone"); const column = table === "library_corrections" ? "key" : "id"; const current = this.db.query(`SELECT data FROM ${table} WHERE ${column}=?`).get(event.target) as { data: string } | null; if (JSON.stringify(current ? json(current.data) : null) !== JSON.stringify(event.after)) throw new Error("newer user decision exists; undo that first"); if (event.before === null) this.db.query(`DELETE FROM ${table} WHERE ${column}=?`).run(event.target); else this.db.query(`INSERT OR REPLACE INTO ${table} VALUES(?,?)`).run(event.target, JSON.stringify(event.before)); event.undone = true; this.db.query("UPDATE library_journal SET data=? WHERE id=?").run(JSON.stringify(event), id); this.event("undo", id, event.after, event.before); });
  }
  journal(after = 0): UserEvent[] { return (this.db.query("SELECT data FROM library_journal WHERE at>=? ORDER BY at,rowid").all(after) as { data: string }[]).map(r => json(r.data)); }
  publishInterpretation(key: SessionKey, expectedRevision: string, interpretation: Interpretation): boolean {
    return this.transaction(() => { const row = this.db.query("SELECT data FROM library_sessions WHERE key=?").get(keyToken(key)) as { data: string } | null; if (!row) return false; const s = json<LibrarySession>(row.data); if (s.revision !== expectedRevision || interpretation.revision !== expectedRevision) return false; for (const c of interpretation.claims) for (const ref of c.refs) if (this.resolve(ref).status !== "current") throw new Error("interpretation contains unavailable/stale reference"); s.summary = interpretation; this.db.query("UPDATE library_sessions SET data=? WHERE key=?").run(JSON.stringify(s), keyToken(key));
      const observations = new Set(interpretation.coverage.covered.map(ref => parseRef(ref).observationId));
      for (const observation of this.observations()) if (observations.has(observation.id)) { observation.summaryCoverage = interpretation.coverage; this.db.query("UPDATE library_observations SET data=? WHERE id=?").run(JSON.stringify(observation), observation.id); }
      return true; });
  }
  artifactFind(query: string, scope: QueryScope = {}, limit = 50): { evidence: ArtifactEvidence[]; coverage: Coverage } {
    const f = this.filters(scope); const rows = this.db.query(`SELECT a.data FROM library_artifacts a JOIN library_sessions s ON s.key=a.session_key LEFT JOIN library_corrections co ON co.key=s.key JOIN library_current c ON c.ref=a.ref AND c.session_key=s.key WHERE ${f.sql} AND instr(lower(a.path),lower(?))>0 ORDER BY s.updated DESC,a.path LIMIT ?`).all(...f.args, query, cap(limit, 100)) as { data: string }[];
    return { evidence: rows.map(r => json(r.data)), coverage: this.coverage(scope) };
  }
}
