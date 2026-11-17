---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Keep all plugin secrets in one Keychain item and run plugins without them when it is unreadable

Refines [Store plugin secrets in the OS credential store](2026-11-13-store-plugin-secrets-in-the-os-keychain.md) (storage layout and failure behaviour only; the credential-store decision stands). Spec: [`SPECs/obsidian-plugins-spec.md`](../../SPECs/obsidian-plugins-spec.md), "Plugin secrets".

## Context and Problem Statement

Every local rebuild is ad-hoc signed, so macOS asks for the login-keychain password once per keychain item on first access: the index plus each secret, so N+1 prompts. If the user denied or failed a prompt, the read failed and the plugin (Copilot) ran without its keys with no visible explanation.

## Considered Options

- One item holding a JSON document of all secrets, read once per process (chosen).
- Keep one item per secret plus an index (status quo): N+1 prompts.
- A Writer-owned encrypted file: a key to protect is still needed, and secrets would be on disk.

## Decision Outcome

Chosen option: a single credential, account `secrets:v2`, holding `{"version":2,"secrets":{"<id>":"<value>"}}`.

- Rust reads it once per process into memory behind the lock; list, get, set and delete work on that cache, and every change writes the whole document back (the cache changes only after a successful write). A failed read is not cached, so the next call retries. A write never happens unless the full document was read first, so a failed read cannot lead to a partial overwrite.
- A corrupt or unsupported-version document is an error and is never overwritten. Error messages never contain values (the JSON parse error is reduced to line and column).
- No migration. The old items (`secret:<id>` and `__index__`) are ignored and left in place; users re-enter their keys. A missing `secrets:v2` item means no secrets.
- Size: Windows Credential Manager caps a blob at 2560 bytes (stored as UTF-16 by `keyring`), so the document is capped at 1280 bytes there and at 64 KiB elsewhere; the per-secret (2048 bytes) and count (256) limits stay. Exceeding a cap is a clear `EINVAL` error.
- Graceful denial: when the read fails, `SecretStorage.hydrate` still resolves, with an empty cache and status `{state:"unavailable", reason}`; plugin loading does not fail. A warn is logged once (`logger.warn("plugin", ...)`). Settings > Secrets shows a non-alarming notice with Retry. A successful retry (Retry button, or any successful Settings refresh) fills the host's cache so the plugin's next `getSecret` sees the values, and notifies subscribers. Writes made while unavailable fail clearly (plugin error log), are kept in memory only, and are written after a successful retry.

### Consequences

- Good, because one Keychain access (one prompt) per launch after a rebuild.
- Good, because a denied prompt is visible and recoverable without restarting Writer.
- Bad, because existing users lose their stored keys once (no migration) and must re-enter them.
- Bad, because on Windows all secrets together must fit in 1280 bytes.
- Bad, because every change rewrites the whole item.

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/plugin_secrets.rs`, `apps/desktop/src/lib/obsidian-host/api/secret-storage.ts`, `apps/desktop/src/stores/secrets-store.ts`, `apps/desktop/src/stores/plugins-store.ts`, `apps/desktop/src/components/settings-panel/secrets-section.tsx`.
- **Patterns to avoid**: reintroducing per-secret keychain items; caching a failed read; writing a document built from a partial cache.

### Verification

- [ ] `cargo test` passes the `plugin_secrets` tests (single item, shape, read once, corrupt, failed read, size cap, no values in errors).
- [ ] `vp test` passes `obsidian-host-secret-storage` and `secrets-section` tests.
- [ ] Manual: rebuild, open a trusted vault, expect one prompt; deny it, see the notice, press Retry.
