/**
 * One registry for how a tool is named, grouped and summarised (docs/consolidation.md): the
 * permission card's "Type" line, the timeline row label and the group header all read it.
 */
import { roleLabelOf } from "./agent-roles";
import type { PermissionPersist, PermissionSuggestion } from "./events";
import type { PermissionView } from "./transcript";

export type ToolKind = "execute" | "edit" | "read" | "search" | "fetch" | "agent" | "other";

type ToolSpec = {
  kind: ToolKind;
  /** Past and present verb for the row label ("Ran" / "Running"). */
  past: string;
  present: string;
  /** Input keys tried, in order, for the one-line primary argument. */
  primary: string[];
  /** Noun used by group headers ("Read 3 notes"). */
  noun: [singular: string, plural: string];
  /** The call opens one file (counted as a file read on a sub-agent card; a search is not). */
  readsFile?: boolean;
};

const SPECS: Record<string, ToolSpec> = {
  Bash: {
    kind: "execute",
    past: "Ran",
    present: "Running",
    primary: ["command"],
    noun: ["command", "commands"],
  },
  BashOutput: {
    kind: "execute",
    past: "Read output of",
    present: "Reading output of",
    primary: ["bash_id"],
    noun: ["command", "commands"],
  },
  KillShell: {
    kind: "execute",
    past: "Stopped",
    present: "Stopping",
    primary: ["shell_id"],
    noun: ["command", "commands"],
  },
  Read: {
    kind: "read",
    past: "Read",
    present: "Reading",
    primary: ["file_path", "path"],
    noun: ["note", "notes"],
    readsFile: true,
  },
  // Glob and Grep: the installed CLI no longer has them, old chats still hold their rows
  Grep: {
    kind: "search",
    past: "Searched",
    present: "Searching",
    primary: ["pattern"],
    noun: ["search", "searches"],
  },
  Glob: {
    kind: "search",
    past: "Listed",
    present: "Listing",
    primary: ["pattern"],
    noun: ["search", "searches"],
  },
  LS: {
    kind: "read",
    past: "Listed",
    present: "Listing",
    primary: ["path"],
    noun: ["folder", "folders"],
  },
  Write: {
    kind: "edit",
    past: "Wrote",
    present: "Writing",
    primary: ["file_path", "path"],
    noun: ["note", "notes"],
  },
  Edit: {
    kind: "edit",
    past: "Edited",
    present: "Editing",
    primary: ["file_path", "path"],
    noun: ["note", "notes"],
  },
  MultiEdit: {
    kind: "edit",
    past: "Edited",
    present: "Editing",
    primary: ["file_path", "path"],
    noun: ["note", "notes"],
  },
  NotebookEdit: {
    kind: "edit",
    past: "Edited",
    present: "Editing",
    primary: ["notebook_path"],
    noun: ["note", "notes"],
  },
  WebFetch: {
    kind: "fetch",
    past: "Fetched",
    present: "Fetching",
    primary: ["url"],
    noun: ["page", "pages"],
  },
  WebSearch: {
    kind: "fetch",
    past: "Searched the web for",
    present: "Searching the web for",
    primary: ["query"],
    noun: ["search", "searches"],
  },
  Task: {
    kind: "agent",
    past: "Ran subagent",
    present: "Running subagent",
    primary: ["description"],
    noun: ["subagent", "subagents"],
  },
  Agent: {
    kind: "agent",
    past: "Ran subagent",
    present: "Running subagent",
    primary: ["description"],
    noun: ["subagent", "subagents"],
  },
};

/** Writer's own MCP tools (`writer mcp`, tools reach the model as `mcp__writer__<command>`). */
const WRITER_TOOL_PREFIX = "mcp__writer__";
/** The commands that look things up in the vault (the explorer's and the main agent's search). */
const WRITER_SEARCH =
  /^(search|search_context|files|folders|tags?|tasks|graph_.+|bases?(_.+)?|dql|properties|property_read)$/;
/** The commands that read one note or one fact about the vault. */
const WRITER_READ = /^(read|file|folder|outline|wordcount|active|status|vaults?)$/;

const WRITER_SEARCH_SPEC: ToolSpec = {
  kind: "search",
  past: "Searched",
  present: "Searching",
  primary: ["query", "file", "path", "name", "tag", "format"],
  noun: ["search", "searches"],
};
const WRITER_READ_SPEC: ToolSpec = {
  kind: "read",
  past: "Read",
  present: "Reading",
  primary: ["file", "path"],
  noun: ["note", "notes"],
  readsFile: true,
};

/** The spec of a `mcp__writer__*` tool by its command; the generic fallback for the others. */
function writerToolSpec(tool: string): ToolSpec | undefined {
  if (!tool.startsWith(WRITER_TOOL_PREFIX)) return undefined;
  const command = tool.slice(WRITER_TOOL_PREFIX.length);
  if (WRITER_SEARCH.test(command)) return WRITER_SEARCH_SPEC;
  if (WRITER_READ.test(command)) return WRITER_READ_SPEC;
  return undefined;
}

const FALLBACK: ToolSpec = {
  kind: "other",
  past: "Used",
  present: "Using",
  primary: ["description", "query", "path", "file_path", "command", "url"],
  noun: ["tool", "tools"],
};

export const toolSpec = (tool: string): ToolSpec => SPECS[tool] ?? writerToolSpec(tool) ?? FALLBACK;
export const toolKind = (tool: string): ToolKind => toolSpec(tool).kind;
export const readsFile = (tool: string): boolean => toolSpec(tool).readsFile === true;

export const KIND_LABEL: Record<ToolKind, string> = {
  execute: "Run a command",
  edit: "Edit a file",
  read: "Read",
  search: "Search",
  fetch: "Fetch from the web",
  agent: "Run a subagent",
  other: "Other",
};

export function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input === "object" && input !== null && !Array.isArray(input))
    return input as Record<string, unknown>;
  return null;
}

/** The one-line argument shown next to the verb: the command, path, pattern or URL. */
export function primaryArg(tool: string, input: unknown): string {
  const rec = asRecord(input);
  if (!rec) return typeof input === "string" ? firstLine(input) : "";
  for (const key of toolSpec(tool).primary) {
    const v = rec[key];
    if (typeof v === "string" && v) return firstLine(v);
  }
  return "";
}

export function firstLine(text: string): string {
  return text.split("\n", 1)[0]!.trim();
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Last path segment, for tidy labels; the full path stays in the expanded input. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** "Ran `ls`", "Reading notes.md": verb plus the primary argument. */
export function toolLabel(tool: string, input: unknown, running: boolean): string {
  const spec = toolSpec(tool);
  const verb = running ? spec.present : spec.past;
  const arg = primaryArg(tool, input);
  const shown = spec.kind === "read" || spec.kind === "edit" ? baseName(arg) : arg;
  if (spec.kind === "other") return `${verb} ${tool}${shown ? `: ${truncate(shown, 80)}` : ""}`;
  return shown ? `${verb} ${truncate(shown, 80)}` : `${verb} ${tool}`;
}

/** "Ran 3 commands", "Read 2 notes", "Used 4 tools" for one run of consecutive tool calls. */
export function groupTitle(tools: readonly string[], running: boolean): string {
  if (tools.length === 0) return running ? "Working" : "Thought";
  const kinds = new Set(tools.map((t) => toolSpec(t).noun[0]));
  const specs = tools.map(toolSpec);
  const first = specs[0]!;
  if (kinds.size === 1) {
    const [one, many] = first.noun;
    const n = tools.length;
    const verb = running ? first.present : first.past;
    return `${verb} ${n} ${n === 1 ? one : many}`;
  }
  return `${running ? "Using" : "Used"} ${tools.length} tools`;
}

// ---------------------------------------------------------------------------------------------
// Permission card

export type PermissionChoice = {
  persist: PermissionPersist;
  label: string;
  /** The rule text, when the choice adds one ("Bash(python3 -c 'print(1)')"). */
  rule: string | null;
  /** The `ruleContent`s the answer keeps; absent keeps every rule offered. */
  rules?: string[];
};

function ruleText(s: PermissionSuggestion): string[] {
  return (s.rules ?? []).map((r) =>
    r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName,
  );
}

const ruleContents = (s: PermissionSuggestion | undefined): string[] =>
  (s?.rules ?? []).flatMap((r) => (r.ruleContent ? [r.ruleContent] : []));

const isAllowRules = (s: PermissionSuggestion) => s.type === "addRules" && s.behavior !== "deny";

/** The rules "Always allow" saves: the CLI's suggestion or Writer's prefix proposal. */
const primaryRules = (suggestions: readonly PermissionSuggestion[]) =>
  suggestions.find((s) => isAllowRules(s) && s.proposal !== "exact");

/** Writer's "This exact command" proposal (Bash with no CLI rule). */
const exactRule = (suggestions: readonly PermissionSuggestion[]) =>
  suggestions.find((s) => isAllowRules(s) && s.proposal === "exact");

/**
 * The rules the user can untick before saving (spec 6.2): Writer's prefix proposal, or a CLI
 * suggestion carrying several rules. Empty when there is nothing to choose.
 */
export function ruleChips(suggestions: readonly PermissionSuggestion[]): string[] {
  const primary = primaryRules(suggestions);
  const rules = ruleContents(primary);
  return primary?.proposal === "prefix" || rules.length > 1 ? rules : [];
}

/**
 * "Always allow" choices, a pure function of the suggestions of the request (spec 6.2): the
 * CLI's, or Writer's Bash proposal when the CLI sent no rule (`bash_rules.rs`). `addRules`
 * offers project and chat scope for the ticked rules (all by default); a Writer proposal adds
 * "This exact command"; `setMode acceptEdits` offers auto-edit.
 */
export function permissionChoices(
  suggestions: readonly PermissionSuggestion[],
  ticked?: readonly string[],
): PermissionChoice[] {
  const out: PermissionChoice[] = [];
  const primary = primaryRules(suggestions);
  if (primary) {
    const chips = ruleChips(suggestions);
    const rules = chips.length > 0 ? [...(ticked ?? chips)] : undefined;
    const rule = rules
      ? rules.map((r) => `${primary.rules?.[0]?.toolName ?? "Bash"}(${r})`).join(", ")
      : ruleText(primary).join(", ") || null;
    out.push({ persist: "project", label: "In this project", rule, rules });
    out.push({ persist: "session", label: "For this chat", rule, rules });
  }
  const exact = exactRule(suggestions);
  if (exact) {
    out.push({
      persist: "project",
      label: "This exact command",
      rule: ruleText(exact).join(", "),
      rules: ruleContents(exact),
    });
  }
  if (suggestions.some((s) => s.type === "setMode" && s.mode === "acceptEdits"))
    out.push({ persist: "accept-edits", label: "Auto-edit files this chat", rule: null });
  return out;
}

/** What Cmd+Shift+Enter answers: the first choice saved in the project. Undefined when the
 *  request offers no rule (an auto-edit-only request stays an "Allow once"). */
export function alwaysChoice(
  suggestions: readonly PermissionSuggestion[],
  ticked?: readonly string[],
): PermissionChoice | undefined {
  return permissionChoices(suggestions, ticked).find((c) => c.persist === "project");
}

/** "The agent wants to run Bash: ls" for the card body (spec 6.2). */
export function permissionSummary(req: PermissionView): string {
  const name = req.displayName ?? req.tool;
  const arg = primaryArg(req.tool, req.input);
  // a sub-agent's request names its role ("Worker wants to edit ...")
  const who = req.by ? roleLabelOf(req.by) : "The agent";
  switch (toolKind(req.tool)) {
    case "execute":
      return `${who} wants to run ${name}${arg ? `: ${truncate(arg, 140)}` : ""}`;
    case "edit": {
      const verb = req.tool === "Write" ? "write" : "edit";
      return `${who} wants to ${verb}${arg ? ` ${truncate(arg, 140)}` : ` with ${name}`}`;
    }
    default:
      return `${who} wants to use ${name}${arg ? `: ${truncate(arg, 140)}` : ""}`;
  }
}

/** Content preview for Edit/Write in "Show details", capped at 200 lines. */
export function editPreview(tool: string, input: unknown): string | null {
  const rec = asRecord(input);
  if (!rec) return null;
  const cap = (s: string) => {
    const lines = s.split("\n");
    return lines.length > 200
      ? `${lines.slice(0, 200).join("\n")}\n… ${lines.length - 200} more lines`
      : s;
  };
  if (tool === "Write" && typeof rec.content === "string") return cap(rec.content);
  if (typeof rec.old_string === "string" && typeof rec.new_string === "string")
    return cap(
      `- ${rec.old_string.split("\n").join("\n- ")}\n+ ${rec.new_string.split("\n").join("\n+ ")}`,
    );
  return null;
}

/** Pretty JSON of a tool input for the expanded row (or the raw partial text while streaming). */
export function inputJson(input: unknown, partial: string): string {
  if (input === undefined) return partial;
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return "(input cannot be shown)";
  }
}
