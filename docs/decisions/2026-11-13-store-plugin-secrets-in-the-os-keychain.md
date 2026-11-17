---
status: accepted
date: 2026-11-13
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Store plugin secrets (`app.secretStorage`) in the OS credential store

> Storage layout and failure behaviour refined by [2026-11-17 one Keychain item](2026-11-17-keep-all-plugin-secrets-in-one-keychain-item-and-run-plugins-without-them-when-it-is-unreadable.md): the per-secret items and index below are no longer used.

> Backfilled on 2026-11-16. Date = `5bfe3ba` "Persist plugin secretStorage in the OS credential store" (adds `plugin_secrets.rs` and the `keyring` dependency). Spec: [`SPECs/obsidian-plugins-spec.md`](../../SPECs/obsidian-plugins-spec.md), "Plugin secrets".

## Context and Problem Statement

Copilot and other plugins keep API keys through `app.secretStorage`. The first e2e run with unmodified Copilot found the API missing (startup unhandled rejection); a memory-only stub would lose keys at quit.

## Considered Options

- The multi-OS `keyring` crate: macOS Keychain, Windows Credential Manager, Linux Secret Service (chosen).
- A file in the app data directory or in the vault: secrets on disk in clear text, or inside a folder users sync and commit.
- Memory only: loses keys at every quit.

## Decision Outcome

Chosen option: `keyring` in `apps/desktop/src-tauri/src/plugin_secrets.rs`; nothing is written to disk by Writer. Commands `plugin_secrets_load`, `plugin_secret_set`, `plugin_secret_delete` work for trusted vaults only, are window-bound and run blocking work off the async runtime.

- One credential per secret (`secret:<id>`) plus an index credential (`__index__`, a JSON array of ids), because credential stores cannot be enumerated portably and Windows caps a blob at a few KB. Write order keeps the index a superset of what exists; a corrupt index is an error, never treated as empty.
- Service name `<app identifier>.plugin-secrets`, so the e2e build (different identifier) never touches the real keychain.
- Secrets are shared by every plugin and vault of the user, like Obsidian's keychain. Limits: id 1-256 chars without control characters, 2048 bytes per secret, 256 secrets.
- The synchronous plugin API is a cache hydrated before any plugin script runs (`apps/desktop/src/lib/obsidian-host/api/secret-storage.ts`).

### Consequences

- Good, because keys survive restarts without a plaintext file.
- Bad, because Linux without a Secret Service, or a locked or denied keychain, degrades to memory-only for the run (reported in `window.__writerPluginErrors`); the real keychain path is unit-tested only against a fake backend, and manual QA on each OS is open.
- Bad, because secrets are not isolated per plugin.

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/plugin_secrets.rs`, `apps/desktop/src/lib/secrets-client.ts`, `apps/desktop/src/stores/secrets-store.ts`, `apps/desktop/tests/obsidian-host-secret-storage.test.ts`.
- **Dependencies**: `keyring = "4"` (`apps/desktop/src-tauri/Cargo.toml`).
- **Patterns to avoid**: persisting a secret to settings, the vault or `localStorage`.

### Verification

- [ ] `cargo test` passes the fake-backend tests in `plugin_secrets.rs`.
- [ ] `vp test` passes `tests/obsidian-host-secret-storage.test.ts`.
- [ ] Manual: set a key in Copilot, quit, relaunch, key is still set (macOS, Windows, Linux).
