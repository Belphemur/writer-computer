// Core commands called by a literal `invoke("name", { ... })` send the argument names Tauri reads:
// the Rust parameter names in camelCase (`update_links` is `updateLinks`), every required one
// present, none unknown. A snake_case key is dropped by Tauri and the command fails at runtime;
// this reads the Rust signatures, so the TypeScript spelling cannot drift from them. Feature
// commands go through generated bindings instead (`tests/helpers/feature-ipc.ts`).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { DESKTOP } from "./helpers/import-graph";

const camel = (snake: string) => snake.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

function walk(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir) as string[]) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules" && name !== "tests") out.push(...walk(path, keep));
    } else if (keep(name)) out.push(path);
  }
  return out;
}

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
  const files = walk(join(DESKTOP, "src-tauri/src"), (n) => n.endsWith(".rs"));
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

/** Every literal `invoke("name", { ... })` of the core web code and of the features' web code. */
function invokeCalls(known: ReadonlySet<string>): Call[] {
  const files = [
    ...walk(join(DESKTOP, "src"), (n) => /\.tsx?$/.test(n)),
    ...walk(join(DESKTOP, "features"), (n) => /\.tsx?$/.test(n)).filter((f) => f.includes("/web/")),
  ].filter((f) => !f.endsWith("bindings.ts") && !/\.test\./.test(f));
  const calls: Call[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\b(\w+)(?:<[^>(]*>)?\(\s*"(\w+)"\s*(,\s*)?/g)) {
      // `invoke("x")` must name a command; a wrapper over it (`call("x", {...})`, `traceIpc`) is
      // read when it names one, which keeps `expect("x", {...})` and the like out.
      if (m[1] !== "invoke" && !known.has(m[2]!)) continue;
      let keys: string[] = [];
      const at = m.index! + m[0].length;
      const literal = m[3] !== undefined && src[at] === "{";
      if (m[1] !== "invoke" && !literal) continue;
      if (literal) {
        keys = topLevel(balanced(src, at, TS), TS).map((p) => p.split(":")[0]!.trim());
      }
      calls.push({ file: relative(DESKTOP, file), command: m[2]!, keys });
    }
  }
  return calls;
}

describe("core command calls", () => {
  const commands = rustCommands();
  const calls = invokeCalls(new Set(commands.keys()));

  it("reads the Rust commands and the calls (a parser that finds none passes nothing)", () => {
    expect(commands.size).toBeGreaterThan(100);
    expect(calls.length).toBeGreaterThan(100);
  });

  it("call a command that exists, with the argument names Tauri reads", () => {
    const problems: string[] = [];
    for (const { file, command, keys } of calls) {
      const params = commands.get(command);
      if (!params) {
        problems.push(`${file}: no Rust command ${command}`);
        continue;
      }
      const known = new Set(params.map((p) => p.key));
      for (const k of keys) {
        if (!k.startsWith("...") && !known.has(k))
          problems.push(`${file}: ${command} has no argument "${k}" (${[...known]})`);
      }
      // A spread (`...args`) hides its keys: the required ones can only be checked without one.
      if (keys.some((k) => k.startsWith("..."))) continue;
      for (const p of params) {
        if (!p.optional && !keys.includes(p.key)) {
          problems.push(`${file}: ${command} is missing "${p.key}"`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
