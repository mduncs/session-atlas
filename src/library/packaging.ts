import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { hashText } from "./passages.js";
const shellQuote = (s: string): string => "'" + s.replaceAll("'", "'\\''") + "'";
const xml = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
function option(args: string[], flag: string): string | undefined { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; }
function checkedPrefix(prefix: string | undefined): string { if (!prefix?.startsWith("/") || ["/", "/usr", "/usr/local", homedir()].includes(resolve(prefix))) throw new Error("choose a dedicated absolute installation prefix, e.g. ~/.local/atlas-library"); return resolve(prefix); }
function manifest(folder: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(dir: string, relative = "") { for (const entry of readdirSync(dir, { withFileTypes: true })) { const rel = join(relative, entry.name); if (entry.isDirectory()) visit(join(dir, entry.name), rel); else if (entry.isFile() && entry.name !== "installation.json") result[rel] = hashText(readFileSync(join(dir, entry.name))); } }
  visit(folder); return result;
}
export async function installPackage(prefix: string, sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")): Promise<{ prefix: string; executable: string; architecture: string; retainedPrevious: string | null }> {
  prefix = checkedPrefix(prefix); const marker = join(prefix, "installation.json");
  if (existsSync(prefix) && !existsSync(marker)) throw new Error("installation prefix exists without Atlas ownership marker");
  const stage = `${prefix}.stage-${process.pid}-${Date.now()}`; mkdirSync(join(stage, "bin"), { recursive: true, mode: 0o700 });
  try {
    const installedSource = existsSync(join(sourceRoot, "installation.json"));
    if (installedSource) { cpSync(join(sourceRoot, "lib"), join(stage, "lib"), { recursive: true, dereference: true }); }
    else {
      mkdirSync(join(stage, "lib"), { recursive: true });
      cpSync(join(sourceRoot, "src"), join(stage, "lib", "src"), { recursive: true });
      cpSync(join(sourceRoot, "node_modules"), join(stage, "lib", "node_modules"), { recursive: true, dereference: true });
      cpSync(join(sourceRoot, "package.json"), join(stage, "lib", "package.json"));
    }
    cpSync(process.execPath, join(stage, "bin", "bun")); chmodSync(join(stage, "bin", "bun"), 0o700);
    const launcher = `#!/bin/sh\nATLAS_INSTALL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$ATLAS_INSTALL_DIR/bin/bun" "$ATLAS_INSTALL_DIR/lib/src/library/cli.ts" "$@"\n`;
    writeFileSync(join(stage, "bin", "atlas-library"), launcher, { mode: 0o700 });
    const probe = Bun.spawnSync([join(stage, "bin", "atlas-library"), "help"], { cwd: stage, stdout: "pipe", stderr: "pipe" });
    if (probe.exitCode !== 0 || !probe.stdout.toString().includes("Atlas library")) throw new Error(`packaged entry failed: ${probe.stderr.toString()}`);
    const native = Bun.spawnSync([join(stage, "bin", "bun"), "-e", "await import('@opentui/core'); process.stdout.write('native-ok')"], { cwd: join(stage, "lib"), stdout: "pipe", stderr: "pipe" });
    if (native.exitCode !== 0) throw new Error(`native renderer cannot load; no service activated: ${native.stderr.toString()}`);
    writeFileSync(join(stage, "installation.json"), JSON.stringify({ product: "atlas-library", version: 1, platform: process.platform, architecture: process.arch, runtime: Bun.version, files: manifest(stage), installedAt: Date.now() }, null, 2), { mode: 0o600 });
    const previous = existsSync(prefix) ? `${prefix}.previous-${Date.now()}` : null;
    if (previous) renameSync(prefix, previous);
    try { renameSync(stage, prefix); } catch (error) { if (previous) renameSync(previous, prefix); throw error; }
    return { prefix, executable: join(prefix, "bin", "atlas-library"), architecture: `${process.platform}-${process.arch}`, retainedPrevious: previous };
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}
export function uninstallPackage(prefix: string): { removed: string; dataRetained: true } {
  prefix = checkedPrefix(prefix); const marker = JSON.parse(readFileSync(join(prefix, "installation.json"), "utf8")) as { product: string };
  if (marker.product !== "atlas-library") throw new Error("not an Atlas-owned installation");
  // Data lives outside installation. Never traverse the configured library or source roots.
  rmSync(prefix, { recursive: true }); return { removed: prefix, dataRetained: true };
}
export function renderLaunchAgent(executable: string, database: string): string {
  if (![executable, database].every(p => p.startsWith("/"))) throw new Error("absolute executable/database required");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.session-atlas.library</string><key>ProgramArguments</key><array>${[executable, "--library", database, "watch"].map(s => `<string>${xml(s)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>ProcessType</key><string>Background</string><key>Umask</key><integer>63</integer></dict></plist>\n`;
}
export async function packagingCommand(command: string, args: string[], database: string): Promise<void> {
  const prefix = option(args, "--prefix");
  if (command === "install") { const result = await installPackage(checkedPrefix(prefix)); process.stdout.write(JSON.stringify(result, null, 2) + "\n"); return; }
  if (command === "uninstall") { process.stdout.write(JSON.stringify(uninstallPackage(checkedPrefix(prefix))) + "\n"); return; }
  const action = args[0]; const executable = option(args, "--executable") ?? (prefix ? join(checkedPrefix(prefix), "bin", "atlas-library") : "");
  const plist = join(homedir(), "Library", "LaunchAgents", "com.session-atlas.library.plist");
  if (action === "render") { const text = renderLaunchAgent(executable, database); const out = option(args, "--output"); if (out) { if (!out.startsWith("/")) throw new Error("absolute output required"); writeFileSync(out, text, { mode: 0o600, flag: "wx" }); } else process.stdout.write(text); return; }
  if (process.platform !== "darwin") throw new Error("Native scheduling supported on macOS only; use watch with your own supervisor.");
  const uid = process.getuid?.(); const domain = `gui/${uid}`;
  const launchctl = (values: string[]) => Bun.spawnSync(["launchctl", ...values], { stdout: "pipe", stderr: "pipe" });
  if (action === "status") { const result = launchctl(["print", `${domain}/com.session-atlas.library`]); process.stdout.write(JSON.stringify({ installed: existsSync(plist), running: result.exitCode === 0 }) + "\n"); return; }
  if (action === "disable") { const result = launchctl(["bootout", `${domain}/com.session-atlas.library`]); process.stdout.write(JSON.stringify({ disabled: result.exitCode === 0, dataRetained: true }) + "\n"); return; }
  if (action !== "enable" || !existsSync(executable)) throw new Error("service enable requires --executable /installed/atlas-library; install first");
  const check = Bun.spawnSync([executable, "help"], { stdout: "pipe", stderr: "pipe" }); if (check.exitCode) throw new Error("installed entry is not executable");
  mkdirSync(dirname(plist), { recursive: true, mode: 0o700 }); writeFileSync(plist, renderLaunchAgent(executable, database), { mode: 0o600 });
  const result = launchctl(["bootstrap", domain, plist]); if (result.exitCode) throw new Error(result.stderr.toString());
  process.stdout.write(JSON.stringify({ enabled: true, database, plist }) + "\n");
}
