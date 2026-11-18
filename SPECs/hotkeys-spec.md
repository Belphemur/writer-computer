# Hotkeys

Status: **implemented 2026-11-18** (code and tests; not seen in a real window). Decision: [ADR `2026-11-18-let-users-rebind-every-command-through-one-keybinding-registry-with-per-os-overrides`](../docs/decisions/2026-11-18-let-users-rebind-every-command-through-one-keybinding-registry-with-per-os-overrides.md). Shortcut map: [`docs/keyboard-shortcuts.md`](../docs/keyboard-shortcuts.md). Built-in feature `hotkeys` ([`builtin-plugins-spec.md`](./builtin-plugins-spec.md)).

Every command can have a key, the user can change it in **Settings > Hotkeys**, and the keys are per operating system. Key sequences (one combination, then another key), per-vault keys and writing `.obsidian/hotkeys.json` are out of scope.

## 1. Where things live

| What                                                                           | Where                                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| The one list of commands and keys, the only matcher, the effective keys        | `src/lib/keybindings/registry.ts` (core)                                                                     |
| Chord syntax, formatting, a chord from a key press                             | `src/lib/keybindings/chord.ts`; grammar pinned by `shared/chord-vectors.json` (the Rust validation reads it) |
| `hotkeys.json` load / save (the one web write path), cross-window reload       | `src/lib/keybindings/overrides.ts`                                                                           |
| Obsidian hotkey shape <-> chord                                                | `src/lib/keybindings/obsidian.ts`                                                                            |
| The dispatcher stands down while a key is recorded                             | `src/lib/keybindings/recording.ts`, `src/hooks/use-keyboard-shortcuts.ts`                                    |
| Palette commands as registry entries, `runCommand`, `commandLabel`             | `src/components/command-palette/commands.ts`                                                                 |
| Plugin commands and hotkeys as registry entries, `app.hotkeyManager`           | `features/obsidian-host/web/host/command-hotkeys.ts`, `.../api/hotkey-manager.ts`                            |
| The page (rows, search, recorder, import, reset)                               | `features/hotkeys/web/`                                                                                      |
| `hotkeys.json` validation, atomic write, read of `.obsidian/hotkeys.json`; IPC | `src-tauri/src/hotkeys.rs` (Tauri-free), `src-tauri/src/commands/hotkeys.rs`                                 |

The keys, the overrides and the Rust half are **core**, not the feature: switching `features.hotkeys.enabled` off removes the page and the "Open hotkeys" command, never the user's keys. The feature is TypeScript only.

## 2. The registry

An entry is `{ id, keys, description, category, group?, when?, phase?, available?, rebindable?, run }`.

- **Defaults** (`keys`): a plain list of chords, or one list per OS `{ mac, windows, linux, other }` (`other` for any OS not named). `Mod` is Cmd on macOS and Ctrl elsewhere and stays the common spelling; the display follows the OS (`⇧⌘T` on macOS, `Ctrl+Shift+T` elsewhere).
- **Command entries** (`addCommand`): every palette command (built-in and feature-contributed) has an entry without default keys, created by `commands.ts`. A command that already has a binding of its own id keeps that binding; a feature binding registered after its command replaces the command entry. Commands owned by a feature go away with it (`removeOwner`).
- **Plugin entries**: see section 5.
- **Overrides**: the current OS's section of `hotkeys.json` (section 3). A list replaces the command's defaults, `[]` removes them, an absent id means defaults; ids that are not loaded (a plugin that is off) are kept and apply when the command appears.
- **Effective keys**: the user's keys claim their chords first, then the defaults; a chord goes to the first claimant whose context overlaps. Reserved chords, bare keys and keys this build cannot read never take effect. Everything that shows or matches keys reads these (`effectiveKeys`, `shortcutFor`, `find`): the dispatcher, the palette, the page, the plugins.
- **Registration** (`add`) is strict for built-ins: a default that is already taken, listed twice or reserved throws `KeybindingConflictError`, as before, and an override never makes it fail. `{ strict: false }` (plugins) skips those checks; such a default just does not take effect when the chord is taken. A docs test keeps `docs/keyboard-shortcuts.md` equal to the defaults.
- **Matching**: one dispatcher (`useKeyboardShortcuts`), chord and `when` first, then `available()` (a plugin's `checkCallback`, a palette command's `when`): a key on an unavailable command is not swallowed, it falls through to the editor. A chord the user recorded also matches by the physical key (Option+A types `å` on macOS), so it works on any layout.
- `rebindable: false` (Jump to Nth tab: the handler reads the digit) shows the keys without controls.

## 3. File: `hotkeys.json`

In the app data dir (`~/Library/Application Support/<identifier>/` on macOS), shared by every vault and window:

```json
{
  "version": 1,
  "mac": { "reopen-closed-tab": ["Mod+Shift+K"], "graph.open": [] },
  "windows": {},
  "linux": {}
}
```

- Only the current OS's section changes; the other sections are kept as they are, so a synced config never applies macOS keys on Windows. Keys equal to the defaults are stored as no override.
- Rust validates on every read and write: known keys only, `version` 1, chord syntax (`shared/chord-vectors.json`), at most 2000 commands per OS, 8 chords per command, 256 KB. A write is atomic (`plugins::write_atomic`) and emits `hotkeys:changed`, which makes every window reload.
- A file that does not validate is not applied: the page shows "Could not read hotkeys.json: reason", the defaults stay, and the next save keeps the bad file as `hotkeys.json.bak`.
- Writes are serialized; a failed write changes nothing and the page shows the error.

## 4. The page

```
Hotkeys                                  [Search commands or press keys]
  Writer
    Open quick switcher          ⌘P              +  ✎  ↺
    Toggle agent pane            ⌘⇧A  +⌥A        +  ✎  ↺
  Graph
    Open graph                   —                  ✎
  Excalidraw (plugin)
    Excalidraw: Save             ⌘S   modified   +  ✎  ↺
  [Import from Obsidian]                          [Reset all]
```

- **Groups**: Writer first, then each built-in feature by its name, then each plugin as "<name> (plugin)". Rows are sorted by name; the name is the palette's, else the binding's description.
- **Row**: the keys in force (the second and later ones prefixed `+`), "modified" when overridden, and the controls: ✎ records a key that **replaces** the command's keys, `+` records **another** key next to them (only when it has one), a key's x (or Backspace/Delete on the focused key) removes that key, ↺ goes back to the defaults (only when modified).
- **Recorder**: press the keys; a lone modifier is ignored; Enter saves, Esc cancels, Backspace clears what was pressed. A chord needs Cmd, Ctrl or Alt (or is a function key): a bare letter would swallow typing. Reserved chords (`Mod+Q`, `Mod+,`, `Mod+H`, `Mod+M`) are refused with a one-line reason ("Reserved by the system", "Needs Cmd, Ctrl or Alt"). A chord another command has in an overlapping context (the registry's own rule: two named contexts are exclusive, none overlaps all) shows "Used by <command>" with **Reassign**, which removes the key from the other command and gives it here in one save, or **Cancel**. Enter does not resolve a conflict. The app's own shortcuts stand down while recording.
- **Search**: words filter by command or group name; a key combination pressed in the box (with Cmd, Ctrl, Alt or a function key) shows the command bound to it, a plain key goes back to words. Copy, paste, cut, select all and undo are left to the box.
- **Reset all** asks first, then clears this OS's section.
- **Import from Obsidian** (needs a vault): reads `.obsidian/hotkeys.json` once, read-only (a Rust command confined to the vault, symlinks not followed), maps `{ "modifiers": ["Mod","Shift"], "key": "t" }` to `Mod+Shift+T` (Obsidian `Mod`, `Meta`, `Ctrl`, `Alt`, `Shift` are Writer's), writes the keys as overrides for this OS and says "Imported N, skipped M". Skipped: a command Writer does not have (an Obsidian core command, a plugin that is not loaded), one whose keys all fail to map or cannot be bound here, a command that is not rebindable. An empty list imports as "no keys". Nothing is written under `.obsidian`.
- The palette command "Open hotkeys" opens the page.

## 5. Obsidian plugins

The host mirrors each plugin command into the registry (`command-hotkeys.ts`): id and name as Obsidian prefixes them, owner = the plugin id, group = "<plugin name> (plugin)", defaults = the keys the plugin set through `hotkeyManager.addDefaultHotkeys`, else the command's own `hotkeys`, run = the command through its availability. The entry follows the command: added with it, updated when the defaults change, removed when the plugin unloads or the host stops. Plugin defaults are not vouched for (`strict: false`).

This also makes plugin default hotkeys work in Writer for the first time: before, they were stored and shown to nobody.

`app.hotkeyManager` reads from the registry: `getHotkeys` returns the keys in force, `getDefaultHotkeys` the defaults, `customKeys` the user's keys for this OS (a copy); `setHotkeys` and `removeHotkeys` write through the same override path as the page (keys that do not map are dropped). `addDefaultHotkeys` / `removeDefaultHotkeys` keep the plugin's defaults and re-mirror the command.

## 6. Tests

| Area                                                                                                                                                                                                                                                                                                            | File                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Chord grammar vectors (TS)                                                                                                                                                                                                                                                                                      | `tests/hotkeys-registry.test.ts`                             |
| Chord grammar vectors, validation, caps, atomic write, `.bak`, Obsidian read and symlink (Rust)                                                                                                                                                                                                                 | `src-tauri/src/hotkeys.rs` tests                             |
| Per-OS defaults and formatting; command entries; override apply, reset, remove; who wins a chord; conflict context rule; refusals; availability; tolerant registration; recorder chord from a key press; Obsidian shape; `HotkeyOverrides` (current OS only, other sections kept, order, failed save, bad file) | `tests/hotkeys-registry.test.ts`                             |
| Palette commands have entries; a key runs the palette command; unavailable falls through; the palette shows the user's key; the dispatcher stands down while recording                                                                                                                                          | `tests/hotkeys-palette.test.ts`                              |
| Plugin hotkeys appear with the plugin as owner; follow the command; `hotkeyManager` reads and writes overrides                                                                                                                                                                                                  | `features/obsidian-host/tests/obsidian-host-hotkeys.test.ts` |
| Feature registration, kill switch, core never imports it; rows and groups; search by name and keys; import mapping and counts; record, reassign, remove, reset                                                                                                                                                  | `features/hotkeys/tests/hotkeys-feature.test.ts`             |
| The page: record + Enter, Esc, Backspace, lone modifier, reserved, conflict Reassign / Cancel, `+`, remove, reset, reset all, search by name and pressed keys, import                                                                                                                                           | `features/hotkeys/tests/hotkeys-section.test.tsx`            |

Only a real window shows: the feel of recording on each OS and keyboard layout (Option, dead keys, non-Latin layouts), that WebKit does not take a chord before the page sees it (Cmd+H, Cmd+M are reserved for that reason), the page's look in both themes, and a key surviving a restart.
