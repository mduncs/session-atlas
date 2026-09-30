import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/atlas-test.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "atlas-test-launcher-"));
  roots.push(root);
  return root;
}

describe("atlas-test launcher", () => {
  test("missing config and archive are not bootstrapped", async () => {
    const root = fixture();
    const variant = process.env.SESSION_ATLAS_UI_VARIANT;
    await expect(main(["--config", join(root, "missing", "config.toml")])).rejects.toThrow();
    expect(readdirSync(root)).toEqual([]);
    expect(process.env.SESSION_ATLAS_UI_VARIANT).toBe(variant);
  });

  test("an existing explicit config cannot create its missing database", async () => {
    const root = fixture();
    const configPath = join(root, "config.toml");
    writeFileSync(configPath, `dbPath = ${JSON.stringify(join(root, "data", "atlas.db"))}\n`);
    await expect(main(["tui", "--config", configPath])).rejects.toThrow();
    expect(readdirSync(root)).toEqual(["config.toml"]);
  });

  test("help leaves the filesystem and UI environment unchanged", async () => {
    const root = fixture();
    const variant = process.env.SESSION_ATLAS_UI_VARIANT;
    const output = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["--config", join(root, "missing.toml"), "--help"])).toBe(0);
      expect(output.mock.calls.map((call) => String(call[0])).join("")).toContain("atlas-test — Session Atlas comparison preview");
    } finally {
      output.mockRestore();
    }
    expect(readdirSync(root)).toEqual([]);
    expect(process.env.SESSION_ATLAS_UI_VARIANT).toBe(variant);
  });

  test("maintenance commands are rejected without config, database, or environment changes", async () => {
    const root = fixture();
    const variant = process.env.SESSION_ATLAS_UI_VARIANT;
    const output = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const command of ["index", "summarize", "fav", "rebuild", "library"]) {
        expect(await main(["--config", join(root, "missing.toml"), command])).toBe(2);
      }
      expect(output.mock.calls.map((call) => String(call[0])).join("")).toContain("only the comparison dashboard is available");
    } finally {
      output.mockRestore();
    }
    expect(readdirSync(root)).toEqual([]);
    expect(process.env.SESSION_ATLAS_UI_VARIANT).toBe(variant);
  });
});
