---
status: accepted
date: 2026-11-15
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Serve quick open, recents and folder checks from an in-memory mirror of the index

> Backfilled on 2026-11-16. Date = `f7a5822` (adds `index/names.rs`). Spec: [`SPECs/obsidian-bases-spec.md`](../../SPECs/obsidian-bases-spec.md) section 4.1.9. The substring matcher itself dates from before the repository history (the changelog's 2026-04-24 entry replaced the `nucleo` fuzzy matcher).

## Context and Problem Statement

Quick open, link autocompletion, recents and the sidebar each used a second in-memory file list (`Vec<IndexedFile>`, built by a separate folder walk). With the SQLite index in place that is a second walker, a second freshness mechanism and about twice the memory.

## Considered Options

- A per-window `NameCache` mirroring the index's listed rows, fed by the index's own change feed (chosen).
- SQL per keystroke: the matcher is a case-folded substring match with three spellings of the query and a Unicode-aware score; SQLite `LIKE` and `lower()` are ASCII-only, so results would change, and a query round trip is slower than scanning a few thousand short strings in memory.
- Keep the separate list: duplicate walker and state.
- A fuzzy subsequence matcher such as `nucleo`: dropped from the palette before the repository history (the changelog's 2026-04-24 entry) in favour of the substring match; the index change keeps the substring semantics and no fuzzy crate was re-introduced.

## Decision Outcome

Chosen option: `apps/desktop/src-tauri/src/index/names.rs`. `NameCache` (held in `WorkspaceState.names`) keeps rows with `ext IN ('md','base')` (path and mtime) in a sorted map plus a folder to listed-file-count map; the `files` table stays the source of truth.

- Fresh through the change feed on the writer thread (batches re-read by path, a `full` batch reloads once); no rescan per keystroke, no second walker.
- Ranking unchanged: substring of the lowercased vault-relative path, with the query, hyphens-to-spaces and spaces-to-hyphens spellings; file-name match 1,000,000, earlier match up to 10,000, shorter path up to 1,000. Equal scores sort by path.
- During the cold build the partial rows are served and marked "Results (indexing...)" until `index:complete`; a failed index returns an error that the palette shows ("File search unavailable") instead of an empty list.
- Measured on 10,000 synthetic notes (release): mirror about 1.5 MB against about 2.7 MB before, 1.2 ms per keystroke on average.

### Consequences

- Good, because one file list, one scan per workspace and one place that keeps it fresh (the watcher).
- Bad, because behaviour changed: global gitignore, `.git/info/exclude` and a parent `.gitignore` no longer hide notes from quick open (the index follows the vault's own `.gitignore` files), and `.MD`/`.BASE` in any case are listed.
- Neutral, because a subsequence matcher such as `nucleo-matcher` is not adopted; adopting one would be a new ADR with a ranking comparison.

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/index/names.rs`, `state.rs`, `commands/search.rs` (`fuzzy_search`, `find_file_by_name`, `read_recent_files`), `commands/workspace.rs` (`run_workspace_bootstrap`).
- **Patterns avoided**: a per-keystroke SQL query; a second file walk.

### Verification

- [ ] `cargo test` passes the matcher tests in `names.rs` (prefix, word boundary, path segments, ties, limit, filters) and `names::tests::perf_10k`.
- [ ] Creating, renaming or deleting a note outside Writer reaches quick open within the watcher debounce.
