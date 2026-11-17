---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Follow symlinks that stay inside the vault, through one shared helper

## Context and Problem Statement

A user's vault links `.agents/skills` and `.claude/skills` to a folder of the same vault (`LLM-Agents/skills`). Every on-disk walker classified entries with `DirEntry::file_type()`, which does not follow links, so a link to a folder was neither a directory nor a file and was silently dropped, while the `.agents` visibility check used `is_dir()` (which follows). The result was a visible but empty `.agents`. Following links in general is unsafe: reading or writing through a link that leaves the vault breaks path confinement, and a link to an ancestor loops every recursive walk.

## Decision Drivers

- One place decides what an entry is; the listing, the folder checks and the skills installer must not drift.
- Path confinement (`vault_ops::confine`, `authorize_path`) must stay true: nothing outside the vault is read or written.
- A folder reachable by two paths must not duplicate search results or links.
- Saving must never replace the user's link with a regular file; the installer must never clobber a linked skills folder.

## Considered Options

- Keep never following links (the previous rule): safe, but hides the user's skills.
- Follow every link (`follow_links(true)`, `is_dir()` everywhere): simple, but escapes the vault and loops.
- Follow only links whose canonical target stays inside the vault, decided by one helper `fs_entry::resolve_entry`; the index and the watcher keep not following.

## Decision Outcome

Chosen option: the third. `fs_entry::resolve_entry` follows a link only when its canonical target is inside the canonical vault root, is not the root or an ancestor of the link's folder, would be visible by `code_files::rel_is_visible` at its real path, and exists as a file or folder; anything else is skipped with a debug log. Recursive walks keep a visited set of canonical folders. The index never follows links, so the real path is the one indexed (it wins) and the same folder is never indexed twice; the sidebar shows both the real folder and the link. Saves write to the resolved target (temp file and rename in the target's folder) so the link survives; a link itself is never renamed or moved. The managed skills installer skips a skill folder, or any folder above it, that is a link (`skipped-symlink`) and removes nothing through a linked skills folder.

### Consequences

- Good, because the linked skills folder shows and edits like any folder, and the visibility rule exists once.
- Good, because escapes, dangling links and cycles are skipped, not errors.
- Bad, because a file opened through a link has no index row under that path (properties, backlinks and the like belong to the real path), and changes to the real folder reach the linked view in the tree only on the next refresh (the watcher reports real paths).
- Bad, because Writer's own skills are not installed into a linked skills folder; the user copies them there or unlinks.
- Neutral, because mutual cycles (`a/l -> b`, `b/l -> a`) are listed and expandable by hand; walks terminate.

## Implementation Plan

- **Affected paths**: `src-tauri/src/fs_entry.rs`, `commands/fs.rs`, `managed_skills/mod.rs`, `src/types/fs.ts`, `src/components/sidebar/`.
- **Dependencies**: none.
- **Patterns to avoid**: reading `file_type().is_dir()` on a vault entry outside `fs_entry`; following a link in the index walker; replacing a path with rename without `fs_entry::write_target`.

### Verification

- [x] `cargo test fs_entry`, `cargo test code_files_tests::symlinks` and `cargo test managed_skills` cover in-vault links, escapes, dangling links, cycles, index dedupe, save through a link, rename and delete of a link, and the installer.

## More Information

Spec: [`SPECs/code-files-spec.md`](../../SPECs/code-files-spec.md), "Symlinks". Refines the "symlinks are never followed" line of [the code files ADR](2026-11-17-show-code-files-and-agent-skill-folders-through-one-visibility-policy-in-rust.md).
