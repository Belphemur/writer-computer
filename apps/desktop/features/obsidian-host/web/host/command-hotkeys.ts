// Plugin commands in the keybinding registry. A plugin's `addCommand({ hotkeys })` and
// `hotkeyManager.addDefaultHotkeys` become entries owned by that plugin (its name is the group on
// the Hotkeys page), so a plugin command is rebindable like any other and its key goes through the
// one dispatcher. The entry follows the command: added with it, updated when its defaults change,
// removed when the plugin unloads. Defaults are not vouched for (`strict: false`): a plugin key
// another command already has simply does not take effect, never an error. A key on a command
// that is not available right now falls through to the editor, like Obsidian's `checkCallback`.
import { obsidianToChord } from "@/lib/keybindings/obsidian";
import { keybindings, type KeybindingRegistry } from "@/lib/keybindings/registry";
import type { CommandRegistry, RegisteredCommand } from "./api/core";
import type { HotkeyManager } from "./api/hotkey-manager";

/** The plugin's default chords: what it set through `hotkeyManager`, else the command's own. */
function defaultsOf(c: RegisteredCommand, hotkeys: HotkeyManager): string[] {
  return (hotkeys.defaultKeys[c.id] ?? c.hotkeys).flatMap((h) => obsidianToChord(h) ?? []);
}

/** Mirrors the commands into `registry` until the returned function is called. */
export function bridgeCommandHotkeys(
  commands: CommandRegistry,
  hotkeys: HotkeyManager,
  pluginName: (pluginId: string) => string,
  registry: KeybindingRegistry = keybindings,
): () => void {
  /** id -> what the entry was built from, so an unchanged command is left alone. */
  const added = new Map<string, string>();

  const sync = () => {
    const live = new Set<string>();
    for (const c of commands.list()) {
      live.add(c.id);
      const keys = defaultsOf(c, hotkeys);
      const group = `${pluginName(c.owner)} (plugin)`;
      const signature = JSON.stringify([c.owner, c.name, group, keys]);
      if (added.get(c.id) === signature) continue;
      const taken = registry.get(c.id);
      if (taken && taken.owner !== c.owner) continue; // never replace another owner's entry
      registry.remove(c.id);
      registry.add(
        c.owner,
        {
          id: c.id,
          keys,
          description: c.name,
          category: "Plugin",
          group,
          available: () => c.isAvailable(),
          run: () => void commands.execute(c.id),
        },
        { strict: false },
      );
      added.set(c.id, signature);
    }
    for (const id of Array.from(added.keys())) {
      if (live.has(id)) continue;
      registry.remove(id);
      added.delete(id);
    }
  };

  sync();
  const offCommands = commands.subscribe(sync);
  const offHotkeys = hotkeys.subscribe(sync);
  return () => {
    offCommands();
    offHotkeys();
    for (const id of added.keys()) registry.remove(id);
    added.clear();
  };
}
