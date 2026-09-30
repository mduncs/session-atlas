import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLayersDb } from "../src/layers/db.js";
import { callerFromEnv, diffRefs, insertSearch, readCorpus, saveCorpus, type PassageRef } from "../src/layers/search-log.js";

describe("search caller", () => {
  test("agent sessions are identified from the harness environment", () => {
    expect(callerFromEnv({ CODEX_THREAD_ID: "019a-thread", AI_AGENT: "codex" }, false)).toEqual({ harness: "codex", nativeId: "019a-thread", agent: "codex" });
    expect(callerFromEnv({ CLAUDE_CODE_SESSION_ID: "ab20fc08", CLAUDECODE: "1" }, false)).toMatchObject({ harness: "claude", nativeId: "ab20fc08" });
    expect(callerFromEnv({ ATLAS_CALLER: "prime:root-7", CLAUDE_CODE_SESSION_ID: "x" }, false)).toMatchObject({ harness: "prime", nativeId: "root-7" });
  });

  test("md at a terminal is human; a pipe with no harness is unknown", () => {
    expect(callerFromEnv({}, true).harness).toBe("human");
    expect(callerFromEnv({}, false).harness).toBe("unknown");
  });
});

describe("search log and corpora", () => {
  test("logs refs, and a corpus re-run reports added, removed and changed passages", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-corpus-"));
    try {
      const layers = openLayersDb(join(dir, "atlas.db"));
      const id = insertSearch(layers, { surface: "cli-search", query: "walls", syntax: "literal", scope: { source: "claude" }, total: 2, refs: [["claude", "a", [3]]], uncovered: { truncated: 1 } },
        { harness: "codex", nativeId: "t1", agent: null }, 1);
      expect(layers.query(`SELECT caller_harness, caller_native_id, returned FROM search_log WHERE id=?`).get(id)).toEqual({ caller_harness: "codex", caller_native_id: "t1", returned: 1 });

      const first: PassageRef[] = [["claude", "a", [3]], ["codex", "b", [1, 4]]];
      const second: PassageRef[] = [["claude", "a", [3, 9]], ["claude", "c", [2]]];
      saveCorpus(layers, { name: "walls", query: "walls", syntax: "literal", scope: {}, origin: "md" }, { total: 2, refs: first }, 10);
      saveCorpus(layers, { name: "walls", query: "walls", syntax: "literal", scope: {}, origin: "md" }, { total: 2, refs: second }, 20);
      const stored = readCorpus(layers, "walls")!;
      expect(stored.snapshots.map((s) => s.taken_at)).toEqual([10, 20]);
      const diff = diffRefs(stored.snapshots[0]!.refs, stored.snapshots[1]!.refs);
      expect(diff).toEqual({ added: [["claude", "c", [2]]], removed: [["codex", "b", [1, 4]]], changed: [["claude", "a", [3, 9]]], kept: 0 });
      layers.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
