/**
 * Provider-free creator pass: archive (read-only) → layers.session_creator.
 * md's corrections live in layers.creator_corrections and are never touched.
 */
import type { Database } from "bun:sqlite";
import type { DB } from "../db/index.js";
import { CREATOR_RULE_VERSION, decideCreator, learnVocabulary, setLearnedVocabulary, type CreatorInput, type CreatorVerdict } from "./authorship.js";
import { bySession } from "./rows.js";

interface UserRecord { ordinal: number; text: string }
interface SessionHead { id: number; harness: string; native_id: string; origin: CreatorInput["origin"]; origin_detail: string | null; start_ts: number | null }

export interface CreatorReport { sessions: number; human: number; agent: number; unknown: number; templatedOpeners: number; ms: number }

/** Recompute every session (or those active since `sinceMs`) and replace their layer rows. */
export function computeCreators(archive: DB, layers: Database, options: { sinceMs?: number; now?: number } = {}): CreatorReport {
  const started = performance.now();
  const now = options.now ?? Date.now();
  // Assistant prose defines the corpus's correctly spelled jargon.
  setLearnedVocabulary(learnVocabulary(texts(archive.query(
    `SELECT substr(text,1,3000) AS text FROM messages WHERE record_kind='assistant_dialogue_prose' ORDER BY id DESC LIMIT 40000`,
  ).iterate() as Iterable<{ text: string | null }>)));
  const heads = archive.query(
    `SELECT id,harness,native_id,origin,origin_detail,start_ts FROM sessions ORDER BY id`,
  ).all() as SessionHead[];
  const byId = new Map(heads.map((head) => [head.id, head]));

  // Templates are judged corpus-wide even when only recent sessions are
  // written, so a scripted opener is recognized on its third launch. The first
  // pass holds one session's records at a time and keeps only verdicts.
  const empty = new Set<string>();
  const firstPass = new Map<number, CreatorVerdict>();
  const rows = archive.query(
    `SELECT m.session_id AS sid, m.ordinal, COALESCE(m.text,'') AS text FROM messages m JOIN sessions s ON s.id=m.session_id
      WHERE m.record_kind='real_user' AND m.construction_generation=s.construction_generation
      ORDER BY m.session_id, m.ordinal`,
  ).iterate() as Iterable<UserRecord & { sid: number }>;
  for (const [sid, records] of bySession(rows)) {
    const head = byId.get(sid);
    if (head) firstPass.set(sid, decideCreator(inputFor(head, records), empty));
  }
  const openerSessions = new Map<string, number>();
  for (const head of heads) {
    const verdict = firstPass.get(head.id) ?? decideCreator(inputFor(head, []), empty);
    firstPass.set(head.id, verdict);
    if (verdict.startedBy !== "agent" && verdict.opener) openerSessions.set(verdict.opener, (openerSessions.get(verdict.opener) ?? 0) + 1);
  }
  const templated = new Set([...openerSessions].filter(([key, n]) => n >= 3 && key.length >= 60).map(([key]) => key));
  const sessionRecords = archive.query(
    `SELECT m.ordinal, COALESCE(m.text,'') AS text FROM messages m JOIN sessions s ON s.id=m.session_id
      WHERE m.session_id=? AND m.record_kind='real_user' AND m.construction_generation=s.construction_generation
      ORDER BY m.ordinal`,
  );

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
      const verdict = first.opener && templated.has(first.opener) ? decideCreator(inputFor(head, sessionRecords.all(head.id) as UserRecord[]), templated) : first;
      upsert.run(head.harness, head.native_id, head.id, verdict.startedBy, verdict.confidence, verdict.evidence.join(" "),
        verdict.firstHumanOrdinal, verdict.humanTurns, verdict.agentTurns, verdict.harnessTurns, CREATOR_RULE_VERSION, now);
      report.sessions++;
      report[verdict.startedBy]++;
    }
  })();
  report.ms = Math.round(performance.now() - started);
  return report;
}

function inputFor(head: SessionHead, records: UserRecord[]): CreatorInput {
  return { harness: head.harness, origin: head.origin, originDetail: head.origin_detail, userRecords: records };
}

function* texts(rows: Iterable<{ text: string | null }>): Generator<string> {
  for (const row of rows) yield row.text ?? "";
}

