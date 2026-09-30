/**
 * Committed fixture catalog seam. It contains synthetic contract metadata
 * only: no corpus id, absolute path, source hash, prose, payload, timestamp,
 * or reverse map. Private provenance lives outside the repository.
 */

export const FIXTURE_CATALOG_VERSION = "contract-v1-f01-f62";
export const FIXTURE_METRIC_ORDER = [
  "raw_provenance_row_count",
  "logical_record_count",
  "raw_tool_activity_count",
  "logical_tool_activity_count",
  "raw_prose_bearing_record_count",
  "logical_prose_bearing_record_count",
  "dialogue_turn_count",
  "user_dialogue_turn_count",
  "assistant_dialogue_turn_count",
  "logical_replay_count",
] as const;

export type FixtureId = `F${number}`;
export type ContractInvariant = `I${number}`;
export type FixtureMetricVector = readonly [number,number,number,number,number,number,number,number,number,number];
export type FixtureLayer = "adapter" | "semantic" | "migration" | "pipeline" | "search-seed" | "durable-state";

export interface FixtureExpectedState {
  metrics: FixtureMetricVector;
  unknownIdentityRawRowCount: number;
}

export interface FixtureCatalogEntry {
  id: FixtureId;
  title: string;
  harness: string;
  invariants: readonly ContractInvariant[];
  expectedStates: readonly FixtureExpectedState[];
  /** Correlates to the private manifest without revealing its selector. */
  opaqueProvenanceToken: `P-${FixtureId}`;
  /** F04 is the construction contract's construction-time gate. */
  preBuildPrivateBindingRequired: boolean;
}

export const FIXTURE_CATALOG = [
  { id: "F01", title: "ordinary Claude evidence-class baseline (I01, I03)", harness: "Claude Code", invariants: ["I01", "I03"], expectedStates: [{ metrics: [4,4,2,2,3,3,3,1,2,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F01", preBuildPrivateBindingRequired: false },
  { id: "F02", title: "local-command caveat, command control, then real request (I01, I02, I04)", harness: "Claude Code", invariants: ["I01", "I02", "I04"], expectedStates: [{ metrics: [4,4,0,0,4,4,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F02", preBuildPrivateBindingRequired: false },
  { id: "F03", title: "metadata-only Claude `ai-title` envelope (I02, I04)", harness: "Claude Code", invariants: ["I02", "I04"], expectedStates: [{ metrics: [0,0,0,0,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F03", preBuildPrivateBindingRequired: false },
  { id: "F04", title: "Claude custom/ai/title tie and Atlas-override precedence (I02)", harness: "Claude Code", invariants: ["I02"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [10,10,0,0,10,10,10,5,5,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F04", preBuildPrivateBindingRequired: true },
  { id: "F05", title: "Claude tool-role boundary (I01, I03)", harness: "Claude Code", invariants: ["I01", "I03"], expectedStates: [{ metrics: [4,4,3,3,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F05", preBuildPrivateBindingRequired: false },
  { id: "F06", title: "auxiliary workflow journal (I04)", harness: "Claude Code", invariants: ["I04"], expectedStates: [{ metrics: [0,0,0,0,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F06", preBuildPrivateBindingRequired: false },
  { id: "F07", title: "byte-empty Claude candidate (I04)", harness: "Claude Code", invariants: ["I04"], expectedStates: [{ metrics: [0,0,0,0,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F07", preBuildPrivateBindingRequired: false },
  { id: "F08", title: "nonempty metadata-only Claude shells (I04)", harness: "Claude Code", invariants: ["I04"], expectedStates: [{ metrics: [0,0,0,0,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F08", preBuildPrivateBindingRequired: false },
  { id: "F09", title: "automatic compact-summary prompt and linked response (I01, I02, I04)", harness: "Claude Code", invariants: ["I01", "I02", "I04"], expectedStates: [{ metrics: [2,2,0,0,2,2,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F09", preBuildPrivateBindingRequired: false },
  { id: "F10", title: "suggestion and interrupted-control family (I01, I02, I04)", harness: "Claude Code", invariants: ["I01", "I02", "I04"], expectedStates: [{ metrics: [1,1,0,0,1,1,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [2,2,0,0,2,2,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [3,3,0,0,3,3,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F10", preBuildPrivateBindingRequired: false },
  { id: "F11", title: "`Warmup` evidence-bound adversarial cases (I04)", harness: "Claude Code", invariants: ["I04"], expectedStates: [{ metrics: [1,1,0,0,1,1,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [3,3,1,1,2,2,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [6,6,1,1,5,5,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F11", preBuildPrivateBindingRequired: false },
  { id: "F12", title: "one-sided and title-ineligible Claude rows (I01, I02, I04)", harness: "Claude Code", invariants: ["I01", "I02", "I04"], expectedStates: [{ metrics: [1,1,0,0,1,1,1,1,0,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [1,1,0,0,1,1,1,0,1,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [1,1,1,1,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [3,3,1,1,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F12", preBuildPrivateBindingRequired: false },
  { id: "F13", title: "legacy rollout, response-item authority, fallback title (I01, I02, I06)", harness: "Codex", invariants: ["I01", "I02", "I06"], expectedStates: [{ metrics: [4,4,2,2,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F13", preBuildPrivateBindingRequired: false },
  { id: "F14", title: "legacy `thread_name` authority (I02)", harness: "Codex", invariants: ["I02"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F14", preBuildPrivateBindingRequired: false },
  { id: "F15", title: "Codex 0.147.0 newest control/context case (I01, I02, I06)", harness: "Codex", invariants: ["I01", "I02", "I06"], expectedStates: [{ metrics: [7,7,0,0,5,5,1,1,0,0] as const, unknownIdentityRawRowCount: 2 }], opaqueProvenanceToken: "P-F15", preBuildPrivateBindingRequired: false },
  { id: "F16", title: "Codex 0.147.0 assistant/item/tool duplication case (I01, I03, I06)", harness: "Codex", invariants: ["I01", "I03", "I06"], expectedStates: [{ metrics: [26,26,10,10,8,8,3,1,2,0] as const, unknownIdentityRawRowCount: 2 }], opaqueProvenanceToken: "P-F16", preBuildPrivateBindingRequired: false },
  { id: "F17", title: "0.147.0 `session_meta`-only empty (I04, I06)", harness: "Codex", invariants: ["I04", "I06"], expectedStates: [{ metrics: [0,0,0,0,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F17", preBuildPrivateBindingRequired: false },
  { id: "F18", title: "legacy metadata plus `task_started` empty (I04)", harness: "Codex", invariants: ["I04"], expectedStates: [{ metrics: [0,0,0,0,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F18", preBuildPrivateBindingRequired: false },
  { id: "F19", title: "current-format controls with no real-user evidence (I01, I02, I06)", harness: "Codex", invariants: ["I01", "I02", "I06"], expectedStates: [{ metrics: [3,3,0,0,3,3,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F19", preBuildPrivateBindingRequired: false },
  { id: "F20", title: "tool-saturated/user-only Codex (I03, I04)", harness: "Codex", invariants: ["I03", "I04"], expectedStates: [{ metrics: [10,10,9,9,1,1,1,1,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F20", preBuildPrivateBindingRequired: false },
  { id: "F21", title: "embedded identity beats filename (I10)", harness: "Prime Agent", invariants: ["I10"], expectedStates: [{ metrics: [1,1,0,0,1,1,1,1,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F21", preBuildPrivateBindingRequired: false },
  { id: "F22", title: "official Prime RLM child lineage (I10)", harness: "Prime Agent", invariants: ["I10"], expectedStates: [{ metrics: [0,0,0,0,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F22", preBuildPrivateBindingRequired: false },
  { id: "F23", title: "nonofficial/external supervision is not Prime RLM lineage (I10)", harness: "Prime Agent", invariants: ["I10"], expectedStates: [{ metrics: [0,0,0,0,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F23", preBuildPrivateBindingRequired: false },
  { id: "F24", title: "`agent_status` telemetry pollution regression (I01, I03, I08)", harness: "Prime Agent", invariants: ["I01", "I03", "I08"], expectedStates: [{ metrics: [4,4,0,0,4,4,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F24", preBuildPrivateBindingRequired: false },
  { id: "F25", title: "Prime tool-only and prose+tool boundary (I01, I03, I08)", harness: "Prime Agent", invariants: ["I01", "I03", "I08"], expectedStates: [{ metrics: [4,4,3,3,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F25", preBuildPrivateBindingRequired: false },
  { id: "F26", title: "Prime inbound versus outbound `custom_message` (I01, I08)", harness: "Prime Agent", invariants: ["I01", "I08"], expectedStates: [{ metrics: [4,4,0,0,4,4,3,2,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F26", preBuildPrivateBindingRequired: false },
  { id: "F27", title: "Prime metadata-only stub (I04, I08)", harness: "Prime Agent", invariants: ["I04", "I08"], expectedStates: [{ metrics: [2,2,0,0,2,2,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F27", preBuildPrivateBindingRequired: false },
  { id: "F28", title: "Prime backward and missing inner timestamps (I09)", harness: "Prime Agent", invariants: ["I09"], expectedStates: [{ metrics: [3,3,0,0,3,3,2,1,1,0] as const, unknownIdentityRawRowCount: 1 }], opaqueProvenanceToken: "P-F28", preBuildPrivateBindingRequired: false },
  { id: "F29", title: "Hermes SQLite first-real-user fallback (I02)", harness: "Hermes", invariants: ["I02"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F29", preBuildPrivateBindingRequired: false },
  { id: "F30", title: "Hermes source-native user-only session (I04)", harness: "Hermes", invariants: ["I04"], expectedStates: [{ metrics: [1,1,0,0,1,1,1,1,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F30", preBuildPrivateBindingRequired: false },
  { id: "F31", title: "zero-byte Kimi context (I04, I09)", harness: "Kimi", invariants: ["I04", "I09"], expectedStates: [{ metrics: [0,0,0,0,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F31", preBuildPrivateBindingRequired: false },
  { id: "F32", title: "Kimi system/checkpoint/usage/tool-only current context (I01, I04, I09)", harness: "Kimi", invariants: ["I01", "I04", "I09"], expectedStates: [{ metrics: [4,4,1,1,1,1,0,0,0,0] as const, unknownIdentityRawRowCount: 4 }], opaqueProvenanceToken: "P-F32", preBuildPrivateBindingRequired: false },
  { id: "F33", title: "Kimi timestamp-free dialogue (I09)", harness: "Kimi", invariants: ["I09"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 2 }], opaqueProvenanceToken: "P-F33", preBuildPrivateBindingRequired: false },
  { id: "F34", title: "Kimi `state.json.custom_title` precedence (I02)", harness: "Kimi", invariants: ["I02"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 2 }], opaqueProvenanceToken: "P-F34", preBuildPrivateBindingRequired: false },
  { id: "F35", title: "Kimi subagent lineage and checkpoint (I10)", harness: "Kimi", invariants: ["I10"], expectedStates: [{ metrics: [0,0,0,0,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [3,3,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 3 }], opaqueProvenanceToken: "P-F35", preBuildPrivateBindingRequired: false },
  { id: "F36", title: "Kimi durable-history/auxiliary-name boundary (I04, I11)", harness: "Kimi", invariants: ["I04", "I11"], expectedStates: [{ metrics: [1,1,0,0,1,1,0,0,0,0] as const, unknownIdentityRawRowCount: 1 }], opaqueProvenanceToken: "P-F36", preBuildPrivateBindingRequired: false },
  { id: "F37", title: "divergent DB/external duplicate election (I03, I10)", harness: "ZCode", invariants: ["I03", "I10"], expectedStates: [{ metrics: [4,4,0,0,4,4,4,1,3,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F37", preBuildPrivateBindingRequired: false },
  { id: "F38", title: "unresolved external-parent edge with reachable source (I10)", harness: "ZCode", invariants: ["I10"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F38", preBuildPrivateBindingRequired: false },
  { id: "F39", title: "stale-path ZCode user-only revalidation (I04, I11)", harness: "ZCode", invariants: ["I04", "I11"], expectedStates: [{ metrics: [1,1,0,0,1,1,1,1,0,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [2,2,0,0,2,2,2,2,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F39", preBuildPrivateBindingRequired: false },
  { id: "F40", title: "complete six-identity ZCode election family (I05, I12)", harness: "ZCode", invariants: ["I05", "I12"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [12,12,0,0,12,12,12,6,6,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F40", preBuildPrivateBindingRequired: false },
  { id: "F41", title: "generic `tool` part on a tool-only source message (I01, I03, I07)", harness: "Kilo", invariants: ["I01", "I03", "I07"], expectedStates: [{ metrics: [1,1,1,1,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F41", preBuildPrivateBindingRequired: false },
  { id: "F42", title: "generic `tool` coexisting with prose (I03, I07)", harness: "Kilo", invariants: ["I03", "I07"], expectedStates: [{ metrics: [1,1,1,1,1,1,1,0,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F42", preBuildPrivateBindingRequired: false },
  { id: "F43", title: "content-bearing generic placeholder title (I02, I07)", harness: "Kilo", invariants: ["I02", "I07"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F43", preBuildPrivateBindingRequired: false },
  { id: "F44", title: "Kilo placeholder empty shell (I02, I04)", harness: "Kilo", invariants: ["I02", "I04"], expectedStates: [{ metrics: [0,0,0,0,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F44", preBuildPrivateBindingRequired: false },
  { id: "F45", title: "exact 49 reasoning/control-only unknown rows (I01, I04, I07)", harness: "Kilo", invariants: ["I01", "I04", "I07"], expectedStates: [{ metrics: [49,49,0,0,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F45", preBuildPrivateBindingRequired: false },
  { id: "F46", title: "apparent Kilo user-only with generic-tool assistant activity (I03, I07)", harness: "Kilo", invariants: ["I03", "I07"], expectedStates: [{ metrics: [2,2,1,1,1,1,1,1,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F46", preBuildPrivateBindingRequired: false },
  { id: "F47", title: "Kilo resolved parent lineage (I10)", harness: "Kilo", invariants: ["I10"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [4,4,0,0,4,4,4,2,2,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F47", preBuildPrivateBindingRequired: false },
  { id: "F48", title: "Kilo multi-root exact-tie bookkeeping (I05, I11)", harness: "Kilo", invariants: ["I05", "I11"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [4,4,0,0,4,4,4,2,2,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F48", preBuildPrivateBindingRequired: false },
  { id: "F49", title: "missing `logical_metrics` (I05)", harness: "Claude + Codex derived state", invariants: ["I05"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [4,4,0,0,4,4,4,2,2,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F49", preBuildPrivateBindingRequired: false },
  { id: "F50", title: "metrics present, logical projection absent (I05)", harness: "Claude + Codex derived state", invariants: ["I05"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [4,4,0,0,4,4,4,2,2,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F50", preBuildPrivateBindingRequired: false },
  { id: "F51", title: "impossible dirty-v10 raw_msg_count>logical_msg_count, zero replay, no projection (I05)", harness: "Claude + Codex derived state", invariants: ["I05"], expectedStates: [{ metrics: [3,3,0,0,3,3,3,1,2,0] as const, unknownIdentityRawRowCount: 3 }], opaqueProvenanceToken: "P-F51", preBuildPrivateBindingRequired: false },
  { id: "F52", title: "valid identity-and-timestamp replay collapse (I05)", harness: "shared replay state", invariants: ["I05"], expectedStates: [{ metrics: [3,2,0,0,3,2,2,1,1,1] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F52", preBuildPrivateBindingRequired: false },
  { id: "F53", title: "same identity with different/missing timestamp does not collapse (I05)", harness: "shared replay state", invariants: ["I05"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,2,0,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [2,2,0,0,2,2,2,2,0,0] as const, unknownIdentityRawRowCount: 2 }, { metrics: [4,4,0,0,4,4,4,4,0,0] as const, unknownIdentityRawRowCount: 2 }], opaqueProvenanceToken: "P-F53", preBuildPrivateBindingRequired: false },
  { id: "F54", title: "dirty pre-release v9 election state (I05)", harness: "shared schema/election state", invariants: ["I05"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [4,4,0,0,4,4,4,2,2,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F54", preBuildPrivateBindingRequired: false },
  { id: "F55", title: "ZCode resolved-root failure and canonical survivor recovery (I10, I11)", harness: "ZCode completeness/election", invariants: ["I10", "I11"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [4,4,0,0,4,4,4,2,2,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F55", preBuildPrivateBindingRequired: false },
  { id: "F56", title: "absent block resolves builtin; disablement is explicit (I11)", harness: "seven-source configuration", invariants: ["I11"], expectedStates: [{ metrics: [1,1,0,0,1,1,1,1,0,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [4,4,0,0,4,4,4,4,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F56", preBuildPrivateBindingRequired: false },
  { id: "F57", title: "transaction failure between raw and derived projection (I05)", harness: "shared construction atomicity", invariants: ["I05"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [3,3,0,0,3,3,3,1,2,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F57", preBuildPrivateBindingRequired: false },
  { id: "F58", title: "continuity evidence with missing projection (I05, I09)", harness: "Claude + Prime + Kimi continuity", invariants: ["I05", "I09"], expectedStates: [{ metrics: [3,3,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [3,3,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 3 }, { metrics: [9,9,0,0,6,6,6,3,3,0] as const, unknownIdentityRawRowCount: 3 }], opaqueProvenanceToken: "P-F58", preBuildPrivateBindingRequired: false },
  { id: "F59", title: "omitted builtin sources have newer local identities (I04, I11, I12)", harness: "Prime + Hermes + Kimi catalog discovery", invariants: ["I04", "I11", "I12"], expectedStates: [{ metrics: [1,1,0,0,1,1,1,1,0,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [1,1,0,0,1,1,1,1,0,0] as const, unknownIdentityRawRowCount: 1 }, { metrics: [6,6,0,0,6,6,6,6,0,0] as const, unknownIdentityRawRowCount: 2 }], opaqueProvenanceToken: "P-F59", preBuildPrivateBindingRequired: false },
  { id: "F60", title: "live Kilo builtin extended by canonical retained DB (I04, I05, I11)", harness: "Kilo", invariants: ["I04", "I05", "I11"], expectedStates: [{ metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [0,0,0,0,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F60", preBuildPrivateBindingRequired: false },
  { id: "F61", title: "Claude project-path alias canonicalization without session merge (I05, I10, I12)", harness: "Claude Code", invariants: ["I05", "I10", "I12"], expectedStates: [{ metrics: [1,1,0,0,1,1,1,1,0,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [8,8,0,0,8,8,8,8,0,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F61", preBuildPrivateBindingRequired: false },
  { id: "F62", title: "Prime child admission precedes embedded-ID election (I04, I10, I11, I12)", harness: "Prime Agent", invariants: ["I04", "I10", "I11", "I12"], expectedStates: [{ metrics: [0,0,0,0,0,0,0,0,0,0] as const, unknownIdentityRawRowCount: 0 }, { metrics: [2,2,0,0,2,2,2,1,1,0] as const, unknownIdentityRawRowCount: 0 }], opaqueProvenanceToken: "P-F62", preBuildPrivateBindingRequired: false },
] as const satisfies readonly FixtureCatalogEntry[];

const ADAPTER_IDS = new Set([
  ...range(1,48), "F55", "F56", ...range(59,62),
]);
const MIGRATION_IDS = new Set(["F49","F50","F51","F54","F57","F58"]);
const PIPELINE_IDS = new Set(["F37","F40",...range(48,62)]);

export function fixtureLayers(id: FixtureId): readonly FixtureLayer[] {
  const layers: FixtureLayer[] = ["semantic"];
  if (ADAPTER_IDS.has(id)) layers.push("adapter");
  if (MIGRATION_IDS.has(id)) layers.push("migration");
  if (PIPELINE_IDS.has(id)) layers.push("pipeline");
  // Search and durable-state layers use the catalog as seed vocabulary; their
  // exact cross-fixture compositions are owned by Phase 4 and Phase 3C.
  return layers;
}

export function assertFixtureCatalog(): void {
  if (FIXTURE_CATALOG.length !== 62) throw new Error("fixture catalog must contain F01-F62");
  const seen = new Set<string>();
  for (let index=0; index<FIXTURE_CATALOG.length; index++) {
    const entry = FIXTURE_CATALOG[index]!;
    const expected = `F${String(index+1).padStart(2,"0")}`;
    if (entry.id !== expected || seen.has(entry.id)) throw new Error(`fixture catalog discontinuity at ${expected}`);
    seen.add(entry.id);
    const expectedStates: readonly FixtureExpectedState[] = entry.expectedStates;
    if (expectedStates.length === 0) throw new Error(`${entry.id} has no expected construction state`);
    for (const state of expectedStates) assertFixtureState(entry.id,state);
  }
  const f04 = FIXTURE_CATALOG.find((entry) => entry.id === "F04");
  if (!f04?.preBuildPrivateBindingRequired) throw new Error("F04 private binding gate is missing");
}

function assertFixtureState(id: FixtureId,state: FixtureExpectedState): void {
  const [R,L,RT,LT,RP,LP,D,U,A,Q] = state.metrics;
  const X = state.unknownIdentityRawRowCount;
  if (![R,L,RT,LT,RP,LP,D,U,A,Q,X].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error(`${id} has a negative or non-integer fixture metric`);
  }
  if (Q!==R-L || D!==U+A || !(D<=LP && LP<=L && L<=R) || RP>R || RT<LT || RP<LP) {
    throw new Error(`${id} violates fixture metric algebra`);
  }
}

function range(from: number,to: number): FixtureId[] {
  return Array.from({length:to-from+1},(_,index) => `F${String(from+index).padStart(2,"0")}` as FixtureId);
}
