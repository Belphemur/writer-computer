---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Show file and folder icons natively, over Iconize's data read-only

## Context and Problem Statement

Iconize (MIT, 2.3M downloads, `FlorianWoelki/obsidian-iconize`) puts icons on files and folders. Its data lives in `.obsidian/plugins/obsidian-icon-folder/data.json`: `{ "settings": {...}, "<vault path>": "IbBell" | "🚀" | {"iconName": "...", "iconColor": "#..."} }`, plus ordered custom rules and icon packs (research 2026-11-18: `src/settings/data.ts`, `src/lib/custom-rule.ts`, `src/emoji.ts`). Writer has a core icon picker (Hugeicons and Emoji tabs, ADR `2026-11-18-give-enum-values-an-optional-emoji-or-icon-picked-from-one-core-icon-picker`), a `fileTreeDecorations` contribution point, and the rule "never write `.obsidian`". The user asked (2026-11-18) for a native Iconize, chose Writer's own file over Iconize's read-only, icons in the sidebar, tabs, note title, links and inline shortcodes, and sources Hugeicons and Emoji; as much as possible in Rust.

## Decision Drivers

- Existing Iconize icons show at once; `.obsidian` is never written.
- One store and one resolver (Rust), every surface asks it.
- Renames and moves keep icons.
- Terse UI; the one core picker.

## Considered Options

- A. Writer's `.writer/icons.json` layered over a live read-only Iconize `data.json`, resolved in Rust.
- B. Import Iconize once into Writer's file.
- C. Writer only, Iconize ignored.

## Decision Outcome

Chosen option: **A**.

1. **Feature**: `apps/desktop/features/icons/` (kill switch `features.icons.enabled`, default on; light `web/index.ts`; Rust half). The store and resolver are Tauri-free in `src-tauri/src/icons.rs` (the CLI shares it).
2. **Store**: `.writer/icons.json` `{ "version": 1, "icons": { "<vault path>": { "icon": "emoji:🚀" | "icon:Rocket01Icon", "color"?: "#rrggbb" } } }`, the icon string in the core icon-value format (`shared/icon-value-vectors.json`). Written atomically, only through the Rust store. Unknown keys preserved.
3. **Iconize layer**: Iconize's `data.json` is read live (watched) and never written. Its path entries map to icon values: an emoji string → `emoji:`; a pack id → shown only if it resolves to a Hugeicons name, else ignored (the user chose Hugeicons and Emoji as sources; Settings shows "n Iconize icons use packs Writer does not show"). Iconize's custom rules, frontmatter mode and packs are not used.
4. **Resolution**: for a path, Writer's entry wins, then Iconize's, then none. Folders do not pass icons to their contents (Iconize removed inheritance too).
5. **Rename, move, delete**: the Rust relocate path (`relocate/`) re-keys Writer's entries for the file and, for a folder, every descendant, in the same operation as the move; a delete drops them. Iconize's file is never rewritten, so an Iconize-only icon on a renamed path is copied into Writer's file under the new path.
6. **Surfaces** (one hook `useFileIcon(path)` over a store fed by a Rust command and a change event):
   - Sidebar tree: before the name, through `fileTreeDecorations`.
   - Tabs: before the title.
   - Note title: above the editor title, small, a click opens the picker.
   - Links: before `[[links]]` whose target has an icon (editor, properties, agent pane, Bases), through the shared link rendering.
   - Inline shortcodes: `:Rocket01Icon:` and `:emoji-name:`-style shortcodes in notes render as the icon (Iconize's `:` identifier), with autocomplete after `:` and two letters; the text stays in the file.
7. **Setting an icon**: "Change icon…" in the sidebar context menu, the tab context menu and the note title opens the core picker (Icons, Emoji, Remove icon); multi-select in the sidebar sets them all.
8. **Agents and CLI**: `writer icon:set path=… icon=…`, `icon:get`, `icon:remove`, through the same store; documented in the `writer-cli` skill.

### Consequences

- Good: Iconize vaults keep their icons with no setup; one resolver for every surface.
- Bad: Iconize pack icons outside Hugeicons are not shown.
- Neutral: Writer's icons do not appear in Obsidian (they live in `.writer/`).

### Non-goals

- Icon packs, Iconize custom rules, frontmatter `icon:` mode, icon colours per rule.
- Writing `.obsidian`.

## Implementation Plan

- **Affected paths**: new `src-tauri/src/icons.rs` (store, Iconize reader, resolver, re-key), `relocate/` (re-key hook), the watcher (Iconize file and `.writer/icons.json` changes), commands through `commands::blocking`; `apps/desktop/features/icons/` (`feature.json`, `rust/` glue and CLI contribution, `web/` hook and store, tree decoration, tab and title slots, link decoration, shortcode editor extension and autocomplete); the core picker (`src/components/icon-picker/`); `SPECs/icons-spec.md`, `SPECs/builtin-plugins-spec.md`, `SPECs/writer-cli-spec.md`; the `writer-cli` skill (bump `BUNDLE_VERSION`); `CHANGELOG.md`, `TODOS.md`; MIT notice in third-party notices if Iconize code is adapted (e.g. its emoji test).
- **Patterns to follow**: property types over `.obsidian/types.json` (Writer file over read-only Obsidian file); relocate's single move operation; contribution points; `docs/design.md`.
- **Patterns to avoid**: a per-surface icon lookup; writing `.obsidian`; a second picker.
- **Tests**: store round-trip and unknown keys kept; Iconize parsing (string, emoji, object with colour, pack id mapped or ignored, settings key skipped); precedence; rename and folder move re-key, Iconize-only icon copied on rename; delete; every surface renders from the hook; shortcode render and autocomplete; context-menu set and multi-select; CLI commands; feature off shows no icons and writes nothing.

### Verification

- [x] A vault with Iconize emoji icons shows them in the sidebar with no setup.
- [x] "Change icon…" sets an icon shown in the sidebar, tab, title and links; it survives a rename and a folder move.
- [x] `.obsidian/plugins/obsidian-icon-folder/data.json` is never written.
- [x] `:Rocket01Icon:` renders in a note and autocompletes.

Ticked 2026-11-18 on code and tests (Rust and jsdom); not yet seen in a real window.

## Pros and Cons of the Options

### A. Writer file over Iconize, read-only

- Good, because live compatibility without writing `.obsidian`.
- Bad, because two sources to merge.

### B. Import once

- Good, because one source.
- Bad, because later Iconize changes (in Obsidian) are missed.

### C. Writer only

- Good, because simplest.
- Bad, because existing icons vanish.

## More Information

Research: the four-plugin source review of 2026-11-18 (Iconize is MIT; data shape, prefixes, emoji detection, rules). Spec: [`SPECs/icons-spec.md`](../../SPECs/icons-spec.md). Related: the enum icons ADR (core picker and icon values), the property types ADR (the read-only Obsidian layer pattern).

Amendment, the user, 2026-11-18: a note's own icon goes next to its first H1, else nowhere in the note body (no slot above the properties).
