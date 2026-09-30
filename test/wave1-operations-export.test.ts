import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { openDb, type DB } from "../src/db/index.js";
import {
  compileExport,
  previewExport,
  renderLauncherCommand,
  resolveExportScope,
  writeExport,
} from "../src/export.js";
import { createFavorite } from "../src/favorites.js";
import { parseExportScope } from "../src/commands/export.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), "atlas-wave1-export-"));
  roots.push(root);
  return {
    root,
    config: {
      sources: {},
      providers: [],
      launchers: [{ name: "fable", cmd: 'clawd-fable "$(< {payload})"' }],
      tunables: {
        tag_promotion_count: 3,
        export_budget_tokens: 20_000,
        fav_default_span: 2,
        summary_stale_pct: 25,
        redact_entropy_threshold: 4.8,
      },
      dbPath: join(root, "atlas.db"),
    },
  };
}

function insertSession(db: DB, nativeId: string, at: number, chainId: number | null, summary: string): number {
  const inserted = db.prepare(
    `INSERT INTO sessions(
       harness,native_id,source_path,title,start_ts,last_activity,models,msg_count,chain_id,ingested_at
     ) VALUES ('claude',?,?,?,?,?,?,2,?,?)`,
  ).run(nativeId, `/source/${nativeId}`, `Topic ${nativeId}`, at, at, JSON.stringify([at < 2 ? "sonnet" : "opus"]), chainId, at);
  const id = Number(inserted.lastInsertRowid);
  db.prepare(`INSERT INTO messages(session_id,ordinal,role,text,tok_estimate) VALUES (?,?,?,?,?)`).run(
    id,
    0,
    "user",
    `verbatim user ${nativeId}`,
    4,
  );
  db.prepare(`INSERT INTO messages(session_id,ordinal,role,text,tok_estimate) VALUES (?,?,?,?,?)`).run(
    id,
    1,
    "assistant",
    `verbatim assistant ${nativeId}`,
    5,
  );
  db.prepare(
    `INSERT INTO summaries(session_id,tier,topic_line,body,msg_count_covered,model,generated_at)
     VALUES (?,2,?,?,2,'fixture',?)`,
  ).run(id, `Topic ${nativeId}`, summary, at);
  return id;
}

async function seeded(): Promise<{ db: DB; root: string; config: Config; first: number; second: number }> {
  const { root, config } = fixture();
  const db = await openDb(config.dbPath);
  const chain = db.prepare(`INSERT INTO chains(member_count,first_ts,last_ts,tok_total) VALUES (2,1,2,9)`).run();
  const chainId = Number(chain.lastInsertRowid);
  const long = (label: string) =>
    `${label} ${"first-detail ".repeat(220)}. ${label} ${"second-detail ".repeat(220)}. ` +
    `${label} ${"third-detail ".repeat(220)}.`;
  const first = insertSession(db, "old", 1, chainId, long("old"));
  const second = insertSession(db, "new", 2, chainId, long("new"));
  const tag = db.prepare(`INSERT INTO tags(name,promoted_at) VALUES ('astronomy',1)`).run();
  db.prepare(`INSERT INTO session_tags(session_id,tag_id) VALUES (?,?)`).run(first, Number(tag.lastInsertRowid));
  db.prepare(`INSERT INTO session_tags(session_id,tag_id) VALUES (?,?)`).run(second, Number(tag.lastInsertRowid));
  await createFavorite(db, { harness: "claude", nativeId: "old", fromOrdinal: 0, toOrdinal: 1, topic: "keep" });
  return { db, root, config, first, second };
}

test("Wave 1 operations — every export scope resolves chronologically with stable selection dedupe", async () => {
  const { db, first, second } = await seeded();
  const chainId = (db.prepare(`SELECT chain_id FROM sessions WHERE id=?`).get(first) as { chain_id: number }).chain_id;
  expect(resolveExportScope(db, { kind: "session", id: first }).sessions).toHaveLength(1);
  expect(resolveExportScope(db, { kind: "chain", id: chainId }).sessions.map((s) => s.nativeId)).toEqual(["old", "new"]);
  expect(resolveExportScope(db, { kind: "tag", name: "astronomy" }).sessions).toHaveLength(2);
  expect(resolveExportScope(db, { kind: "favorites" }).sessions.map((s) => s.nativeId)).toEqual(["old"]);
  expect(
    resolveExportScope(db, {
      kind: "selection",
      sessions: [
        { harness: "claude", nativeId: "new" },
        { harness: "claude", nativeId: "new" },
        { harness: "claude", nativeId: "old" },
      ],
    }).sessions.map((s) => s.nativeId),
  ).toEqual(["old", "new"]);
  expect(second).toBeGreaterThan(first);
  expect(parseExportScope(`selection:${first},${second}`, db)).toEqual({
    kind: "selection",
    sessions: [
      { harness: "claude", nativeId: "old" },
      { harness: "claude", nativeId: "new" },
    ],
  });
  db.close();
});

test("Wave 1 operations — preview is the exact pass-1 size and the four-pass ladder never truncates a favorite", async () => {
  const { db, config, first } = await seeded();
  const scope = { kind: "session", id: first } as const;
  const full = compileExport(db, config, scope, { budget: 100_000 });
  const preview = previewExport(db, config, scope, { budget: 100_000 });
  expect(preview.predictedTokens).toBe(full.finalTokens);
  expect(full.pass).toBe(1);

  let pass2: ReturnType<typeof compileExport> | null = null;
  for (let budget = preview.minimumTokens; budget < preview.predictedTokens; budget++) {
    try {
      const candidate = compileExport(db, config, scope, { budget });
      if (candidate.pass === 2) {
        pass2 = candidate;
        break;
      }
    } catch {}
  }
  expect(pass2?.pass).toBe(2);
  const exactFavorite = (db.prepare(`SELECT span_text FROM favorites`).get() as { span_text: string }).span_text;
  expect(pass2!.content).toContain(exactFavorite);
  expect(pass2!.content).toContain("## Model lineage");
  expect(pass2!.content).toContain("## Source pointers");

  expect(() => compileExport(db, config, scope, { budget: preview.minimumTokens - 1 })).toThrow(
    /exceeds budget by .*favorited and selected spans were not truncated/,
  );
  db.close();
});

test("Wave 1 operations — selected spans are immutable budget material just like favorites", async () => {
  const { db, config, second } = await seeded();
  const selectedText = "verbatim user new";
  const scope = { kind: "session", id: second } as const;
  const options = {
    budget: 100_000,
    selectedSpans: [
      { harness: "claude", nativeId: "new", fromOrdinal: 0, toOrdinal: 1 },
    ],
  };
  const compiled = compileExport(db, config, scope, options);
  expect(compiled.content).toContain(selectedText);
  const preview = previewExport(db, config, scope, options);
  expect(() => compileExport(db, config, scope, { ...options, budget: preview.minimumTokens - 1 })).toThrow(
    /selected spans were not truncated/,
  );
  db.close();
});

test("Wave 1 operations — pass 3 drops oldest summaries first and writes a private payload plus exact launcher", async () => {
  const { db, root, config, first } = await seeded();
  const chainId = (db.prepare(`SELECT chain_id FROM sessions WHERE id=?`).get(first) as { chain_id: number }).chain_id;
  const scope = { kind: "chain", id: chainId } as const;
  const preview = previewExport(db, config, scope, { budget: 100_000, launcher: "fable" });
  let pass3: ReturnType<typeof compileExport> | null = null;
  for (let budget = preview.minimumTokens; budget < preview.predictedTokens; budget++) {
    try {
      const candidate = compileExport(db, config, scope, { budget, launcher: "fable" });
      if (candidate.pass === 3) {
        pass3 = candidate;
        break;
      }
    } catch {}
  }
  expect(pass3?.pass).toBe(3);
  expect(pass3?.omittedSessions[0]).toContain("old");
  expect(pass3?.content).toContain("Summaries omitted oldest-first");

  const written = await writeExport(db, config, scope, {
    budget: 100_000,
    launcher: "fable",
    outputDir: join(root, "exports"),
    now: new Date("2026-07-19T12:00:00Z"),
  });
  expect(written.path).toEndWith("chain-1-20260719.md");
  expect(readFileSync(written.path, "utf8")).toBe(written.content);
  expect(written.launcherCommand).toBe(`clawd-fable "$(< ${written.path})"`);
  const secondWrite = await writeExport(db, config, scope, {
    budget: 100_000,
    outputDir: join(root, "exports"),
    now: new Date("2026-07-19T12:00:00Z"),
  });
  expect(secondWrite.path).toEndWith("chain-1-20260719-2.md");
  expect(renderLauncherCommand(config.launchers[0]!, "/tmp/path with space/payload.md")).toBe(
    `clawd-fable "$(< '/tmp/path with space/payload.md')"`,
  );
  db.close();
});
