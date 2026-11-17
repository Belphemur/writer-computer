---
status: accepted
date: 2026-11-16
decision-makers: Antoine
---

# Links resolve by file name, and rename rewrites links through one Rust function

## Context and Problem Statement

Notes have two identities: the file name and a "title" (frontmatter `title:`, else the first `# Heading`) that the sidebar and tabs show. Link resolution had drifted: the Rust index, the `writer` CLI and Bases resolved by file name with Obsidian's rules, but the editor's click-through used its own TypeScript copy (duplicate names were "unresolved", partial paths unsupported) and the plugin host a third copy with a different tie-break. Renaming through the sidebar broke links, while `writer rename` rewrote them with a best-effort, non-atomic routine. Obsidian's public documentation addresses notes by name only (aliases and titles never resolve a link) and updates links on rename.

## Decision

- A link resolves by **file name** only, through the one resolver `index/resolve.rs::PathIndex::resolve` (case-insensitive name, optional `.md`, partial path suffix, full name for attachments; ties: closest folder, fewest components, shortest path, alphabetical). The editor asks it through a new `resolve_wiki_link` command; the plugin host copy uses the same tie-break. Titles stay display-only (sidebar, tabs) and remain searchable text (headings and props FTS columns, weighted below the file name).
- Renaming or moving a file rewrites every link to it through one Tauri-free function pair, `relocate::plan` (no write) and `relocate::apply` (stage, move, commit, roll back on error), used by `writer rename`/`writer move` and the app's `relocate_entry` command. Link text is rewritten by `relocate/linkfix.rs`, byte-minimally, keeping each link's style.
- Non-goals: folder renames rewriting inner links, non-Markdown referrers other than `.base`, a setting to turn link updates off in the app (the CLI has `no-update-links`).

## Consequences

- Good, because backlinks, unresolved links, `writer`, Bases, click-through and plugins agree; an in-app rename no longer breaks links; failures leave a known state.
- Bad, because the editor now needs the index to follow a link (a cold build returns an error instead of a guess) and a sidebar rename during the cold build moves the file without updating links (logged).
- Bad, because a bare link can change target when a rename makes two files share a name (documented limit).

## Implementation Plan

- **Affected paths**: `src-tauri/src/relocate/`, `cli/cmd_notes.rs`, `cli/registry.rs`, `commands/fs.rs` (`relocate_entry`), `commands/search.rs` (`resolve_wiki_link`), `index/resolve.rs`, `src/lib/wiki-links.ts`, `src/lib/obsidian-host/api/vault.ts`, `src/components/sidebar/use-move-entry.ts`, managed skills.
- **Dependencies**: none.
- **Patterns to follow**: plan first, apply second; `commands::blocking`; one resolver.
- **Patterns to avoid**: a second link resolver in TypeScript; resolving by title.

### Verification

- [x] `cargo test` (resolver, index, relocate, CLI), `vp test` (wiki-links, bases, plugin host).
- [ ] In a real window: sidebar rename of a linked note, click-through of a duplicate name.

## Alternatives Considered

- Keep the TypeScript resolver and fix it: a second implementation to keep in sync; rejected.
- Index the title as the note name: contradicts Obsidian's documented model and breaks `[[file-name]]` links.
- Rewrite links from the frontend after `rename_entry`: not atomic, not available to the CLI; rejected.

## More Information

Spec: [`SPECs/filename-links-and-rename-spec.md`](../../SPECs/filename-links-and-rename-spec.md). Related: `SPECs/writer-cli-spec.md` (CLI), `SPECs/link-paths-with-spaces-spec.md` (Markdown link forms).
