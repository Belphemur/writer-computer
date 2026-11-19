# Icons

Status: **implemented 2026-11-18** (code and tests; not seen in a real window). Decision: [ADR `2026-11-18-show-file-and-folder-icons-natively-over-iconize-data-read-only`](../docs/decisions/2026-11-18-show-file-and-folder-icons-natively-over-iconize-data-read-only.md). Built-in feature `icons` ([`builtin-plugins-spec.md`](./builtin-plugins-spec.md)); the picker and the icon values are the core ones ([`properties-types-spec.md`](./properties-types-spec.md) "Enum").

Files and folders can have an icon (an emoji or a Hugeicons icon). It shows in the sidebar tree, the tabs, above a note, before links to the note and, as `:shortcodes:`, inline in a note. Icons made with the Iconize plugin show with no setup. Writer never writes `.obsidian`.

## 1. Where things live

| What                                                                                         | Where                                                                                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| The store, the Iconize reader, the one resolver, re-key on move, drop on delete (Tauri-free) | `src-tauri/src/icons.rs` (tests `icons/tests.rs`)                                                                        |
| Re-key hook for a file move (also `writer rename` / `move`)                                  | `relocate::apply`, after the move and the link rewrites                                                                  |
| Re-key hook for a folder rename or move, and drop on delete                                  | `commands/fs.rs` (`relocate_entry`, `rename_entry`, `delete_entry`); the CLI `delete` in `cli/cmd_notes.rs`              |
| The kill switch as core sees it                                                              | `icons::set_enabled`, set by `features::icons::apply` (settings, startup) and `apply_for_cli`                            |
| Commands `icons_resolved`, `icons_set`, `icons_remove`; the `icons:changed` event            | `features/icons/rust/` (plugin `icons`, bindings generated into `web/bindings.ts`)                                       |
| `writer icon:set`, `icon:get`, `icon:remove`                                                 | `features/icons/rust/cli.rs` (table), `cli/cmd_icons.rs` (handlers); documented in the managed `writer-cli` skill (v11)  |
| The one store and hooks every surface asks (`useFileIcon`, `useLinkIcon`, `watchLinkIcon`)   | `src/lib/file-icons.ts` (core; a test pins that nothing else reads the store)                                            |
| Filling that store, the picker overlay, menu items, the note icon, shortcodes, Settings page | `features/icons/web/`                                                                                                    |
| Icon values (`emoji:` / `icon:`), the picker, drawing an icon in React and in the DOM        | `src/lib/icon-picker/` (`icon-value.ts`, `icon-dom.ts`), `src/components/icon-picker/`; `shared/icon-value-vectors.json` |

## 2. The store: `.writer/icons.json`

```json
{
  "version": 1,
  "icons": {
    "Notes/Idea.md": { "icon": "emoji:🚀", "color": "#ff8800" },
    "Projects": { "icon": "icon:Folder01Icon" }
  }
}
```

- Keys are vault-relative paths with `/`, for files and folders. `icon` is a core icon value (`property_types::valid_icon`). `color` is `#rrggbb` and optional (the picker does not offer one yet; the CLI and Iconize colours do).
- Written atomically (`plugins::write_atomic`) and only by `icons.rs`, through one function (`modify`) behind a process-wide lock. `.writer` must be a folder inside the vault (a symlinked one is refused). Larger than 8 MB is refused.
- Unknown top-level keys and unknown keys of an entry survive a round trip. A bad entry (a bad icon, a bad colour) is dropped on the next write; bad JSON is an error and nothing is overwritten.
- The icon string `"none"` is a **hiding entry**: it shows no icon and blocks an Iconize icon of the same path. Removing the icon of a path that has an Iconize icon writes it (deleting Writer's entry alone would show Iconize's again); removing any other icon deletes the entry.
- Reading never creates `.writer`.

## 3. The Iconize layer (read-only)

`.obsidian/plugins/obsidian-icon-folder/data.json` is read on every resolution (it is watched) and never written. Path entries are `"<path>": "IbBell" | "🚀"` or `{ "iconName", "iconColor" }`; the `settings` key, custom rules, frontmatter mode and packs are not used.

- An emoji maps to `emoji:<emoji>`; a name shaped like a Hugeicons export (`Rocket01Icon`) maps to `icon:<name>`; anything else (a pack icon such as `IbBell`) is counted as unsupported and not shown. Settings > Icons says "n Iconize icons use packs Writer does not show".
- A name that has the shape but no file in the Hugeicons set draws nothing.
- A link that leaves the vault, or a file over 8 MB, is ignored.

## 4. Resolution

For a path: Writer's entry wins, then Iconize's, then none; a hiding entry shows none. A folder does not pass its icon to its contents. `icons::resolve` is the one resolver; `icons_resolved` returns every resolved path of the vault (the web half keeps the whole map: a few bytes per iconized path) and `icon:get` asks the same function.

## 5. Rename, move, delete

- **Move or rename** of a file goes through `relocate::apply`, which calls `vault_events::moved` (the one hook every per-path store follows; it calls `icons::on_move`) once the file is moved and its links rewritten. A folder rename or move (`relocate_entry`'s folder branch, `rename_entry`) calls `vault_events::moved_abs`. Writer's entries at or under the old path are re-keyed to the new path in the same call. A failure never fails the move (the files are moved; icons are cosmetic) and is logged without paths.
- An Iconize-only icon at or under the old path is **copied** to the new path in Writer's file and **hidden** at the old path (so a new file with the old name does not inherit it). Iconize's file is never touched.
- **Delete** (`delete_entry`, `writer delete`) drops the entries at and under the path. Hiding entries go with them.
- A change made outside Writer (Finder, git, Obsidian) cannot be followed: the entry stays under the old path.
- With the feature off nothing is read or written by any of these.

## 6. Surfaces

All of them call `useFileIcon(path)` (or `useLinkIcon(target)` / `watchLinkIcon` for the target of a link) from `src/lib/file-icons.ts`; none looks an icon up itself. The store is empty while the feature is off or no workspace is open, so every surface looks as it did.

| Surface                                            | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar tree (and Pinned, Recents, the drag ghost) | `EntryIcon` in `components/sidebar/file-tree-icons.tsx`: the icon **replaces** the default file or folder glyph (a folder still shows its chevron on hover).                                                                                                                                                                                                                                                                                                                                                                                      |
| Tabs                                               | `EditorTabButton` in `editor-area/editor-tabs.tsx`: before the title.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Note icon                                          | the editor extension `icons.note-icon` (`features/icons/web/note-icon.ts`): an inline widget before the text of the note's **first H1** (`# Title` after its marker, or a setext H1; front matter is skipped), about 0.9em of the heading, vertically centred, drawn by `fillIconElement`. Never text, never in the document; a click opens the picker for the note. A note without an H1 shows no icon in its body (the tab and sidebar still do). Only the first H1 gets it. It follows the store: set, changed, removed, the H1 moved or gone. |
| Links in the editor                                | `WikiLinkWidget` (`wiki-link-extension.ts`): an icon span before the text; the target is resolved by the vault resolver (`resolve_wiki_link`, file name, cached 5 s) and only while some icon exists.                                                                                                                                                                                                                                                                                                                                             |
| Links in properties                                | `WikiLinkButton` (`property-wikilink.tsx`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Links in Bases cells                               | `Link` in `features/bases/web/view/cell-view.tsx` (link cells, file cells, the `file.name` column; the cell already knows the resolved path).                                                                                                                                                                                                                                                                                                                                                                                                     |
| Links in the agent pane                            | `useMarkdownLinks` (`features/agent/web/components/agent-links.ts`): `#wikilink:` anchors get an icon span, including ones that appear while a reply streams.                                                                                                                                                                                                                                                                                                                                                                                     |
| Inline shortcodes                                  | the editor extension `icons.shortcodes` (section 8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 7. Setting an icon

"Change icon..." (one item, `features/icons/web/menus.ts`) in the context menu of a sidebar file, a folder, a multi-selection and a tab (the new menu surface `editor-tab`), and in the palette for the active note. It opens the core picker (Icons, Emoji, Remove icon) in a modal (`ModalShell`). A multi-selection sets one icon on all of them in one write; Remove icon is offered for one path that has an icon. A write error stays in the picker. `icons_set` / `icons_remove` confine every path to the vault, refuse `.obsidian` and a path that does not exist.

CLI: `writer icon:set path=Projects icon=📁 [color=#rrggbb]` (`file=` also works for notes; `icon=` takes `emoji:🚀`, `icon:Rocket01Icon`, a bare emoji or a bare Hugeicons name), `writer icon:get path=...` (the icon value, `format=json` adds colour and source; exit 1 when none), `writer icon:remove path=...`. They work on files and folders, write only `.writer/icons.json` and are gated by `features.icons.enabled`.

## 8. Inline shortcodes

`:Rocket01Icon:` (a Hugeicons name) and `:rocket:` (an emoji name, words joined with `_`, case-insensitive) render as the icon while the caret is elsewhere, like a rendered link. The text stays in the file and shows again under the caret; code, a time such as `12:30:45` and names that are neither render nothing. After `:` and two letters the editor offers matching emoji and icons (up to eight of each); the completion joins the editor's one autocompletion through `lib/editor-completion-sources.ts` (CodeMirror accepts one `override`, so other sources go through that facet). Typing `a:rock` (mid-word) offers nothing. The emoji names come from the picker's `emoji.json` (its own chunk, loaded with the extension), the Hugeicons names from the icon set, loaded the first time a completion asks (a few MB).

## 9. Feature off

`features.icons.enabled = false`: the web half unregisters at once (every contribution removed, the store cleared, so every surface is as before), the Rust plugin is added no more after the next launch, `icons::set_enabled(false)` makes the move and delete hooks do nothing, and the CLI commands answer "the icons feature is turned off". Nothing is read or written; `.writer/icons.json` stays as it is.

## 10. Not built

Icon packs and Iconize's custom rules, frontmatter `icon:` mode, per-rule colours, a colour control in the picker, icons for folders' contents by inheritance, following a move done outside Writer, a "remove" for a multi-selection.

## 11. Tests

Rust: `icons/tests.rs` (round trip and unknown keys, bad entries, Iconize parsing, precedence and hiding, Iconize never written, file and folder re-key, Iconize copy on rename, delete, relocate hook, feature off writes nothing, symlinked `.writer`), `features/icons/rust/mod.rs` (manifest, watcher filter, ACL, the commands over a window's vault with confinement, the kill switch from settings and from the config file), `cli/tests.rs` (set, get, remove, bad input, Iconize, rename and delete, the feature switch), `shared/icon-value-vectors.json` read by the store's validator.

TypeScript: `features/icons/tests/` (registration and kill switch, activation, reload on the event and the workspace, newest answer wins, picker writes, menus on four surfaces, command, the manifest and the generated bindings, shortcodes in CodeMirror and their completion, note icon, Settings line, the startup chunk and core independence) and `tests/file-icons.test.tsx`, `tests/file-icons-surfaces.test.tsx` (the hook, the tree, the tabs, the three kinds of link, the tab menu, and that only `lib/file-icons.ts` reads the store).
