import { flagValue, hasFlag, withCtx } from "./ctx.js";
import {
  applyHumanClassifications,
  buildHumanClassifierBatch,
  collectHumanCandidates,
  countHumanCandidates,
  DEFAULT_CLASSIFIER_BATCH_SIZE,
  parseHumanPromotions,
  ZcodeHumanClassifierRunner,
} from "../human-classifier.js";

/**
 * Human-only promotion pass. Preview is the default; --run invokes the
 * installed ZCode CLI through the authorized Coding Plan OpenAI-compatible
 * endpoint (GLM-5.2) and commits auditable decisions to this DB. The key comes
 * from SESSION_ATLAS_ZAI_API_KEY or the equivalent Z_AI_API_KEY.
 */
export async function classifyHumansCmd(argv: string[]): Promise<number> {
  const limit = Number(flagValue(argv, "--limit") ?? DEFAULT_CLASSIFIER_BATCH_SIZE);
  const batchSize = Number(flagValue(argv, "--batch-size") ?? DEFAULT_CLASSIFIER_BATCH_SIZE);
  const run = hasFlag(argv, "--run");
  const all = hasFlag(argv, "--all");
  const redo = hasFlag(argv, "--redo");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 80) {
    process.stderr.write("atlas classify-humans: --limit must be an integer from 1 to 200\n");
    return 2;
  }
  if (all && redo) {
    process.stderr.write("atlas classify-humans: --all and --redo cannot be combined; redo a bounded --limit batch\n");
    return 2;
  }

  let exitCode = 0;
  await withCtx(argv, async ({ db, config, dbPath }) => {
    const total = countHumanCandidates(db, { redo });
    const requested = all ? total : Math.min(total, limit);
    const firstBatch = collectHumanCandidates(db, {
      limit: Math.min(requested, batchSize),
      redo,
      redactOptions: {
        entropyThreshold: config.tunables.redact_entropy_threshold,
        minEntropyLength: 20,
      },
    });
    process.stdout.write(
      `atlas classify-humans · ${total} candidate(s) remaining · ${requested} requested · ` +
      `human/unknown provenance only · target ${dbPath}\n`,
    );
    if (firstBatch.length === 0) return;
    if (!run) {
      process.stdout.write("preview only; no model call and no writes (add --run with SESSION_ATLAS_ZAI_API_KEY or Z_AI_API_KEY for ZCode Coding Plan GLM-5.2)\n");
      for (const item of firstBatch.slice(0, 12)) {
        process.stdout.write(`  #${item.id} ${item.origin} · ${item.topic}\n`);
      }
      if (requested > 12) process.stdout.write(`  … ${requested - 12} more requested\n`);
      return;
    }

    const runner = new ZcodeHumanClassifierRunner();
    process.stdout.write(`invoking ${runner.name} · ${runner.model}; ambiguous/omitted candidates become agent\n`);
    let processed = 0;
    let promotedTotal = 0;
    let batchNumber = 0;
    while (processed < requested) {
      const candidates = collectHumanCandidates(db, {
        limit: Math.min(batchSize, requested - processed),
        redo,
        redactOptions: {
          entropyThreshold: config.tunables.redact_entropy_threshold,
          minEntropyLength: 20,
        },
      });
      if (candidates.length === 0) break;
      batchNumber++;
      const batch = buildHumanClassifierBatch(candidates);
      const startedAt = Date.now();
      const heartbeat = setInterval(() => {
        process.stdout.write(`  [batch ${batchNumber}] still running · ${processed}/${requested} complete\n`);
      }, 60_000);
      try {
        const raw = await runner.classify(batch.prompt);
        const promotions = parseHumanPromotions(raw, candidates);
        const result = applyHumanClassifications(db, candidates, promotions, runner);
        processed += candidates.length;
        promotedTotal += result.human;
        process.stdout.write(
          `  [batch ${batchNumber}] ${processed}/${requested} · ${result.human} human · ` +
          `${result.agent} agent · ${Math.round((Date.now() - startedAt) / 1000)}s\n`,
        );
      } catch (error) {
        exitCode = 1;
        process.stderr.write(`atlas classify-humans: batch ${batchNumber} failed: ${(error as Error).message}\n`);
        process.stderr.write("no classification rows were written for the failed batch; rerun resumes from it\n");
        break;
      } finally {
        clearInterval(heartbeat);
      }
    }
    process.stdout.write(`atlas classify-humans · ${processed} classified · ${promotedTotal} human promoted · ${requested - processed} not attempted\n`);
  });
  return exitCode;
}
