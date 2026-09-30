import {
  ISOLATED_CLONE_MIGRATION_CONFIRMATION,
  migrateIsolatedClone,
} from "../db/index.js";
import { flagValue, hasFlag, resolveRuntimeCtx } from "./ctx.js";

/** Explicit clone-only schema migration. It performs no source walk or call. */
export async function migrateCmd(argv: string[]): Promise<number> {
  try {
    const explicitConfig = flagValue(argv, "--config");
    if (!explicitConfig || !hasFlag(argv, "--isolated-clone")) {
      throw new Error("usage: atlas migrate --config <absolute-temp-config> --isolated-clone");
    }
    const runtime = await resolveRuntimeCtx(argv, { bootstrap: false });
    const report = migrateIsolatedClone({
      dbPath: runtime.dbPath,
      configPath: explicitConfig,
      confirmation: ISOLATED_CLONE_MIGRATION_CONFIRMATION,
    });
    process.stdout.write(
      `atlas migrate · isolated clone · schema v${report.fromVersion} → v${report.toVersion} · ` +
      `integrity ${report.integrity} · FK ${report.foreignKeyViolations}\n`,
    );
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`atlas migrate: ${detail}\n`);
    return 2;
  }
}
