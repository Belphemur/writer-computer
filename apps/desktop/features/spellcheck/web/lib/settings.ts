// The feature's settings, read in one place: the keys (declared in `../../settings.schema.json`)
// and typed readers over the settings store.
import { useSettingsStore } from "@/stores/settings-store";

export const KEYS = {
  spelling: "spellcheck.check-spelling",
  grammar: "spellcheck.check-grammar",
  style: "spellcheck.check-style",
  dialect: "spellcheck.english-dialect",
  defaultLanguage: "spellcheck.default-language",
  folderLanguages: "spellcheck.folder-languages",
  ignoredRules: "spellcheck.ignored-rules",
} as const;

type Settings = Record<string, unknown>;

const flag = (s: Settings, key: string, fallback: boolean): boolean =>
  typeof s[key] === "boolean" ? (s[key] as boolean) : fallback;

/** Whether any kind of finding is switched on (nothing to ask the backend otherwise). */
export function anyKindEnabled(s: Settings = useSettingsStore.getState().settings): boolean {
  return flag(s, KEYS.spelling, true) || flag(s, KEYS.grammar, true) || flag(s, KEYS.style, false);
}

export function ignoredRules(s: Settings = useSettingsStore.getState().settings): string[] {
  const v = s[KEYS.ignoredRules];
  return Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : [];
}

/** The settings that change what a check returns: when one of them changes, notes are checked
 *  again. A string, so a store subscription compares it by value. */
export function checkSignature(s: Settings = useSettingsStore.getState().settings): string {
  return JSON.stringify(Object.values(KEYS).map((k) => s[k] ?? null));
}
