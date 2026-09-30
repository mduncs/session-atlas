import { parseRepairAge, repairStaleTargetedRuns, type TargetedRepairReport } from "../targeted-repair.js";
import { isConstructionRefusal } from "../runtime/writer-coordinator.js";
import { repairSessionTitles, type TitleRepairReport } from "../title-repair.js";
import { flagValue, hasFlag, withConstructionCtx, withReadOnlyCtx } from "./ctx.js";

const USAGE = "usage: atlas repair targeted-ingest --older-than <Nm|Nh> [--yes] | atlas repair titles [--yes]";

/** atlas repair targeted-ingest --older-than 30m [--yes] · atlas repair titles [--yes] */
export async function repairCmd(argv: string[]): Promise<number> {
  try {
    if (argv[0] === "titles") return await repairTitles(argv);
    if (argv[0] !== "targeted-ingest") throw new Error(USAGE);
    const age = parseRepairAge(flagValue(argv, "--older-than"));
    const confirmed = hasFlag(argv, "--yes");
    if (!confirmed) {
      const report = await withReadOnlyCtx(argv, ({ db }) => repairStaleTargetedRuns(db, {
        ...age,
        confirmed: false,
      }));
      printReport(report);
      process.stderr.write("Preview only; no rows were changed. Add --yes to confirm the live repair.\n");
      return 0;
    }
    const report = await withConstructionCtx(argv, "atlas repair targeted-ingest", ({ db }) => repairStaleTargetedRuns(db, {
      ...age,
      confirmed: true,
    }));
    printReport(report);
    return 0;
  } catch (error) {
    process.stderr.write(`atlas repair: ${error instanceof Error ? error.message : String(error)}\n`);
    return isConstructionRefusal(error) ? 1 : 2;
  }
}

function printReport(report: TargetedRepairReport): void {
  const mode = report.confirmed ? "repaired" : "preview";
  process.stdout.write(
    `atlas repair targeted-ingest · ${mode} · older than ${report.ageLabel} · ` +
    `cutoff ${new Date(report.cutoffMs).toISOString()} · before ${report.before} · ` +
    `${report.confirmed ? "repaired" : "would repair"} ${report.confirmed ? report.repaired : report.before} · after ${report.after}\n`,
  );
}

async function repairTitles(argv: string[]): Promise<number> {
  const confirmed = hasFlag(argv, "--yes");
  const report = confirmed
    ? await withConstructionCtx(argv, "atlas repair titles", ({ db }) => repairSessionTitles(db, { confirmed: true }))
    : await withReadOnlyCtx(argv, ({ db }) => repairSessionTitles(db, { confirmed: false }));
  printTitleReport(report);
  if (!confirmed) process.stderr.write("Preview only; no rows were changed. Add --yes to rewrite the stored titles.\n");
  return 0;
}

function printTitleReport(report: TitleRepairReport): void {
  const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KiB`;
  process.stdout.write(
    `atlas repair titles · ${report.confirmed ? "repaired" : "preview"} · scanned ${report.scanned} · ` +
    `${report.confirmed ? `repaired ${report.repaired}` : `would repair ${report.stale}`} · ` +
    `${kb(report.bytesBefore)} -> ${kb(report.bytesAfter)}\n`,
  );
}
