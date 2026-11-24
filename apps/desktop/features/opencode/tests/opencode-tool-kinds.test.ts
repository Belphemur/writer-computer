// @vitest-environment jsdom
// The tool table the web classifies a tool row by: Claude's first, then every registered backend's
// (`tool-kinds.ts`). OpenCode's rows classify like their Claude kinds once the feature is on, fall
// back to `other` when it is off, and no tool name means two different things across tables.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import claude from "@shared/agent-tools/claude.json";
import { featureHost } from "@/lib/features/registry";
import {
  buildSpecs,
  groupTitle,
  readsFile,
  toolKind,
  toolLabel,
  toolRole,
  toolSpec,
} from "@features/agent/web/lib/tool-kinds";
import opencode from "../tools.json";
import opencodeFeature from "../web/index";

describe("OpenCode's tools in the web table", () => {
  beforeEach(() => featureHost.register(opencodeFeature));
  afterEach(async () => featureHost.unregister("opencode"));

  it("classify like their Claude kinds", () => {
    expect(toolKind("shell")).toBe(toolKind("Bash"));
    expect(toolKind("shell")).toBe("execute");
    expect(toolKind("edit")).toBe(toolKind("Edit"));
    expect(toolKind("write")).toBe("edit");
    expect(toolKind("read")).toBe(toolKind("Read"));
    expect(toolKind("grep")).toBe(toolKind("Grep"));
    expect(toolKind("glob")).toBe(toolKind("Glob"));
    expect(toolKind("subagent")).toBe(toolKind("Task"));
    expect(toolKind("subagent")).toBe("agent");
    expect(toolKind("webfetch")).toBe(toolKind("WebFetch"));
    expect(toolKind("websearch")).toBe(toolKind("WebSearch"));
  });

  it("carry the roles and words the neutral code reads", () => {
    expect(toolRole("shell")).toBe("shell");
    expect(toolRole("write")).toBe("create");
    expect(readsFile("read")).toBe(true);
    expect(toolLabel("shell", { command: "ls notes" }, false)).toBe("Ran ls notes");
    expect(toolLabel("read", { path: "/v/a.md" }, true)).toMatch(/^Reading a\.md/);
    expect(groupTitle(["read", "read"], false)).toBe("Read 2 notes");
  });

  it("classify Writer's own tools through OpenCode's prefix", () => {
    const prefix = opencode.mcp.prefix;
    expect(toolKind(`${prefix}search`)).not.toBe("other");
  });

  it("are `other` while the feature is off (nothing registered)", async () => {
    await featureHost.unregister("opencode");
    expect(toolKind("shell")).toBe("other");
    expect(toolKind("subagent")).toBe("other");
    // Claude's table is unaffected
    expect(toolKind("Bash")).toBe("execute");
    featureHost.register(opencodeFeature);
    expect(toolKind("shell")).toBe("execute");
  });

  it("no tool name is in two tables with a different meaning", () => {
    const a = buildSpecs(claude as never);
    const b = buildSpecs(opencode as never);
    const shared = [...a.specs.keys()].filter((name) => b.specs.has(name));
    for (const name of shared) expect(a.specs.get(name), name).toEqual(b.specs.get(name));
    // today none is shared at all: the names differ in case or word
    expect(shared).toEqual([]);
    expect(toolSpec("Bash")).toEqual(a.specs.get("Bash"));
  });
});
