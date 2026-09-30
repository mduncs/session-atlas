/**
 * SQL for the creator lens. md's correction wins, then a decided evidence
 * verdict, then the model's verdict on the residue, then launch metadata for sessions no layer pass has seen yet.
 * Requires `layers` attached (see attachLayers); every archive open path does.
 */
/** "empty": no human or agent turn at all (opened and closed, or harness plumbing only). */
export type EffectiveCreator = "human" | "agent" | "unknown" | "empty";

export function effectiveCreatorSql(alias = "s"): string {
  return `COALESCE(
    (SELECT cc.started_by FROM layers.creator_corrections cc WHERE cc.harness=${alias}.harness AND cc.native_id=${alias}.native_id),
    (SELECT CASE WHEN sc.started_by<>'unknown' THEN sc.started_by ELSE COALESCE(
        (SELECT cm.started_by FROM layers.creator_model cm WHERE cm.harness=sc.harness AND cm.native_id=sc.native_id AND cm.started_by<>'unknown'),
        CASE WHEN sc.human_turns+sc.agent_turns=0 THEN 'empty' ELSE 'unknown' END) END
       FROM layers.session_creator sc WHERE sc.harness=${alias}.harness AND sc.native_id=${alias}.native_id),
    CASE ${alias}.origin WHEN 'agent' THEN 'agent' WHEN 'human' THEN 'human' ELSE 'unknown' END
  )`;
}

/** Joinable creator rows exposing decision/confidence/reason/method as `hc`. */
export function creatorJoinSql(alias = "s", as = "hc"): string {
  return `LEFT JOIN (
    SELECT sc.harness, sc.native_id,
           COALESCE(cc.started_by, CASE WHEN sc.started_by='unknown' AND cm.started_by<>'unknown' THEN cm.started_by END,
             CASE WHEN sc.started_by='unknown' AND sc.human_turns+sc.agent_turns=0 THEN 'empty' END, sc.started_by) AS decision,
           CASE WHEN cc.started_by IS NOT NULL THEN 1.0 WHEN sc.started_by='unknown' AND cm.started_by<>'unknown' THEN 0.7 ELSE sc.confidence END AS confidence,
           CASE WHEN cc.started_by IS NOT NULL THEN 'corrected by hand' WHEN sc.started_by='unknown' AND cm.started_by<>'unknown' THEN cm.reason ELSE sc.evidence END AS reason,
           CASE WHEN cc.started_by IS NOT NULL THEN 'correction' WHEN sc.started_by='unknown' AND cm.started_by<>'unknown' THEN 'model:' || cm.model ELSE 'evidence-v' || sc.rule_version END AS method
    FROM layers.session_creator sc
    LEFT JOIN layers.creator_corrections cc ON cc.harness=sc.harness AND cc.native_id=sc.native_id
    LEFT JOIN layers.creator_model cm ON cm.harness=sc.harness AND cm.native_id=sc.native_id
  ) ${as} ON ${as}.harness=${alias}.harness AND ${as}.native_id=${alias}.native_id`;
}

/** Exact lens: unknowns have their own "? unsure" filter, so they never pad the human view. */
export function creatorFilterSql(decision: EffectiveCreator, alias = "s"): string {
  return `${effectiveCreatorSql(alias)} = '${decision}'`;
}
