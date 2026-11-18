// What the page changes, every one through `hotkeyOverrides.update` (the one write path): record
// a key (replace or add), reassign it from the command that has it, remove one key, reset one
// command or all, import from Obsidian. The registry resolves the rest (SPECs/hotkeys-spec.md).
import { hotkeysReadObsidian } from "@/lib/tauri";
import { normalizeChord } from "@/lib/keybindings/chord";
import { hotkeyOverrides, type HotkeyOverrides } from "@/lib/keybindings/overrides";
import { keybindings, type KeybindingRegistry } from "@/lib/keybindings/registry";
import { mapObsidianHotkeys, type ImportResult } from "./model";

/** What stands in the way of binding `chord` to `id`: nothing, a refusal, or another command. */
export type Check =
  | { kind: "ok" }
  | { kind: "refused"; reason: "reserved" | "needs-modifier" }
  | { kind: "conflict"; id: string };

export function checkChord(
  id: string,
  chord: string,
  registry: KeybindingRegistry = keybindings,
): Check {
  const reason = registry.refusal(chord);
  if (reason) return { kind: "refused", reason };
  const other = registry.conflictFor(id, chord);
  return other ? { kind: "conflict", id: other.id } : { kind: "ok" };
}

/** The one-line reason a key is refused. */
export const REFUSAL_TEXT = {
  reserved: "Reserved by the system",
  "needs-modifier": "Needs Cmd, Ctrl or Alt",
} as const;

/** Keys equal to the defaults are stored as "no override", so the command is not marked modified. */
function keysFor(
  registry: KeybindingRegistry,
  id: string,
  keys: readonly string[],
): readonly string[] | null {
  const defaults = registry.defaultKeys(id);
  return keys.length === defaults.length && keys.every((k, i) => k === defaults[i]) ? null : keys;
}

export interface RecordOptions {
  /** `add`: another key next to the existing ones; `replace`: this key alone. */
  mode: "replace" | "add";
  /** Take the key from the command that has it (a conflict), in the same save. */
  reassign?: boolean;
}

/** Binds `chord` to `id`. Rejects when the key is refused or taken and `reassign` is not set. */
export function recordKey(
  id: string,
  chord: string,
  { mode, reassign }: RecordOptions,
  overrides: HotkeyOverrides = hotkeyOverrides,
  registry: KeybindingRegistry = keybindings,
): Promise<void> {
  const key = normalizeChord(chord);
  const check = checkChord(id, key, registry);
  if (check.kind === "refused") return Promise.reject(new Error(REFUSAL_TEXT[check.reason]));
  if (check.kind === "conflict" && !reassign)
    return Promise.reject(new Error("That key is used by another command"));
  return overrides.update((_, set) => {
    if (check.kind === "conflict") {
      const rest = registry.effectiveKeys(check.id).filter((k) => k !== key);
      set(check.id, keysFor(registry, check.id, rest));
    }
    const mine = mode === "add" ? registry.effectiveKeys(id) : [];
    set(id, keysFor(registry, id, [...mine.filter((k) => k !== key), key]));
  });
}

export function removeKey(
  id: string,
  chord: string,
  overrides: HotkeyOverrides = hotkeyOverrides,
  registry: KeybindingRegistry = keybindings,
): Promise<void> {
  const key = normalizeChord(chord);
  return overrides.setKeys(
    id,
    keysFor(
      registry,
      id,
      registry.effectiveKeys(id).filter((k) => k !== key),
    ),
  );
}

export const resetKeys = (id: string, overrides: HotkeyOverrides = hotkeyOverrides) =>
  overrides.setKeys(id, null);

export const resetAllKeys = (overrides: HotkeyOverrides = hotkeyOverrides) => overrides.resetAll();

/** Reads the vault's `.obsidian/hotkeys.json` (read-only) and writes what maps as overrides for
 *  this OS. Null when the vault has no such file. */
export async function importFromObsidian(
  overrides: HotkeyOverrides = hotkeyOverrides,
  registry: KeybindingRegistry = keybindings,
  read: () => Promise<string | null> = hotkeysReadObsidian,
): Promise<ImportResult | null> {
  const text = await read();
  if (text === null) return null;
  const result = mapObsidianHotkeys(text, registry);
  if (result.imported > 0) {
    await overrides.update((_, set) => {
      for (const [id, keys] of Object.entries(result.keys)) set(id, keysFor(registry, id, keys));
    });
  }
  return result;
}
