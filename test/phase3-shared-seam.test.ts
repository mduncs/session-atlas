import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ISOLATED_CLONE_MIGRATION_CONFIRMATION,
  migrateIsolatedClone,
  openDb,
  runMigrations,
} from "../src/db/index.js";
import { assertFixtureCatalog, FIXTURE_CATALOG } from "../src/conformance/fixture-catalog.js";
import { LATEST_SCHEMA_VERSION } from "../src/db/schema.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });

function v10Fixture(): { root: string; dbPath: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(),"atlas-v11-seam-")); roots.push(root);
  const dbPath = join(root,"clone.db");
  const configPath = join(root,"clone.toml");
  writeFileSync(configPath,`dbPath = "${dbPath}"
`,{mode:0o600});
  const db = new Database(dbPath);
  runMigrations(db,10);
  const insertSession = db.prepare(`INSERT INTO sessions(
    harness,native_id,source_path,title,start_ts,end_ts,last_activity,duration_ms,
    models,msg_count,transcript_bytes,ingested_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const a = Number(insertSession.run("claude","a","/fixture/a",null,null,null,null,null,"[]",0,0,1).lastInsertRowid);
  const b = Number(insertSession.run("codex","b","/fixture/b",null,null,null,null,null,"[]",0,0,1).lastInsertRowid);
  const jobs = [
    ["summarize",a,"tier-1"],["summarize",a,"tier-1"],
    ["summarize",b,"tier-1"],["summarize",b,"tier-1"],
    ["summarize",a,"tier-2"],["summarize",a,"tier-2"],
    ["export",a,"scope-a"],["export",a,"scope-a"],
    ["export",b,"scope-b"],
  ] as const;
  const insertJob = db.prepare(`INSERT INTO jobs(kind,session_id,scope,status,attempts,last_error,provider,created_at,updated_at)
    VALUES (?,?,?,'pending',0,NULL,NULL,?,?)`);
  jobs.forEach((job,index) => insertJob.run(...job,index+1,index+1));
  db.close();
  return {root,dbPath,configPath};
}

test("ordinary startup refuses a pre-existing v10 database without changing its version", async () => {
  const fixture = v10Fixture();
  await expect(openDb(fixture.dbPath)).rejects.toThrow("ordinary startup will not migrate");
  const db = new Database(fixture.dbPath,{readonly:true});
  expect(db.query(`SELECT value FROM meta WHERE key='schema_version'`).get()).toEqual({value:"10"});
  db.close();
});

test("guarded clone migration lands full v11 and preserves nine legacy attempts as five work identities", () => {
  const fixture = v10Fixture();
  const report = migrateIsolatedClone({
    dbPath:fixture.dbPath,
    configPath:fixture.configPath,
    confirmation:ISOLATED_CLONE_MIGRATION_CONFIRMATION,
  });
  expect(report).toMatchObject({fromVersion:10,toVersion:LATEST_SCHEMA_VERSION,integrity:"ok",foreignKeyViolations:0});
  const db = new Database(fixture.dbPath,{readonly:true});
  expect(db.query(`SELECT COUNT(*) n FROM job_work`).get()).toEqual({n:5});
  expect(db.query(`SELECT COUNT(*) n FROM job_attempts`).get()).toEqual({n:9});
  expect(db.query(`SELECT COUNT(*) n FROM sessions WHERE construction_status='invalid' AND source_validation_status='legacy_unverified'`).get()).toEqual({n:2});
  expect(db.query(`SELECT COUNT(*) n FROM construction_metrics`).get()).toEqual({n:2});
  expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  db.close();
});

test("committed catalog is contiguous F01-F62 and all expected vectors satisfy contract algebra", () => {
  expect(() => assertFixtureCatalog()).not.toThrow();
  expect(FIXTURE_CATALOG).toHaveLength(62);
  expect(FIXTURE_CATALOG[3]).toMatchObject({id:"F04",opaqueProvenanceToken:"P-F04",preBuildPrivateBindingRequired:true});
});
