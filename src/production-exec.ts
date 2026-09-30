import { constants as osConstants, homedir } from "node:os";
import { join } from "node:path";

/**
 * Re-run this process with NODE_ENV=production and return the child's exit
 * code. Bun fixes both the JSX transform (jsx vs jsxDEV) and React's build
 * from NODE_ENV at process start, so setting it later yields a dev transform
 * calling into a production runtime that has no jsxDEV. The child shares the
 * terminal and the process group: Ctrl-Z suspends the whole job, and resize
 * and resume signals reach the child directly.
 *
 * The child also gets its own runtime transpiler cache. Bun 1.3.5 keys that
 * cache (files over ~50 KB, such as app.tsx) by content, not NODE_ENV, so a
 * shared cache hands production the jsxDEV output of an earlier dev run.
 */
export async function execUnderProduction(): Promise<number> {
  const child = Bun.spawn([process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: productionTranspilerCache(process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH),
    },
    stdio: ["inherit", "inherit", "inherit"],
  });
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, forward(signal));
  const code = await child.exited;
  if (!child.signalCode) return code;
  return 128 + (osConstants.signals[child.signalCode as keyof typeof osConstants.signals] ?? 0);
}

/** A production-only cache beside any configured one; "0" or "" (disabled) passes through. */
export function productionTranspilerCache(configured: string | undefined): string {
  if (configured === "0" || configured === "") return configured;
  if (configured !== undefined) return join(configured, "atlas-production");
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "session-atlas", "bun-production");
}
