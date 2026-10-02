/**
 * Daily summary drip (LaunchAgent com.session-atlas.summarize-drip).
 *
 *   bun run scripts/summarize-drip.ts [cap=150]
 *
 * At most `cap` tier-1 summaries per run through headless Claude (Haiku 4.5),
 * md's own sessions first, then agent-started ones, newest first. The usage
 * gate stops issuing calls at the threshold and resumes after reset; launchd
 * never starts a second copy while one is still waiting.
 *
 * The canonical config stays provider-free: the claude-cli provider exists
 * only in a per-run copy that is removed on exit. This runs under bun, not
 * /bin/sh: launchd's /bin/sh is denied the external volume, bun is not.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const cap = Number(process.argv[2] ?? 150);
if (!Number.isInteger(cap) || cap < 0) {
  process.stderr.write("summarize-drip: cap must be a whole number\n");
  process.exit(2);
}
const threshold = process.env.ATLAS_DRIP_THRESHOLD ?? "0.8";
const canonical = process.env.ATLAS_DRIP_CONFIG ?? join(homedir(), ".config/session-atlas/config.toml");
const model = "claude-haiku-4-5-20251001";
const cli = join(import.meta.dir, "../src/cli.ts");

const runDir = mkdtempSync(join(tmpdir(), "atlas-drip."));
const cleanup = () => rmSync(runDir, { recursive: true, force: true });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { cleanup(); process.exit(143); });
const config = join(runDir, "config.toml");
writeFileSync(config, `${readFileSync(canonical, "utf8")}\n[[providers]]\nname = "haiku-cli"\nkind = "claude-cli"\nmodel = "${model}"\n`, { mode: 0o600 });

const stamp = () => new Date().toLocaleString("sv-SE").slice(0, 16);
try {
  process.stdout.write(`summarize-drip · ${stamp()} · cap ${cap} · threshold ${threshold}\n`);
  let left = cap;
  for (const origin of ["human", "agent"]) {
    if (left <= 0) break;
    const child = Bun.spawn(
      [process.execPath, "run", cli, "summarize", "--backfill", "--origin", origin, "--limit", String(left),
        "--concurrency", "1", "--threshold", threshold, "--config", config],
      { stdout: "pipe", stderr: "inherit" },
    );
    let out = "";
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      const text = decoder.decode(chunk, { stream: true });
      out += text;
      process.stdout.write(text);
    }
    const code = await child.exited;
    if (code !== 0) { process.exitCode = code; break; }
    // Summarized and pending both spent a call; skips never reach the model.
    const spent = /· (\d+) summarized · (\d+) pending ·/.exec(out);
    left -= Number(spent?.[1] ?? 0) + Number(spent?.[2] ?? 0);
  }
  process.stdout.write(`summarize-drip · done · ${stamp()}\n`);
} finally {
  cleanup();
}
