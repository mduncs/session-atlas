import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface StorageConfig {
  /** Absolute mount prefix -> expected filesystem volume UUID. */
  volumes: Record<string, string>;
}

export interface VolumeIdentityExpectation {
  mountPrefix: string;
  expected: string | null;
}

export interface VolumeIdentityObservation {
  mounted: boolean;
  uuid: string | null;
  /** True when the mountpoint exists as an ordinary directory on its parent filesystem. */
  staleDirectoryPresent?: boolean;
}

export type VolumeIdentityProbe = (mountPrefix: string) => VolumeIdentityObservation;

export interface VolumeIdentityResult {
  state: "unconfigured" | "match" | "absent" | "mismatch";
  expected: string | null;
  observed: string | null;
  mountPrefix: string;
  staleDirectoryPresent: boolean;
  probeError?: string;
}

export type StorageIdentityConfig = StorageConfig | { storage?: StorageConfig } | undefined;

/**
 * A configured identity is a write precondition, not a discovery hint. The
 * real probe first proves that the prefix is a mount boundary, then asks
 * diskutil for the mounted filesystem's UUID. Tests always inject this seam.
 */
export const defaultVolumeIdentityProbe: VolumeIdentityProbe = (mountPrefix) => {
  let mountedStat: ReturnType<typeof statSync>;
  try {
    mountedStat = statSync(mountPrefix);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { mounted: false, uuid: null, staleDirectoryPresent: false };
    }
    throw error;
  }

  const parentStat = statSync(dirname(mountPrefix));
  if (mountedStat.dev === parentStat.dev) {
    return { mounted: false, uuid: null, staleDirectoryPresent: true };
  }

  const plist = diskutilInfo(mountPrefix);
  const uuid = /<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim() ?? null;
  if (!uuid) throw new Error(`diskutil returned no VolumeUUID for ${mountPrefix}`);
  return { mounted: true, uuid, staleDirectoryPresent: false };
};

/**
 * diskutil answers in well under a second but stalls for several under memory
 * pressure; a 2 s cap refused whole index runs. A slow answer is still proof,
 * so wait longer and retry one timeout before reporting the UUID unverified.
 */
function diskutilInfo(mountPrefix: string): string {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync("/usr/sbin/diskutil", ["info", "-plist", mountPrefix], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      if (attempt >= 2 || errorCode(error) !== "ETIMEDOUT") throw error;
    }
  }
}

/** Resolve one configured prefix. A bare string represents an unconfigured prefix. */
export function resolveVolumeIdentity(
  prefix: string | VolumeIdentityExpectation,
  probe: VolumeIdentityProbe = defaultVolumeIdentityProbe,
): VolumeIdentityResult {
  const mountPrefix = typeof prefix === "string" ? prefix : prefix.mountPrefix;
  const expected = typeof prefix === "string" ? null : prefix.expected;
  if (!expected) {
    return {
      state: "unconfigured",
      expected: null,
      observed: null,
      mountPrefix,
      staleDirectoryPresent: false,
    };
  }

  let observation: VolumeIdentityObservation;
  try {
    observation = probe(mountPrefix);
  } catch (error) {
    return {
      state: "mismatch",
      expected,
      observed: null,
      mountPrefix,
      staleDirectoryPresent: false,
      probeError: messageOf(error),
    };
  }
  if (!observation.mounted) {
    return {
      state: "absent",
      expected,
      observed: null,
      mountPrefix,
      staleDirectoryPresent: observation.staleDirectoryPresent ?? false,
    };
  }
  const observed = observation.uuid?.trim() || null;
  return {
    state: observed !== null && sameUuid(expected, observed) ? "match" : "mismatch",
    expected,
    observed,
    mountPrefix,
    staleDirectoryPresent: false,
  };
}

export class StorageIdentityError extends Error {
  readonly path: string;
  readonly state: "absent" | "mismatch";
  readonly expected: string;
  readonly observed: string | null;
  readonly mountPrefix: string;
  readonly staleDirectoryPresent: boolean;

  constructor(path: string, result: VolumeIdentityResult) {
    if (result.state !== "absent" && result.state !== "mismatch") {
      throw new Error("StorageIdentityError requires an absent or mismatched identity");
    }
    const observed = result.observed;
    const detail = result.state === "absent"
      ? result.staleDirectoryPresent
        ? "nothing mounted at prefix; stale directory present"
        : "nothing mounted at prefix; mountpoint path absent"
      : observed
        ? `UUID mismatch; observed ${observed}`
        : `UUID could not be verified${result.probeError ? ` (${result.probeError})` : ""}`;
    super(
      `storage identity refused for ${path}: expected UUID ${result.expected} at ${result.mountPrefix}; ${detail}. `
      + "Mount the expected volume, verify it with `atlas doctor`, and retry; no filesystem mutation was attempted.",
    );
    this.name = "StorageIdentityError";
    this.path = path;
    this.state = result.state;
    this.expected = result.expected!;
    this.observed = observed;
    this.mountPrefix = result.mountPrefix;
    this.staleDirectoryPresent = result.staleDirectoryPresent;
  }
}

/**
 * Assert the longest configured mount prefix covering a prospective mutable
 * path. Existing ancestors are realpathed so symlink aliases converge before
 * prefix selection. This function performs reads only.
 */
export function assertMutablePath(
  path: string,
  config: StorageIdentityConfig,
  probe: VolumeIdentityProbe = defaultVolumeIdentityProbe,
): VolumeIdentityResult {
  const volumes = storageVolumes(config);
  if (Object.keys(volumes).length === 0) {
    return {
      state: "unconfigured",
      expected: null,
      observed: null,
      mountPrefix: "",
      staleDirectoryPresent: false,
    };
  }
  if (!isAbsolute(path)) throw new Error(`storage identity path must be absolute: ${path}`);

  const lexicalPath = resolve(path);
  const canonicalPath = realpathThroughExistingAncestor(lexicalPath);
  const match = Object.entries(volumes)
    .map(([mountPrefix, expected]) => {
      const lexicalPrefix = resolve(mountPrefix);
      const canonicalPrefix = realpathThroughExistingAncestor(lexicalPrefix);
      const lexicalMatch = containsPath(lexicalPrefix, lexicalPath);
      const canonicalMatch = containsPath(canonicalPrefix, canonicalPath);
      return {
        mountPrefix,
        expected,
        matches: lexicalMatch || canonicalMatch,
        score: Math.max(lexicalMatch ? lexicalPrefix.length : 0, canonicalMatch ? canonicalPrefix.length : 0),
      };
    })
    .filter((candidate) => candidate.matches)
    .sort((a, b) => b.score - a.score || b.mountPrefix.length - a.mountPrefix.length)[0];

  if (!match) {
    return {
      state: "unconfigured",
      expected: null,
      observed: null,
      mountPrefix: "",
      staleDirectoryPresent: false,
    };
  }
  const result = resolveVolumeIdentity(
    { mountPrefix: match.mountPrefix, expected: match.expected },
    probe,
  );
  if (result.state === "absent" || result.state === "mismatch") {
    throw new StorageIdentityError(path, result);
  }
  return result;
}

function storageVolumes(config: StorageIdentityConfig): Record<string, string> {
  if (!config) return {};
  return "volumes" in config ? config.volumes : config.storage?.volumes ?? {};
}

function realpathThroughExistingAncestor(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return join(realpathSync(cursor), ...suffix);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") return resolve(path);
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function containsPath(prefix: string, candidate: string): boolean {
  const rel = relative(prefix, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sameUuid(expected: string, observed: string): boolean {
  return expected.toLowerCase() === observed.toLowerCase();
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
