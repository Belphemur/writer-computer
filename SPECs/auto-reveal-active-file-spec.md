# Auto-reveal current file

Setting `sidebar.auto-reveal-active-file` (Settings > Appearance, "Auto-reveal current file", global, **default on**). It deviates from Obsidian's "Auto-reveal current file" (default off) on purpose. A saved settings file without the key reads as on (the default layer fills missing keys; the UI falls back to `true`).

It supersedes the 2026-06-03 note in [`reveal-in-sidebar-and-external-watcher-spec.md`](./reveal-in-sidebar-and-external-watcher-spec.md) that removed auto-reveal on open: it is now opt-out instead of always off.

## Behavior

When on, whenever `activeFilePath` changes (tab switch, open, back/forward, reopen closed tab, links, quick open, plugins, restore) the `Everything` tree expands the file's ancestors, scrolls its row into view only if it is off-screen (then centered) and the existing active-row highlight shows it. It never focuses anything, never collapses folders, never touches sort or sections.

## Design

- One reveal path: `revealPathInSidebar` (`src/lib/reveal-in-sidebar.ts`), which lazily loads each ancestor with `toggleDirectory`; new option `center` (scroll only if not visible, `block: "center"`).
- `src/hooks/use-auto-reveal-active-file.ts`, mounted in `SidebarSurface`, subscribes to the setting, the sidebar visibility and `activeFilePath`. It debounces 150 ms (last file wins).
- Ignored: no path, outside the workspace root, any dot-folder segment (`.obsidian`), sidebar hidden or `Everything` section folded (reveals when they open, since the effect depends on both).
- Waits (retries every 250 ms, up to 10 s) during an inline rename, a tree drag (`body.tree-dragging`) and for 800 ms after pointer or wheel use inside the sidebar.
- Pinned and Recents are never expanded or scrolled.

## Tests

`tests/auto-reveal-active-file.test.tsx`, `tests/reveal-in-sidebar-center.test.tsx`, a Settings UI case in `tests/settings-panel.test.tsx`, Rust `auto_reveal_active_file_defaults_on_and_missing_key_means_on`.

Not verified in a real window (scroll geometry, pointer pause feel).
