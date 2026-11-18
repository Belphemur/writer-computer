---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Let users rebind every command through one keybinding registry with per-OS overrides

## Context and Problem Statement

Writer's shortcuts live in one registry (`apps/desktop/src/lib/keybindings/registry.ts`: id, default chords, `when` context, owner, conflict refusal at registration), fed by core bindings and built-in features' `keybindings` contribution. Obsidian plugins declare hotkeys (`addCommand({ hotkeys })`, `app.hotkeyManager.addDefaultHotkeys`), which the host stores but no one can change. There is no hotkey settings page, user overrides do not exist, and defaults cannot differ per operating system. The user asked (2026-11-18) for a feature where every plugin's hotkeys are collected, shown in Settings and changeable, OS-dependent.

## Decision Drivers

- One list of commands and keys (DRY): the registry stays the source; no second matcher.
- Every command can get a key, with or without a default.
- OS-dependent: defaults and user keys per platform; a synced config never applies macOS keys on Windows.
- Conflicts are explicit, never "first one wins".
- Never write `.obsidian`; plugins see the effective keys through their own API.
- Terse UI.

## Considered Options

- A. Registry gains command entries without keys and a user override layer; a built-in `hotkeys` feature owns the settings page; overrides app-wide per OS in `hotkeys.json`, validated in Rust.
- B. Per-vault overrides in `.writer/hotkeys.json`.
- C. Follow `.obsidian/hotkeys.json` live for plugin commands.

## Decision Outcome

Chosen option: **A**.

1. **Registry** (`src/lib/keybindings/registry.ts`, core): the one list. Every palette command (core, built-in features, Obsidian plugins) has an entry; commands without a default have none. The Obsidian host maps `addCommand({ hotkeys })` and `hotkeyManager.addDefaultHotkeys` to entries owned by that plugin (owner shown as the plugin name).
2. **Per-OS defaults**: a binding's keys may be `{ mac, windows, linux, other }` as well as a plain list; `Mod` (Cmd on macOS, Ctrl elsewhere) stays the common form; formatting follows the OS (`⌘⇧T` on macOS, `Ctrl+Shift+T` elsewhere).
3. **User overrides**: one file `hotkeys.json` in Writer's app config directory, `{ "version": 1, "mac": { "<command id>": ["Meta+Shift+K"] | [] }, "windows": {…}, "linux": {…} }`; a list replaces the defaults for that command, `[]` removes its keys, an absent id means defaults. Read and written only through Rust commands (validation: known shape, chord syntax, size cap, atomic write); the registry applies the current platform's overrides on top of defaults; the palette and Obsidian plugins (`hotkeyManager.getHotkeys`, `customKeys`) see the effective keys; `docs/keyboard-shortcuts.md` and its test keep reading defaults.
4. **Conflicts**: recording a chord already bound in an overlapping context shows "Used by <command>" with Reassign or Cancel; Reassign removes it from the other command (written as an override). OS- or menu-reserved chords (`Mod+Q`, `Mod+,`, `Mod+H`, `Mod+M`) are refused.
5. **Settings page** (built-in feature `hotkeys`, `apps/desktop/features/hotkeys/`, contributing a settings section): commands grouped by owner (Writer, each feature, each plugin), a search that matches names or, when keys are pressed in it, the command bound to them; per row the key(s), ✎ to record (press keys, Enter saves, Esc cancels), "+" for a second key, × to remove one, ↺ to reset, a "modified" mark; footer "Import from Obsidian" and "Reset all".
6. **Import from Obsidian**: reads `.obsidian/hotkeys.json` once, read-only, maps Obsidian modifiers to chords for the current OS, writes them as overrides; unknown commands are skipped and counted.

### Consequences

- Good: every command is rebindable in one place, per OS, without a second matcher.
- Good: plugins keep working through their own hotkey API.
- Bad: the registry now holds entries for every command (a few hundred), a small startup cost.
- Neutral: per-vault keys are not supported.

### Non-goals

- Key sequences (one combination, then another key).
- Per-vault hotkeys.
- Rebinding native menu items the registry does not drive.
- Writing `.obsidian/hotkeys.json`.

## Implementation Plan

- **Affected paths**: `apps/desktop/src/lib/keybindings/` (`registry.ts` command entries and override layer, `chord.ts` per-OS defaults and formatting), `src/lib/platform.ts`, the palette command registry (effective keys), the Obsidian host (`features/obsidian-host/web/host/api/hotkey-manager.ts`, `core.ts` `addCommand`), a Rust config module for `hotkeys.json` (beside `config.rs`, commands through `commands::blocking`, specta bindings), new feature `apps/desktop/features/hotkeys/` (`feature.json`, settings section, recorder), `docs/keyboard-shortcuts.md` only if defaults change, a spec `SPECs/hotkeys-spec.md`, `CHANGELOG.md`.
- **Patterns to follow**: the registry as the only matcher; overrides as data; Rust validation and atomic writes for config; feature contribution points; `writer-feature` skill.
- **Patterns to avoid**: a second keydown listener; per-plugin special cases; writing `.obsidian`; storing chords already resolved for one OS in the shared section.
- **Tests**: per-OS default resolution and formatting; override apply, reset and remove; reassign on conflict; reserved chords refused; Obsidian plugin hotkeys appear with their plugin as owner and plugins see overrides through `hotkeyManager`; import mapping and skip counts; Rust validation (bad shape, bad chord, cap) and atomic write; settings page record, Enter/Esc, search by name and by pressed keys, reset all.

### Verification

- [ ] Every palette command is listed, grouped by owner, with its effective key.
- [ ] A recorded key works at once and survives a restart; it is stored under the current OS only.
- [ ] A conflict offers Reassign, which removes the key from the other command.
- [ ] Reserved chords are refused.
- [ ] An Obsidian plugin's hotkey can be changed and the plugin reads the new key.
- [ ] Import from Obsidian applies the vault's `.obsidian/hotkeys.json` without writing it.

## Pros and Cons of the Options

### A. Registry overrides, app-wide per OS

- Good, because one source of truth and the same keys in every vault.
- Bad, because the registry grows by every command.

### B. Per vault

- Good, because keys travel with a vault.
- Bad, because the same user gets different keys per vault; the user chose app-wide.

### C. Follow `.obsidian/hotkeys.json`

- Good, because Obsidian and Writer stay in step.
- Bad, because two places define keys.

## More Information

Related: [built-in features](../../SPECs/builtin-plugins-spec.md) (`keybindings` contribution), [link activation](2026-11-17-open-every-link-like-a-browser-link-through-one-link-activation-module.md) for the clickable rows, `docs/keyboard-shortcuts.md`. Revisit if key sequences or per-vault keys are requested.
