// Spawned by test/production-exec.test.ts. Without NODE_ENV it re-executes
// itself the way `atlas` does; with it, it reports which JSX transform the
// 88 KB app module was compiled with.
import { execUnderProduction } from "../../src/production-exec.js";

if (process.env.NODE_ENV === undefined && process.argv[2] === "reexec") {
  process.exit(await execUnderProduction());
}
const { launchTui } = await import("../../src/tui/app.js");
const jsxDev = /jsxDEV/.test(launchTui.toString());
const runtime = await import("react/jsx-dev-runtime");
process.stdout.write(JSON.stringify({ nodeEnv: process.env.NODE_ENV ?? null, jsxDev, runtimeHasJsxDev: typeof runtime.jsxDEV === "function" }));
