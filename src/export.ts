import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Config, LauncherConfig } from "./config.js";
import type { DB } from "./db/index.js";
import { estimateTokens } from "./metrics.js";
import { materializeSpan, WHOLE_SESSION_FAVORITE_MARKER, type StableSessionRef } from "./favorites.js";

export type ExportScope =
  | { kind: "session"; id: number }
  | { kind: "chain"; id: number }
  | { kind: "selection"; sessions: StableSessionRef[] }
  | { kind: "tag"; name: string }
  | { kind: "favorites" };

export interface SelectedSpan extends StableSessionRef {
  fromOrdinal: number;
  toOrdinal: number;
  label?: string;
}

export interface ExportCompileOptions {
  budget?: number;
  launcher?: string;
  selectedSpans?: SelectedSpan[];
}

export interface ExportPreview {
  scopeName: string;
  sessionCount: number;
  predictedTokens: number;
  minimumTokens: number;
  budget: number;
  overBudgetBy: number;
}

export interface CompiledExport extends ExportPreview {
  content: string;
  finalTokens: number;
  pass: 1 | 2 | 3;
  omittedSessions: string[];
}

export interface WrittenExport extends CompiledExport {
  path: string;
  launcherCommand: string | null;
}

interface ExportSession {
  id: number | null;
  harness: string;
  nativeId: string;
  title: string | null;
  startTs: number | null;
  lastActivity: number | null;
  models: string[];
  summary: string | null;
  spans: ExportSpan[];
}

interface ExportSpan {
  text: string;
  fromOrdinal: number | null;
  toOrdinal: number | null;
  topic: string | null;
  favorite: boolean;
}

interface ResolvedExport {
  name: string;
  sessions: ExportSession[];
}

/** Pass-1 prediction and immutable-span floor, both rendered by the compiler itself. */
export function previewExport(
  db: DB,
  config: Config,
  scope: ExportScope,
  options: ExportCompileOptions = {},
): ExportPreview {
  const resolved = resolveExportScope(db, scope, options.selectedSpans ?? []);
  const budget = validBudget(options.budget ?? config.tunables.export_budget_tokens);
  const full = renderPayload(resolved, "full", new Set(), options.launcher);
  const minimum = renderPayload(resolved, "none", new Set(), options.launcher);
  const predictedTokens = estimateTokens(full);
  const minimumTokens = estimateTokens(minimum);
  return {
    scopeName: resolved.name,
    sessionCount: resolved.sessions.length,
    predictedTokens,
    minimumTokens,
    budget,
    overBudgetBy: Math.max(0, minimumTokens - budget),
  };
}

/** Compile through the strict four-pass ladder. Pass 4 is represented by an error. */
export function compileExport(
  db: DB,
  config: Config,
  scope: ExportScope,
  options: ExportCompileOptions = {},
): CompiledExport {
  const resolved = resolveExportScope(db, scope, options.selectedSpans ?? []);
  const budget = validBudget(options.budget ?? config.tunables.export_budget_tokens);
  const pass1 = renderPayload(resolved, "full", new Set(), options.launcher);
  const predictedTokens = estimateTokens(pass1);
  const base = {
    scopeName: resolved.name,
    sessionCount: resolved.sessions.length,
    predictedTokens,
    budget,
  };
  if (predictedTokens <= budget) {
    return finish(base, pass1, 1, [], estimateTokens(renderPayload(resolved, "none", new Set(), options.launcher)));
  }

  const pass2 = renderPayload(resolved, "short", new Set(), options.launcher);
  if (estimateTokens(pass2) <= budget) {
    return finish(base, pass2, 2, [], estimateTokens(renderPayload(resolved, "none", new Set(), options.launcher)));
  }

  // Oldest summaries disappear first. Every iteration is rendered in full so
  // header omission markers are included in the same token accounting.
  const summaryBearing = resolved.sessions.filter((session) => session.summary).map(sessionStableKey);
  const omitted = new Set<string>();
  for (const key of summaryBearing) {
    omitted.add(key);
    const candidate = renderPayload(resolved, "short", omitted, options.launcher);
    if (estimateTokens(candidate) <= budget) {
      const omittedLabels = resolved.sessions
        .filter((session) => omitted.has(sessionStableKey(session)))
        .map(sessionLabel);
      return finish(base, candidate, 3, omittedLabels, estimateTokens(renderPayload(resolved, "none", new Set(), options.launcher)));
    }
  }

  const minimum = renderPayload(resolved, "none", new Set(), options.launcher);
  const minimumTokens = estimateTokens(minimum);
  const overage = Math.max(1, minimumTokens - budget);
  throw new Error(
    `export exceeds budget by ${overage} tokens after dropping every summary ` +
      `(${minimumTokens} required, ${budget} budget); favorited and selected spans were not truncated`,
  );
}

export async function writeExport(
  db: DB,
  config: Config,
  scope: ExportScope,
  options: ExportCompileOptions & { outputDir?: string; now?: Date } = {},
): Promise<WrittenExport> {
  const compiled = compileExport(db, config, scope, options);
  const outputDir = options.outputDir ?? join(dirname(config.dbPath), "exports");
  await mkdir(outputDir, { recursive: true });
  const day = dateStamp(options.now ?? new Date());
  const path = await writeUniqueExport(
    outputDir,
    `${slugify(compiled.scopeName)}-${day}`,
    compiled.content,
  );
  const launcher = options.launcher ? findLauncher(config.launchers, options.launcher) : null;
  return {
    ...compiled,
    path,
    launcherCommand: launcher ? renderLauncherCommand(launcher, path) : null,
  };
}

export function renderLauncherCommand(launcher: LauncherConfig, payloadPath: string): string {
  if (!launcher.cmd.includes("{payload}")) {
    throw new Error(`launcher '${launcher.name}' command must contain {payload}`);
  }
  const renderedPath = /^[A-Za-z0-9_./-]+$/.test(payloadPath) ? payloadPath : shellQuote(payloadPath);
  return launcher.cmd.replaceAll("{payload}", renderedPath);
}

export function resolveExportScope(db: DB, scope: ExportScope, selectedSpans: SelectedSpan[] = []): ResolvedExport {
  const rows = selectScopeSessions(db, scope);
  const byKey = new Map<string, ExportSession>();
  for (const row of rows) byKey.set(sessionStableKey(row), hydrateSession(db, row));

  const favoriteRows = favoriteSpans(db, scope, rows);
  for (const favorite of favoriteRows) {
    const key = stableKey(favorite.harness, favorite.native_id);
    let session = byKey.get(key);
    if (!session) {
      session = {
        id: null,
        harness: favorite.harness,
        nativeId: favorite.native_id,
        title: favorite.topic,
        startTs: favorite.created_at,
        lastActivity: favorite.created_at,
        models: [],
        summary: null,
        spans: [],
      };
      byKey.set(key, session);
    }
    const lazyWholeSession = favorite.scope === "session"
      ? materializeSpan(db, {
          harness: favorite.harness,
          nativeId: favorite.native_id,
          wholeSession: true,
        })
      : null;
    const storedText = favorite.span_text === WHOLE_SESSION_FAVORITE_MARKER
      ? "[whole-session favorite; indexed transcript is no longer available]"
      : favorite.span_text;
    session.spans.push({
      text: lazyWholeSession?.text ?? storedText,
      fromOrdinal: favorite.from_ordinal,
      toOrdinal: favorite.to_ordinal,
      topic: favorite.topic,
      favorite: true,
    });
  }
  for (const span of selectedSpans) {
    const key = stableKey(span.harness, span.nativeId);
    let session = byKey.get(key);
    if (!session) {
      const row = selectStableSession(db, span);
      if (!row) throw new Error(`selected span session ${span.harness}/${span.nativeId} is not indexed`);
      session = hydrateSession(db, row);
      byKey.set(key, session);
    }
    const materialized = materializeSpan(db, {
      harness: span.harness,
      nativeId: span.nativeId,
      fromOrdinal: span.fromOrdinal,
      toOrdinal: span.toOrdinal,
    });
    if (!materialized) {
      throw new Error(
        `selected span ${span.harness}/${span.nativeId}:${span.fromOrdinal}-${span.toOrdinal} has no readable messages`,
      );
    }
    session.spans.push({
      text: materialized.text,
      fromOrdinal: span.fromOrdinal,
      toOrdinal: span.toOrdinal,
      topic: span.label ?? null,
      favorite: false,
    });
  }

  const sessions = [...byKey.values()].sort((a, b) => sessionTime(a) - sessionTime(b) || sessionStableKey(a).localeCompare(sessionStableKey(b)));
  if (sessions.length === 0) throw new Error(`export scope '${scopeName(scope)}' has no material`);
  return { name: scopeName(scope), sessions };
}

interface SessionRow {
  id: number;
  harness: string;
  native_id: string;
  title: string | null;
  start_ts: number | null;
  last_activity: number | null;
  models: string | null;
}

function selectScopeSessions(db: DB, scope: ExportScope): SessionRow[] {
  const columns = `s.id,s.harness,s.native_id,s.title,s.start_ts,s.last_activity,s.models`;
  switch (scope.kind) {
    case "session": {
      const row = db.prepare(`SELECT ${columns} FROM sessions s WHERE s.id=?`).get(scope.id) as SessionRow | null;
      if (!row) throw new Error(`no session #${scope.id}`);
      return [row];
    }
    case "chain": {
      const rows = db
        .prepare(`SELECT ${columns} FROM sessions s WHERE s.chain_id=? ORDER BY COALESCE(s.start_ts,s.last_activity),s.id`)
        .all(scope.id) as SessionRow[];
      if (rows.length === 0) throw new Error(`no chain #${scope.id}`);
      return rows;
    }
    case "selection": {
      const out: SessionRow[] = [];
      const seen = new Set<string>();
      for (const ref of scope.sessions) {
        const row = selectStableSession(db, ref);
        if (!row) throw new Error(`selected session ${ref.harness}/${ref.nativeId} is not indexed`);
        const key = sessionStableKey(row);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(row);
        }
      }
      return out;
    }
    case "tag": {
      const rows = db
        .prepare(
          `SELECT ${columns} FROM sessions s
           JOIN session_tags st ON st.session_id=s.id JOIN tags t ON t.id=st.tag_id
           WHERE t.name=? ORDER BY COALESCE(s.start_ts,s.last_activity),s.id`,
        )
        .all(scope.name) as SessionRow[];
      if (rows.length === 0) throw new Error(`tag '${scope.name}' has no sessions`);
      return rows;
    }
    case "favorites":
      return db
        .prepare(
          `SELECT DISTINCT ${columns} FROM sessions s JOIN favorites f
           ON f.harness=s.harness AND f.native_id=s.native_id
           WHERE f.status='ok' ORDER BY COALESCE(s.start_ts,s.last_activity),s.id`,
        )
        .all() as SessionRow[];
  }
}

function selectStableSession(db: DB, ref: StableSessionRef): SessionRow | null {
  return db
    .prepare(`SELECT id,harness,native_id,title,start_ts,last_activity,models FROM sessions WHERE harness=? AND native_id=?`)
    .get(ref.harness, ref.nativeId) as SessionRow | null;
}

function hydrateSession(db: DB, row: SessionRow): ExportSession {
  const summaryRows = db
    .prepare(`SELECT tier,topic_line,body FROM summaries WHERE session_id=? ORDER BY tier DESC`)
    .all(row.id) as Array<{ tier: number; topic_line: string | null; body: string | null }>;
  const tier2 = summaryRows.find((summary) => summary.tier === 2);
  const tier1 = summaryRows.find((summary) => summary.tier === 1);
  const summary = tier2?.body || tier2?.topic_line || tier1?.body || tier1?.topic_line || null;
  return {
    id: row.id,
    harness: row.harness,
    nativeId: row.native_id,
    title: row.title,
    startTs: row.start_ts,
    lastActivity: row.last_activity,
    models: parseModels(row.models),
    summary,
    spans: [],
  };
}

interface FavoriteSpanRow {
  harness: string;
  native_id: string;
  from_ordinal: number | null;
  to_ordinal: number | null;
  span_text: string;
  scope: "tail" | "span" | "session";
  topic: string | null;
  created_at: number;
}

function favoriteSpans(db: DB, scope: ExportScope, sessions: SessionRow[]): FavoriteSpanRow[] {
  if (scope.kind === "favorites") {
    return db
      .prepare(
        `SELECT harness,native_id,from_ordinal,to_ordinal,span_text,scope,topic,created_at
         FROM favorites WHERE status='ok' AND span_text IS NOT NULL ORDER BY created_at,id`,
      )
      .all() as FavoriteSpanRow[];
  }
  const refs = new Set(sessions.map(sessionStableKey));
  if (refs.size === 0) return [];
  return (db
    .prepare(
      `SELECT harness,native_id,from_ordinal,to_ordinal,span_text,scope,topic,created_at
       FROM favorites WHERE status='ok' AND span_text IS NOT NULL ORDER BY created_at,id`,
    )
    .all() as FavoriteSpanRow[]).filter((row) => refs.has(stableKey(row.harness, row.native_id)));
}

function renderPayload(
  resolved: ResolvedExport,
  summaries: "full" | "short" | "none",
  omitted: Set<string>,
  launcherName?: string,
): string {
  const omittedLabels = resolved.sessions.filter((session) => omitted.has(sessionStableKey(session))).map(sessionLabel);
  const lines: string[] = [
    `# Session Atlas continuation: ${resolved.name}`,
    "",
    `Sessions: ${resolved.sessions.length}`,
  ];
  if (omittedLabels.length) lines.push(`Summaries omitted oldest-first: ${omittedLabels.join(", ")}`);
  lines.push("", "## Model lineage", "", "| When | Session | Models |", "|---|---|---|");
  for (const session of resolved.sessions) {
    lines.push(`| ${month(sessionTime(session))} | ${escapeTable(session.harness + "/" + session.nativeId)} | ${escapeTable(session.models.join(", ") || "—")} |`);
  }
  if (launcherName) lines.push(`| now | continuation | ${escapeTable(launcherName)} |`);

  for (const session of resolved.sessions) {
    lines.push("", `## ${sessionLabel(session)}`, "");
    const key = sessionStableKey(session);
    if (summaries !== "none" && !omitted.has(key) && session.summary) {
      lines.push("### Summary", "", summaries === "short" ? firstTwoSentences(session.summary) : session.summary, "");
    } else if (omitted.has(key) && session.summary) {
      lines.push("[session summary omitted]", "");
    }
    for (const [index, span] of session.spans.entries()) {
      const range = span.fromOrdinal === null ? "session" : `${span.fromOrdinal}-${span.toOrdinal}`;
      lines.push(
        `### ${span.favorite ? "Favorite" : "Selected span"} ${index + 1}${span.topic ? ` · ${span.topic}` : ""}`,
        "",
        `<verbatim-span source="${xmlAttr(session.harness + "/" + session.nativeId)}" ordinals="${range}">`,
        span.text,
        "</verbatim-span>",
        "",
      );
    }
    if (summaries !== "none" && !session.summary && session.spans.length === 0) {
      lines.push("[no summary or selected material available]", "");
    }
  }

  lines.push("", "## Source pointers", "");
  for (const session of resolved.sessions) {
    lines.push(
      session.id === null
        ? `- ${session.harness}/${session.nativeId} · detached favorite (source may be pruned)`
        : `- ${session.harness}/${session.nativeId} · \`atlas read ${session.id}\``,
    );
  }
  lines.push("", `Continue the thread represented by “${resolved.name}”. Preserve the decisions and constraints above, and treat every verbatim span as source material.`, "");
  return lines.join("\n");
}

function finish(
  base: Omit<CompiledExport, "content" | "finalTokens" | "pass" | "omittedSessions" | "minimumTokens" | "overBudgetBy">,
  content: string,
  pass: 1 | 2 | 3,
  omittedSessions: string[],
  minimumTokens: number,
): CompiledExport {
  return {
    ...base,
    content,
    finalTokens: estimateTokens(content),
    pass,
    omittedSessions,
    minimumTokens,
    overBudgetBy: Math.max(0, minimumTokens - base.budget),
  };
}

function parseModels(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return [value];
  }
}

function firstTwoSentences(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const matches = normalized.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [normalized];
  return matches.slice(0, 2).join(" ").trim();
}

function scopeName(scope: ExportScope): string {
  switch (scope.kind) {
    case "session": return `session-${scope.id}`;
    case "chain": return `chain-${scope.id}`;
    case "selection": return `selection-${scope.sessions.length}`;
    case "tag": return scope.name;
    case "favorites": return "favorites";
  }
}

function validBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("export budget must be a positive integer token count");
  return value;
}

function stableKey(harness: string, nativeId: string): string {
  return JSON.stringify([harness, nativeId]);
}

function sessionStableKey(session: Pick<ExportSession, "harness" | "nativeId"> | SessionRow): string {
  return "nativeId" in session
    ? stableKey(session.harness, session.nativeId)
    : stableKey(session.harness, session.native_id);
}

function sessionTime(session: ExportSession): number {
  return session.startTs ?? session.lastActivity ?? 0;
}

function sessionLabel(session: ExportSession): string {
  return `${session.harness}/${session.nativeId}${session.title ? ` · ${session.title}` : ""}`;
}

function month(timestamp: number): string {
  return timestamp > 0 ? new Date(timestamp).toISOString().slice(0, 7) : "—";
}

function escapeTable(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/g, " ");
}

function xmlAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function slugify(value: string): string {
  const slug = value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "export";
}

function dateStamp(value: Date): string {
  return value.toISOString().slice(0, 10).replaceAll("-", "");
}

function findLauncher(launchers: LauncherConfig[], name: string): LauncherConfig {
  const launcher = launchers.find((candidate) => candidate.name === name);
  if (!launcher) throw new Error(`unknown launcher '${name}'`);
  return launcher;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function writeUniqueExport(outputDir: string, stem: string, content: string): Promise<string> {
  for (let suffix = 1; ; suffix++) {
    const path = join(outputDir, `${stem}${suffix === 1 ? "" : `-${suffix}`}.md`);
    try {
      await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
