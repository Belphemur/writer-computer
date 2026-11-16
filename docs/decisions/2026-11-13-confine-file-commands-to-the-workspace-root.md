---
status: accepted
date: 2026-11-13
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Confine file commands to the window's workspace root in Rust

> Backfilled on 2026-11-16. Date = `0c518f0` "Scope file commands to the window's workspace root" (it introduced `authorize_path`). Spec: [`SPECs/obsidian-plugins-spec.md`](../../SPECs/obsidian-plugins-spec.md), Phase 0 item 1 and "Authorization coverage".

## Context and Problem Statement

Plugins run in the same webview and can invoke any file command. Before the plugin host, file commands accepted any absolute path. Page-side checks are bypassable, so confinement has to live in Rust and apply to every caller.

## Decision

`WorkspaceState::authorize_path` (`apps/desktop/src-tauri/src/state.rs`) resolves symlinks and `..` and allows only the workspace root, a standalone window's one hosted file, or a pending open. Violations fail with `InvalidPath`.

- Checked by `read_file`, `write_file`, `create_file`, `create_directory`, `rename_entry`, `delete_entry`, then also `read_directory`, `read_file_entries` (the old lexical `starts_with` let `root/../x` through), `file_exists` (false outside reach), `reveal_in_file_manager`, `save_clipboard_image`, `find_file_by_name`. Standalone windows get read-only probes of sibling entries and `<stem>-assets` (`authorize_probe`).
- The `_impl` functions stay unscoped because `get_startup_state` reads the standalone file before it is registered.
- Intentionally unscoped (they define a new root or touch app data only): `open_workspace`, `restore_workspace`, `open_workspace_in_new_window`, `open_file_in_standalone_window`, `watch_standalone_file`, `save_session`, `load_session`, `remove_recent_workspace`.
- Tauri-free code reuses the same idea: `vault_ops.rs` confines CLI and Bases writes to the vault, refuses symlinks leaving it, and protects `.obsidian` and `.git`.

## Consequences

- Good, because a plugin (or any webview code) cannot read or write outside the open vault through Writer's commands, whoever calls them.
- Bad, because frontend callers that read outside the workspace root now fail; none were found at the time, to be confirmed by running the app (spec "Open risks"). Links to files outside the workspace already hit a related ACL gap (see `2026-11-13-scope-the-opener-open-path-permission.md`).
- Bad, because the unscoped commands remain callable by a malicious plugin in a trusted vault (documented residual risk).

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/state.rs`, `commands/fs.rs`, `commands/images.rs`, `commands/search.rs`, `apps/desktop/src-tauri/src/vault_ops.rs`.
- **Patterns to follow**: every new path-taking command calls `authorize_path` first.

### Verification

- [ ] `cargo test` runs the `authorize_path_*` tests in `state.rs` (symlinks, `..`, standalone file).
- [ ] `vault_ops.rs` tests reject `.obsidian/app.json` and `a/../.obsidian/x.md`.
