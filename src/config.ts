import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { expandPath } from "./paths.js";
import { HARNESS_IDS, type HarnessId, type SourceResolutionMode } from "./contracts/construction.js";
import type { StorageConfig } from "./runtime/storage-identity.js";

export interface SourceConfig {
  /** Fully resolved catalog mode. */
  mode: SourceResolutionMode;
  /** Ordered absolute roots after builtin/extend/replace resolution. */
  roots: string[];
  disabledReason: string | null;
}

export interface ProviderConfig {
  name: string;
  base: string;
  /** `claude-cli` runs headless `claude -p` on md's subscription; `base` and `key_env` are unused. */
  kind: "anthropic" | "openai" | "claude-cli";
  model: string;
  key_env: string;
  /** Optional OpenAI-compatible reasoning control (for example DeepSeek V4). */
  thinking?: "enabled" | "disabled";
}

export interface LauncherConfig {
  name: string;
  cmd: string;
}

export interface Tunables {
  tag_promotion_count: number;
  export_budget_tokens: number;
  fav_default_span: number;
  summary_stale_pct: number;
  redact_entropy_threshold: number;
  full_walk_interval_ms: number;
  full_walk_degraded_after_ms: number;
  full_walk_stale_after_ms: number;
}

export interface Config {
  /** Every loaded configuration contains exactly the seven catalog sources. */
  sources: Record<HarnessId, SourceConfig>;
  providers: ProviderConfig[];
  launchers: LauncherConfig[];
  tunables: Tunables;
  /** Path to the SQLite database. */
  dbPath: string;
  /** Optional filesystem trust expectations; absent for legacy programmatic configs. */
  storage?: StorageConfig;
}

export class ConfigError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const DEFAULT_TUNABLES: Tunables = {
  tag_promotion_count: 3,
  export_budget_tokens: 20000,
  fav_default_span: 6,
  summary_stale_pct: 25,
  redact_entropy_threshold: 4.8,
  full_walk_interval_ms: 30 * 60_000,
  full_walk_degraded_after_ms: 90 * 60_000,
  full_walk_stale_after_ms: 6 * 60 * 60_000,
};

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "session-atlas", "config.toml");
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "session-atlas");
}

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultDataDir(env), "atlas.db");
}

/** Kept as constants for command callers; each atlas process resolves XDG at startup. */
export const DEFAULT_CONFIG_PATH = defaultConfigPath();
export const DEFAULT_DB_PATH = defaultDbPath();

export interface BootstrapResult {
  configPath: string;
  created: boolean;
}

export function builtinSourceRoots(home: string = homedir()): Record<HarnessId, string[]> {
  return {
    claude: [join(home, ".claude", "projects")],
    codex: [join(home, ".codex")],
    prime: [join(home, ".prime", "agent")],
    hermes: [join(home, ".hermes", "state.db")],
    kimi: [join(home, ".kimi", "sessions")],
    zcode: [join(home, ".zcode")],
    kilo: [join(home, ".local", "share", "kilo", "kilo.db")],
  };
}

/** Runtime compatibility for embedders constructed before catalog modes existed.
 * File-backed configs never use this path: loadConfig always returns all seven. */
export function resolvedSourceConfig(config: Pick<Config, "sources">, source: HarnessId): SourceConfig {
  const raw = (config.sources as Partial<Record<HarnessId, Partial<SourceConfig>>>)[source];
  if (!raw) return { mode: "disabled", roots: [], disabledReason: "programmatic config omitted source" };
  const roots = Array.isArray(raw.roots) ? raw.roots : [];
  const mode = raw.mode ?? "replace";
  return {
    mode,
    roots,
    disabledReason: mode === "disabled" ? raw.disabledReason ?? "programmatic config disabled source" : null,
  };
}

/** Stable provider-free digest used by reconciliation and schedule evidence. */
export function sourcePlanDigest(config: Pick<Config, "sources" | "dbPath">): string {
  const plans = HARNESS_IDS.map((source) => {
    const plan = resolvedSourceConfig(config, source);
    return [source, plan.mode, plan.roots, plan.disabledReason];
  });
  return createHash("sha256").update(JSON.stringify({ plans, dbPath: config.dbPath })).digest("hex");
}

/**
 * Resolve the implicit database target for a config file. The standard config
 * keeps the standard XDG data target. A custom config is an isolation
 * boundary: absent an explicit dbPath, its database lives beside that config.
 */
export function implicitDbPath(configPath: string = DEFAULT_CONFIG_PATH): string {
  const resolved = expandPath(configPath);
  return resolved === expandPath(DEFAULT_CONFIG_PATH)
    ? DEFAULT_DB_PATH
    : join(dirname(resolved), "atlas.db");
}

export async function bootstrapConfig(path: string = DEFAULT_CONFIG_PATH): Promise<BootstrapResult> {
  const resolved = expandPath(path);
  try {
    await readFile(resolved, "utf8");
    return { configPath: resolved, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, defaultConfigTemplate(implicitDbPath(resolved)), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { configPath: resolved, created: true };
}

export function defaultConfigTemplate(dbPath: string = DEFAULT_DB_PATH): string {
  return `# Session Atlas configuration. Sources are read-only.
# A missing source block means mode="builtin". Disablement is always explicit.
dbPath = ${tomlString(dbPath)}

[sources.claude]
mode = "builtin"

[sources.codex]
mode = "builtin"

[sources.prime]
mode = "builtin"

[sources.hermes]
mode = "builtin"

[sources.kimi]
mode = "builtin"

[sources.zcode]
mode = "builtin"

[sources.kilo]
mode = "builtin"

# Current retained-source examples:
# [sources.zcode]
# mode = "replace"
# roots = ["/absolute/canonical/zcode/"]
# [sources.kilo]
# mode = "extend"
# roots = ["/absolute/retained/kilo.db"]

# Add ordered [[providers]] and [[launchers]] blocks only after explicit approval.

[tunables]
tag_promotion_count = ${DEFAULT_TUNABLES.tag_promotion_count}
export_budget_tokens = ${DEFAULT_TUNABLES.export_budget_tokens}
fav_default_span = ${DEFAULT_TUNABLES.fav_default_span}
summary_stale_pct = ${DEFAULT_TUNABLES.summary_stale_pct}
redact_entropy_threshold = ${DEFAULT_TUNABLES.redact_entropy_threshold}
full_walk_interval_ms = ${DEFAULT_TUNABLES.full_walk_interval_ms}
full_walk_degraded_after_ms = ${DEFAULT_TUNABLES.full_walk_degraded_after_ms}
full_walk_stale_after_ms = ${DEFAULT_TUNABLES.full_walk_stale_after_ms}
`;
}

function exactStringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new ConfigError(`${context} must be an array of absolute roots`);
  const roots = value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) throw new ConfigError(`${context} contains an empty/non-string root`);
    const expanded = expandPath(item);
    if (!expanded.startsWith("/")) throw new ConfigError(`${context} roots must resolve to absolute paths`);
    return expanded;
  });
  if (new Set(roots).size !== roots.length) throw new ConfigError(`${context} contains duplicate roots`);
  return roots;
}

function resolveSourcePlans(
  rawSources: unknown,
  builtins: Record<HarnessId, string[]> = builtinSourceRoots(),
): Record<HarnessId, SourceConfig> {
  if (rawSources !== undefined && (!rawSources || typeof rawSources !== "object" || Array.isArray(rawSources))) {
    throw new ConfigError("sources must be a TOML table");
  }
  const supplied = (rawSources ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(supplied).filter((source) => !(HARNESS_IDS as readonly string[]).includes(source));
  if (unknown.length > 0) throw new ConfigError(`unknown source catalog entr${unknown.length === 1 ? "y" : "ies"}: ${unknown.join(", ")}`);

  const resolved = {} as Record<HarnessId, SourceConfig>;
  for (const source of HARNESS_IDS) {
    const raw = supplied[source];
    if (raw === undefined) {
      resolved[source] = { mode: "builtin", roots: [...builtins[source]], disabledReason: null };
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`sources.${source} must be a table`);
    const table = raw as Record<string, unknown>;
    const allowed = new Set(["mode", "roots", "reason"]);
    const extra = Object.keys(table).filter((key) => !allowed.has(key));
    if (extra.length > 0) throw new ConfigError(`sources.${source} has unknown field(s): ${extra.join(", ")}`);

    // Pre-contract roots-only files remain readable as explicit replacement
    // plans. An empty roots-only block is still invalid; empty never means off.
    const legacyRootsOnly = table.mode === undefined && table.roots !== undefined;
    const mode = legacyRootsOnly ? "replace" : table.mode;
    if (mode !== "builtin" && mode !== "extend" && mode !== "replace" && mode !== "disabled") {
      throw new ConfigError(`sources.${source}.mode must be builtin, extend, replace, or disabled`);
    }
    const reason = typeof table.reason === "string" ? table.reason.trim() : "";
    const hasRoots = table.roots !== undefined;
    const roots = hasRoots ? exactStringArray(table.roots, `sources.${source}.roots`) : [];

    if (mode === "disabled") {
      if (!reason) throw new ConfigError(`sources.${source} disabled mode requires a nonblank reason`);
      if (hasRoots) throw new ConfigError(`sources.${source} disabled mode cannot define roots`);
      resolved[source] = { mode, roots: [], disabledReason: reason };
    } else if (mode === "builtin") {
      if (hasRoots) throw new ConfigError(`sources.${source} builtin mode cannot define roots`);
      if (table.reason !== undefined) throw new ConfigError(`sources.${source} reason is valid only for disabled mode`);
      resolved[source] = { mode, roots: [...builtins[source]], disabledReason: null };
    } else if (mode === "extend") {
      if (roots.length === 0) throw new ConfigError(`sources.${source} extend mode requires nonempty roots`);
      if (table.reason !== undefined) throw new ConfigError(`sources.${source} reason is valid only for disabled mode`);
      const extended = [...builtins[source], ...roots];
      if (new Set(extended).size !== extended.length) throw new ConfigError(`sources.${source} extend mode duplicates a builtin root`);
      resolved[source] = { mode, roots: extended, disabledReason: null };
    } else {
      if (roots.length === 0) throw new ConfigError(`sources.${source} replace mode requires nonempty roots`);
      if (table.reason !== undefined) throw new ConfigError(`sources.${source} reason is valid only for disabled mode`);
      resolved[source] = { mode, roots, disabledReason: null };
    }
  }
  return resolved;
}

function resolveStorage(rawStorage: unknown): StorageConfig {
  if (rawStorage === undefined) return { volumes: {} };
  if (!rawStorage || typeof rawStorage !== "object" || Array.isArray(rawStorage)) {
    throw new ConfigError("storage must be a TOML table");
  }
  const storage = rawStorage as Record<string, unknown>;
  const unknown = Object.keys(storage).filter((key) => key !== "volumes");
  if (unknown.length > 0) throw new ConfigError(`storage has unknown field(s): ${unknown.join(", ")}`);
  if (storage.volumes === undefined) return { volumes: {} };
  if (!storage.volumes || typeof storage.volumes !== "object" || Array.isArray(storage.volumes)) {
    throw new ConfigError("storage.volumes must be a TOML table");
  }

  const volumes: Record<string, string> = {};
  for (const [rawPrefix, rawUuid] of Object.entries(storage.volumes as Record<string, unknown>)) {
    if (!rawPrefix.trim()) throw new ConfigError("storage.volumes contains a blank mount prefix");
    if (!isAbsolute(rawPrefix)) {
      throw new ConfigError(`storage.volumes mount prefix must be absolute: ${rawPrefix}`);
    }
    if (typeof rawUuid !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(rawUuid)) {
      throw new ConfigError(`storage.volumes.${rawPrefix} must be a UUID-shaped string`);
    }
    const prefix = resolve(rawPrefix);
    if (volumes[prefix] !== undefined) {
      throw new ConfigError(`storage.volumes contains duplicate normalized prefix: ${prefix}`);
    }
    volumes[prefix] = rawUuid.toUpperCase();
  }
  return { volumes };
}

/** Load and completely validate config before any caller opens an Atlas DB. */
export interface LoadConfigOptions {
  bootstrap?: boolean;
  /** Fixture-only builtin override; production callers omit this. */
  builtinRoots?: Record<HarnessId, string[]>;
}

export async function loadConfig(path: string = DEFAULT_CONFIG_PATH, options: LoadConfigOptions = {}): Promise<Config> {
  const resolved = expandPath(path);
  let raw = "";
  try {
    raw = await readFile(resolved, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      if (options.bootstrap === false) raw = defaultConfigTemplate(implicitDbPath(resolved));
      else {
        await bootstrapConfig(resolved);
        raw = await readFile(resolved, "utf8");
      }
    } else throw err;
  }

  let parsed: Record<string, unknown>;
  try {
    const { parse } = await import("smol-toml");
    parsed = parse(raw) as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(`invalid TOML: ${error instanceof Error ? error.message : String(error)}`);
  }

  const dbPath = typeof parsed.dbPath === "string" ? expandPath(parsed.dbPath) : implicitDbPath(resolved);
  if (!dbPath.startsWith("/")) throw new ConfigError("dbPath must resolve to an absolute path");
  const cfg: Config = {
    sources: resolveSourcePlans(parsed.sources, options.builtinRoots),
    providers: [],
    launchers: [],
    tunables: { ...DEFAULT_TUNABLES },
    dbPath,
    storage: resolveStorage(parsed.storage),
  };

  const providers = parsed.providers;
  if (Array.isArray(providers)) {
    cfg.providers = providers.map((p) => {
      const r = p as Record<string, unknown>;
      const thinking = r.thinking;
      if (thinking !== undefined && thinking !== "enabled" && thinking !== "disabled") {
        throw new ConfigError(`provider thinking must be 'enabled' or 'disabled'`);
      }
      const kind = r.kind ?? "anthropic";
      if (kind !== "anthropic" && kind !== "openai" && kind !== "claude-cli") {
        throw new ConfigError(`provider kind must be 'anthropic', 'openai', or 'claude-cli'`);
      }
      return {
        name: String(r.name ?? ""), base: String(r.base ?? ""),
        kind,
        model: String(r.model ?? ""), key_env: String(r.key_env ?? ""),
        ...(thinking ? { thinking } : {}),
      };
    });
  }
  const launchers = parsed.launchers;
  if (Array.isArray(launchers)) {
    cfg.launchers = launchers.map((p) => {
      const r = p as Record<string, unknown>;
      return { name: String(r.name ?? ""), cmd: String(r.cmd ?? "") };
    });
  }

  const tun = (parsed.tunables ?? {}) as Record<string, unknown>;
  const t = cfg.tunables;
  for (const key of Object.keys(DEFAULT_TUNABLES) as Array<keyof Tunables>) {
    if (typeof tun[key] === "number") t[key] = Number(tun[key]);
  }
  validateTunables(t);
  return cfg;
}

function validateTunables(t: Tunables): void {
  const positive: Array<keyof Tunables> = [
    "tag_promotion_count", "export_budget_tokens", "fav_default_span", "summary_stale_pct",
    "redact_entropy_threshold", "full_walk_interval_ms", "full_walk_degraded_after_ms", "full_walk_stale_after_ms",
  ];
  for (const key of positive) {
    if (!Number.isFinite(t[key]) || t[key] <= 0) throw new ConfigError(`tunables.${key} must be positive`);
  }
  if (t.full_walk_degraded_after_ms < 2 * t.full_walk_interval_ms) {
    throw new ConfigError("tunables.full_walk_degraded_after_ms must be at least twice full_walk_interval_ms");
  }
  if (t.full_walk_stale_after_ms <= t.full_walk_degraded_after_ms) {
    throw new ConfigError("tunables.full_walk_stale_after_ms must be greater than full_walk_degraded_after_ms");
  }
}

export { homedir, HARNESS_IDS };

function tomlString(value: string): string {
  return JSON.stringify(value);
}
