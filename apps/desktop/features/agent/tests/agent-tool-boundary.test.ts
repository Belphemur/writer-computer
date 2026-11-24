/**
 * The boundary of the tool table (spec `SPECs/opencode-backend-spec.md` section 11, phase 1): the
 * web half of the agent spells no Claude tool name in code. A tool is its table's row
 * (`shared/agent-tools/claude.json`); its words and roles come from there. Comments may name
 * tools (they explain), string literals may not. The Rust twin is `agent/boundary_tests.rs`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import table from "@shared/agent-tools/claude.json";
import { mcpPrefix } from "../web/lib/tool-kinds";

const WEB = fileURLToPath(new URL("../web", import.meta.url));

/**
 * Every name to look for, from the table: each row, the `protocolOnly` names (known to the
 * protocol, no row) and the MCP prefix. One list for both checks below.
 */
const NAMES: string[] = [
  ...table.tools.map((t) => t.name),
  ...(table as { protocolOnly: string[] }).protocolOnly,
];
const alternatives = NAMES.join("|");

/**
 * A Claude tool name used as a name (a whole literal, or the head of a rule such as `Name(...)`),
 * or the prefix of Writer's own MCP tools. The interface's sentences ("Edit a file") are words,
 * not tool names, and are not looked at: the Rust twin scans prose too, because the prompt there
 * is what a model reads.
 */
const TOOL_NAME = new RegExp(`^(${alternatives})(\\(.*)?$|${mcpPrefix(table.mcp, "writer")}`);

/** The files with generated or fixture content: the bindings are specta's, the mock is a fake. */
const SKIPPED = new Set(["bindings.ts"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !SKIPPED.has(name)) out.push(path);
  }
  return out;
}

/** An object key spelled as a tool name: `Bash: {` (the old registry was keyed like that). */
const TOOL_KEY = new RegExp(`(^|[{,])\\s*(${alternatives})\\s*:`, "m");

/** `code` without comments and string contents (line numbers kept). */
function bare(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (code.startsWith("//", i)) {
      while (i < code.length && code[i] !== "\n") i++;
    } else if (code.startsWith("/*", i)) {
      const end = code.indexOf("*/", i + 2);
      const stop = end < 0 ? code.length : end + 2;
      out += code.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) {
        if (code[j] === "\\") j++;
        j++;
      }
      out += code.slice(i, j + 1).replace(/[^\n]/g, " ");
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The string literals of `code` outside comments, with their line. */
function literals(code: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  let i = 0;
  let line = 1;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "\n") line++;
    if (code.startsWith("//", i)) {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (code.startsWith("/*", i)) {
      const end = code.indexOf("*/", i + 2);
      const stop = end < 0 ? code.length : end + 2;
      line += code.slice(i, stop).split("\n").length - 1;
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) {
        if (code[j] === "\\") j++;
        if (code[j] === "\n") line++;
        j++;
      }
      found.push({ line, text: code.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    i++;
  }
  return found;
}

/**
 * Words of the interface that are not tool names, by file: the pane's own title. Exact literals,
 * listed so a tool name cannot hide behind a broad allowance.
 */
const UI_WORDS: Record<string, string[]> = {
  "index.ts": ["Agent"],
  "components/agent-pane.tsx": ["Agent"],
  "components/project-switcher.tsx": ["Agent"],
  // the label of the `read` kind in the permission picker
  "lib/tool-kinds.ts": ["Read"],
};

describe("tool names stay in the table", () => {
  it("finds no Claude tool name in a string literal of the web half", () => {
    const files = sources(WEB);
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(WEB, file);
      const allowed = UI_WORDS[rel] ?? [];
      const code = readFileSync(file, "utf8");
      if (TOOL_KEY.test(bare(code))) offenders.push(`${rel} keys an object by a tool name`);
      for (const { line, text } of literals(code)) {
        if (TOOL_NAME.test(text) && !allowed.includes(text))
          offenders.push(`${rel}:${line} ${text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("would see a tool name in a literal and ignore it in a comment", () => {
    const code =
      '// "Bash" in a comment\nconst a = "Edit a file";\nconst b = `Bash(ls)`;\n/* "Edit" */';
    const hits = literals(code).filter((l) => TOOL_NAME.test(l.text));
    expect(hits).toEqual([{ line: 3, text: "Bash(ls)" }]);
  });

  it("looks for every row of the table and the protocol-only names, not a copied list", () => {
    for (const name of ["BashOutput", "KillShell", "WebFetch", "AskUserQuestion", "TodoWrite"]) {
      expect(TOOL_NAME.test(name)).toBe(true);
      expect(TOOL_KEY.test(bare(`const t = { ${name}: 1 };`))).toBe(true);
    }
    expect(TOOL_NAME.test(`${mcpPrefix(table.mcp, "writer")}search`)).toBe(true);
    expect(TOOL_NAME.test("Bashful")).toBe(false);
  });

  it("would see a tool name used as an object key", () => {
    expect(TOOL_KEY.test(bare("const t = {\n  Bash: { kind: 1 },\n};"))).toBe(true);
    expect(TOOL_KEY.test(bare('const t = { "x": 1 }; // Bash: no'))).toBe(false);
  });
});
