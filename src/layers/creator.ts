/**
 * Provider-free creator pass: archive (read-only) → layers.session_creator.
 * md's corrections live in layers.creator_corrections and are never touched.
 */
import type { Database } from "bun:sqlite";
import type { DB } from "../db/index.js";
import { CREATOR_RULE_VERSION, decideCreator, learnVocabulary, setLearnedVocabulary, type CreatorInput, type CreatorVerdict } from "./authorship.js";

interface SessionHead { id: number; harness: string; native_id: string; origin: CreatorInput["origin"]; origin_detail: string | null; start_ts: number | null }

export interface CreatorReport { sessions: number; human: number; agent: number; unknown: number; templatedOpeners: number; ms: number }

/** Recompute every session (or those active since `sinceMs`) and replace their layer rows. */
export function computeCreators(archive: DB, layers: Database, options: { sinceMs?: number; now?: number } = {}): CreatorReport {
  const started = performance.now();
  const now = options.now ?? Date.now();
  // Assistant prose defines the corpus's correctly spelled jargon.
  setLearnedVocabulary(learnVocabulary((archive.query(
    `SELECT substr(text,1,3000) AS text FROM messages WHERE record_kind='assistant_dialogue_prose' ORDER BY id DESC LIMIT 40000`,
  ).all() as { text: string | null }[]).map((row) => row.text ?? "")));
  const heads = archive.query(
    `SELECT id,harness,native_id,origin,origin_detail,start_ts FROM sessions ORDER BY id`,
  ).all() as SessionHead[];
  const records = new Map<number, { ordinal: number; text: string }[]>();
  const rows = archive.query(
    `SELECT m.session_id AS sid, m.ordinal, m.text FROM messages m JOIN sessions s ON s.id=m.session_id
      WHERE m.record_kind='real_user' AND m.construction_generation=s.construction_generation
      ORDER BY m.session_id, m.ordinal`,
  ).all() as { sid: number; ordinal: number; text: string | null }[];
  for (const row of rows) {
    const list = records.get(row.sid) ?? [];
    list.push({ ordinal: row.ordinal, text: row.text ?? "" });
    records.set(row.sid, list);
  }

  // Templates are judged corpus-wide even when only recent sessions are
  // written, so a scripted opener is recognized on its third launch.
  const empty = new Set<string>();
  const firstPass = new Map<number, CreatorVerdict>();
  const openerSessions = new Map<string, number>();
  for (const head of heads) {
    const verdict = decideCreator(inputFor(head, records), empty);
    firstPass.set(head.id, verdict);
    if (verdict.startedBy !== "agent" && verdict.opener) openerSessions.set(verdict.opener, (openerSessions.get(verdict.opener) ?? 0) + 1);
  }
  const templated = new Set([...openerSessions].filter(([key, n]) => n >= 3 && key.length >= 60).map(([key]) => key));

  const report: CreatorReport = { sessions: 0, human: 0, agent: 0, unknown: 0, templatedOpeners: templated.size, ms: 0 };
  const upsert = layers.query(
    `INSERT OR REPLACE INTO session_creator(harness,native_id,session_id,started_by,confidence,evidence,
       first_human_ordinal,human_turns,agent_turns,harness_turns,rule_version,computed_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  layers.transaction(() => {
    for (const head of heads) {
      if (options.sinceMs !== undefined && (head.start_ts ?? 0) < options.sinceMs) continue;
      const first = firstPass.get(head.id)!;
      const verdict = first.opener && templated.has(first.opener) ? decideCreator(inputFor(head, records), templated) : first;
      upsert.run(head.harness, head.native_id, head.id, verdict.startedBy, verdict.confidence, verdict.evidence.join(" "),
        verdict.firstHumanOrdinal, verdict.humanTurns, verdict.agentTurns, verdict.harnessTurns, CREATOR_RULE_VERSION, now);
      report.sessions++;
      report[verdict.startedBy]++;
    }
  })();
  report.ms = Math.round(performance.now() - started);
  return report;
}

function inputFor(head: SessionHead, records: Map<number, { ordinal: number; text: string }[]>): CreatorInput {
  return { harness: head.harness, origin: head.origin, originDetail: head.origin_detail, userRecords: records.get(head.id) ?? [] };
}

