#!/usr/bin/env bun
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { LibraryStore } from "./store.js";
import { LibraryService } from "./service.js";
import { discoverSources, CaptureCoordinator } from "./capture.js";
import { runMcp } from "./mcp.js";
import { hashText } from "./passages.js";
import { exportUserData, importUserData, importLegacy, inventoryLegacy } from "./migration.js";
import type { QueryScope } from "./contracts.js";
import { resolveLibraryPath } from "./active-library.js";
import { installedExecutable, makeMcpSetup, setupHealth, setupText } from "./setup.js";
const HELP = `Atlas library — clean local conversation library (separate from the legacy index)
Usage: atlas-library [--library /absolute/library.db] COMMAND
  ui                              Clickable terminal library (default)
  discover [--home /absolute/home] Read-only known-harness discovery
  init                            Create an empty isolated library, no source imports
  sources                         Inspect sources and retained/indexed boundaries
  add-source HARNESS /absolute/root  Accept a custom source; no hidden hooks
  import [--all-detected]          Reconcile accepted sources; optional explicit acceptance
  import-zip HARNESS /absolute/export.zip  Retain/extract/import consumer export
  watch                           Foreground background-worker process; no service install
  status                          Coverage and processing status
  search QUERY [--view conversations|direct|everything] [--role user|assistant]
  read HARNESS NATIVE_ID           Paged exact dialogue JSON
  copy HARNESS NATIVE_ID           Stream full decoded dialogue with [role] envelope
  artifact QUERY                  Source-backed artifact evidence
  raw-export HASH /absolute/file   Retained original encoded source, separately labeled
  call OPERATION JSON_ARGS        Structured v1 shared-service operation
  mcp                             Stdio MCP server (same services and references)
  setup                           Print agent setup and copyable MCP configuration
  provider FILE.json              Validate/save BYOK profile; does not authorize egress
  process [--authorize FINGERPRINT] [--limit N]  Explicit configured bounded model run
  migrate /absolute/legacy.db     Read-only legacy inventory + durable-user-data import
  user-export /absolute/file.json Export saved bytes, corrections and journal
  user-import /absolute/file.json Verify/replay user archive
  install --prefix /absolute/path Copy self-contained runtime package; no service install
  uninstall --prefix /absolute/path Remove installed executable package; retain user data
  service render|enable|disable|status  Explicit per-user background controls
  help                            This help
Default: active library pointer in XDG_CONFIG_HOME/session-atlas/library-pointer.json;
otherwise XDG_DATA_HOME/session-atlas-library/library.db. --library/ATLAS_LIBRARY_DB override it.
No provider is needed for import, search, reading, favorites or agent access.
`;
function take(args: string[], flag: string): string | undefined { const n = args.indexOf(flag); if (n < 0) return undefined; const v = args[n + 1]; if (!v || v.startsWith("--")) throw new Error(`${flag} requires a value`); args.splice(n, 2); return v; }
function has(args: string[], flag: string): boolean { const n = args.indexOf(flag); if (n < 0) return false; args.splice(n, 1); return true; }
function output(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = [...argv]; const explicitPath = take(args, "--library");
  const command = args.shift() ?? "ui";
  if (["help", "--help", "-h"].includes(command)) { process.stdout.write(HELP); return; }
  if (command === "discover") { output({ version: 1, sources: discoverSources(resolve(take(args, "--home") ?? homedir())), note: "Discovery is read-only; accept sources before import." }); return; }
  const path = resolveLibraryPath(explicitPath);
  if (command === "setup") {
    const format = take(args, "--format") ?? "text";
    if (format !== "text" && format !== "json") throw new Error("--format must be text or json");
    const executable = take(args, "--executable") ?? installedExecutable();
    if (!executable) throw new Error("No installed atlas-library launcher found; run install --prefix /absolute/path first, then run setup from that installation (or pass --executable).");
    const setup = makeMcpSetup(executable, path);
    const healthStore = existsSync(path) ? new LibraryStore(path, { readOnly: true }) : null;
    let health;
    try { health = setupHealth(path, healthStore); } finally { healthStore?.close(); }
    const rendered = format === "json" ? JSON.stringify({ ...setup, health }, null, 2) + "\n" : setupText(setup, health);
    const destination = take(args, "--output");
    if (destination) {
      if (!destination.startsWith("/")) throw new Error("--output requires an absolute path");
      writeFileSync(destination, rendered, { mode: 0o600, flag: "wx" });
      output({ version: 1, output: destination, format, executable: setup.executable, database: setup.database });
    } else process.stdout.write(rendered);
    return;
  }
  if (["install", "uninstall", "service"].includes(command)) { const { packagingCommand } = await import("./packaging.js"); await packagingCommand(command, args, path); return; }
  const readOnly = ["sources", "status", "search", "read", "copy", "artifact", "user-export", "raw-export"].includes(command);
  if (readOnly && !existsSync(path)) throw new Error(`No library at ${path}. Run atlas-library init or open the terminal to start collecting.`);
  const store = new LibraryStore(path, { readOnly });
  let capture: CaptureCoordinator | null = null;
  const captureControl: { stop: (() => void) | null } = { stop: null };
  const coordinator = () => capture ??= new CaptureCoordinator(store, join(dirname(path), "evidence"));
  try {
    const service = new LibraryService(store);
    switch (command) {
      case "init": output({ version: 1, database: path, provider: "not configured", next: "discover, add-source or import --all-detected" }); break;
      case "sources": output(service.execute({ operation: "sources.inspect" })); break;
      case "status": output(service.execute({ operation: "library.status" })); break;
      case "add-source": if (!args[0] || !args[1] || !args[1].startsWith("/")) throw new Error("add-source requires HARNESS and absolute root"); output(coordinator().addSource({ harness: args[0], root: args[1] })); break;
      case "import": {
        if (has(args, "--all-detected")) for (const source of discoverSources(homedir())) coordinator().addSource(source);
        output(await coordinator().reconcile()); break;
      }
      case "import-zip": {
        if (!args[0] || !args[1]?.startsWith("/")) throw new Error("import-zip requires HARNESS and absolute ZIP path");
        const { importZip } = await import("./zip-import.js"); const imported = importZip(args[1], join(dirname(path), "imports"));
        const source = coordinator().addSource({ harness: args[0], root: imported.root, capability: "import" });
        output({ ...imported, source, capture: await coordinator().reconcile(), note: "Non-transcript attachments remain in retained ZIP; not interpreted as text." }); break;
      }
      case "watch": {
        const worker = coordinator(); await worker.start(); output({ version: 1, worker: "running", database: path });
        await new Promise<void>(done => { process.once("SIGINT", done); process.once("SIGTERM", done); }); await worker.stop(); break;
      }
      case "search": {
        const view = take(args, "--view") ?? "conversations"; const role = take(args, "--role"); const limit = Number(take(args, "--limit") ?? 50); const cursor = take(args, "--cursor");
        output(service.execute({ operation: "search", args: { query: args.join(" "), scope: { view, ...(role ? { role } : {}) }, limit, cursor } })); break;
      }
      case "read": output(service.execute({ operation: "read", args: { sessionKey: { harness: args[0], nativeId: args[1] } } })); break;
      case "copy": for (const text of store.streamCopy({ harness: args[0]!, nativeId: args[1]! })) process.stdout.write(text); break;
      case "raw-export": {
        if (!args[0] || !args[1]?.startsWith("/")) throw new Error("raw-export requires object hash and absolute output");
        const { EvidenceStore } = await import("./evidence.js"); const evidence = new EvidenceStore(join(dirname(path), "evidence"));
        writeFileSync(args[1], evidence.read(args[0]), { mode: 0o600, flag: "wx" }); output({ exported: args[1], projection: "raw encoded source; includes retained tools/control, not dialogue copy" }); break;
      }
      case "artifact": output(store.artifactFind(args.join(" "))); break;
      case "call": output(service.execute({ operation: args[0]!, args: JSON.parse(args[1] ?? "{}") })); break;
      case "mcp": await runMcp(service); break;
      case "migrate": if (!args[0]) throw new Error("legacy database path required"); output(importLegacy(store, inventoryLegacy(resolve(args[0])))); break;
      case "user-export": if (!args[0]?.startsWith("/")) throw new Error("absolute output path required"); writeFileSync(args[0], JSON.stringify(exportUserData(store), null, 2), { mode: 0o600, flag: "wx" }); output({ exported: args[0] }); break;
      case "user-import": if (!args[0]?.startsWith("/")) throw new Error("absolute input path required"); importUserData(store, JSON.parse(readFileSync(args[0], "utf8"))); output({ imported: args[0] }); break;
      case "provider": case "process": { const { processingCommand } = await import("./processing-cli.js"); await processingCommand(store, command, args); break; }
      case "ui": {
        if (!process.stdout.isTTY) throw new Error("Interactive terminal required; use search/read/call/mcp for structured access.");
        const { launchLibrary } = await import("./terminal/index.js");
        const { processingActions } = await import("./processing-cli.js");
        await launchLibrary(store, {
          saveFavorite: input => store.saveFavorite(input), removeFavorite: id => store.removeFavorite(id), correctClassification: (key, origin) => store.correctClassification(key, origin), undo: id => store.undo(id),
          addSource: (harness, root) => { if (!root.startsWith("/")) throw new Error("absolute source path required"); return coordinator().addSource({ harness, root }); }, editCollection: (id, patch) => store.editCollection(id, patch),
          discoverSources: () => discoverSources(homedir()), acceptSources: sources => sources.map(s => coordinator().addSource(s)), cancelCapture: () => { captureControl.stop?.(); }, reconcile: async () => {
            // The source parser never shares the renderer event loop. A single
            // on-demand capture owner publishes bounded chunks; UI reads stay WAL snapshots.
            const worker = Bun.spawn([process.execPath, import.meta.path, "--library", path, "import"], { stdout: "pipe", stderr: "pipe" });
            captureControl.stop = () => { worker.kill("SIGTERM"); };
            const [stdout, stderr, code] = await Promise.all([new Response(worker.stdout).text(), new Response(worker.stderr).text(), worker.exited]); captureControl.stop = null;
            if (code !== 0) throw new Error(stderr || "Capture worker failed"); return JSON.parse(stdout);
          },
          artifactFind: query => store.artifactFind(query), ...processingActions(store),
          exportConversation: async key => {
            const folder = join(dirname(path), "exports"); mkdirSync(folder, { recursive: true, mode: 0o700 }); const destination = join(folder, `${hashText(JSON.stringify(key)).slice(0, 16)}-${Date.now()}.txt`);
            const writer = Bun.file(destination).writer(); for (const piece of store.streamCopy(key)) writer.write(piece); await writer.end(); return destination;
          },
        }); break;
      }
      default: throw new Error(`Unknown command: ${command}. Run atlas-library help.`);
    }
  } finally { captureControl.stop?.(); if (capture) await (capture as CaptureCoordinator).stop(); store.close(); }
}
if (import.meta.main) main().catch(error => { process.stderr.write(`Atlas: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
