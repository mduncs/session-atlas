import { withReadOnlyCtx } from "./ctx.js";
import { runChat, degradedMessage } from "../chat.js";
import { hasUsableProvider } from "../provider.js";

/** atlas chat "<question>" — grounded Q&A over the archive (M5). */
export async function chatCmd(argv: string[]): Promise<number> {
  const query = positionalArgs(argv).join(" ");
  if (!query) {
    process.stderr.write('atlas chat "<question>"\n');
    return 2;
  }

  await withReadOnlyCtx(argv, async ({ db, config }) => {
    if (!hasUsableProvider(config.providers)) {
      process.stdout.write(degradedMessage("no permitted provider available; see atlas doctor") + "\n");
      return;
    }

    process.stdout.write(`atlas chat · ${config.providers.map((p) => p.name).join(" → ")}\n\n`);
    process.stdout.write(`Q: ${query}\n\n`);

    const outcome = await runChat(db, config, query, (turn) => {
      process.stdout.write(`A: ${turn.text}\n`);
      if (turn.citations.length > 0) {
        process.stdout.write(
          `   cites: ${turn.citations.map((c) => `[${c.sessionId}${c.ordinal !== null ? `:${c.ordinal}` : ""}]`).join(" ")}\n`,
        );
      } else {
        process.stdout.write(`   ⚠ uncited answer (no grounding)\n`);
      }
      if (turn.invalidCitations?.length) {
        process.stdout.write(
          `   ⚠ rejected citations: ${turn.invalidCitations.map((c) => `[${c.sessionId}${c.ordinal !== null ? `:${c.ordinal}` : ""}]`).join(" ")}\n`,
        );
      }
    });

    if (!outcome.ok) {
      process.stdout.write(`\n${degradedMessage(outcome.reason ?? "unknown error")}\n`);
      return;
    }

    if (outcome.result && !outcome.result.grounded) {
      process.stdout.write(`\n⚠ This answer did not pass archive-grounding validation.\n`);
    }
  });
  return 0;
}

function positionalArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--config") {
      index++;
      continue;
    }
    if (!argv[index]!.startsWith("-")) out.push(argv[index]!);
  }
  return out;
}
