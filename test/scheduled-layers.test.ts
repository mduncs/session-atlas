import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_IDS } from "../src/config.js";
import { indexCmd } from "../src/commands/index.js";
import { openDb } from "../src/db/index.js";
import { layersPathFor } from "../src/layers/db.js";

function configAt(root: string): string {
  const path = join(root, "config with spaces.toml");
  writeFileSync(path, `dbPath=${JSON.stringify(join(root, "atlas.db"))}\n` + HARNESS_IDS.map(source => `[sources.${source}]\nmode="disabled"\nreason="fixture"\n`).join("\n"));
  return path;
}

test("scheduled index survives a layers child that cannot spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-layers-spawn-"));
  const configPath = configAt(root);
  const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("spawn failed: resource temporarily unavailable"); });
  const output = spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect(await indexCmd(["--scheduled", "--config", configPath])).toBe(0);
    expect(output.mock.calls.flat().join(" ")).toContain("layers skipped: spawn failed");
  } finally { spawn.mockRestore(); output.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test("layers runner waits for a refresh lock during database initialization", async () => {
  const root = mkdtempSync(join(tmpdir(), "atlas-layers-lock-"));
  const configPath = configAt(root);
  const dbPath = join(root, "atlas.db");
  (await openDb(dbPath)).close();
  const holder = Bun.spawn([process.execPath, "--eval", `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(layersPathFor(dbPath))});
    db.exec("BEGIN IMMEDIATE");
    process.stdout.write("locked\\n");
    setTimeout(() => { db.exec("COMMIT"); db.close(); }, 7000);
  `], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    reader.releaseLock();
    const runner = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "layers", "run", "--max-calls", "0", "--config", configPath], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([runner.exited, new Response(runner.stdout).text(), new Response(runner.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).toContain("exit · max-calls · 0 calls");
  } finally { holder.kill(); await holder.exited; rmSync(root, { recursive: true, force: true }); }
}, 15000);
