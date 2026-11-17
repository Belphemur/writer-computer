---
status: accepted
date: 2026-11-17
decision-makers: Antoine
---

# File name is the title, frontmatter `title` is an explicit display override

## Context and Problem Statement

[Links resolve by file name](2026-11-16-links-resolve-by-file-name-and-rename-rewrites-links-through-one-rust-function.md), but the sidebar, tabs, recents and the window title still labelled a note by its frontmatter `title:` or, failing that, its first `# Heading`. The label changed as the user typed a heading, differed from the name every link and the CLI use, and could name the wrong thing (a note showed a neighbouring heading's text in the tab strip and the tree). The user wants the file name to be the title.

## Decision

- A note's title everywhere in the UI is its **file name without the extension**. The first heading never labels a note and editing it changes no label and renames nothing.
- The only exception is an explicit **frontmatter `title` property** (a non-empty string): it overrides the displayed name, never the file name or any link target. Surfaces that show an override mark it (italic label, tooltip "Title override. File: <name>.md"; the Properties panel explains the property).
- Link resolution is unchanged: the title (override or not) is never a link target. This refines, and does not supersede, the accepted links ADR.
- Setting or clearing the override is its own action ("Set display title...", "Clear display title", `writer title`), distinct from renaming the file. It writes only frontmatter. Links that show the old title as their alias (`[[File|Old title]]`, `![[File|Old title]]`) follow through `relocate::retitle`, the same plan/apply/rollback as a rename; links without an alias, with another alias, or to other files are untouched.
- Quick open (`fuzzy_search`) matches the file name and the override, and shows the override as the row title with the path below.
- One TypeScript function (`lib/note-title.ts::noteLabel`) decides the label for the tab strip, sidebar tree and drag ghost, window title, compact window and recents; the Rust side reports only the override (`DirEntry.title`).

## Consequences

- Good, because the label is stable, predictable and equals what links, the index, the CLI and Bases use.
- Good, because renaming the note's display without touching links stays possible.
- Bad, because the setting `appearance.sidebar-file-label` (title or file name) no longer has a meaning and was removed.
- Bad, because the names mirror now reads the `title` property of every listed row (a join on `props`, no schema change).

## Implementation Plan

- **Affected paths**: `src/lib/note-title.ts`, `src/lib/frontmatter.ts`, `src/components/sidebar/use-file-tree-label.ts`, `editor-tabs.tsx`, `window-title/`, `src-tauri/src/commands/fs.rs` (`extract_title`, `retitle_note`), `src-tauri/src/relocate/retitle.rs`, `index/names.rs`, `cli/cmd_notes.rs` (`title`), `note-title-dialog.tsx`.
- **Patterns to avoid**: deriving a label from a heading; a second label function.

### Verification

- [x] `vp test` (`tests/note-title.test.ts`, stores, flatten-tree), `cargo test commands::fs`.
- [ ] In a real window: a note whose H1 differs from its name shows the file name in the tab and the tree.

## More Information

Spec: [`SPECs/filename-links-and-rename-spec.md`](../../SPECs/filename-links-and-rename-spec.md), section "Display titles".
