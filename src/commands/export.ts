import { previewExport, writeExport, type ExportScope } from "../export.js";
import type { DB } from "../db/index.js";
import { flagValue, withReadOnlyCtx } from "./ctx.js";

export function parseExportScope(value: string, db?: DB): ExportScope {
  if (value === "favorites") return { kind: "favorites" };
  const match = /^(session|chain|tag|selection):(.+)$/.exec(value);
  if (!match) {
    if (/^[1-9]\d*$/.test(value)) return { kind: "session", id: Number(value) };
    throw new Error("scope must be a session id, session:N, chain:N, tag:NAME, selection:N,N, or favorites");
  }
  const [, kind, payload] = match;
  if (kind === "session" || kind === "chain") {
    if (!/^[1-9]\d*$/.test(payload!)) throw new Error(`${kind} scope requires a positive numeric id`);
    return kind === "session" ? { kind, id: Number(payload) } : { kind, id: Number(payload) };
  }
  if (kind === "tag") {
    if (!payload!.trim()) throw new Error("tag scope requires a name");
    return { kind, name: payload!.trim() };
  }
  if (!db) throw new Error("selection scope resolution requires an open database");
  const ids = payload!.split(",").map((part) => {
    const trimmed = part.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) throw new Error("selection scope requires comma-separated session ids");
    return Number(trimmed);
  });
  const sessions = ids.map((id) => {
    const row = db.prepare(`SELECT harness,native_id FROM sessions WHERE id=?`).get(id) as
      | { harness: string; native_id: string }
      | null;
    if (!row) throw new Error(`selection contains unknown session #${id}`);
    return { harness: row.harness, nativeId: row.native_id };
  });
  return { kind: "selection", sessions };
}

/** atlas export <scope> [--budget N] [--launcher NAME] [--preview] */
export async function exportCmd(argv: string[]): Promise<number> {
  const scopeArg = positionalArgs(argv)[0];
  if (!scopeArg) {
    process.stderr.write(
      "atlas export <session-id|session:N|chain:N|tag:NAME|favorites> [--budget N] [--launcher NAME] [--preview]\n",
    );
    return 2;
  }
  const budgetRaw = flagValue(argv, "--budget");
  const budget = budgetRaw === undefined ? undefined : Number(budgetRaw);
  const launcher = flagValue(argv, "--launcher");
  const previewOnly = argv.includes("--preview");
  let exitCode = 0;

  await withReadOnlyCtx(argv, async ({ db, config }) => {
    try {
      const scope = parseExportScope(scopeArg, db);
      const before = previewExport(db, config, scope, { budget, launcher });
      process.stdout.write(
        `atlas export · ${before.scopeName} · ${before.sessionCount} sessions · ` +
          `predicted ${before.predictedTokens} tokens / ${before.budget} budget` +
          (before.predictedTokens > before.budget ? ` · compression required` : "") +
          "\n",
      );
      if (previewOnly) {
        process.stdout.write(`payload · first ${before.excerpt.length} lines\n${before.excerpt.map((line) => `  ${line}`).join("\n")}\n`);
        return;
      }
      const written = await writeExport(db, config, scope, { budget, launcher });
      process.stdout.write(
        `export → ${written.path} · ${written.finalTokens} tokens · pass ${written.pass}\n` +
          (written.launcherCommand ? `command: ${written.launcherCommand}\n` : ""),
      );
    } catch (error) {
      exitCode = 2;
      process.stderr.write(`atlas export: ${messageOf(error)}\n`);
    }
  });
  return exitCode;
}

function positionalArgs(argv: string[]): string[] {
  const valued = new Set(["--config", "--budget", "--launcher", "--sessions"]);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]!;
    if (valued.has(value)) {
      i++;
      continue;
    }
    if (!value.startsWith("-")) out.push(value);
  }
  return out;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
