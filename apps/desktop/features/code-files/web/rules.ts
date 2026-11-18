import shared from "@shared/code-files.json";
import { useSettingsStore } from "@/stores/settings-store";
import type { CodeFilesRules } from "@/lib/code-files";
import fragment from "../settings.schema.json";

/**
 * Which file names are code files (spec: SPECs/code-files-spec.md). The Rust twin is
 * `src-tauri/src/code_files.rs`; the shared data is `shared/code-files.json`, the defaults are the
 * ones of `../settings.schema.json`. Registered as the `code-files.rules` service, so this file
 * is in the startup chunk: it stays tiny and imports no editor code.
 */

export const EXTENSIONS_SETTING = "code-files.extensions";

/** Default `code-files.extensions`: the fragment's default, the one place the list lives. */
export const DEFAULT_CODE_EXTENSIONS: readonly string[] =
  (fragment.settings.find((s) => s.key === EXTENSIONS_SETTING)?.default as string[]) ?? [];

/** Files recognised by exact name. */
const CODE_FILE_NAMES: readonly string[] = shared.fileNames;

/** Extensions no setting can enable (secrets, formats with their own viewer). */
const NEVER_EXTENSIONS = new Set(shared.neverExtensions);

/** The setting as a set: anything but a list is the default; secrets and notes are dropped. */
function toSet(list: unknown): ReadonlySet<string> {
  if (!Array.isArray(list)) return new Set(DEFAULT_CODE_EXTENSIONS);
  return new Set(
    list
      .filter((e): e is string => typeof e === "string")
      .map((e) => e.trim().replace(/^\./, "").toLowerCase())
      .filter((e) => e !== "" && !NEVER_EXTENSIONS.has(e)),
  );
}

// The set is rebuilt only when the settings hold another list (the store replaces it on a change).
let builtFrom: unknown = Symbol("unread");
let built: ReadonlySet<string> = new Set();
function extensions(): ReadonlySet<string> {
  const list = useSettingsStore.getState().settings[EXTENSIONS_SETTING];
  if (list !== builtFrom) {
    builtFrom = list;
    built = toSet(list);
  }
  return built;
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
  return ext !== "" && extensions().has(ext);
}

export const codeFilesRules: CodeFilesRules = { isCodeName };
