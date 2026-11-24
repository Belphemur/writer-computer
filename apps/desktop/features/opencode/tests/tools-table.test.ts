/**
 * OpenCode's tool table (`features/opencode/tools.json`, spec section 6 and section 11, phase 2):
 * the same shape as the shared Claude table, every row a known kind, and every role the neutral
 * code reads present. The Rust parser (`ToolTable::parse`) is the real reader; this keeps the JSON
 * honest for the web twin.
 */
import { describe, expect, it } from "vite-plus/test";
import opencode from "../tools.json";

const KEYS = ["$comment", "backend", "fallback", "mcp", "protocolOnly", "tools"];

describe("opencode tool table", () => {
  it("has the sections the shared table has", () => {
    // `shared/agent-tools/claude.json` is the other table of this shape (its test is in
    // features/agent/tests/agent-tool-table.test.ts)
    expect(Object.keys(opencode).sort()).toEqual(KEYS);
  });

  it("gives every row a known kind and a unique name", () => {
    const names = opencode.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    // the kinds are `shared/agent-tools/kinds.json` (one list); `ToolTable::parse` rejects any other
    // kind when the Rust tests read this file
    for (const t of opencode.tools) expect(typeof t.kind).toBe("string");
  });

  it("covers the tools the free model listed, shell and codemode included", () => {
    const names = opencode.tools.map((t) => t.name);
    for (const n of [
      "shell",
      "read",
      "edit",
      "write",
      "glob",
      "grep",
      "execute",
      "subagent",
      "question",
    ]) {
      expect(names).toContain(n);
    }
  });
});
