#!/usr/bin/env bun
/**
 * Provider-free Phase 6 Batch dry run.
 *
 * Reads one explicitly supplied current Atlas DB read-only, writes only the
 * explicitly supplied manifest/request artifacts, and never loads config,
 * secrets, providers, launchers, or network clients.
 */
import { isAbsolute, resolve } from "node:path";
import { openReadOnlyDb } from "../src/db/index.js";
import { DEFAULT_DB_PATH } from "../src/config.js";
import { planBatch } from "../src/batch/plan.js";
import { renderBatchJsonl } from "../src/batch/render.js";
import { writeManifest } from "../src/batch/manifest.js";
import type { BatchCaps } from "../src/batch/types.js";
import { writeFile } from "node:fs/promises";

interface CliOptions {
  dbPath: string;
  manifestPath: string;
  requestsPath: string | null;
  provider: string;
  caps: BatchCaps;
  outputTokensPerRequest: number;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set(["--db", "--manifest", "--requests", "--provider", "--max-input-tokens", "--max-output-tokens", "--max-input-dollars", "--max-output-dollars", "--max-dollars", "--output-tokens"]);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (!flags.has(flag)) throw new Error(`unknown argument ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (!value) throw new Error(`${flag} is required`);
    return value;
  };
  const positiveInt = (flag: string): number => {
    const value = Number(required(flag));
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
    return value;
  };
  const positiveNumber = (flag: string): number => {
    const value = Number(required(flag));
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be positive`);
    return value;
  };
  const dbPath = absolute(required("--db"));
  const manifestPath = absolute(required("--manifest"));
  if (dbPath === resolve(DEFAULT_DB_PATH)) throw new Error("dry run refuses the live/default Atlas database");
  if (manifestPath === dbPath) throw new Error("manifest must not overwrite the database");
  return {
    dbPath,
    manifestPath,
    requestsPath: values.has("--requests") ? absolute(values.get("--requests")!) : null,
    provider: required("--provider"),
    caps: {
      maxInputTokens: positiveInt("--max-input-tokens"),
      maxOutputTokens: positiveInt("--max-output-tokens"),
      maxInputDollars: positiveNumber("--max-input-dollars"),
      maxOutputDollars: positiveNumber("--max-output-dollars"),
      maxDollars: positiveNumber("--max-dollars"),
    },
    outputTokensPerRequest: positiveInt("--output-tokens"),
  };
}

export async function runDryRun(options: CliOptions): Promise<{ manifestPath: string; requestCount: number; batchCount: number; totals: unknown }> {
  const db = openReadOnlyDb(options.dbPath);
  try {
    const manifest = planBatch(db, {
      provider: options.provider,
      caps: options.caps,
      outputTokensPerRequest: options.outputTokensPerRequest,
      redact: true,
    });
    await writeManifest(options.manifestPath, manifest);
    if (options.requestsPath) await writeFile(options.requestsPath, renderBatchJsonl(manifest), { mode: 0o600, flag: "wx" });
    return {
      manifestPath: options.manifestPath,
      requestCount: manifest.candidates.length,
      batchCount: manifest.batches.length,
      totals: manifest.totals,
    };
  } finally {
    db.close();
  }
}

function absolute(value: string): string {
  if (!isAbsolute(value)) throw new Error(`path must be absolute: ${value}`);
  return resolve(value);
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await runDryRun(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
