---
status: accepted
date: 2026-05-08
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Keep the `notify` watcher and fix its post-receive filter for external changes

> Backfilled on 2026-11-16. Date = the commit that added the spec and the fix, `a4f0fc0` "Pick up external file changes reliably (watcher spec) (#35)". Spec: [`SPECs/external-file-watcher-spec.md`](../../SPECs/external-file-watcher-spec.md).

## Context and Problem Statement

Files created, renamed, deleted or modified outside Writer (Finder, `git pull`, vim, scripts) were inconsistently reflected in the sidebar and open editors. The watcher existed and events fired, but three bugs in the Rust-side filtering swallowed them: a path filter that dropped every path with a dot-prefixed component including the workspace root (a vault under `~/.notes/`), a canonical-versus-opened root mismatch on macOS (`/var` versus `/private/var`), and self-write suppression that let two of the three FSEvents of one save through.

## Considered Options

- Keep `notify` (`RecommendedWatcher`) and fix the filter, root comparison and self-write handling.
- Swap to `tauri-plugin-fs-watch` or another crate: rejected in the spec because the watcher itself was correct, only filtering was wrong.
- Add a polling fallback for network mounts and FUSE: explicitly out of scope; users on those keep stale data.

## Decision Outcome

Chosen option: keep `notify` with a 300 ms debounce, filter only paths below the workspace root, and keep the two-tier ignore (cheap hard-coded skip of `.git`, `node_modules`, `.DS_Store`, other dot components, then the gitignore matcher). `.writer` and `.gitignore` stay watchable (settings reload, matcher rebuild). Own saves are recorded with `record_write` (2 s TTL, not consumed on first match) so the three events of one save do not bounce back as a reload. `WRITER_WATCHER_LOG=1` dumps events and filter decisions for the residual "missed change" investigation.

### Consequences

- Good, because external edits appear in the sidebar within about the debounce interval, and the same feed later drives the vault index (see `2026-11-15-sqlite-vault-index-in-app-data.md`).
- Bad, because network mounts and FUSE remain unsupported, and residual miss cases are still being characterised (`SPECs/reveal-in-sidebar-and-external-watcher-spec.md`, `TODOS.md` In Progress).
- Neutral, because each window owns its watcher (see `2026-04-30-per-window-workspace-state.md`).

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/watcher.rs` (`should_ignore`, `record_write`, `DEBOUNCE_MS`, `SELF_WRITE_TTL`), `apps/desktop/src/hooks/use-file-watcher.ts`, `apps/desktop/tests/file-watcher.test.ts`.
- **Patterns to avoid**: filtering on absolute paths (the root may be a dot directory); comparing un-canonicalised roots.

### Verification

- [ ] `cargo test` in `apps/desktop/src-tauri` passes the watcher filter tests; `vp test` passes `tests/file-watcher.test.ts`.
- [ ] A vault under a dot-prefixed path shows an externally created file in the sidebar.
