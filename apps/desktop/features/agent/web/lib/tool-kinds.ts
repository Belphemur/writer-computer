/**
 * One registry for how a tool is named, grouped and summarised (docs/consolidation.md): the
 * permission card's "Type" line, the timeline row label and the group header all read it. The
 * tools themselves are data, a backend's table (`shared/agent-tools/<backend>.json`, spec
 * `SPECs/opencode-backend-spec.md` A11) that the Rust side reads too: this file spells no tool name.
 */
import claudeTable from "@shared/agent-tools/claude.json";
import writerMcp from "@shared/agent-tools/writer-mcp.json";
import { roleLabelOf } from "./agent-roles";
import type { PermissionPersist, PermissionSuggestion } from "./events";
import type { PermissionView } from "./transcript";

/** The neutral kinds: `shared/agent-tools/kinds.json` is the list (the Rust `Kind` and its test read
 * it too); `TOOL_KIND_KEYS` below makes the compiler hold this union to it. */
export type ToolKind = "execute" | "edit" | "read" | "search" | "fetch" | "agent" | "other";

/** Every `ToolKind` once: a kind added to the union and not here (or the reverse) fails to compile,
 * and the table test compares the keys with the shared list. */
export const TOOL_KIND_KEYS: Record<ToolKind, true> = {
  execute: true,
  edit: true,
  read: true,
  search: true,
  fetch: true,
  agent: true,
  other: true,
};

/** What shared code asks of a tool beyond its kind (the Rust `Role`). */
export type ToolRole =
  | "read"
  | "shell"
  | "replace"
  | "multi-replace"
  | "create"
  | "launch"
  | "handback"
  | "codemode"
  | "question";

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
  role?: ToolRole;
  /** The input keys of an edit (`old`, `new`, `content`), when the table names them. */
  args?: { old?: string; new?: string; content?: string };
};

/** A row of a table: the fields a row may leave to the table's `fallback`. */
type TableRow = {
  name?: string;
  kind: ToolKind;
  role?: ToolRole;
  past?: string;
  present?: string;
  noun?: [string, string];
  readsFile?: boolean;
  args?: { primary?: string[]; old?: string; new?: string; content?: string };
};

type ToolTable = {
  fallback: TableRow;
  tools: TableRow[];
  mcp?: { prefix: string };
};

/** A row completed with the fallback's words. */
function specOf(row: TableRow, fallback: TableRow): ToolSpec {
  return {
    kind: row.kind,
    past: row.past ?? fallback.past ?? "",
    present: row.present ?? fallback.present ?? "",
    primary: row.args?.primary ?? fallback.args?.primary ?? [],
    noun: row.noun ?? fallback.noun ?? ["tool", "tools"],
    ...(row.readsFile ? { readsFile: true } : {}),
    ...(row.role ? { role: row.role } : {}),
    ...(row.args ? { args: row.args } : {}),
  };
}

/** The tools of a table by name, and the classes of Writer's own MCP tools. */
export function buildSpecs(table: ToolTable) {
  const specs = new Map<string, ToolSpec>(
    table.tools.map((row) => [row.name ?? "", specOf(row, table.fallback)]),
  );
  const mcp = table.mcp && {
    prefix: table.mcp.prefix,
    // what each command is does not depend on the backend: one shared file
    classes: (writerMcp.classes as unknown as (TableRow & { match: string })[]).map((c) => ({
      match: new RegExp(c.match),
      spec: specOf(c, table.fallback),
    })),
  };
  return { specs, mcp, fallback: specOf(table.fallback, table.fallback), table };
}

const TABLE = buildSpecs(claudeTable as unknown as ToolTable);

/** The spec of a Writer MCP tool by its command; undefined for the others. */
function mcpToolSpec(tool: string): ToolSpec | undefined {
  const mcp = TABLE.mcp;
  if (!mcp?.prefix || !tool.startsWith(mcp.prefix)) return undefined;
  const command = tool.slice(mcp.prefix.length);
  return mcp.classes.find((c) => c.match.test(command))?.spec;
}

export const toolSpec = (tool: string): ToolSpec =>
  TABLE.specs.get(tool) ?? mcpToolSpec(tool) ?? TABLE.fallback;
export const toolKind = (tool: string): ToolKind => toolSpec(tool).kind;
export const readsFile = (tool: string): boolean => toolSpec(tool).readsFile === true;
/** The role of a tool, when it has one (`shell`, `create`, `launch` ...). */
export const toolRole = (tool: string): ToolRole | undefined => toolSpec(tool).role;
/** The name of the first tool with `role` in the table (the one a rule is written for). */
export const toolNameOf = (role: ToolRole): string | undefined =>
  TABLE.table.tools.find((t) => t.role === role)?.name;

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
  /** The rule text, when the choice adds one (the shell tool and its prefix: `<shell>(ls:*)`). */
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
      ? rules
          .map((r) => `${primary.rules?.[0]?.toolName ?? toolNameOf("shell") ?? ""}(${r})`)
          .join(", ")
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
      const verb = toolRole(req.tool) === "create" ? "write" : "edit";
      return `${who} wants to ${verb}${arg ? ` ${truncate(arg, 140)}` : ` with ${name}`}`;
    }
    default:
      return `${who} wants to use ${name}${arg ? `: ${truncate(arg, 140)}` : ""}`;
  }
}

/** Content preview for an edit in "Show details" (a replacement or a new file), capped at 200 lines. */
export function editPreview(tool: string, input: unknown): string | null {
  const rec = asRecord(input);
  if (!rec) return null;
  const cap = (s: string) => {
    const lines = s.split("\n");
    return lines.length > 200
      ? `${lines.slice(0, 200).join("\n")}\n… ${lines.length - 200} more lines`
      : s;
  };
  const keys = toolSpec(tool).args;
  const content = keys?.content && rec[keys.content];
  if (toolRole(tool) === "create" && typeof content === "string") return cap(content);
  const from = keys?.old && rec[keys.old];
  const to = keys?.new && rec[keys.new];
  if (typeof from === "string" && typeof to === "string")
    return cap(`- ${from.split("\n").join("\n- ")}\n+ ${to.split("\n").join("\n+ ")}`);
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
