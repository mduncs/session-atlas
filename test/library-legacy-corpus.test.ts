import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePassage } from "../src/library/passages";
import { LibraryStore } from "../src/library/store";
import { recoverLegacyCorpus } from "../src/library/legacy-corpus";
import { inventoryLegacy, importLegacy, exportUserData, replayUserArchiveToLegacy } from "../src/library/migration";
test("missing original sources stay readable as explicitly unverified retained legacy projections; real legacy rollback replays favorite edits", async () => {
  const root = mkdtempSync(join(tmpdir(),"atlas-live-migration-test-")); const legacyPath=join(root,"legacy.db"); const db=new Database(legacyPath);
  db.exec("CREATE TABLE sessions(id INTEGER PRIMARY KEY,harness TEXT,native_id TEXT,title TEXT,chain_id INTEGER,origin TEXT,source_validation_status TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id INTEGER,ordinal INTEGER,role TEXT,text TEXT); CREATE TABLE favorites(id INTEGER PRIMARY KEY,harness TEXT,native_id TEXT,span_text TEXT,span_hash TEXT,topic TEXT,created_at INTEGER); CREATE TABLE lineage_claims(session_id INTEGER,parent_harness TEXT,parent_native_id TEXT,resolution_status TEXT); CREATE TABLE chains(id INTEGER PRIMARY KEY,head_session_id INTEGER,member_count INTEGER); INSERT INTO sessions VALUES(1,'claude','a','A',1,'unknown','legacy_unverified'),(2,'claude','b','B',1,'human','current'); INSERT INTO messages VALUES(1,1,0,'user','exact archived 日本語'),(2,2,0,'assistant','other'); INSERT INTO favorites VALUES(1,'claude','a','saved bytes',NULL,'keep',1); INSERT INTO lineage_claims VALUES(2,'claude','a','resolved'); INSERT INTO chains VALUES(1,1,2);"); db.close(); const before=readFileSync(legacyPath);
  const store=new LibraryStore(join(root,"new.db"));
  try {
    expect((await recoverLegacyCorpus(store,legacyPath,join(root,"evidence"))).recovered).toBe(2);
    importLegacy(store,inventoryLegacy(legacyPath)); expect(store.search("日本語").hits[0]!.passage!.text).toBe("exact archived 日本語"); expect(store.coverage().limitations.join()).toContain("not recaptured");
    const preserved=store.getState<any>("legacy-lineage"); expect(preserved.chains[0].members).toHaveLength(2); expect(preserved.lineage[0].parentKey.nativeId).toBe("a"); expect(readFileSync(legacyPath)).toEqual(before);
    const oldRef = store.read({harness:"claude",nativeId:"b"}).passages[0]!.ref;
    const delta = new Database(legacyPath); delta.exec("INSERT INTO messages VALUES(3,2,1,'user','final delta'); ALTER TABLE messages ADD COLUMN prose TEXT; UPDATE messages SET prose='' WHERE id=2; DELETE FROM favorites"); delta.close();
    await recoverLegacyCorpus(store,legacyPath,join(root,"evidence")); importLegacy(store,inventoryLegacy(legacyPath));
    expect(store.favorites()).toHaveLength(0); expect(store.read({harness:"claude",nativeId:"b"}).passages).toHaveLength(1); expect(store.db.query("SELECT text FROM library_passages WHERE channel='legacy-raw-record'").get()).toEqual({text:"other"});
    const key={harness:"claude",nativeId:"b"}; const prior=store.session(key)!;
    const passage=makePassage({sessionKey:key,observationId:"real-source",record:"real",channel:"dialogue",text:"verified original",role:"user",ordinal:0,timestamp:null});
    const boundary={observationId:"real-source",bytes:17,at:Date.now()};
    await store.publishBounded({session:{...prior,revision:"real"},passages:[passage],observation:{id:"real-source",sourceId:"claude",locator:"/original.jsonl",objectHash:"real",format:"claude",retainedBoundary:boundary,indexedBoundary:boundary,summaryCoverage:null,lastCompleteReconciliation:null,gaps:[]}});
    expect(store.read(key).passages[0]!.text).toBe("verified original"); expect(store.db.query("SELECT count(*) n FROM library_sessions").get()).toEqual({n:2});
    expect(store.db.query("SELECT text FROM library_passages WHERE ref=?").get(oldRef)).toEqual({text:"other"});
    // Recreate unchanged legacy import then exercise post-cutover deletion replay.
    const restored = new Database(legacyPath); restored.exec("INSERT INTO favorites VALUES(1,'claude','a','saved bytes',NULL,'keep',1)"); restored.close();
    importLegacy(store,inventoryLegacy(legacyPath));
    store.removeFavorite(store.favorites()[0]!.id); const saved=store.saveFavorite({sessionKey:{harness:"claude",nativeId:"b"},note:"new after cutover"});
    const result=replayUserArchiveToLegacy(legacyPath,exportUserData(store)); expect(result.deleted).toBe(1); const check=new Database(legacyPath,{readonly:true}); expect((check.query("SELECT span_text FROM favorites").get() as {span_text:string}).span_text).toBe(saved.text); check.close();
    replayUserArchiveToLegacy(legacyPath,exportUserData(store)); const again=new Database(legacyPath,{readonly:true}); expect((again.query("SELECT count(*) n FROM favorites").get() as {n:number}).n).toBe(1); again.close();
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});
