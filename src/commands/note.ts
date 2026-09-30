import { flagValue, hasFlag, withConstructionCtx } from "./ctx.js";
import { ingestOne } from "../ingest.js";
import { summarizeSession } from "../summarize.js";
import { retryPendingFavorites } from "../favorites.js";
import type { VolumeIdentityProbe } from "../runtime/storage-identity.js";
import { isConstructionRefusal } from "../runtime/writer-coordinator.js";

/**
 * atlas note <session-id> — harness SessionEnd/Stop hook target. Targeted
 * single-session ingest + immediate tier-1 summarize. Chain debounce: if the
 * session belongs to a chain whose previous member was summarized < 30 min ago,
 * refresh is skipped (the chain line already covers it; SPEC §2).
 */
const CHAIN_DEBOUNCE_MS = 30 * 60 * 1000;

export interface NoteCommandOptions { storageProbe?: VolumeIdentityProbe; }

export async function noteCmd(argv: string[], options: NoteCommandOptions = {}): Promise<number> {
  const { target, harness: harnessHint } = parseNoteArgs(argv);
  const ingestOnly = hasFlag(argv, "--ingest-only");
  if (!target) {
    process.stderr.write("atlas note <session-id> [--harness claude|codex|kilo]\n");
    return 2;
  }
  try {
    await withConstructionCtx(argv, "atlas note", async ({ db, config }) => {
    // Try each configured source to find the native id.
    const harnesses = harnessHint ? [harnessHint] : Object.keys(config.sources);
    let found = false;
    let sessionId: number | null = null;
    let matchedHarness = "";
    for (const h of harnesses) {
      const r = await ingestOne(db, config, h, target, { storageProbe: options.storageProbe });
      if (r.found) {
        found = true;
        sessionId = r.sessionId;
        matchedHarness = h;
        break;
      }
    }

    if (!found || sessionId === null) {
      process.stdout.write(`atlas note · ${target} not found in any configured source\n`);
      return;
    }

    retryPendingFavorites(db, {
      harness: matchedHarness,
      nativeId: target,
      defaultSpan: config.tunables.fav_default_span,
    });

    if (ingestOnly) {
      process.stdout.write(`atlas note · ${matchedHarness}/${target} (#${sessionId}) · indexed (summary deferred)\n`);
      return;
    }

    // Chain debounce: skip if a chain sibling was summarized very recently.
    const chainRow = db
      .prepare(`SELECT chain_id FROM sessions WHERE id=?`)
      .get(sessionId) as { chain_id: number | null } | null;
    if (chainRow?.chain_id) {
      const recent = db
        .prepare(
          `SELECT MAX(sm.generated_at) AS t FROM summaries sm
           JOIN sessions s ON s.id=sm.session_id
           WHERE s.chain_id=? AND s.id != ? AND sm.tier=1`,
        )
        .get(chainRow.chain_id, sessionId) as { t: number | null } | null;
      if (recent?.t && Date.now() - recent.t < CHAIN_DEBOUNCE_MS) {
        process.stdout.write(
          `atlas note · ${matchedHarness}/${target} (#${sessionId}) · debounced (chain summarized <30m ago)\n`,
        );
        return;
      }
    }

    const out = await summarizeSession(db, config, sessionId);
    process.stdout.write(
      `atlas note · ${matchedHarness}/${target} (#${sessionId}) · ${out.status}` +
        (out.provider ? ` via ${out.provider}` : "") +
        (out.reason ? ` · ${out.reason}` : "") +
        "\n",
    );
    }, { storageProbe: options.storageProbe });
  } catch (error) {
    if (!isConstructionRefusal(error)) throw error;
    process.stderr.write(`atlas note: ${error.message}\n`);
    return 1;
  }
  return 0;
}

/** Parse note's one positional without mistaking values of shared flags for it. */
export function parseNoteArgs(argv: string[]): { target?: string; harness?: string } {
  const valuedFlags = new Set(["--config", "--harness"]);
  let target: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (valuedFlags.has(value)) {
      index++;
      continue;
    }
    if (!value.startsWith("-")) {
      target = value;
      break;
    }
  }
  return { target, harness: flagValue(argv, "--harness") };
}
