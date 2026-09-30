import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { CapturedSession, Interpretation, Role } from "./contracts";
import { makePassage, hashText, keyToken } from "./passages";
import { LibraryStore } from "./store";
import { EvidenceStore } from "./evidence";
/** Recover every archived identity absent from raw recapture, with explicit cache provenance.
 * This never certifies compact cached rows as original raw harness evidence. */
export async function recoverLegacyCorpus(store: LibraryStore, snapshotPath: string, evidenceDir: string, progress?: (state: Record<string, number>) => void): Promise<{ recovered: number; alreadyCaptured: number; summaries: number }> {
  const db = new Database(snapshotPath, { readonly: true, strict: true }); const evidence = new EvidenceStore(evidenceDir);
  let recovered = 0, alreadyCaptured = 0, summaries = 0;
  try {
    const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name));
    const columns = new Set((db.query("PRAGMA table_info(messages)").all() as { name: string }[]).map(r => r.name));
    for (const s of db.query("SELECT * FROM sessions ORDER BY id").iterate() as Iterable<Record<string, unknown>>) {
      const key = { harness: String(s.harness), nativeId: String(s.native_id) };
      const active = store.db.query("SELECT o.data FROM library_active a JOIN library_observations o ON o.id=a.observation WHERE a.session_key=?").get(keyToken(key)) as { data: string } | null;
      if (store.session(key) && (!active || JSON.parse(active.data).format !== "legacy-index-projection")) alreadyCaptured++;
      else {
        const rows = db.query("SELECT * FROM messages WHERE session_id=? ORDER BY ordinal,id").all(Number(s.id)) as Record<string, unknown>[];
        const raw = Buffer.from(JSON.stringify({ kind: "legacy-index-projection", schema: "atlas-legacy", session: s, messages: rows }));
        const retained = evidence.retain("legacy-index-projection", `${snapshotPath}#session:${s.id}`, raw, "legacy-index-projection");
        const observationId = hashText(JSON.stringify(["legacy-index-projection-v2", key, retained.hash]));
        const passages = rows.flatMap((row, i) => {
          const role: Role = row.role === "user" || row.role === "assistant" || row.role === "tool" ? row.role : "system";
          const kind = String(row.record_kind ?? "legacy_unclassified");
          const text = columns.has("prose") && typeof row.prose === "string" ? row.prose : typeof row.text === "string" ? row.text : "";
          // Legacy-unverified rows remain recoverable as observed role-labelled text;
          // their classification/source completeness limitations stay explicit.
          const out = text ? [makePassage({ sessionKey: key, observationId, record: `legacy-row:${row.id}`, channel: "legacy-projection", text, role: kind !== "legacy_unclassified" && kind !== "unclassified" && !["real_user", "assistant_dialogue_prose"].includes(kind) ? "system" : role, ordinal: i * 3, timestamp: typeof row.ts === "number" ? row.ts : null })] : [];
          if (typeof row.tool_text === "string" && row.tool_text) out.push(makePassage({ sessionKey: key, observationId, record: `legacy-row:${row.id}`, channel: "legacy-tool-projection", text: row.tool_text, role: "tool", ordinal: i * 3 + 1, timestamp: typeof row.ts === "number" ? row.ts : null }));
          if (typeof row.text === "string" && row.text && row.text !== text && row.text !== row.tool_text) out.push(makePassage({sessionKey:key,observationId,record:`legacy-row:${row.id}`,channel:"legacy-raw-record",text:row.text,role:"system",ordinal:i * 3 + 2,timestamp:typeof row.ts === "number" ? row.ts : null}));
          return out;
        });
        const boundary = { observationId, bytes: raw.length, at: Date.now() };
        let models: string[] = []; try { models = JSON.parse(String(s.models ?? "[]")); } catch {}
        const capture: CapturedSession = { session: { key, revision: retained.hash, title: String(s.title ?? s.native_id), origin: s.origin === "agent" ? "worker" : s.origin === "human" ? "human_started" : s.origin === "mixed" ? "mixed" : "unknown", originReason: "Preserved legacy metadata; source evidence not independently recaptured", models, cwd: typeof s.cwd === "string" ? s.cwd : null, updatedAt: Number(s.last_activity ?? s.end_ts ?? s.start_ts ?? 0) }, observation: { id: observationId, sourceId: "legacy-index-projection", locator: `${snapshotPath}#session:${s.id}`, objectHash: retained.hash, retainedBoundary: boundary, indexedBoundary: boundary, summaryCoverage: null, lastCompleteReconciliation: null, format: "legacy-index-projection", gaps: ["Original harness source not recaptured for this identity; exact surviving index rows retained, not raw-source-complete", ...(s.source_validation_status === "legacy_unverified" ? ["Legacy construction/classification unverified"] : [])] }, passages };
        await store.publishBounded(capture); recovered++;
      }
      const current = store.session(key)!;
      if (tables.has("summaries") && !current.summary) {
        const summary = db.query("SELECT * FROM summaries WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(Number(s.id)) as Record<string, unknown> | null;
        if (summary) {
          const text = [summary.overview, summary.summary, summary.text, summary.body, summary.topic_line, summary.content, summary.topic].find(v => typeof v === "string") as string | undefined;
          const interpretation: Interpretation = { revision: `legacy:${snapshotPath}:${s.id}`, overview: text ?? JSON.stringify(summary), claims: [], episodes: [], coverage: { revision: `legacy:${s.id}`, covered: [], omitted: ["Historical summary; input coverage and claims not validated under new librarian contract"] }, model: String(summary.model ?? "legacy-unknown"), createdAt: Number(summary.generated_at ?? summary.created_at ?? 0), provenance: "legacy-coverage-unverified" };
          store.transaction(() => { const row = store.db.query("SELECT data FROM library_sessions WHERE key=?").get(keyToken(key)) as { data: string }; const data = JSON.parse(row.data); data.summary = interpretation; store.db.query("UPDATE library_sessions SET data=? WHERE key=?").run(JSON.stringify(data), keyToken(key)); }); summaries++;
        }
      }
      if ((recovered + alreadyCaptured) % 100 === 0) { progress?.({ recovered, alreadyCaptured, summaries }); await new Promise<void>(done => setImmediate(done)); }
    }
    return { recovered, alreadyCaptured, summaries };
  } finally { db.close(); }
}
