import type { SessionTranscriptDto } from "../src/contracts/search.js";
import type { ArtifactKind, HistoryCompleteness, SourceValidationStatus } from "../src/contracts/construction.js";

export interface Phase5FixtureOptions {
  artifactKind?: ArtifactKind;
  historyCompleteness?: HistoryCompleteness;
  sourceValidationStatus?: SourceValidationStatus;
  diagnostic?: string | null;
  oneSided?: "user" | "assistant" | null;
  generationMismatch?: boolean;
  empty?: boolean;
}

/** Sanitized synthetic current-schema DTO: no source path/hash/id/timestamp or corpus prose. */
export function phase5TranscriptFixture(options: Phase5FixtureOptions = {}): SessionTranscriptDto {
  const generation = "fixture-generation-current";
  const key = { harness: "claude" as const, nativeId: "fixture-phase5-dialogue" };
  const tool = {
    toolActivityId: 1,
    rawRecordId: 2,
    activityOrdinal: 0,
    activityKind: "call" as const,
    toolName: "fixture_tool",
    toolText: "synthetic tool payload",
    sourceActivityId: "fixture-activity-1",
  };
  const dialogue = [
    {
      logicalRecordId: 1, logicalOrdinal: 1, rawRepresentativeOrdinal: 1,
      side: "user" as const, recordKind: "real_user" as const,
      prose: "Synthetic user turn alpha repeats enough measured words to wrap over several terminal lines without borrowing another row gutter or ordinal.",
      eventTs: null, replayCount: 0, toolActivities: [], constructionGeneration: generation,
    },
    {
      logicalRecordId: 2, logicalOrdinal: 2, rawRepresentativeOrdinal: 2,
      side: "assistant" as const, recordKind: "assistant_dialogue_prose" as const,
      prose: "Synthetic assistant turn beta also wraps deliberately and retains one attached activity only in explicit activity projections.",
      eventTs: null, replayCount: 0, toolActivities: [tool], constructionGeneration: options.generationMismatch ? "fixture-generation-stale" : generation,
    },
    {
      logicalRecordId: 5, logicalOrdinal: 5, rawRepresentativeOrdinal: 5,
      side: "user" as const, recordKind: "real_user" as const,
      prose: "Synthetic user turn gamma closes the dialogue projection.",
      eventTs: null, replayCount: 0, toolActivities: [], constructionGeneration: generation,
    },
  ];
  const selectedDialogue = options.empty
    ? []
    : options.oneSided === "user"
      ? dialogue.filter((row) => row.side === "user")
      : options.oneSided === "assistant"
        ? dialogue.filter((row) => row.side === "assistant")
        : dialogue;
  const activity = options.empty ? [] : [
    ...dialogue.slice(0, 2).map((turn) => ({
      logicalRecordId: turn.logicalRecordId,
      logicalOrdinal: turn.logicalOrdinal,
      recordKind: turn.recordKind,
      prose: turn.prose,
      eventTs: turn.eventTs,
      replayCount: turn.replayCount,
      toolActivities: turn.toolActivities,
      constructionGeneration: turn.constructionGeneration,
    })),
    {
      logicalRecordId: 3, logicalOrdinal: 3, recordKind: "telemetry" as const,
      prose: null, eventTs: null, replayCount: 0, toolActivities: [], constructionGeneration: generation,
    },
    {
      logicalRecordId: 4, logicalOrdinal: 4, recordKind: "tool" as const,
      prose: null, eventTs: null, replayCount: 0,
      toolActivities: [{ ...tool, toolActivityId: 2, rawRecordId: 4, activityKind: "result" as const, sourceActivityId: "fixture-activity-2" }],
      constructionGeneration: generation,
    },
    {
      logicalRecordId: 5, logicalOrdinal: 5, recordKind: "real_user" as const,
      prose: dialogue[2]!.prose, eventTs: null, replayCount: 0, toolActivities: [], constructionGeneration: generation,
    },
  ].filter((record) => selectedDialogue.some((turn) => turn.logicalRecordId === record.logicalRecordId)
    || record.recordKind !== "real_user" && record.recordKind !== "assistant_dialogue_prose");
  const userCount = selectedDialogue.filter((turn) => turn.side === "user").length;
  const assistantCount = selectedDialogue.filter((turn) => turn.side === "assistant").length;
  const rawCount = activity.length;
  const toolCount = activity.reduce((sum, row) => sum + row.toolActivities.length, 0);
  const proseCount = activity.filter((row) => row.prose?.trim()).length;
  return {
    session: {
      sessionKey: key,
      surrogateId: 7001,
      effectiveTitle: "Synthetic measured dialogue fixture",
      titleEvidence: null,
      originalProjectKey: "fixture-project",
      canonicalProjectKey: "fixture-project",
      cwd: null,
      lastActivityTs: null,
      dialogueStartTs: null,
      dialogueEndTs: null,
      artifactKind: options.artifactKind ?? "dialogue_history",
      historyCompleteness: options.historyCompleteness ?? "complete",
      sourceValidationStatus: options.sourceValidationStatus ?? "current",
      defaultSessionVisible: selectedDialogue.length > 0,
      constructionGeneration: generation,
      metrics: {
        rawProvenanceRowCount: rawCount,
        logicalRecordCount: rawCount,
        rawToolActivityCount: toolCount,
        logicalToolActivityCount: toolCount,
        rawProseBearingRecordCount: proseCount,
        logicalProseBearingRecordCount: proseCount,
        dialogueTurnCount: selectedDialogue.length,
        userDialogueTurnCount: userCount,
        assistantDialogueTurnCount: assistantCount,
        logicalReplayCount: 0,
        unknownIdentityRawRowCount: rawCount,
      },
      models: ["fixture-model"],
      favorite: false,
      chainStableKey: null,
    },
    dialogue: selectedDialogue,
    activity,
    diagnostic: options.diagnostic ?? null,
  };
}
