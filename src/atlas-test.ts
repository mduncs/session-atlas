#!/usr/bin/env bun
/** Separate, read-only dashboard preview; the ordinary atlas entry is unchanged. */

const HELP = `atlas-test — Session Atlas comparison preview

Usage:
  atlas-test                   open the comparison dashboard
  atlas-test --config <path>   use the same explicit config as another Atlas window
  atlas-test --help            show this help

Run atlas in one terminal and atlas-test in another. Cyan marks redesigned UI.
This preview reads the existing archive without starting ingestion or summaries.
It only opens the dashboard; use atlas for archive maintenance commands.
`;

export async function main(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  const { dispatchCli, splitGlobalArgs } = await import("./cli.js");
  const { command } = splitGlobalArgs(args);
  if (command !== undefined && command !== "tui" && command !== "ui") {
    process.stderr.write(`atlas-test: only the comparison dashboard is available.\n\n${HELP}`);
    return 2;
  }
  return dispatchCli(args, {
    tui: async (rest) => {
      const { resolveRuntimeCtx } = await import("./commands/ctx.js");
      const { launchTui } = await import("./tui/app.js");
      const runtime = await resolveRuntimeCtx(rest, { bootstrap: false });
      await launchTui({
        dbPath: runtime.dbPath,
        configPath: runtime.configPath,
        visibleRows: Math.max(10, (process.stdout.rows || 40) - 6),
        uiVariant: "atlas-test",
      });
      return 0;
    },
  });
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
