// Undocumented `app.hotkeyManager`: plugins that ship default hotkeys register them here
// (Excalidraw: `addDefaultHotkeys(commandId, [{modifiers: ["Ctrl"], key: "s"}])`) and read them
// back. Writer stores them (so the plugin sees what it set) but has no hotkey settings page: the
// commands' own `hotkeys` stay what the host binds.
import type { Hotkey } from "./core";

export class HotkeyManager {
  /** Defaults by command id (set by plugins). */
  defaultKeys: Record<string, Hotkey[]> = {};
  /** User overrides by command id (Writer has no hotkey editor, so this stays empty). */
  customKeys: Record<string, Hotkey[]> = {};

  addDefaultHotkeys(commandId: string, hotkeys: Hotkey[]): void {
    this.defaultKeys[commandId] = hotkeys.map((h) => ({ ...h }));
  }
  removeDefaultHotkeys(commandId: string): void {
    delete this.defaultKeys[commandId];
  }
  getDefaultHotkeys(commandId: string): Hotkey[] {
    return this.defaultKeys[commandId] ?? [];
  }
  getHotkeys(commandId: string): Hotkey[] {
    return this.customKeys[commandId] ?? this.defaultKeys[commandId] ?? [];
  }
  setHotkeys(commandId: string, hotkeys: Hotkey[]): void {
    this.customKeys[commandId] = hotkeys.map((h) => ({ ...h }));
  }
  removeHotkeys(commandId: string): void {
    delete this.customKeys[commandId];
  }
  printHotkeyForCommand(commandId: string): string {
    const h = this.getHotkeys(commandId)[0];
    return h ? [...h.modifiers, h.key].join("+") : "";
  }
  bake(): void {}
  load(): void {}
  save(): void {}
}
