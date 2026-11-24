// The switch rule of the agent's on/off lists, over the vectors Rust reads too
// (`shared/agent-mcp/vectors.json`, src-tauri/src/agent/mcp_menu.rs).
import { describe, expect, it } from "vite-plus/test";
import vectors from "@shared/agent-mcp/vectors.json";
import { mcpNeedsAttention } from "@features/agent/web/lib/mcp-status";
import type { McpState } from "@features/agent/web/ipc";
import { isModelEnabled } from "@/lib/features/agent-backends";
import {
  isMcpSwitchOn,
  isSwitchOn,
  mcpCoveredBy,
  mcpSwitchedAfter,
  serverKey,
  switchedAfter,
} from "@/lib/switches";

describe("the switch rule", () => {
  it("is on unless listed when the default is on, off unless listed otherwise", () => {
    for (const c of vectors.on) {
      expect(isSwitchOn(c.list, c.name, c.defaultOn), JSON.stringify(c)).toBe(c.on);
    }
  });

  it("writes the list after a switch: no duplicates, the others kept in order", () => {
    for (const c of vectors.after) {
      expect(switchedAfter(c.list, c.name, c.on, c.defaultOn), JSON.stringify(c)).toEqual(c.result);
    }
  });

  it("names an MCP server by its key, as Rust does", () => {
    for (const c of vectors.keys) expect(serverKey(c.raw), c.raw).toBe(c.key);
  });

  it("reads the MCP list by key and by glob", () => {
    for (const c of vectors.mcpOn) {
      expect(isMcpSwitchOn(c.list, c.name, c.defaultOn), JSON.stringify(c)).toBe(c.on);
    }
  });

  it("writes the MCP list after a switch", () => {
    for (const c of vectors.mcpAfter) {
      expect(mcpSwitchedAfter(c.list, c.name, c.on, c.defaultOn), JSON.stringify(c)).toEqual(
        c.result,
      );
    }
  });

  it("settles the states Rust settles", () => {
    for (const c of vectors.settled) {
      expect(!mcpNeedsAttention(c.state as McpState), c.state).toBe(c.settled);
    }
  });

  it("names the entry that takes a covered server off, only where the list holds the off ones", () => {
    expect(mcpCoveredBy(["a"], "a__b", true)).toBe("a");
    expect(mcpCoveredBy(["a.x"], "a_x__b", true)).toBe("a_x");
    expect(mcpCoveredBy(["a"], "a", true)).toBeNull();
    expect(mcpCoveredBy(["a__b"], "a", true)).toBeNull();
    expect(mcpCoveredBy(["a"], "ab", true)).toBeNull();
    expect(mcpCoveredBy(["a"], "a__b", false)).toBeNull();
  });

  it("does not touch the list it was given", () => {
    const list = ["a"];
    switchedAfter(list, "a", true, true);
    expect(list).toEqual(["a"]);
  });

  it("is the models' enabled rule: on unless switched off, the backend's own switch first", () => {
    expect(isModelEnabled({ id: "a/b", available: true }, [])).toBe(true);
    expect(isModelEnabled({ id: "a/b", available: true }, ["a/b"])).toBe(false);
    expect(isModelEnabled({ id: "a/b", available: false }, [])).toBe(false);
  });
});
