import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import shared from "@shared/code-files.json";

/**
 * What the code editor needs to know about a file name: its language, its indentation and the size
 * limits (spec: SPECs/code-files-spec.md). The rules for what counts as a code file are the
 * `code-files.rules` service (`../rules.ts`); this module is only loaded with the editor.
 */

/** Opened read-only with a banner above this many bytes. */
export const CODE_READ_ONLY_BYTES: number = shared.readOnlyBytes;
/** Never read above this many bytes (Rust refuses the read). */
export const CODE_MAX_BYTES: number = shared.maxReadBytes;

/** Files recognised by exact name. */
const CODE_FILE_NAMES: readonly string[] = shared.fileNames;

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Extensions the language data has no filename pattern for, mapped to a language it has (by
 * name). Extensions with no language at all (ex, exs, tf, tfvars, conf, graphql, bat, mk and
 * Makefile, plus the plain-text csv, tsv, log, txt) open without highlighting.
 */
const EXTENSION_LANGUAGE: Record<string, string> = {
  pyi: "python",
  jsonc: "json",
  zsh: "shell",
  fish: "shell",
  dockerfile: "dockerfile",
  gradle: "groovy",
  hh: "c++",
};

/**
 * The language of a file name, resolved from the language data the markdown editor already uses
 * for fenced code (`@codemirror/language-data`). `null` for plain text (txt, log, csv, tsv).
 */
export function codeLanguageFor(name: string): LanguageDescription | null {
  const direct = LanguageDescription.matchFilename(languages, name);
  if (direct) return direct;
  const alias = EXTENSION_LANGUAGE[extOf(name)];
  if (alias) {
    const byName = LanguageDescription.matchLanguageName(languages, alias, true);
    if (byName) return byName;
  }
  return null;
}

export interface IndentStyle {
  /** `"\t"` or that many spaces. */
  unit: string;
  /** `true` when the unit is a tab. */
  tabs: boolean;
  /** Width of one indent level in columns (and the tab width). */
  size: number;
}

const TAB_FILES = new Set(["go", "mk"]);
const TWO_SPACE = new Set([
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "html",
  "htm",
  "xml",
  "css",
  "scss",
  "less",
  "vue",
  "svelte",
  "rb",
  "lua",
  "ex",
  "exs",
  "dart",
  "tf",
  "tfvars",
  "graphql",
  "proto",
  "sql",
  "sh",
  "bash",
  "zsh",
  "fish",
  "scala",
]);

/** Per-language default: tabs for Go and Makefiles, two spaces for web/config/shell, else four. */
export function defaultIndentFor(name: string): IndentStyle {
  const ext = extOf(name);
  if (TAB_FILES.has(ext) || CODE_FILE_NAMES.includes(name)) {
    if (name === "Dockerfile") return { unit: "  ", tabs: false, size: 2 };
    return { unit: "\t", tabs: true, size: 4 };
  }
  if (TWO_SPACE.has(ext)) return { unit: "  ", tabs: false, size: 2 };
  return { unit: "    ", tabs: false, size: 4 };
}

/** Look at the first lines of a file for the indentation it already uses; fall back to `fallback`. */
export function detectIndent(text: string, fallback: IndentStyle): IndentStyle {
  let tabLines = 0;
  let spaceLines = 0;
  const counts = new Map<number, number>();
  let previous = 0;
  let scanned = 0;
  for (const line of text.split("\n", 400)) {
    if (line.trim() === "") continue;
    if (line.startsWith("\t")) {
      tabLines += 1;
    } else if (line.startsWith("  ")) {
      spaceLines += 1;
      const indent = line.length - line.trimStart().length;
      const step = Math.abs(indent - previous);
      if (step >= 2 && step <= 8) counts.set(step, (counts.get(step) ?? 0) + 1);
      previous = indent;
    } else {
      previous = 0;
    }
    scanned += 1;
    if (scanned >= 300) break;
  }
  if (tabLines === 0 && spaceLines === 0) return fallback;
  if (tabLines > spaceLines)
    return { unit: "\t", tabs: true, size: fallback.tabs ? fallback.size : 4 };
  let best = 0;
  let size = fallback.tabs ? 4 : fallback.size;
  for (const [step, n] of counts) {
    if (n > best || (n === best && step < size)) {
      best = n;
      size = step;
    }
  }
  return { unit: " ".repeat(size), tabs: false, size };
}

/** Is this content past the read-only threshold (UTF-16 units approximate bytes)? */
export function isOverReadOnlyLimit(content: string): boolean {
  return content.length > CODE_READ_ONLY_BYTES;
}
