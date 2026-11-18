// Undocumented `app.hotkeyManager`: plugins that ship default hotkeys register them here
// (Excalidraw: `addDefaultHotkeys(commandId, [{modifiers: ["Ctrl"], key: "s"}])`) and read them
// back. The keys themselves live in Writer's keybinding registry (`command-hotkeys.ts` mirrors the
// plugin commands into it), so what a plugin reads (`getHotkeys`, `customKeys`) is what the user
// has in Settings > Hotkeys, and `setHotkeys` writes through the same override path the page uses
// (`lib/keybindings/overrides.ts`). Nothing is written under `.obsidian`.
import { chordToObsidian, obsidianToChord } from "@/lib/keybindings/obsidian";
import { hotkeyOverrides, type HotkeyOverrides } from "@/lib/keybindings/overrides";
import { keybindings, type KeybindingRegistry } from "@/lib/keybindings/registry";
import type { Hotkey } from "./core";

const asHotkeys = (chords: readonly string[]): Hotkey[] =>
  chords.map((c) => chordToObsidian(c) as Hotkey);

export class HotkeyManager {
  /** Defaults by command id (set by plugins). */
  defaultKeys: Record<string, Hotkey[]> = {};
  private listeners = new Set<() => void>();

  constructor(
    private registry: KeybindingRegistry = keybindings,
    private overrides: HotkeyOverrides = hotkeyOverrides,
  ) {}

  /** The user's keys by command id, on this OS (a copy: change them with `setHotkeys`). */
  get customKeys(): Record<string, Hotkey[]> {
    return Object.fromEntries(
      Object.entries(this.registry.overridesSnapshot()).map(([id, keys]) => [id, asHotkeys(keys)]),
    );
  }

  /** Called when the defaults change (the bridge re-mirrors the command into the registry). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const l of Array.from(this.listeners)) l();
  }

  addDefaultHotkeys(commandId: string, hotkeys: Hotkey[]): void {
    this.defaultKeys[commandId] = hotkeys.map((h) => ({ ...h }));
    this.changed();
  }
  removeDefaultHotkeys(commandId: string): void {
    delete this.defaultKeys[commandId];
    this.changed();
  }
  getDefaultHotkeys(commandId: string): Hotkey[] {
    return this.registry.get(commandId)
      ? asHotkeys(this.registry.defaultKeys(commandId))
      : (this.defaultKeys[commandId] ?? []);
  }
  /** The keys in force: the user's, else the defaults, as the registry resolved them. */
  getHotkeys(commandId: string): Hotkey[] {
    return this.registry.get(commandId)
      ? asHotkeys(this.registry.effectiveKeys(commandId))
      : (this.defaultKeys[commandId] ?? []);
  }
  setHotkeys(commandId: string, hotkeys: Hotkey[]): void {
    const chords = hotkeys.flatMap((h) => obsidianToChord(h) ?? []);
    // A failed save is already logged by the overrides; a plugin has nobody to tell.
    void this.overrides.setKeys(commandId, chords).catch(() => {});
  }
  removeHotkeys(commandId: string): void {
    void this.overrides.setKeys(commandId, null).catch(() => {});
  }
  printHotkeyForCommand(commandId: string): string {
    const h = this.getHotkeys(commandId)[0];
    return h ? [...h.modifiers, h.key].join("+") : "";
  }
  bake(): void {}
  load(): void {}
  save(): void {}
}
