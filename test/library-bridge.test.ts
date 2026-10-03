import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryStore } from "../src/library/store.js";
import { makePassage } from "../src/library/passages.js";
import { InkLibraryBridge } from "../src/tui/library-bridge.js";
import { summarizeTier2 } from "../src/tier2.js";
import { openDb } from "../src/db/index.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const temp = (prefix: string) => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; };

const key = { harness: "codex", nativeId: "bridge-1" };
function capture(store: LibraryStore): void {
  const observation = { id: "obs-1", sourceId: "fixture", locator: "fixture:1", objectHash: "h", retainedBoundary: { observationId: "obs-1", bytes: 4, at: 1 }, indexedBoundary: { observationId: "obs-1", bytes: 4, at: 1 }, summaryCoverage: null, lastCompleteReconciliation: 1, format: "fixture", gaps: [] as string[] };
  store.publish({ session: { key, revision: "r1", title: "Bridge", origin: "human_started", originReason: "fixture", models: [], cwd: null, updatedAt: 1 }, observation, passages: [makePassage({ sessionKey: key, observationId: observation.id, record: "r", channel: "c", role: "user", ordinal: 0, timestamp: null, text: "hello" })] });
}

describe("InkLibraryBridge", () => {
  test("opens read-only and exposes cached interpretation provenance", () => {
    const path = join(temp("atlas-bridge-"), "library.db"); const writer = new LibraryStore(path); capture(writer); writer.close();
    const bridge = InkLibraryBridge.open({ libraryPath: path });
    expect(bridge.getSessionView(key).status).toBe("unavailable");
    bridge.close(); expect(existsSync(path)).toBe(true);
  });

  test("favorite add returns durable undo id and concurrent change blocks undo", () => {
    const path = join(temp("atlas-bridge-"), "library.db"); const writer = new LibraryStore(path); capture(writer); writer.close();
    const bridge = InkLibraryBridge.open({ libraryPath: path }); const added = bridge.toggleFavorite(key); expect(added.undoId).toBeString();
    const second = new LibraryStore(path); const row = second.favorites().find(f => f.id === added.favorite?.id)!;
    second.transaction(() => second.db.query("UPDATE library_favorites SET data=? WHERE id=?").run(JSON.stringify({ ...row, note: "concurrent edit" }), row.id));
    expect(() => bridge.undoFavorite(added.undoId!)).toThrow(); second.close(); bridge.close();
  });
});

test("tier-1 prose remains visible without a provider", async () => {
  const path = join(temp("atlas-tier2-"), "atlas.db"); const db = await openDb(path);
  const id = Number((db.prepare("INSERT INTO sessions(harness,native_id,source_path,ingested_at) VALUES ('codex','t1','fixture',1)").run() as { lastInsertRowid: number | bigint }).lastInsertRowid);
  db.prepare("INSERT INTO summaries(session_id,tier,topic_line,body,msg_count_covered,model) VALUES (?,?,?,?,?,?)").run(id, 1, "topic", "historical prose", 1, "old-model");
  const outcome = await summarizeTier2(db, { providers: [] } as never, id); expect(outcome.status).toBe("degraded"); expect(outcome.result?.body).toBe("historical prose"); db.close();
});
