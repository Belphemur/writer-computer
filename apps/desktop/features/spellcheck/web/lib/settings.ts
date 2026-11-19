// The feature's settings, read in one place: the keys (declared in `../../settings.schema.json`),
// typed readers over the settings store, and the one rule for which checker runs next to the
// LanguageTool plugin (spec `SPECs/spellcheck-spec.md` "LanguageTool").
import { isCommunityPluginRunning } from "@/lib/community-plugins";
import { useSettingsStore } from "@/stores/settings-store";

export const KEYS = {
  spelling: "spellcheck.check-spelling",
  grammar: "spellcheck.check-grammar",
  style: "spellcheck.check-style",
  dialect: "spellcheck.english-dialect",
  defaultLanguage: "spellcheck.default-language",
  folderLanguages: "spellcheck.folder-languages",
  ignoredRules: "spellcheck.ignored-rules",
  languageTool: "spellcheck.provider-with-languagetool",
} as const;

export const LANGUAGETOOL_PLUGIN_ID = "obsidian-languagetool-plugin";

export type LanguageToolChoice = "ask" | "writer" | "languagetool" | "both";
const CHOICES: readonly LanguageToolChoice[] = ["ask", "writer", "languagetool", "both"];

type Settings = Record<string, unknown>;

const flag = (s: Settings, key: string, fallback: boolean): boolean =>
  typeof s[key] === "boolean" ? (s[key] as boolean) : fallback;

/** The stored answer to "which checker next to LanguageTool"; `ask` until the user answered. */
export function languageToolChoice(s: Settings = useSettingsStore.getState().settings) {
  const v = s[KEYS.languageTool];
  return CHOICES.find((c) => c === v) ?? "ask";
}

/** Whether any kind of finding is switched on (nothing to ask the backend otherwise). */
export function anyKindEnabled(s: Settings = useSettingsStore.getState().settings): boolean {
  return flag(s, KEYS.spelling, true) || flag(s, KEYS.grammar, true) || flag(s, KEYS.style, false);
}

/** Does Writer's checker run? Not when the user chose the LanguageTool plugin and it is running.
 *  Before the question is answered it runs: nothing is turned off without the user's word. */
export function writerCheckerActive(s: Settings = useSettingsStore.getState().settings): boolean {
  return !(
    languageToolChoice(s) === "languagetool" && isCommunityPluginRunning(LANGUAGETOOL_PLUGIN_ID)
  );
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
