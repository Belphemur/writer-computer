---
status: proposed
date: 2026-11-13
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Scope the `opener:allow-open-path` permission for links to files outside the workspace

> Backfilled on 2026-11-16 from `TODOS.md` (Up Next). Date = `0246bc8`, the commit that added the TODO item. Nothing is decided yet; this records the open question and its constraint.

## Context and Problem Statement

`openPath` in `apps/desktop/src/components/editor-area/link-navigation.ts` (links to files outside the workspace) calls `plugin:opener|open_path`. That command has no permission in `apps/desktop/src-tauri/capabilities/default.json`, so such links fail with an ACL error. Plugins share the page's IPC, so a broad permission also becomes available to a plugin in a trusted vault.

## Considered Options

- A scoped `opener:allow-open-path` (for example only the workspace root and its asset folders): safe but must be kept in step with workspace changes; Tauri scopes cannot be revoked within a session (see `2026-11-13-serve-plugin-code-over-the-writer-plugin-scheme.md`).
- A `**` scope: simple, but would let a trusted vault's plugin launch any file.
- A Rust command that applies `authorize_path` and calls the opener plugin itself: the pattern already used for "Open in Finder" (`SPECs/sidebar-empty-area-context-menu-spec.md`) and for `plugin_open_path`, which opens only existing vault or agent-home entries.
- Leave links to outside files unsupported.

## Decision Outcome

Not decided. `TODOS.md` says to decide the scope first; the options above are the ones the repository already has precedents for.

### Consequences

- Until decided, links to files outside the workspace fail with an ACL error.

## Implementation Plan

- **Affected paths**: `apps/desktop/src/components/editor-area/link-navigation.ts`, `apps/desktop/src-tauri/capabilities/default.json`, `apps/desktop/src-tauri/src/commands/`.
- **Patterns to avoid**: a `**` allow-open-path scope.

### Verification

- [ ] A link to a file outside the workspace opens in the default app, and a plugin cannot use the same path to launch an arbitrary file.

## More Information

- Related: [`2026-11-13-confine-file-commands-to-the-workspace-root.md`](2026-11-13-confine-file-commands-to-the-workspace-root.md).
