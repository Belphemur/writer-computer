import { getService } from "@/lib/features/services";
import { getFileName } from "@/lib/paths";

/**
 * Code and text files in the vault (spec: SPECs/code-files-spec.md). The Rust twin is
 * `src-tauri/src/code_files.rs`: the sidebar listing, index and watcher decide what is shown;
 * the built-in feature `code-files` decides what opens in the code editor and provides the rule
 * as the `code-files.rules` service. Core asks here and never imports the feature: with the
 * feature off there is no service, so nothing counts as a code file (the files open as text, as
 * they did before the feature existed).
 */

/** The service id the feature registers (`provides` in its manifest). */
export const CODE_FILES_RULES = "code-files.rules";

/** What the feature offers core: does this file name open as a code file? */
export interface CodeFilesRules {
  isCodeName(name: string): boolean;
}

/** Does this file name open in the code editor? Always false while the feature is off. */
export function isCodeName(name: string): boolean {
  return getService<CodeFilesRules>(CODE_FILES_RULES)?.isCodeName(name) ?? false;
}

/** Does this path open in the code editor? (`.md` and `.base` never do.) */
export function isCodePath(path: string): boolean {
  return isCodeName(getFileName(path));
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

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
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
