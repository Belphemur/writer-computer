// The feature's settings, read in one place: the keys (declared in `../../settings.schema.json`),
// the rule registry (`../../rules.json`, the file Rust reads too) and typed readers over the
// settings store. `enabledRules` is the twin of `lint::Options::from_lookup`: the rules on are
// the registry's defaults, plus `lint.rules-on`, minus `lint.rules-off`.
import { useSettingsStore } from "@/stores/settings-store";
import registry from "../../rules.json";

export const KEYS = {
  on: "lint.rules-on",
  off: "lint.rules-off",
  fixOnSave: "lint.fix-on-save",
} as const;

export interface RuleInfo {
  id: string;
  name: string;
  /** Its fix changes formatting only: the rules fix-on-save runs. */
  safe: boolean;
  default: boolean;
  fixable: boolean;
}

export const RULES: readonly RuleInfo[] = registry.rules;

type Settings = Record<string, unknown>;

const current = () => useSettingsStore.getState().settings;

/** A list setting as the store holds it: a config file reads a list of one as a plain string. */
function listOf(s: Settings, key: string): string[] {
  const v = s[key];
  if (Array.isArray(v)) return v.filter((r): r is string => typeof r === "string");
  return typeof v === "string" && v !== "" ? [v] : [];
}

/** The ids of the rules that are on. */
export function enabledRules(s: Settings = current()): ReadonlySet<string> {
  const off = new Set(listOf(s, KEYS.off));
  const on = new Set(listOf(s, KEYS.on));
  return new Set(
    RULES.filter((r) => (r.default || on.has(r.id)) && !off.has(r.id)).map((r) => r.id),
  );
}

/** Does some rule that fix-on-save runs (a safe one) stand on? */
export function anySafeRuleEnabled(s: Settings = current()): boolean {
  const on = enabledRules(s);
  return RULES.some((r) => r.safe && on.has(r.id));
}

export function fixOnSaveEnabled(s: Settings = current()): boolean {
  const v = s[KEYS.fixOnSave];
  return typeof v === "boolean" ? v : true;
}

/** The two lists after switching `id` on or off: only the difference from the defaults is kept. */
export function listsWith(
  s: Settings,
  id: string,
  enabled: boolean,
): { on: string[]; off: string[] } {
  const rule = RULES.find((r) => r.id === id);
  const without = (xs: string[]) => xs.filter((x) => x !== id);
  let on = without(listOf(s, KEYS.on));
  let off = without(listOf(s, KEYS.off));
  if (rule && enabled !== rule.default) {
    if (enabled) on = [...on, id];
    else off = [...off, id];
  }
  return { on, off };
}

export async function setRule(id: string, enabled: boolean): Promise<void> {
  const { on, off } = listsWith(current(), id, enabled);
  const { setSetting } = useSettingsStore.getState();
  await setSetting(KEYS.on, on);
  await setSetting(KEYS.off, off);
}

/** What changes the findings: when it changes, notes are linted again. A string, so a store
 *  subscription compares it by value. */
export function lintSignature(s: Settings = current()): string {
  return [...enabledRules(s)].sort().join(",");
}
