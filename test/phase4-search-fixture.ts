import { Database } from "bun:sqlite";
import { runMigrations } from "../src/db/index.js";
import { attachLayers } from "../src/layers/db.js";
import type { RecordKind } from "../src/contracts/construction.js";
import { applyV12SearchFragment } from "../src/search/v12-fts.js";

export interface SyntheticRecord {
  kind: RecordKind;
  side: "user" | "assistant" | null;
  prose: string | null;
  logicalKey?: string;
  replay?: boolean;
  tool?: boolean;
}

export interface SyntheticSession {
  nativeId: string;
  harness?: "claude" | "codex" | "prime" | "hermes" | "kimi" | "zcode" | "kilo";
  title?: string | null;
  records: SyntheticRecord[];
  lastActivity?: number | null;
  model?: string;
  project?: string;
  visible?: boolean;
  status?: "valid" | "invalid";
  sourceValidation?: "current" | "snapshot_only" | "legacy_unverified";
  artifactKind?: "dialogue_history" | "current_context_projection" | "metadata_shell";
  chainId?: number | null;
  favorite?: boolean;
  tag?: string | null;
}

export interface SeededSession {
  id: number;
  nativeId: string;
  logicalByKey: Map<string, number>;
  rawIds: number[];
}

export function phase4Database(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  attachLayers(db, ":memory:");
  return db;
}

export function seedSyntheticSession(db: Database, input: SyntheticSession): SeededSession {
  const generation = `fixture-generation-${input.nativeId}`;
  const harness = input.harness ?? "claude";
  const title = input.title === undefined ? `Synthetic ${input.nativeId}` : input.title;
  const status = input.status ?? "valid";
  const visible = input.visible ?? input.records.some((record) => isDialogue(record) && nonblank(record.prose));
  const sessionId = Number(db.prepare(
    `INSERT INTO sessions(
      harness,native_id,source_path,title,project,cwd,last_activity,models,
      tok_user,tok_assistant,tok_tool,msg_count,orphaned,ingested_at,
      original_project_key,canonical_project_key,project_key_rule_version,
      artifact_kind,history_completeness,construction_generation,construction_status,
      construction_invalid_reason,default_session_visible,source_validation_status,chain_id
    ) VALUES (?,?,?,?,?,?,?,?,0,0,0,0,0,1,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    harness,
    input.nativeId,
    `fixture://${input.nativeId}`,
    title,
    input.project ?? "fixture-project",
    input.project ?? "fixture-project",
    input.lastActivity ?? null,
    JSON.stringify([input.model ?? "fixture-model"]),
    input.project ?? "fixture-project",
    input.project ?? "fixture-project",
    "fixture-project-v1",
    input.artifactKind ?? "dialogue_history",
    "complete",
    generation,
    status,
    status === "valid" ? null : "fixture-invalid",
    visible ? 1 : 0,
    input.sourceValidation ?? "current",
    input.chainId ?? null,
  ).lastInsertRowid);

  const rawIds: number[] = [];
  for (let ordinal = 0; ordinal < input.records.length; ordinal++) {
    const record = input.records[ordinal]!;
    const role = record.side ?? (record.kind === "developer_system" ? "system" : "tool");
    const rawId = Number(db.prepare(
      `INSERT INTO messages(
        session_id,ordinal,role,text,tool_text,has_tool,tok_estimate,
        source_record_id,source_record_ts,source_identity_kind,source_ordinal,
        record_kind,dialogue_side,prose,event_ts,construction_generation
      ) VALUES (?,?,?,?,?,?,0,?,?,?, ?,?,?,?,?,?)`,
    ).run(
      sessionId,
      ordinal,
      role,
      record.prose,
      record.tool ? `synthetic-tool-${input.nativeId}-${ordinal}` : null,
      record.tool ? 1 : 0,
      `fixture-record-${input.nativeId}-${record.logicalKey ?? ordinal}`,
      record.logicalKey ? 7 : null,
      record.logicalKey ? "record-id" : "none",
      ordinal,
      record.kind,
      record.side,
      record.prose,
      null,
      generation,
    ).lastInsertRowid);
    rawIds.push(rawId);
    if (record.tool) {
      db.prepare(
        `INSERT INTO tool_activities(
          raw_record_id,activity_ordinal,activity_kind,tool_name,tool_text,source_activity_id,construction_generation
        ) VALUES (?,0,'call','fixture-tool',?,?,?)`,
      ).run(rawId, `synthetic-tool-${input.nativeId}-${ordinal}`, `fixture-activity-${ordinal}`, generation);
    }
  }

  const byKey = new Map<string, number[]>();
  input.records.forEach((record, ordinal) => {
    const key = record.logicalKey ?? `singleton-${ordinal}`;
    const members = byKey.get(key) ?? [];
    members.push(ordinal);
    byKey.set(key, members);
  });
  const logicalByKey = new Map<string, number>();
  let logicalOrdinal = 0;
  for (const [key, ordinals] of byKey) {
    const representativeOrdinal = ordinals[0]!;
    const representative = input.records[representativeOrdinal]!;
    const representativeRawId = rawIds[representativeOrdinal]!;
    const proved = ordinals.length > 1;
    const logicalId = Number(db.prepare(
      `INSERT INTO logical_messages(
        session_id,representative_message_id,logical_ordinal,logical_key,identity_kind,
        source_record_id,source_record_ts,member_count,replay_count,record_kind,
        dialogue_side,identity_status,construction_generation
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      sessionId,
      representativeRawId,
      logicalOrdinal,
      `fixture-logical-${input.nativeId}-${key}`,
      proved ? "record-id" : "none",
      proved ? `fixture-record-${input.nativeId}-${key}` : null,
      proved ? 7 : null,
      ordinals.length,
      ordinals.length - 1,
      representative.kind,
      representative.side,
      proved ? "proved" : "unknown",
      generation,
    ).lastInsertRowid);
    logicalByKey.set(key, logicalId);
    ordinals.forEach((rawOrdinal, memberOrdinal) => {
      db.prepare(
        `INSERT INTO logical_message_members(
          logical_message_id,message_id,raw_ordinal,is_replay,construction_generation
        ) VALUES (?,?,?,?,?)`,
      ).run(logicalId, rawIds[rawOrdinal]!, rawOrdinal, memberOrdinal === 0 ? 0 : 1, generation);
    });
    if (proved) {
      db.prepare(
        `INSERT INTO replay_election_evidence(
          logical_record_id,evidence_rule_version,source_identity_kind,source_record_id,
          source_record_ts,representative_raw_record_id,construction_generation
        ) VALUES (?,'fixture-replay-v1','record-id',?,7,?,?)`,
      ).run(logicalId, `fixture-record-${input.nativeId}-${key}`, representativeRawId, generation);
      ordinals.forEach((rawOrdinal, memberOrdinal) => {
        db.prepare(
          `INSERT INTO replay_election_members(logical_record_id,raw_record_id,member_ordinal,is_representative)
           VALUES (?,?,?,?)`,
        ).run(logicalId, rawIds[rawOrdinal]!, memberOrdinal, memberOrdinal === 0 ? 1 : 0);
      });
    }
    logicalOrdinal++;
  }

  const representatives = [...byKey.values()].map((ordinals) => input.records[ordinals[0]!]!);
  const rawToolCount = input.records.filter((record) => record.tool).length;
  const logicalToolCount = representatives.filter((record) => record.tool).length;
  const rawProse = input.records.filter((record) => nonblank(record.prose)).length;
  const logicalProse = representatives.filter((record) => nonblank(record.prose)).length;
  const userTurns = representatives.filter((record) => record.kind === "real_user" && record.side === "user" && nonblank(record.prose)).length;
  const assistantTurns = representatives.filter((record) => record.kind === "assistant_dialogue_prose" && record.side === "assistant" && nonblank(record.prose)).length;
  db.prepare(
    `INSERT INTO construction_metrics(
      session_id,construction_generation,raw_provenance_row_count,logical_record_count,
      raw_tool_activity_count,logical_tool_activity_count,raw_prose_bearing_record_count,
      logical_prose_bearing_record_count,dialogue_turn_count,user_dialogue_turn_count,
      assistant_dialogue_turn_count,logical_replay_count,unknown_identity_raw_row_count,computed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
  ).run(
    sessionId,
    generation,
    input.records.length,
    representatives.length,
    rawToolCount,
    logicalToolCount,
    rawProse,
    logicalProse,
    userTurns + assistantTurns,
    userTurns,
    assistantTurns,
    input.records.length - representatives.length,
    input.records.length - [...byKey.values()].filter((members) => members.length > 1).reduce((sum, members) => sum + members.length, 0),
  );
  if (title !== null) {
    db.prepare(
      `INSERT INTO title_evidence(
        session_id,construction_generation,authority,harness_source_class,value,
        source_record_id,source_reference,source_ordinal,eligibility_rule_version,selected
      ) VALUES (?,?,'source_explicit','fixture-title',?,NULL,'fixture-title-reference',NULL,'fixture-title-v1',1)`,
    ).run(sessionId, generation, title);
  }
  if (input.favorite) {
    db.prepare(
      `INSERT INTO favorites(
        harness,native_id,span_text,span_hash,scope,status,created_at,updated_at
      ) VALUES (?,?,?,NULL,'session','ok',1,1)`,
    ).run(harness, input.nativeId, `Synthetic favorite ${input.nativeId}`);
  }
  if (input.tag) {
    db.prepare(`INSERT OR IGNORE INTO tags(name,promoted_at) VALUES (?,1)`).run(input.tag);
    db.prepare(
      `INSERT INTO session_tags(session_id,tag_id) SELECT ?,id FROM tags WHERE name=?`,
    ).run(sessionId, input.tag);
  }
  return { id: sessionId, nativeId: input.nativeId, logicalByKey, rawIds };
}

export function seedLayerE(): {
  db: Database;
  strong: SeededSession;
  recent: SeededSession;
  phraseNear: SeededSession;
  metadata: SeededSession;
  excluded: Record<string, string>;
} {
  const db = phase4Database();
  const strong = seedSyntheticSession(db, {
    nativeId: "fixture-strong",
    harness: "claude",
    title: "Synthetic strong title",
    lastActivity: 101,
    model: "fixture-model-a",
    project: "fixture-project-a",
    favorite: true,
    tag: "fixture-tag-a",
    records: [
      { kind: "real_user", side: "user", prose: "session-atlas session-atlas cost-effective C++ parentSession native_prime_child", logicalKey: "turn-user" },
      { kind: "real_user", side: "user", prose: "session-atlas session-atlas cost-effective C++ parentSession native_prime_child", logicalKey: "turn-user", replay: true },
      { kind: "assistant_dialogue_prose", side: "assistant", prose: "source logs messages_fts src/commands/search.ts fixture/root/session-atlas rlm-subagents.jsonl", logicalKey: "turn-assistant" },
    ],
  });
  const recent = seedSyntheticSession(db, {
    nativeId: "fixture-recent",
    harness: "codex",
    title: "Synthetic recent title",
    lastActivity: 303,
    model: "fixture-model-b",
    project: "fixture-project-b",
    sourceValidation: "snapshot_only",
    records: [
      { kind: "real_user", side: "user", prose: "session-atlas ordinary recent evidence" },
      { kind: "assistant_dialogue_prose", side: "assistant", prose: "secondary response" },
    ],
  });
  const phraseNear = seedSyntheticSession(db, {
    nativeId: "fixture-nonphrase",
    harness: "prime",
    title: "Synthetic nonphrase title",
    lastActivity: 202,
    records: [
      { kind: "real_user", side: "user", prose: "source detailed logs" },
    ],
  });
  const excluded = {
    control: "tokencontrolscope",
    developer: "tokendeveloperscope",
    telemetry: "tokentelemetryscope",
    tool: "tokentoolscope",
    utility: "tokenutilityscope",
    unclassified: "tokenunknownscope",
  };
  seedSyntheticSession(db, {
    nativeId: "fixture-eligibility",
    harness: "hermes",
    title: "Synthetic eligibility title",
    lastActivity: 151,
    records: [
      { kind: "real_user", side: "user", prose: "tokenuserprimary" },
      { kind: "assistant_dialogue_prose", side: "assistant", prose: "tokenassistantprimary" },
      { kind: "control_context", side: null, prose: excluded.control },
      { kind: "developer_system", side: null, prose: excluded.developer },
      { kind: "telemetry", side: null, prose: excluded.telemetry },
      { kind: "tool", side: null, prose: excluded.tool, tool: true },
      { kind: "automatic_utility", side: null, prose: excluded.utility },
      { kind: "unclassified", side: null, prose: excluded.unclassified },
    ],
  });
  const metadata = seedSyntheticSession(db, {
    nativeId: "fixture-metadata",
    harness: "kimi",
    title: "titleonlytoken",
    lastActivity: 111,
    visible: false,
    artifactKind: "metadata_shell",
    records: [],
  });
  seedSyntheticSession(db, {
    nativeId: "fixture-invalid",
    title: "Synthetic invalid title",
    status: "invalid",
    records: [{ kind: "real_user", side: "user", prose: "tokeninvalidscope" }],
  });
  seedSyntheticSession(db, {
    nativeId: "fixture-cpp-decoy",
    title: "Synthetic decoy title",
    records: [{ kind: "real_user", side: "user", prose: "C primer without punctuation" }],
  });
  seedSyntheticSession(db, {
    nativeId: "fixture-blank",
    title: "Synthetic blank title",
    records: [{ kind: "real_user", side: "user", prose: "\u2003\u00a0" }],
    visible: false,
  });
  applyV12SearchFragment(db);
  return { db, strong, recent, phraseNear, metadata, excluded };
}

function isDialogue(record: SyntheticRecord): boolean {
  return record.kind === "real_user" || record.kind === "assistant_dialogue_prose";
}

function nonblank(value: string | null): boolean {
  return value !== null && value.trim().length > 0;
}
