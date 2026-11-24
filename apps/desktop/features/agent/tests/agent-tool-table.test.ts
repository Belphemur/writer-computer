/**
 * The tools of a backend are data (`shared/agent-tools/claude.json`, spec
 * `SPECs/opencode-backend-spec.md` A11) that the Rust side reads too
 * (`agent/tool_table.rs`, whose tests pin the same rows). The old hand-kept lists are pinned here,
 * so the table cannot drift from what the app did before it existed.
 */
import { describe, expect, it } from "vite-plus/test";
import claude from "@shared/agent-tools/claude.json";
import kinds from "@shared/agent-tools/kinds.json";
import {
  editPreview,
  permissionSummary,
  readsFile,
  TOOL_KIND_KEYS,
  toolKind,
  toolLabel,
  toolNameOf,
  toolRole,
  toolSpec,
} from "../web/lib/tool-kinds";

type Old = [kind: string, past: string, present: string, primary: string[], noun: string[]];

/** The web's `SPECS` before the table: the tool, then what it said. */
const OLD_SPECS: Record<string, Old> = {
  Bash: ["execute", "Ran", "Running", ["command"], ["command", "commands"]],
  BashOutput: [
    "execute",
    "Read output of",
    "Reading output of",
    ["bash_id"],
    ["command", "commands"],
  ],
  KillShell: ["execute", "Stopped", "Stopping", ["shell_id"], ["command", "commands"]],
  Read: ["read", "Read", "Reading", ["file_path", "path"], ["note", "notes"]],
  Grep: ["search", "Searched", "Searching", ["pattern"], ["search", "searches"]],
  Glob: ["search", "Listed", "Listing", ["pattern"], ["search", "searches"]],
  LS: ["read", "Listed", "Listing", ["path"], ["folder", "folders"]],
  Write: ["edit", "Wrote", "Writing", ["file_path", "path"], ["note", "notes"]],
  Edit: ["edit", "Edited", "Editing", ["file_path", "path"], ["note", "notes"]],
  MultiEdit: ["edit", "Edited", "Editing", ["file_path", "path"], ["note", "notes"]],
  NotebookEdit: ["edit", "Edited", "Editing", ["notebook_path"], ["note", "notes"]],
  WebFetch: ["fetch", "Fetched", "Fetching", ["url"], ["page", "pages"]],
  WebSearch: [
    "fetch",
    "Searched the web for",
    "Searching the web for",
    ["query"],
    ["search", "searches"],
  ],
  Task: ["agent", "Ran subagent", "Running subagent", ["description"], ["subagent", "subagents"]],
  Agent: ["agent", "Ran subagent", "Running subagent", ["description"], ["subagent", "subagents"]],
};
const OLD_FALLBACK: Old = [
  "other",
  "Used",
  "Using",
  ["description", "query", "path", "file_path", "command", "url"],
  ["tool", "tools"],
];
/** Old `EDIT_TOOLS`, `SHELL_TOOL`, `LAUNCH_TOOLS` and `HANDBACK_TOOL` of the Rust side. */
const OLD_EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];
const OLD_LAUNCH_TOOLS = ["Agent", "Task"];

const shape = (tool: string): Old => {
  const s = toolSpec(tool);
  return [s.kind, s.past, s.present, s.primary, s.noun];
};

describe("the Claude tool table", () => {
  it("says what the web said before the table existed", () => {
    for (const [tool, old] of Object.entries(OLD_SPECS)) expect(shape(tool), tool).toEqual(old);
    expect(shape("SomeNewTool")).toEqual(OLD_FALLBACK);
    expect(readsFile("Read")).toBe(true);
    expect(readsFile("Grep")).toBe(false);
  });

  it("has the old lists of the Rust side", () => {
    const names = (pred: (r: (typeof claude.tools)[number]) => boolean) =>
      claude.tools.filter(pred).map((r) => r.name);
    expect(names((r) => r.kind === "edit")).toEqual(OLD_EDIT_TOOLS);
    expect(names((r) => "role" in r && r.role === "launch")).toEqual(OLD_LAUNCH_TOOLS);
    expect(names((r) => "role" in r && r.role === "shell")).toEqual(["Bash"]);
    expect(names((r) => "role" in r && r.role === "handback")).toEqual(["SubagentHandback"]);
    expect(toolNameOf("shell")).toBe("Bash");
  });

  // The shared vectors: every row's kind, the one the Rust test reads from the same file.
  it("gives every row of the file its kind", () => {
    for (const row of claude.tools) expect(toolKind(row.name), row.name).toBe(row.kind);
  });

  it("classifies Writer's own MCP tools by their command", () => {
    const p = claude.mcp.prefix;
    expect(toolKind(`${p}search`)).toBe("search");
    expect(toolKind(`${p}graph_backlinks`)).toBe("search");
    expect(toolKind(`${p}outline`)).toBe("read");
    expect(readsFile(`${p}read`)).toBe(true);
    expect(toolKind(`${p}create`)).toBe("other");
    expect(toolKind("mcp__other__search")).toBe("other");
  });

  it("derives what the card says from roles and argument names, not from tool names", () => {
    expect(toolRole("Write")).toBe("create");
    expect(toolRole("Bash")).toBe("shell");
    expect(toolRole("Read")).toBe("read");
    expect(toolRole("Grep")).toBeUndefined();
    const view = (tool: string, input: unknown) =>
      ({ tool, input, displayName: undefined, by: undefined }) as never;
    expect(permissionSummary(view("Write", { file_path: "a.md" }))).toBe(
      "The agent wants to write a.md",
    );
    expect(permissionSummary(view("Edit", { file_path: "a.md" }))).toBe(
      "The agent wants to edit a.md",
    );
    expect(editPreview("Write", { content: "x\ny" })).toBe("x\ny");
    expect(editPreview("Edit", { old_string: "a", new_string: "b" })).toBe("- a\n+ b");
    expect(editPreview("Bash", { command: "ls" })).toBeNull();
    expect(toolLabel("Bash", { command: "ls" }, false)).toBe("Ran ls");
  });
});

describe("the neutral kinds", () => {
  it("are the one shared list, the same as the ToolKind type", () => {
    expect(Object.keys(TOOL_KIND_KEYS)).toEqual(kinds);
  });
});
