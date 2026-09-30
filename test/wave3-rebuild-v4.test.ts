import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { openDb, type DB } from "../src/db/index.js";
import { rebuildDatabase } from "../src/rebuild.js";
import { listTagMergeLog, undoTagMerge } from "../src/tag-intelligence.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(name: string): { dbPath: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), `atlas-wave3-${name}-`));
  roots.push(root);
  const dbPath = join(root, "atlas.db");
  return {
    dbPath,
    config: {
      sources: {},
      providers: [],
      launchers: [],
      tunables: {
        tag_promotion_count: 3,
        export_budget_tokens: 20_000,
        fav_default_span: 6,
        summary_stale_pct: 25,
        redact_entropy_threshold: 4.8,
      },
      dbPath,
    },
  };
}

function insertSession(db: DB, nativeId: string): number {
  const result = db.prepare(
    `INSERT INTO sessions(harness,native_id,source_path,last_activity,msg_count,ingested_at)
     VALUES ('claude',?, ?,100,1,100)`,
  ).run(nativeId, `/fixture/${nativeId}`);
  const id = Number(result.lastInsertRowid);
  db.prepare(
    `INSERT INTO messages(session_id,ordinal,role,text,tok_estimate) VALUES (?,0,'user',?,1)`,
  ).run(id, `message for ${nativeId}`);
  return id;
}

async function buildRemappedSessions(db: DB): Promise<void> {
  insertSession(db, "id-shifter");
  insertSession(db, "astronomy-session");
  insertSession(db, "cosmology-session");
}

test("Wave 3 rebuild v4 — normal rebuild preserves synthesis provenance with remapped session ids", async () => {
  const { dbPath, config } = fixture("synthesis");
  const source = await openDb(dbPath);
  const oldSessionId = insertSession(source, "astronomy-session");
  const tagId = Number(source.prepare(`INSERT INTO tags(name,promoted_at) VALUES ('astronomy',44)`).run().lastInsertRowid);
  source.prepare(`INSERT INTO session_tags(session_id,tag_id) VALUES (?,?)`).run(oldSessionId, tagId);
  source.prepare(
    `INSERT INTO tag_syntheses(tag_id,body,model,provider,citations,session_ids,generated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    tagId,
    "A cited longitudinal arc.",
    "fixture-model",
    "fixture-provider",
    JSON.stringify([{ sessionId: oldSessionId, ordinal: 0 }]),
    JSON.stringify([oldSessionId]),
    123456,
  );
  source.close();

  await rebuildDatabase(config, { buildShadow: async (shadow) => buildRemappedSessions(shadow) });

  const rebuilt = await openDb(dbPath);
  const newSessionId = (rebuilt.prepare(
    `SELECT id FROM sessions WHERE harness='claude' AND native_id='astronomy-session'`,
  ).get() as { id: number }).id;
  expect(newSessionId).not.toBe(oldSessionId);
  const synthesis = rebuilt.prepare(
    `SELECT t.name,ts.body,ts.model,ts.provider,ts.citations,ts.session_ids,ts.generated_at
     FROM tag_syntheses ts JOIN tags t ON t.id=ts.tag_id`,
  ).get() as Record<string, unknown>;
  expect(synthesis).toMatchObject({
    name: "astronomy",
    body: "A cited longitudinal arc.",
    model: "fixture-model",
    provider: "fixture-provider",
    generated_at: 123456,
  });
  expect(JSON.parse(String(synthesis.citations))).toEqual([{ sessionId: newSessionId, ordinal: 0 }]);
  expect(JSON.parse(String(synthesis.session_ids))).toEqual([newSessionId]);
  rebuilt.close();
});

for (const hard of [false, true]) {
  test(`Wave 3 rebuild v4 — ${hard ? "hard" : "normal"} rebuild preserves merge log and exact undo`, async () => {
    const { dbPath, config } = fixture(hard ? "hard-undo" : "normal-undo");
    const source = await openDb(dbPath);
    const astronomySession = insertSession(source, "astronomy-session");
    const cosmologySession = insertSession(source, "cosmology-session");
    const astronomy = Number(source.prepare(`INSERT INTO tags(name,promoted_at) VALUES ('astronomy',11)`).run().lastInsertRowid);
    const cosmology = Number(source.prepare(`INSERT INTO tags(name,promoted_at) VALUES ('cosmology',22)`).run().lastInsertRowid);
    source.prepare(`INSERT INTO session_tags(session_id,tag_id) VALUES (?,?)`).run(astronomySession, astronomy);
    source.prepare(`INSERT INTO session_tags(session_id,tag_id) VALUES (?,?)`).run(cosmologySession, cosmology);
    source.prepare(`INSERT INTO tag_candidates(name,session_id) VALUES ('astronomy',?)`).run(astronomySession);
    source.prepare(`INSERT INTO tag_candidates(name,session_id) VALUES ('cosmology',?)`).run(cosmologySession);

    const snapshot = {
      target: { name: "astronomy", promotedAt: 11, sessions: [astronomySession], candidates: [astronomySession] },
      sources: [{ name: "cosmology", promotedAt: 22, sessions: [cosmologySession], candidates: [cosmologySession] }],
    };
    source.prepare(
      `INSERT INTO tag_merge_events(target_name,source_names,snapshot,model,provider,created_at)
       VALUES ('astronomy','["cosmology"]',?,'merge-model','merge-provider',777)`,
    ).run(JSON.stringify(snapshot));
    // Materialize the post-merge state whose exact inverse is captured above.
    source.prepare(`INSERT INTO session_tags(session_id,tag_id) VALUES (?,?)`).run(cosmologySession, astronomy);
    source.prepare(`INSERT INTO tag_candidates(name,session_id) VALUES ('astronomy',?)`).run(cosmologySession);
    source.prepare(`DELETE FROM tag_candidates WHERE name='cosmology'`).run();
    source.prepare(`DELETE FROM tags WHERE id=?`).run(cosmology);
    source.close();

    await rebuildDatabase(config, { hard, buildShadow: async (shadow) => buildRemappedSessions(shadow) });

    const rebuilt = await openDb(dbPath);
    const log = listTagMergeLog(rebuilt);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      id: 1,
      target: "astronomy",
      sources: ["cosmology"],
      model: "merge-model",
      provider: "merge-provider",
      createdAt: 777,
      revertedAt: null,
    });
    expect(undoTagMerge(rebuilt, log[0]!.id)).toBe(true);

    const links = rebuilt.prepare(
      `SELECT t.name,s.native_id
       FROM session_tags st
       JOIN tags t ON t.id=st.tag_id
       JOIN sessions s ON s.id=st.session_id
       WHERE t.name IN ('astronomy','cosmology')
       ORDER BY t.name,s.native_id`,
    ).all();
    expect(links).toEqual([
      { name: "astronomy", native_id: "astronomy-session" },
      { name: "cosmology", native_id: "cosmology-session" },
    ]);
    const candidates = rebuilt.prepare(
      `SELECT tc.name,s.native_id FROM tag_candidates tc
       JOIN sessions s ON s.id=tc.session_id
       WHERE tc.name IN ('astronomy','cosmology') ORDER BY tc.name,s.native_id`,
    ).all();
    expect(candidates).toEqual([
      { name: "astronomy", native_id: "astronomy-session" },
      { name: "cosmology", native_id: "cosmology-session" },
    ]);
    expect(listTagMergeLog(rebuilt)[0]?.revertedAt).not.toBeNull();
    rebuilt.close();
  });
}
