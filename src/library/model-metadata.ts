import { readCodexModelHistory } from "../adapters/codex.js";
import type { LibrarySession, SourceObservation } from "./contracts.js";
import { EvidenceStore } from "./evidence.js";
import { LibraryStore } from "./store.js";
/** Upgrade metadata without re-publishing passages or changing exact source references.
 * Models mean observed history, including inherited fork history; never inferred current model. */
export async function refreshCodexModelMetadata(store: LibraryStore, evidenceDirectory: string, progress?: (state: { updated: number; unchanged: number; total: number }) => void): Promise<{ updated: number; unchanged: number; total: number }> {
  const evidence = new EvidenceStore(evidenceDirectory);
  const rows = store.db.query("SELECT s.key,o.data observation FROM library_sessions s JOIN library_active a ON a.session_key=s.key JOIN library_observations o ON o.id=a.observation WHERE json_extract(s.data,'$.key.harness')='codex' ORDER BY s.key").all() as { key: string; observation: string }[];
  let updated = 0; let unchanged = 0;
  for (const row of rows) {
    const observation = JSON.parse(row.observation) as SourceObservation;
    const stateKey = `codex-model-history-v1:${row.key}:${observation.id}`;
    if (observation.format === "legacy-index-projection" || store.getState(stateKey)) { unchanged++; continue; }
    const snapshot = evidence.temporarySnapshot(evidence.read(observation.objectHash));
    let models: string[];
    try { models = readCodexModelHistory(snapshot.path); } finally { snapshot.dispose(); }
    store.transaction(() => {
      const active = store.db.query("SELECT observation FROM library_active WHERE session_key=?").get(row.key) as { observation: string } | null;
      if (active?.observation !== observation.id) throw new Error("Source revision changed during metadata refresh; retry against the current observation");
      const current = store.db.query("SELECT data FROM library_sessions WHERE key=?").get(row.key) as { data: string };
      const session = JSON.parse(current.data) as LibrarySession;
      store.db.query("UPDATE library_sessions SET data=? WHERE key=?").run(JSON.stringify({ ...session, models }), row.key);
      store.setState(stateKey, { version: 1, observationId: observation.id, models, provenance: "Recorded session_meta/turn_context model history, including inherited fork history; current model not inferred" });
    });
    updated++;
    if ((updated + unchanged) % 50 === 0) progress?.({ updated, unchanged, total: rows.length });
    await new Promise<void>(done => setImmediate(done));
  }
  return { updated, unchanged, total: rows.length };
}
