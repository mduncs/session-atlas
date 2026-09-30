import { launchTui } from "../tui/app.js";
import { resolveRuntimeCtx } from "./ctx.js";

type TuiLauncher = typeof launchTui;

/** atlas tui — interactive keyboard-only terminal UI (M3). */
export async function tuiCmd(argv: string[], launch: TuiLauncher = launchTui): Promise<number> {
  const runtime = await resolveRuntimeCtx(argv);
  // Rows derived from terminal height at launch (leave room for header/footer).
  const rows = process.stdout.rows || 40;
  await launch({
    dbPath: runtime.dbPath,
    configPath: runtime.configPath,
    visibleRows: Math.max(10, rows - 6),
  });
  return 0;
}
