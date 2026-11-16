---
status: accepted
date: 2026-04-30
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Keep workspace state per window, in one process

> Backfilled on 2026-11-16 from `SPECs/multi-window-spec.md`. The spec says v1 shipped on 2026-04-23, before the git history begins; `594cabd` (2026-04-30, "Initial commit") is the earliest commit that contains the spec and the code, so that is the date used. Spec: [`SPECs/multi-window-spec.md`](../../SPECs/multi-window-spec.md).

## Context and Problem Statement

Writer used a single global workspace: opening a second workspace replaced the first. Users want several workspace windows at once (File > New Window, Cmd+Shift+N), each with its own tabs, sidebar and history, while closing one window must not affect the others.

## Considered Options

- Per-window state inside one process: every window is a Tauri `WebviewWindow`; a process-wide registry maps the window label to a per-window state object.
- One process per window: heavier, and cross-window coordination (updater, recents, single instance) becomes inter-process.
- Keep one global state and swap it: the status quo, which cannot host two workspaces.

## Decision Outcome

Chosen option: per-window state in one process.

- Rust: `AppState` (`apps/desktop/src-tauri/src/state.rs`) holds `windows: RwLock<HashMap<String, Arc<WorkspaceState>>>` keyed by window label (`main` or uuid-based labels from `open_workspace_in_new_window`). `WorkspaceState` owns the workspace root, name cache of the index, watcher handle, recent-write map, ignore matcher, workspace epoch, cancel flag and the merged settings for that window. Every command derives the label from the invoking webview and calls `get_or_create`; the window-close handler `remove`s the state so the watcher is dropped.
- Frontend: each window mounts its own Zustand store instances scoped to its React tree.
- Shared on disk, not in memory: recents, `sessions.json`, the global config. Read-modify-write on these is serialised by `global_settings_file_lock`, `sessions_file_lock` and `recent_files_lock` in `AppState`.
- Background work captures `workspace_epoch` and drops results from a previous workspace.

### Consequences

- Good, because windows are isolated: different workspaces carry different merged settings and independent watchers.
- Good, because later features reuse the same keying: the vault index and its `NameCache` hang off `WorkspaceState`, and plugin commands are "window-bound" and trust-gated per window (see `2026-11-13-confine-file-commands-to-the-workspace-root.md`).
- Bad, because per-window settings copies can lag: a global setting changed in one window is not live in another until reload (known limitation in the spec).
- Bad, because shared JSON files rely on in-process locks; two app instances are prevented by `tauri-plugin-single-instance` (`docs/open-flow.md`).

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/state.rs`, `commands/workspace.rs`, `lib.rs`, `apps/desktop/src/stores/`.
- **Patterns to follow**: derive the window label first in every IPC command; capture `workspace_epoch` before async work and re-check before writing.
- **Patterns to avoid**: global (non-keyed) workspace statics; sharing a watcher between windows.

### Verification

- [ ] Unit tests in `state.rs` cover `authorize_path`, window registry and epoch behaviour (`cargo test` in `apps/desktop/src-tauri`).
- [ ] Opening a second window on another folder leaves the first window's sidebar and watcher untouched (manual, spec Goals).

## More Information

- Open follow-ups (from the spec and `TODOS.md`): macOS Window menu, multi-window session restore, tab tear-off.
- Related: [`2026-05-08-keep-notify-watcher-and-fix-the-filter.md`](2026-05-08-keep-notify-watcher-and-fix-the-filter.md).
