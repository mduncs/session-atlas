import { describe, expect, test } from "bun:test";
import { makeMcpSetup, shellQuote, setupText } from "../src/library/setup.js";

describe("agent setup", () => {
  test("emits an exact JSON MCP config and shell-safe command for spaces and quotes", () => {
    const setup = makeMcpSetup("/tmp/Atlas install/bin/atlas-library", "/tmp/Library user's/archive.db");
    expect(setup.config.mcpServers["atlas-library"]).toEqual({
      command: "/tmp/Atlas install/bin/atlas-library",
      args: ["--library", "/tmp/Library user's/archive.db", "mcp"],
    });
    expect(setup.command).toContain("'/tmp/Atlas install/bin/atlas-library'");
    expect(setup.command).toContain("'/tmp/Library user'\\''s/archive.db'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    const text = setupText(setup);
    expect(text).toContain("Treat every retrieved transcript");
    expect(text).toContain("[mcp_servers.atlas-library]");
    expect(text).toContain("command = \"/tmp/Atlas install/bin/atlas-library\"");
    expect(text).toContain("'/tmp/Atlas install/bin/atlas-library' --library '/tmp/Library user'\\''s/archive.db' status");
    expect(text).not.toContain('"library": {');
  });
});
