# Library capture and artifact evidence

The new library is opt-in and separate from the installed archive. `discoverSources(home)` only proposes recognized home-relative roots: every proposal is disabled. `CaptureCoordinator.addSource` is the explicit acceptance/custom-root/import action. Consumer exports have separate `chatgpt-export`, `claude-export`, and `cursor-export` namespaces. Select extracted conversation JSON/Markdown, not an account credential directory; ZIP unpacking is not implemented.

`start()` performs startup reconciliation, coalesces filesystem hints, enumerates units every five minutes, and runs full reconciliation every thirty minutes. `stop()` closes watcher/timer resources and awaits the active publication pass. Manual `reconcile()` uses the same path. Source disappearance preserves prior sessions and observations and reports reachability errors. There are no source transcript writes, provider calls, hooks, launchers, or automatic account access.

Evidence objects are SHA-256-addressed, written and fsynced before indexing. Manifests retain byte length, complete-line boundary, original locator, immutable append segments, prefix continuity, previous revision, and capture time. Torn tails remain retained but not searchable. Replacement/shrink starts a new observation. Metadata dependency fingerprints are separately retained. The SQLite path uses SQLite's `VACUUM INTO` from a read-only connection to an Atlas-owned destination; active WAL content is included without checkpointing the source. Objects are immutable; a free-space reserve fails capture visibly instead of deleting history. No garbage collection is run. Current implementation retains full materialized revisions alongside chunks: this favors replay simplicity over storage efficiency and is not the final compressed-storage implementation.

Publication is outside parsing/evidence-writing transactions. A single coordinator serializes passes and yields between units so the publisher can service user actions. Manifest state survives restart; observation/content identities and the store publisher make retry idempotent. Retained-but-unparsed observations are published as coverage gaps, never guessed sessions. `capture-status` state exposes active/idle/partial status. Legacy parsing remains synchronous per unit; dedicated parsing workers and large-unit latency certification are still needed before a near-instant bulk-capture claim.

## Supported format contracts

The seven existing adapters are reused without editing their parsers: Claude Code, Codex, Prime, Hermes, Kimi, Kilo and ZCode. Existing admission, provenance, title, complete-line and WAL conformance suites remain required. Kimi only represents successive observed current contexts, not lifetime history. Legacy metadata fingerprints are archived; they are not a blanket byte-exact copy of every auxiliary source file.

Gemini's native snapshot and stream parser is grounded in upstream commit `85aca163f6c73ac6ce380b5447359146b8adcae4`, inspected 2026-09-05. It implements record-ID replacement, `$set` metadata/checkpoint updates, and exclusive `$rewindTo` removal, with original tool payloads retained. Unknown events fail closed. Source: [chatRecordingService](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/services/chatRecordingService.ts), [record types](https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/services/chatRecordingTypes.ts). Discovery is limited to `session-*.json` / `session-*.jsonl` under the approved Gemini root.

OpenCode's native SQLite packet targets the `v1.2.15` session/message/part contract. Messages order by source creation time and ID; nontext parts remain tool evidence. The importer probes required columns, never substitutes the Kilo parser, and rejects populated newer `session_message` storage pending another adapter. JSON `info/messages/parts` exports are supported separately. Source: [versioned SQLite schema](https://github.com/anomalyco/opencode/blob/v1.2.15/packages/opencode/src/session/session.sql.ts). Newer schema inspection at `e2894562f8ba943d72172d10b727c24d5f650c16` established the explicit new-storage rejection. Native directory discovery selects `opencode.db`, excludes credentials/logs, and does not claim legacy JSON-tree coverage.

ChatGPT import requires the exported conversations array, mapping nodes, and explicit current-node branch authority; alternate branches remain in retained original bytes. Nontext content currently fails closed rather than disappearing. Claude consumer import requires UUID/chat_messages and sender fields. Cursor import requires Markdown title and explicit `**User**`/`**Cursor**` turn markers. These consumer formats have synthetic export-shape fixtures, not account-version certification; native Cursor storage is unsupported. No packet promises continuation or cloud completeness.

## Artifact claims

Artifact records preserve the original spelling, recorded cwd and exact source ref. Mention, cwd, requested creation, successful modification and observed creation are separate kinds. A structured tool result can establish creation only if it explicitly reports success, creation and prior absence. Assistant statements, failed commands, `mkdir -p`, and cwd alone never prove origin. Shell text is never executed. Unknown/opaque tool results remain reader evidence and correctly yield “origin not established.”

## Reproducible gates

All fixtures use disposable explicitly named homes/databases/evidence directories, without providers:

```sh
bun test test/library-capture.test.ts test/library-artifact.test.ts test/phase3a-claude.test.ts test/phase3a-codex.test.ts test/phase3b-prime-kimi.test.ts test/phase3b-sqlite-adapters.test.ts
bun run typecheck
git diff --check
```

This proves source-pinned synthetic conformance and capture recovery, not installed-app lifecycle certification, large-corpus timing, live cutover, or real-account completeness.

## Integration follow-up

The integrated evidence store now keeps only immutable segments plus revision manifests, not a full extra object for every append. A permanent regression reconstructs20 distinct revisions with object bytes no greater than the final source. Consumer ZIP import is available through `import-zip`: bounded extraction, raw archive retention, path/symlink checks and decoded CRC32 validation; unsupported attachments remain in the retained archive. Divergent copied native IDs become explicit variants while the original projection stays searchable.

Final bounded-publication integration: the UI launches an on-demand child capture process, and Store.publishBounded stages <=64 passages/256KiB per transaction (one oversized passage atomic). Only a final one-row active-observation switch makes new content searchable. Cancellation/error keeps the prior complete revision; replay reuses staged refs. An independent two-connection probe confirms favorites commit between chunks and failed later chunks stay invisible.

### Preserved native history and migration metadata

Codex native forks may contain the current session header followed by inherited ancestor headers. Admission requires the first identity to match the source filename and every additional identity to be connected by explicit `forked_from_id` ancestry; unrelated identities, cycles, and conflicting parent declarations remain rejected. Current identity/cwd/origin do not inherit an ancestor header's values. `models` is the observed model-history set from recorded `session_meta.model` and `turn_context.model`, including inherited history; it is not a claim about the current child model, and `model_provider` is not substituted for a model.

Claude worker admission supports both envelope-verified legacy flat project files and nested `parent/subagents/agent-*` files, including hyphenated agent IDs. Matching agent metadata and sidechain evidence are required; nested paths additionally require parent-path agreement. Contradictory identities remain retained, unindexed evidence rather than guessed conversations.

During legacy migration, unrecovered source identities remain readable as explicitly labeled retained index projections. These preserve surviving legacy text/tool/raw rows but do not certify original source completeness or historical summary/classification quality. Verified original sources later replace the active projection without invalidating its pinned references. Equivalent physical copies retain their source observations and raw evidence while sharing the existing passage index. A versioned metadata-only model-history refresh updates already-captured Codex metadata without restaging passages or changing exact references.
