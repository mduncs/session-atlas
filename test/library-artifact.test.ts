import { expect, test } from "bun:test";
import { extractArtifacts, artifactOrigin } from "../src/library/artifacts.js";
import { makePassage } from "../src/library/passages.js";
const passage = (text: string, role: "user" | "assistant" | "tool" = "user", ordinal = 0) => makePassage({ sessionKey: { harness: "fixture", nativeId: "s" }, observationId: "obs", record: `r${ordinal}`, channel: role === "tool" ? "tool" : "prose", text, role, ordinal, timestamp: null });
test("artifact origin distinguishes request, cwd, assistant claim, failed and existing creation", () => {
  const rows = [passage("Create /projects/demo/output.md"), passage("I created /projects/demo/output.md", "assistant", 1), passage(JSON.stringify({ action: "create", path: "/projects/demo/output.md", success: false }), "tool", 2), passage(JSON.stringify({ command: "mkdir -p /projects/demo", success: true }), "tool", 3), passage(JSON.stringify({ action: "create", path: "/projects/demo/output.md", success: true, created: true, existed_before: true }), "tool", 4)];
  const evidence = extractArtifacts(rows, "/home/user");
  expect(evidence.some(e => e.kind === "cwd")).toBe(true);
  expect(evidence.some(e => e.kind === "creation_requested")).toBe(true);
  expect(artifactOrigin(evidence).established).toBe(false);
  const observed = passage(JSON.stringify({ action: "create", path: "/projects/demo/output.md", success: true, created: true, existed_before: false }), "tool", 5);
  expect(artifactOrigin(extractArtifacts([...rows, observed], "/elsewhere")).origins[0]!.ref).toBe(observed.ref);
});
test("same basename in unrelated locations stays distinct; original relative spelling preserved", () => {
  const a = extractArtifacts([passage("See ./result.md")], "/project/a");
  const b = extractArtifacts([passage("See ./result.md")], "/project/b");
  expect(a.find(item => item.kind === "mentioned")!.path).toBe("/project/a/result.md");
  expect(b.find(item => item.kind === "mentioned")!.path).toBe("/project/b/result.md");
  expect(a.find(item => item.kind === "mentioned")!.originalPath).toBe("./result.md");
});

test("opaque slash-heavy tool payloads stay bounded and duplicate mentions are elected once", () => {
  const opaque = "/" + "a".repeat(200_000) + "/b/".repeat(100_000);
  const row = passage(opaque + "\n" + Array(1000).fill("/project/result.md").join(" "), "tool");
  const start = performance.now();
  const evidence = extractArtifacts([row], null);
  expect(performance.now() - start).toBeLessThan(1000);
  expect(evidence).toHaveLength(1);
  expect(evidence[0]!.originalPath).toBe("/project/result.md");
  expect(row.text.startsWith(opaque)).toBe(true);
});
