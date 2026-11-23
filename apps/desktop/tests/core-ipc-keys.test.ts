// Core commands called by a literal `invoke("name", { ... })` send the argument names Tauri reads:
// the Rust parameter names in camelCase (`update_links` is `updateLinks`), every required one
// present, none unknown. A snake_case key is dropped by Tauri and the command fails at runtime;
// this reads the Rust signatures, so the TypeScript spelling cannot drift from them. Feature
// commands go through generated bindings instead (`tests/helpers/feature-ipc.ts`).
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { DESKTOP, sourceFiles } from "./helpers/import-graph";

const camel = (snake: string) => snake.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

/** What brackets nest and what quotes a string: Rust has generics and lifetimes, TypeScript has
 *  comparisons. */
interface Lang {
  open: string;
  close: string;
  quotes: string;
}
const RUST: Lang = { open: "([{<", close: ")]}>", quotes: '"' };
const TS: Lang = { open: "([{", close: ")]}", quotes: "\"'`" };

/** The index just past a quoted string starting at `i`. */
function skipString(text: string, i: number): number {
  const q = text[i]!;
  for (i++; i < text.length && text[i] !== q; i++) if (text[i] === "\\") i++;
  return i + 1;
}

/** The text between the bracket at `open` and its match. */
function balanced(text: string, open: number, lang: Lang): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (lang.quotes.includes(c)) i = skipString(text, i) - 1;
    else if (lang.open.includes(c)) depth++;
    else if (lang.close.includes(c) && text[i - 1] !== "-") {
      if (--depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced");
}

/** Top-level comma-separated parts of a parameter or property list. */
function topLevel(text: string, lang: Lang): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (lang.quotes.includes(c)) {
      const end = skipString(text, i);
      cur += text.slice(i, end);
      i = end - 1;
      continue;
    }
    if (lang.open.includes(c)) depth++;
    if (lang.close.includes(c) && text[i - 1] !== "-") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

interface Param {
  key: string;
  optional: boolean;
}

const INJECTED = /^(tauri::)?(State|AppHandle|Window|WebviewWindow|Webview)\b|^tauri::ipc::Request/;

/** Every `#[tauri::command]` of the core: name to the arguments the web side sends. */
function rustCommands(): Map<string, Param[]> {
  const out = new Map<string, Param[]>();
  const files = sourceFiles(join(DESKTOP, "src-tauri/src"), (n) => n.endsWith(".rs"));
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(
      /#\[(?:tauri::)?command[^\]]*\](?:\s*#\[[^\]]*\]|\s*\/\/\/[^\n]*)*\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\(/g,
    )) {
      const params = topLevel(balanced(src, m.index! + m[0].length - 1, RUST), RUST)
        .map((p) => {
          const colon = p.indexOf(":");
          return { name: p.slice(0, colon).trim(), type: p.slice(colon + 1).trim() };
        })
        .filter((p) => !INJECTED.test(p.type));
      out.set(
        m[1]!,
        params.map((p) => ({ key: camel(p.name), optional: p.type.startsWith("Option<") })),
      );
    }
  }
  return out;
}

interface Call {
  file: string;
  command: string;
  keys: string[];
}

/** A generic argument list, one level of nesting inside (`invoke<Record<string, number>>`). */
const GENERIC = "(?:<(?:[^<>()]|<[^<>]*>)*>)?";

/** The calls of one file that name a command with an object literal, and the `invoke(` calls this
 *  cannot read (a name held in a variable): those must be accounted for, not silently skipped. */
export function callsIn(
  file: string,
  src: string,
  known: ReadonlySet<string>,
): { calls: Call[]; skipped: string[] } {
  const calls: Call[] = [];
  const read = new Set<number>();
  for (const m of src.matchAll(new RegExp(`\\b(\\w+)${GENERIC}\\(\\s*"(\\w+)"\\s*(,\\s*)?`, "g"))) {
    // `invoke("x")` must name a command; a wrapper over it (`call("x", {...})`, `traceIpc`) is
    // read when it names one, which keeps `expect("x", {...})` and the like out.
    if (m[1] !== "invoke" && !known.has(m[2]!)) continue;
    let keys: string[] = [];
    const at = m.index! + m[0].length;
    const literal = m[3] !== undefined && src[at] === "{";
    if (m[1] !== "invoke" && !literal) continue;
    if (literal) keys = topLevel(balanced(src, at, TS), TS).map((p) => p.split(":")[0]!.trim());
    read.add(m.index!);
    calls.push({ file, command: m[2]!, keys });
  }
  const skipped = [...src.matchAll(new RegExp(`\\binvoke${GENERIC}\\(`, "g"))]
    .filter((m) => !read.has(m.index!))
    .map(() => file);
  return { calls, skipped };
}

/** What is wrong with `calls` against the Rust commands. */
export function callProblems(calls: Call[], commands: Map<string, Param[]>): string[] {
  const problems: string[] = [];
  for (const { file, command, keys } of calls) {
    const params = commands.get(command);
    if (!params) {
      problems.push(`${file}: no Rust command ${command}`);
      continue;
    }
    const known = new Set(params.map((p) => p.key));
    for (const k of keys) {
      if (!k.startsWith("...") && !known.has(k)) {
        problems.push(`${file}: ${command} has no argument "${k}" (${[...known]})`);
      }
    }
    // A spread (`...args`) hides its keys: the required ones can only be checked without one.
    if (keys.some((k) => k.startsWith("..."))) continue;
    for (const p of params) {
      if (!p.optional && !keys.includes(p.key))
        problems.push(`${file}: ${command} is missing "${p.key}"`);
    }
  }
  return problems;
}

/** The files with an `invoke(` whose name this cannot read, and why: the plugin host's own
 *  wrappers take the name as a parameter (their callers' literal names are read through the
 *  `call("x", {...})` form above), `featureInvoke` builds `plugin:<id>|<cmd>` (pinned by
 *  `describeFeatureIpc`), and two files only mention `invoke(` in a comment or a message. */
const UNREAD = new Set([
  "features/obsidian-host/web/host/store-client.ts",
  "features/obsidian-host/web/host/api/vault-io-tauri.ts",
  "src/lib/features/ipc.ts",
  "features/agent/web/ipc.ts",
  "features/obsidian-host/web/host/node/misc.ts",
]);

/** Every call of the core web code and of the features' web code. */
function scan(known: ReadonlySet<string>) {
  const files = [
    ...sourceFiles(join(DESKTOP, "src")),
    ...sourceFiles(join(DESKTOP, "features")).filter((f: string) => f.includes("/web/")),
  ].filter((f: string) => !f.endsWith("bindings.ts") && !/\.test\./.test(f));
  const out = { calls: [] as Call[], skipped: [] as string[] };
  for (const file of files) {
    const r = callsIn(relative(DESKTOP, file), readFileSync(file, "utf8"), known);
    out.calls.push(...r.calls);
    out.skipped.push(...r.skipped);
  }
  return out;
}

describe("core command calls", () => {
  const commands = rustCommands();
  const { calls, skipped } = scan(new Set(commands.keys()));

  it("reads the Rust commands and the calls (a parser that finds none passes nothing)", () => {
    expect(commands.size).toBeGreaterThan(100);
    expect(calls.length).toBeGreaterThan(100);
  });

  it("call a command that exists, with the argument names Tauri reads", () => {
    expect(callProblems(calls, commands)).toEqual([]);
  });

  it("leave unread only the calls whose name is a variable, in the known wrappers", () => {
    expect([...new Set(skipped)].filter((f) => !UNREAD.has(f))).toEqual([]);
  });

  it("reports a wrong key behind a generic argument", () => {
    const src = 'invoke<Record<string, number>>("read_file", { pth: "x" });';
    const r = callsIn("x.ts", src, new Set(commands.keys()));
    expect(r.skipped).toEqual([]);
    expect(callProblems(r.calls, commands)).toEqual([
      expect.stringContaining('read_file has no argument "pth"'),
      expect.stringContaining('read_file is missing "path"'),
    ]);
  });
});
