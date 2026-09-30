import type { Config } from "../config.js";
import { rebuildDatabase, type RebuildOptions, type RebuildReport } from "../rebuild.js";
import { isConstructionRefusal } from "../runtime/writer-coordinator.js";
import { hasFlag, resolveRuntimeCtx } from "./ctx.js";

export interface RebuildCommandOptions extends RebuildOptions {
  confirmed?: boolean;
}

export async function runRebuild(config: Config, options: RebuildCommandOptions = {}): Promise<RebuildReport> {
  if (!options.confirmed) throw new Error("rebuild confirmation required");
  return rebuildDatabase(config, options);
}

export function rebuildWarning(hard: boolean): string {
  return hard
    ? "HARD rebuild re-derives every cache layer. Favorites remain verbatim; it preserves summaries, summaries, anchors, tags, syntheses, merge history, and canonical jobs/attempts exactly by SessionKey. Missing stable targets block the swap."
    : "Rebuild re-indexes source transcripts while preserving favorites, summaries, anchors, and tags plus syntheses, merge history, and canonical jobs/attempts exactly by SessionKey. Missing stable targets block the swap.";
}

/** atlas rebuild [--hard] [--yes] */
export async function rebuildCmd(argv: string[]): Promise<number> {
  const hard = hasFlag(argv, "--hard");
  const assumeYes = hasFlag(argv, "--yes");
  process.stderr.write(rebuildWarning(hard) + "\n");
  if (!assumeYes && !(await confirmRebuild(hard))) {
    process.stderr.write("atlas rebuild: cancelled\n");
    return 1;
  }
  const runtime = await resolveRuntimeCtx(argv);
  try {
    const report = await runRebuild(runtime.config, { hard, confirmed: true });
    process.stdout.write(
      `atlas rebuild · ${hard ? "hard" : "normal"} · ${report.sessions} sessions · ` +
        `${report.messages} messages · ${report.favorites} favorites · ` +
        `${report.summariesRestored} summaries restored · ${report.tagsRestored} tags restored\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(`atlas rebuild: ${error instanceof Error ? error.message : String(error)}\n`);
    return isConstructionRefusal(error) ? 1 : 2;
  }
}

async function confirmRebuild(hard: boolean): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write("Non-interactive use requires --yes.\n");
    return false;
  }
  const { createInterface } = await import("node:readline/promises");
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const expected = hard ? "hard" : "yes";
    const answer = await prompt.question(`Type '${expected}' to continue: `);
    return answer.trim().toLowerCase() === expected;
  } finally {
    prompt.close();
  }
}
