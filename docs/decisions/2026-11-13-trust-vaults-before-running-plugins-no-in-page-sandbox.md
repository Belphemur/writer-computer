---
status: accepted
date: 2026-11-13
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Run plugins only in trusted vaults, with no in-page sandbox

> Backfilled on 2026-11-16. Date = `0b6a596` "Remove the Tauri IPC seal; trust gate is the isolation model" (the same day `4fadcd0` first added the seal). Spec section "Trust model": [`SPECs/obsidian-plugins-spec.md`](../../SPECs/obsidian-plugins-spec.md).

## Context and Problem Statement

Plugin code runs in Writer's webview and can call any Tauri IPC command. The phase-0 plan (`4fadcd0`) was to capture `invoke` and neutralise `__TAURI_INTERNALS__` before any plugin script ran. Verified in the built app (WKWebView): Tauri defines `__TAURI_INTERNALS__` and every property on it as non-writable and non-configurable, so sealing always threw, and the fail-closed host loaded no plugins.

## Considered Options

- Restricted mode by default plus per-vault trust, with Rust-side enforcement (chosen).
- In-page seal of the IPC bridge: impossible, see above; code and tests were deleted.
- Isolated plugin webview with its own capability set: the only real boundary (Tauri capabilities are per window), deferred because plugins need synchronous DOM and editor access (`app.workspace`, `registerEditorExtension`, views mounted into Writer's panes), which cannot cross a webview boundary without rewriting the API shim as RPC.
- Sandboxed iframe: rejected for now; same DOM-access problem, and an iframe inside the main webview reaches `window.parent.__TAURI_INTERNALS__` unless cross-origin, which would break `writer-plugin://` loading.

## Decision Outcome

Chosen option: trusting a vault means its plugins run with the app's privileges, as in Obsidian itself, and what still holds is enforced in Rust:

- **Restricted mode is the default, per vault.** Nothing from `.obsidian/plugins` is evaluated until the user confirms trust, and the confirmation says plainly that plugins are not sandboxed. The trust flag lives in the app data dir, outside the vault, so a vault cannot pre-trust itself (`plugins::is_trusted`, `apps/desktop/src-tauri/src/plugins.rs`). Every plugin command calls `require_trusted` (`commands/plugins.rs`).
- File access is confined by Rust (`2026-11-13-confine-file-commands-to-the-workspace-root.md`), process spawn needs native consent (`2026-11-13-native-consent-for-plugin-process-spawn.md`), network goes through `plugin_http` for trusted vaults only (http/https, cloud-metadata addresses refused), marketplace installs come from a GitHub-only allowlist (`2026-11-13-github-only-marketplace-fetched-by-rust.md`).

### Consequences

- Good, because the model is honest and testable: restricted mode loads no plugin code at all.
- Bad, because a malicious plugin in a trusted vault can call any IPC command that is not path-confined (settings, workspace switching, the intentionally unscoped commands), read and change every note, exfiltrate over `plugin_http` or the webview's own network, and mislead the user. The spec states this residual risk.
- Revisit when: an RPC-based API shim becomes acceptable, which would allow an isolated webview.

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/plugins.rs`, `commands/plugins.rs` (`plugins_set_trust`), `apps/desktop/src/stores/plugins-store.ts` (`requestTrust`, the one confirmation flow), `apps/desktop/src/lib/obsidian-host/loader.ts`.
- **Patterns to follow**: every new plugin-facing command is window-bound and calls `require_trusted`.
- **Patterns to avoid**: relying on page-side hiding of `invoke`; adding a plugin command that accepts arbitrary paths.

### Verification

- [ ] `apps/desktop/tests/plugins-store.test.ts` and `obsidian-host-lifecycle.test.ts` pass (restricted mode boots nothing).
- [ ] `cargo test` covers `plugins::is_trusted` and the scheme handler's refusals.
- [ ] Revoking trust (`plugins_set_trust(false)`) kills plugin processes and clears remembered consents.
