import { posix } from "node:path";
import type { ArtifactEvidence, Passage } from "./contracts.js";
import { evidenceHash } from "./evidence.js";

/** Linear token scan: opaque tool blobs must not enter a backtracking path regex. */
function pathMentions(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(/[\w./@+~-]+/g)) {
    const token = match[0];
    // This bounds derived path candidates, never the retained/searchable text.
    if (token.length > 4096 || !token.includes("/")) continue;
    const parts = token.split("/").filter(Boolean);
    const leaf = parts.at(-1) ?? "";
    const dot = leaf.lastIndexOf(".");
    const extension = dot >= 0 && dot < leaf.length - 1 && /^[\w-]+$/.test(leaf.slice(dot + 1));
    if (extension || (token.startsWith("/") && parts.length >= 2)) paths.push(token);
  }
  return paths;
}

/** Evidence extraction never executes shell text or probes the referenced paths. */
export function extractArtifacts(passages: Passage[], cwd: string | null): ArtifactEvidence[] {
  const out: ArtifactEvidence[] = [];
  const seen = new Set<string>();
  const add = (p: Passage, originalPath: string, kind: ArtifactEvidence["kind"], detail: string, certainty: ArtifactEvidence["certainty"]) => {
    const path = originalPath.startsWith("/") ? posix.normalize(originalPath) : cwd ? posix.resolve(cwd, originalPath) : originalPath;
    const id = evidenceHash(JSON.stringify([p.ref, originalPath, kind, detail]));
    if (!seen.has(id)) { seen.add(id); out.push({ id, sessionKey: p.sessionKey, ref: p.ref, path, originalPath, kind, detail, certainty }); }
  };
  if (cwd && passages[0]) add(passages[0], cwd, "cwd", "Recorded working directory; not evidence of artifact activity", "observed");
  for (const p of passages) {
    const paths = pathMentions(p.text);
    for (const path of paths) add(p, path.trim(), "mentioned", "Path appears in source text", p.role === "assistant" ? "claim" : "observed");
    // Structured result evidence only. A command's existence, exit 0, mkdir -p,
    // and assistant claims cannot establish that a new artifact was created.
    if (p.channel.startsWith("tool") || p.role === "tool") {
      try {
        const value = JSON.parse(p.text) as Record<string, unknown>;
        const path = value.path ?? value.file_path;
        if (typeof path !== "string") continue;
        if (value.success === true && value.created === true && value.existed_before === false) add(p, path, "creation_observed", "Tool result explicitly reports new creation and prior absence", "observed");
        else if (value.success === true && ["write", "edit", "patch"].includes(String(value.action))) add(p, path, "worked_on", "Successful structured modification result", "observed");
        else if (["write", "create"].includes(String(value.action)) || /:(Write|write_file|create_file)$/i.test(p.channel)) add(p, path, "creation_requested", "Tool action requested; creation not established", "candidate");
      } catch { /* Opaque tool payload remains searchable source evidence. */ }
    } else if (p.role === "user" && /\b(create|write|generate|save)\b/i.test(p.text)) {
      for (const path of paths) add(p, path.trim(), "creation_requested", "User requested artifact creation", "candidate");
    }
  }
  return out;
}
export function artifactOrigin(items: ArtifactEvidence[]): { origins: ArtifactEvidence[]; established: boolean; reason: string } {
  const origins = items.filter(item => item.kind === "creation_observed");
  return { origins, established: origins.length > 0, reason: origins.length ? "Explicit source result evidence" : "Origin not established by retained evidence" };
}
