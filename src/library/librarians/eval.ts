/** Offline evaluation preparation/scoring. Never calls a provider or opens a library. */
import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { makePassage } from "../passages";
import type { CapturedSession } from "../contracts";

export interface QualityReview {
  id: string; split: "development" | "held-out";
  reviewer: string | null; evidenceNotes: string | null;
  technicalOnlyDemotions: number | null; unsupportedFinalDecisions: number | null;
  missedLateReversals: number | null; substantiveTopics: number | null; recoveredTopics: number | null;
  proposedMemberships: number | null; supportedMemberships: number | null;
  invalidCitations: number | null; coverageFailures: number | null;
}
export function evaluationCases(): { capture: CapturedSession; label: { id: string; split: "development" | "held-out"; stratum: string; topics: string[]; finalDecision: string; reversalRequired: boolean }; review: QualityReview }[] {
  const subjects = ["repairable furniture", "Japanese reading", "database recovery", "accessible menus", "garden drainage", "family recipes", "unicode source evidence", "walking routes", "budget planning", "camera repair", "sleep diary", "local archives"];
  return Array.from({ length: 60 }, (_, i) => {
    const id = `quality-${String(i + 1).padStart(2, "0")}`; const key = { harness: "codex", nativeId: id };
    const observationId = `${id}:retained-v1`; const long = i < 20; const technical = i >= 20 && i < 35;
    const topics = [subjects[i % subjects.length]!, subjects[(i + 5) % subjects.length]!];
    const finalDecision = `Keep the original ${topics[0]} notes; do not replace them with a summary.`;
    const texts = [technical ? "I started this technical conversation myself. Help inspect the migration; the subject does not make this a worker session." : `Let's discuss ${topics[0]} and ${topics[1]}.`, `Proposal: replace the ${topics[0]} notes after writing a summary.`,
      ...(long ? Array.from({ length: 180 }, (_, n) => `Topic ${n % 2 + 1}: ${topics[n % 2]}. Observation ${n}: retain the distinction between a proposal and an observed result.\n\n    preserved indentation 日本語 👩‍💻`) : [`Open question: how do ${topics[0]} and ${topics[1]} relate?`]),
      `Late correction: withdraw the replacement proposal. ${finalDecision}`, "The change is still a plan. No tool result confirms execution."];
    const passages = texts.map((text, ordinal) => makePassage({ sessionKey: key, observationId, record: `message-${ordinal}`, channel: "text", role: ordinal % 2 ? "assistant" : "user", text, ordinal, timestamp: ordinal }));
    const bytes = passages.reduce((n, p) => n + Buffer.byteLength(p.text), 0);
    const split = i % 2 ? "held-out" as const : "development" as const;
    return { capture: { session: { key, revision: observationId, title: topics.join(" / "), origin: technical ? "human_started" : "unknown", originReason: technical ? "Synthetic source-native direct-start fixture" : "Synthetic fixture has no native initiation evidence", models: [], cwd: null, updatedAt: i }, observation: { id: observationId, sourceId: "quality-fixtures", locator: `synthetic:${id}`, objectHash: observationId, retainedBoundary: { observationId, bytes, at: i }, indexedBoundary: { observationId, bytes, at: i }, summaryCoverage: null, lastCompleteReconciliation: i, format: "synthetic", gaps: ["Generated evaluation seed, not independently labeled evidence"] }, passages }, label: { id, split, stratum: long ? "long-multitopic" : technical ? "technical-human-start" : "other", topics, finalDecision, reversalRequired: true },
      review: { id, split, reviewer: null, evidenceNotes: null, technicalOnlyDemotions: null, unsupportedFinalDecisions: null, missedLateReversals: null, substantiveTopics: null, recoveredTopics: null, proposedMemberships: null, supportedMemberships: null, invalidCitations: null, coverageFailures: null } };
  });
}
export function scoreReviews(reviews: QualityReview[]): unknown {
  const cases = evaluationCases();
  if (reviews.length !== 60 || new Set(reviews.map(r => r.id)).size !== 60) throw new Error("Exactly 60 unique completed reviews required");
  for (const item of cases) {
    const r = reviews.find(r => r.id === item.label.id);
    if (!r || r.split !== item.label.split || !r.reviewer?.trim() || !r.evidenceNotes?.trim()) throw new Error(`Independent reviewer and evidence notes required: ${item.label.id}`);
    for (const field of ["technicalOnlyDemotions", "unsupportedFinalDecisions", "missedLateReversals", "substantiveTopics", "recoveredTopics", "proposedMemberships", "supportedMemberships", "invalidCitations", "coverageFailures"] as const) if (!Number.isSafeInteger(r[field]) || r[field]! < 0) throw new Error(`Incomplete review ${r.id}: ${field}`);
    if (r.recoveredTopics! > r.substantiveTopics! || r.supportedMemberships! > r.proposedMemberships!) throw new Error("Recovered/supported counts exceed reviewed totals");
  }
  return Object.fromEntries(["development", "held-out"].map(split => {
    const selected = reviews.filter(r => r.split === split);
    const sum = (field: keyof QualityReview) => selected.reduce((n, r) => n + Number(r[field]), 0);
    const topicRecall = sum("substantiveTopics") ? sum("recoveredTopics") / sum("substantiveTopics") : 0;
    const membershipPrecision = sum("proposedMemberships") ? sum("supportedMemberships") / sum("proposedMemberships") : null;
    const failures = ["technicalOnlyDemotions", "unsupportedFinalDecisions", "missedLateReversals", "invalidCitations", "coverageFailures"].map(field => sum(field as keyof QualityReview));
    return [split, { conversations: selected.length, topicRecall, membershipPrecision, failures, passed: failures.every(n => n === 0) && topicRecall >= 0.95 && membershipPrecision !== null && membershipPrecision >= 0.95 }];
  }));
}
if (import.meta.main) {
  const [command, path] = process.argv.slice(2);
  if (!path) throw new Error("Usage: bun src/library/librarians/eval.ts --prepare <new-output-directory> | --score <completed-review.jsonl>");
  if (command === "--prepare") {
    const directory = resolve(path); await mkdir(directory, { recursive: false }); const cases = evaluationCases();
    for (const [name, rows] of [["captured-sessions.jsonl", cases.map(c => c.capture)], ["seed-labels.jsonl", cases.map(c => c.label)], ["review-template.jsonl", cases.map(c => c.review)]] as const) await Bun.write(join(directory, name), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    console.log(`Prepared 60 synthetic cases (20 long, 15 technical starts), 30 held-out. No model calls or quality claim. ${directory}`);
  } else if (command === "--score") {
    const reviews = (await Bun.file(resolve(path)).text()).trim().split("\n").map(line => JSON.parse(line)); console.log(JSON.stringify(scoreReviews(reviews), null, 2));
  } else throw new Error("Unknown evaluation command");
}
