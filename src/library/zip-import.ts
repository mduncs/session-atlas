import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { hashText } from "./passages.js";
import { EvidenceStore } from "./evidence.js";
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function zipCrc32(bytes: Uint8Array): number { let crc = 0xffffffff; for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
/** Consumer export extraction: no shell/unzip dependency, traversal, symlink or zip bomb. */
export function importZip(zipPath: string, inbox: string): { root: string; files: number; omitted: string[]; archiveHash: string } {
  if (![zipPath, inbox].every(p => p.startsWith("/"))) throw new Error("absolute ZIP and import-inbox paths required");
  const zip = readFileSync(zipPath); if (zip.length > 256 * 1024 * 1024) throw new Error("ZIP exceeds 256 MiB import cap");
  let end = -1;
  for (let p = zip.length - 22; p >= Math.max(0, zip.length - 65557); p--) if (zip.readUInt32LE(p) === 0x06054b50) { end = p; break; }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) throw new Error("unsupported or multi-disk ZIP");
  const count = zip.readUInt16LE(end + 10); let at = zip.readUInt32LE(end + 16);
  if (count > 10000 || at === 0xffffffff || count === 0xffff) throw new Error("ZIP64 or too many entries not supported");
  const archiveHash = hashText(zip); const root = join(inbox, archiveHash); const stage = `${root}.${randomUUID()}.stage`;
  const omitted: string[] = []; let files = 0; let total = 0; const seen = new Set<string>();
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    for (let i = 0; i < count; i++) {
      if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) throw new Error("invalid ZIP central directory");
      const expectedCrc = zip.readUInt32LE(at + 16); const flags = zip.readUInt16LE(at + 8); const method = zip.readUInt16LE(at + 10); const compressed = zip.readUInt32LE(at + 20); const size = zip.readUInt32LE(at + 24); const nameLength = zip.readUInt16LE(at + 28); const extraLength = zip.readUInt16LE(at + 30); const commentLength = zip.readUInt16LE(at + 32); const mode = zip.readUInt32LE(at + 38) >>> 16; const offset = zip.readUInt32LE(at + 42);
      const name = new TextDecoder("utf-8", { fatal: true }).decode(zip.subarray(at + 46, at + 46 + nameLength)); at += 46 + nameLength + extraLength + commentLength;
      if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes("..") || (mode & 0xf000) === 0xa000) throw new Error("unsafe ZIP path or symlink");
      if (name.endsWith("/")) continue;
      if (flags & 1) throw new Error("encrypted ZIP unsupported");
      if (!/\.(json|jsonl|md)$/i.test(name)) { omitted.push(name); continue; }
      if (seen.has(name)) throw new Error("duplicate ZIP member path"); seen.add(name);
      if (size > 32 * 1024 * 1024 || total + size > 128 * 1024 * 1024) throw new Error("expanded import exceeds 32 MiB/file or 128 MiB total");
      if (offset + 30 > zip.length || zip.readUInt32LE(offset) !== 0x04034b50) throw new Error("invalid ZIP local member");
      const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28); if (start + compressed > zip.length) throw new Error("truncated ZIP member");
      const data = zip.subarray(start, start + compressed); const decoded = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: 32 * 1024 * 1024 }) : null;
      if (!decoded || decoded.length !== size) throw new Error("unsupported ZIP compression or size mismatch");
      if (zipCrc32(decoded) !== expectedCrc) throw new Error("ZIP member CRC32 integrity failure");
      const target = resolve(stage, name); if (!target.startsWith(stage + "/")) throw new Error("ZIP member escaped inbox");
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, decoded, { flag: "wx", mode: 0o600 }); total += size; files++;
    }
    if (!files) throw new Error("ZIP contains no supported JSON/JSONL/Markdown transcripts");
    const evidence = new EvidenceStore(join(inbox, "archive-evidence")); evidence.retain("consumer-zip", zipPath, zip, "zip");
    if (!existsSync(root)) renameSync(stage, root); else rmSync(stage, { recursive: true, force: true });
    writeFileSync(join(inbox, `${archiveHash}.manifest.json`), JSON.stringify({ archiveHash, source: basename(zipPath), root, files, omitted, bytes: total }, null, 2), { mode: 0o600 });
    return { root, files, omitted, archiveHash };
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}
