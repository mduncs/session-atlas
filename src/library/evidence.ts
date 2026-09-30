import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export const evidenceHash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export interface EvidenceManifest {
  version: 1; hash: string; sourceId: string; locator: string; bytes: number;
  indexedBytes: number; segments: { hash: string; bytes: number }[];
  previous: string | null; append: boolean; format: string; capturedAt: number;
}
export class EvidenceStore {
  constructor(readonly directory: string, readonly reserveBytes = 64 * 1024 * 1024) {
    mkdirSync(join(directory, "objects"), { recursive: true });
    mkdirSync(join(directory, "manifests"), { recursive: true });
  }
  objectPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid evidence hash");
    return join(this.directory, "objects", hash);
  }
  private durable(path: string, bytes: Uint8Array): void {
    if (existsSync(path)) return;
    const space = statfsSync(this.directory);
    if (space.bavail * space.bsize - bytes.length < this.reserveBytes) throw new Error("Capture paused: evidence free-space reserve reached");
    const temp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const dir = openSync(path.slice(0, path.lastIndexOf("/")), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  read(hash: string): Buffer {
    let bytes: Buffer;
    if (existsSync(this.objectPath(hash))) bytes = readFileSync(this.objectPath(hash));
    else {
      const manifest = JSON.parse(readFileSync(join(this.directory, "manifests", `${hash}.json`), "utf8")) as EvidenceManifest;
      bytes = Buffer.concat(manifest.segments.map(segment => { const piece = this.read(segment.hash); if (piece.length !== segment.bytes) throw new Error("segment size mismatch"); return piece; }));
    }
    if (evidenceHash(bytes) !== hash) throw new Error("Retained evidence integrity failure");
    return bytes;
  }
  retain(sourceId: string, locator: string, bytes: Buffer, format: string, previous?: EvidenceManifest): EvidenceManifest {
    const hash = evidenceHash(bytes);
    const indexedBytes = format === "jsonl" ? bytes.lastIndexOf(10) + 1 : bytes.length;
    let append = false;
    if (previous && previous.bytes <= bytes.length) {
      append = evidenceHash(bytes.subarray(0, previous.bytes)) === previous.hash;
    }
    const segments = append && previous ? [...previous.segments] : [];
    const start = append && previous ? previous.bytes : 0;
    // Fixed-size immutable chunks preserve old observations and deduplicate appends.
    for (let offset = start; offset < bytes.length; offset += 1024 * 1024) {
      const part = bytes.subarray(offset, Math.min(bytes.length, offset + 1024 * 1024));
      const partHash = evidenceHash(part);
      this.durable(this.objectPath(partHash), part);
      segments.push({ hash: partHash, bytes: part.length });
    }

    const manifest: EvidenceManifest = { version: 1, hash, sourceId, locator, bytes: bytes.length, indexedBytes, segments, previous: previous?.hash ?? null, append, format, capturedAt: Date.now() };
    const encoded = Buffer.from(JSON.stringify(manifest));
    this.durable(join(this.directory, "manifests", hash + ".json"), encoded);
    return manifest;
  }
  snapshotSqlite(path: string): Buffer {
    const db = new Database(path, { readonly: true });
    const destination = join(this.directory, `${randomUUID()}.snapshot.db`);
    try {
      // SQLite itself builds a WAL-visible consistent logical snapshot. VACUUM
      // INTO writes only the Atlas-owned destination, never the source database.
      db.query("VACUUM INTO ?").run(destination);
      return readFileSync(destination);
    } finally { db.close(); try { unlinkSync(destination); } catch {} }
  }

  temporarySnapshot(bytes: Buffer): { path: string; dispose(): void } {
    const path = join(this.directory, `${randomUUID()}.db`);
    writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
    return { path, dispose: () => { for (const suffix of ["", "-wal", "-shm"]) { try { unlinkSync(path + suffix); } catch {} } } };
  }
}
