import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import shared from "@shared/code-files.json";
import schema from "@shared/settings.schema.json";
import { getFileName } from "@/lib/paths";

/**
 * Code and text files in the vault (spec: SPECs/code-files-spec.md). The Rust twin is
 * `src-tauri/src/code_files.rs`: the sidebar listing, index and watcher decide what is shown;
 * this module decides what opens in the code editor and how (language, indentation, size).
 */

/** Opened read-only with a banner above this many bytes. */
export const CODE_READ_ONLY_BYTES: number = shared.readOnlyBytes;
/** Never read above this many bytes (Rust refuses the read). */
export const CODE_MAX_BYTES: number = shared.maxReadBytes;

/** Default `files.code-extensions`: the schema default, the one place the list lives. */
export const DEFAULT_CODE_EXTENSIONS: readonly string[] =
  (schema.settings.find((s) => s.key === "files.code-extensions")?.default as string[]) ?? [];

/** Files recognised by exact name. */
export const CODE_FILE_NAMES: readonly string[] = shared.fileNames;

/** Extensions no setting can enable (secrets, formats with their own viewer). */
const NEVER_EXTENSIONS = new Set(shared.neverExtensions);

let configured: ReadonlySet<string> = new Set(DEFAULT_CODE_EXTENSIONS);

/** Apply `files.code-extensions` (called when settings hydrate). Anything but a list keeps the default. */
export function configureCodeFiles(list: unknown): void {
  if (!Array.isArray(list)) {
    configured = new Set(DEFAULT_CODE_EXTENSIONS);
    return;
  }
  configured = new Set(
    list
      .filter((e): e is string => typeof e === "string")
      .map((e) => e.trim().replace(/^\./, "").toLowerCase())
      .filter((e) => e !== "" && !NEVER_EXTENSIONS.has(e)),
  );
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Secret-looking names are never code files, whatever the extension setting says. */
export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env")) return true;
  if (shared.secretKeyPrefixes.some((p) => lower.startsWith(p))) return true;
  const dot = lower.lastIndexOf(".");
  const stem = dot > 0 ? lower.slice(0, dot) : lower;
  return shared.secretNameWords.some((w) => stem.includes(w));
}

/** Does this file name open in the code editor? */
export function isCodeName(name: string): boolean {
  if (name.startsWith(".") && extOf(name) === "") return false;
  if (isSecretName(name)) return false;
  if (CODE_FILE_NAMES.includes(name)) return true;
  const ext = extOf(name);
  return ext !== "" && configured.has(ext);
}

/** Does this path open in the code editor? (`.md` and `.base` never do.) */
export function isCodePath(path: string): boolean {
  return isCodeName(getFileName(path));
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

/** An agent skills tree path (`<root>/.agents/skills/...` or `.claude/skills`)? */
export function agentSkillDir(path: string, root: string | null): string | null {
  if (!root) return null;
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.startsWith(normalizedRoot + "/")) return null;
  const rel = normalized.slice(normalizedRoot.length + 1).split("/");
  if ((rel[0] === ".agents" || rel[0] === ".claude") && rel[1] === "skills" && rel.length >= 3) {
    return `${normalizedRoot}/${rel[0]}/skills/${rel[2]}`;
  }
  return null;
}

/** Top-level `.agents` / `.claude` folder or their `skills` folder (badged "agent skills"). */
export function isAgentFolderPath(path: string, root: string | null): boolean {
  if (!root) return false;
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const normalized = path.replace(/\\/g, "/");
  if (!normalized.startsWith(normalizedRoot + "/")) return false;
  const rel = normalized.slice(normalizedRoot.length + 1);
  return (
    rel === ".agents" || rel === ".claude" || rel === ".agents/skills" || rel === ".claude/skills"
  );
}

export type CodeIconFamily = "script" | "code" | "web" | "config" | "table" | "text" | "sql";

const FAMILY: Record<string, CodeIconFamily> = {
  sh: "script",
  bash: "script",
  zsh: "script",
  fish: "script",
  ps1: "script",
  bat: "script",
  mk: "script",
  html: "web",
  htm: "web",
  css: "web",
  scss: "web",
  less: "web",
  xml: "web",
  vue: "web",
  svelte: "web",
  json: "config",
  jsonc: "config",
  yaml: "config",
  yml: "config",
  toml: "config",
  ini: "config",
  conf: "config",
  cfg: "config",
  tf: "config",
  tfvars: "config",
  csv: "table",
  tsv: "table",
  txt: "text",
  log: "text",
  sql: "sql",
};

/** The glyph family of a code file name (`code` for the rest). */
export function codeIconFamily(name: string): CodeIconFamily {
  if (name === "Makefile" || name === "GNUmakefile") return "script";
  if (name === "Dockerfile") return "config";
  return FAMILY[extOf(name)] ?? "code";
}
