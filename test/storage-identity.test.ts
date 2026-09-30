import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { ConfigError, loadConfig, sourcePlanDigest } from "../src/config.js";
import { storageDoctorLines } from "../src/commands/doctor.js";
import { openDb, openRebuildShadowDb } from "../src/db/index.js";
import {
  assertMutablePath,
  resolveVolumeIdentity,
  StorageIdentityError,
  type VolumeIdentityProbe,
} from "../src/runtime/storage-identity.js";

const EXPECTED = "11111111-2222-3333-4444-555555555555";
const OTHER = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

test("storage identity resolves match, mismatch, absent, stale shadow, and unconfigured without the real probe", () => {
  const mountPrefix = "/Volumes/Fixture";
  const expectation = { mountPrefix, expected: EXPECTED };

  expect(resolveVolumeIdentity(expectation, observed(true, EXPECTED.toLowerCase()))).toMatchObject({
    state: "match", expected: EXPECTED, observed: EXPECTED.toLowerCase(), mountPrefix,
  });
  expect(resolveVolumeIdentity(expectation, observed(true, OTHER))).toMatchObject({
    state: "mismatch", expected: EXPECTED, observed: OTHER, mountPrefix,
  });
  expect(resolveVolumeIdentity(expectation, observed(false, null, false))).toMatchObject({
    state: "absent", observed: null, staleDirectoryPresent: false,
  });
  expect(resolveVolumeIdentity(expectation, observed(false, null, true))).toMatchObject({
    state: "absent", observed: null, staleDirectoryPresent: true,
  });

  let probes = 0;
  const unconfigured = resolveVolumeIdentity(mountPrefix, () => {
    probes++;
    throw new Error("must stay inert");
  });
  expect(unconfigured.state).toBe("unconfigured");
  expect(probes).toBe(0);
});

test("assertMutablePath selects the longest covering prefix and emits distinct actionable refusals", () => {
  const root = temporary("longest");
  const mount = join(root, "mount");
  const nested = join(mount, "nested");
  const storage = { volumes: { [mount]: EXPECTED, [nested]: OTHER } };
  const seen: string[] = [];
  const result = assertMutablePath(join(nested, "atlas.db"), storage, (prefix) => {
    seen.push(prefix);
    return { mounted: true, uuid: OTHER };
  });
  expect(result).toMatchObject({ state: "match", mountPrefix: nested, expected: OTHER });
  expect(seen).toEqual([nested]);

  expect(() => assertMutablePath(join(mount, "atlas.db"), storage, observed(false, null, true)))
    .toThrow("nothing mounted at prefix; stale directory present");
  try {
    assertMutablePath(join(mount, "atlas.db"), storage, observed(true, OTHER));
  } catch (error) {
    expect(error).toBeInstanceOf(StorageIdentityError);
    expect((error as StorageIdentityError).message).toContain(`expected UUID ${EXPECTED}`);
    expect((error as StorageIdentityError).message).toContain(`observed ${OTHER}`);
    expect((error as StorageIdentityError).message).toContain("atlas doctor");
  }
});

test("writable DB openers refuse before creating database or connection artifacts", async () => {
  const root = temporary("openers");
  const fakePrefix = join(root, "absent-volume");
  const dbPath = join(fakePrefix, "archive", "atlas.db");
  const shadowPath = `${dbPath}.rebuild-fixture`;
  const storage = { volumes: { [fakePrefix]: EXPECTED } };
  const absent = observed(false, null, true);

  await expect(openDb(dbPath, { storage, storageProbe: absent })).rejects.toBeInstanceOf(StorageIdentityError);
  await expect(openRebuildShadowDb(shadowPath, { storage, storageProbe: absent })).rejects.toBeInstanceOf(StorageIdentityError);
  expect(existsSync(dbPath)).toBe(false);
  expect(existsSync(`${dbPath}.connections`)).toBe(false);
  expect(existsSync(join(fakePrefix, "archive"))).toBe(false);
});

test("storage.volumes validates absolute normalized prefixes and UUID-shaped values", async () => {
  const root = temporary("config");
  const dbPath = join(root, "atlas.db");
  const validPath = join(root, "valid.toml");
  writeFileSync(validPath, `dbPath = ${JSON.stringify(dbPath)}\n[storage.volumes]\n${JSON.stringify(join(root, "mount/..", "mount"))} = ${JSON.stringify(EXPECTED.toLowerCase())}\n`);
  const valid = await loadConfig(validPath, { bootstrap: false });
  expect(valid.storage?.volumes).toEqual({ [join(root, "mount")]: EXPECTED });

  for (const [name, table, message] of [
    ["relative", `[storage.volumes]\n"relative/path" = "${EXPECTED}"`, "must be absolute"],
    ["blank", `[storage.volumes]\n"" = "${EXPECTED}"`, "blank mount prefix"],
    ["uuid", `[storage.volumes]\n"/Volumes/Fixture" = "not-a-uuid"`, "UUID-shaped"],
    ["shape", `storage = "wrong"`, "storage must be a TOML table"],
  ] as const) {
    const path = join(root, `${name}.toml`);
    writeFileSync(path, `dbPath = ${JSON.stringify(dbPath)}\n${table}\n`);
    await expect(loadConfig(path, { bootstrap: false })).rejects.toThrow(message);
    await expect(loadConfig(path, { bootstrap: false })).rejects.toBeInstanceOf(ConfigError);
  }
});

test("storage trust expectations stay out of the source-plan digest", () => {
  const base = {
    sources: {}, providers: [], launchers: [], tunables: {}, dbPath: "/tmp/atlas.db",
  } as unknown as Config;
  const first = { ...base, storage: { volumes: { "/Volumes/A": EXPECTED } } };
  const second = { ...base, storage: { volumes: { "/Volumes/A": OTHER } } };
  expect(sourcePlanDigest(first)).toBe(sourcePlanDigest(second));
});

test("doctor renders match, stale absence, and mismatch as read-only storage health", () => {
  const mountPrefix = "/Volumes/Fixture";
  const config = { storage: { volumes: { [mountPrefix]: EXPECTED } } } as Config;
  expect(storageDoctorLines(config, observed(true, EXPECTED))).toEqual({
    down: false,
    lines: [`  [ok] storage ${mountPrefix} · mounted · uuid match`],
  });
  expect(storageDoctorLines(config, observed(false, null, true))).toEqual({
    down: true,
    lines: [`  [DOWN] storage ${mountPrefix} · not mounted (stale directory present)`],
  });
  expect(storageDoctorLines(config, observed(true, OTHER))).toEqual({
    down: true,
    lines: [`  [DOWN] storage ${mountPrefix} · uuid mismatch expected ${EXPECTED} observed ${OTHER}`],
  });
});

function observed(mounted: boolean, uuid: string | null, staleDirectoryPresent = false): VolumeIdentityProbe {
  return () => ({ mounted, uuid, staleDirectoryPresent });
}

function temporary(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `atlas-storage-${name}-`));
  roots.push(root);
  expect(existsSync(root)).toBe(true);
  return root;
}
