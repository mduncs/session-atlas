import { createHash } from "node:crypto";
import type { Passage, PassageRef, SessionKey } from "./contracts.js";
export const hashText = (text: string | Uint8Array): string => createHash("sha256").update(text).digest("hex");
export const keyToken = (key: SessionKey): string => JSON.stringify(key.variant ? [key.harness, key.nativeId, key.variant] : [key.harness, key.nativeId]);
export function utf8Slice(text: string, start: number, end: number): string {
  const bytes = Buffer.from(text);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > bytes.length || (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) || (end < bytes.length && (bytes[end]! & 0xc0) === 0x80)) throw new Error("invalid UTF-8 passage boundary");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
}
export function makePassage(input: Omit<Passage, "ref" | "startByte" | "endByte" | "textHash"> & { startByte?: number; endByte?: number }): Passage {
  const startByte = input.startByte ?? 0;
  const endByte = input.endByte ?? startByte + Buffer.byteLength(input.text);
  if (endByte - startByte !== Buffer.byteLength(input.text)) throw new Error("passage byte range disagrees with text");
  const textHash = hashText(input.text);
  const identity = [1, input.sessionKey.harness, input.sessionKey.nativeId, input.observationId, input.record, input.channel, startByte, endByte, textHash, ...(input.sessionKey.variant ? [input.sessionKey.variant] : [])];
  return { ...input, startByte, endByte, textHash, ref: `atlas:p1:${Buffer.from(JSON.stringify(identity)).toString("base64url")}` };
}
export function parseRef(ref: PassageRef): { sessionKey: SessionKey; observationId: string; record: string; channel: string; startByte: number; endByte: number; textHash: string } {
  if (!ref.startsWith("atlas:p1:") || ref.length > 16384) throw new Error("unsupported passage reference");
  let a: unknown;
  try { a = JSON.parse(Buffer.from(ref.slice(9), "base64url").toString("utf8")); } catch { throw new Error("invalid passage reference"); }
  if (!Array.isArray(a) || (a.length !== 9 && a.length !== 10) || a[0] !== 1 || !a.slice(1, 6).every(v => typeof v === "string") || !Number.isSafeInteger(a[6]) || !Number.isSafeInteger(a[7]) || a[6] < 0 || a[7] < a[6] || typeof a[8] !== "string" || !/^[a-f0-9]{64}$/.test(a[8])) throw new Error("invalid passage reference fields");
  return { sessionKey: { harness: a[1], nativeId: a[2], ...(typeof a[9] === "string" ? { variant: a[9] } : {}) }, observationId: a[3], record: a[4], channel: a[5], startByte: a[6], endByte: a[7], textHash: a[8] };
}
export function selectPassage(passage: Passage, startByte: number, endByte: number): Passage {
  const text = utf8Slice(passage.text, startByte, endByte);
  return makePassage({ ...passage, text, startByte: passage.startByte + startByte, endByte: passage.startByte + endByte });
}
/** Convert DOM/terminal UTF-16 offsets once, rejecting split surrogate pairs. */
export function selectionBytes(text: string, start: number, end: number): [number, number] {
  if (start < 0 || end < start || end > text.length || !Number.isInteger(start) || !Number.isInteger(end)) throw new Error("invalid selection");
  for (const n of [start, end]) if (n > 0 && n < text.length && /[\uD800-\uDBFF]/.test(text[n - 1]!) && /[\uDC00-\uDFFF]/.test(text[n]!)) throw new Error("selection splits surrogate pair");
  return [Buffer.byteLength(text.slice(0, start)), Buffer.byteLength(text.slice(0, end))];
}
