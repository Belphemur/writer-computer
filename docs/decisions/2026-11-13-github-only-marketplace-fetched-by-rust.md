---
status: accepted
date: 2026-11-13
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Fetch and install marketplace plugins from Rust, against a GitHub-only host allowlist

> Backfilled on 2026-11-16. Date = `ab56648` "Add Rust backend for the Obsidian plugin host" (`plugin_store.rs`); the browser UI followed in `c64b35c` and `d8a4539`. Spec: [`SPECs/obsidian-plugins-spec.md`](../../SPECs/obsidian-plugins-spec.md) ("Decisions", "Status (marketplace UI ...)").

## Context and Problem Statement

Users browse and install community plugins from inside Writer. Whatever the page shows or installs is code that later runs with app privileges in a trusted vault, so the network path that fetches it must not be steerable by page code or by a malicious catalog entry.

## Decision

All catalog, README and release-asset requests are made by Rust (`apps/desktop/src-tauri/src/plugin_store.rs`); the page only receives parsed results. `check_url` applies to every hop, redirects included: https only, default port only, no userinfo, a DNS name (never an IP), host compared exactly against `ALLOWED_HOSTS` (`github.com`, `api.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`), manual redirects with a cap and re-check of each `Location`, timeouts and a byte cap enforced while reading, anonymous requests (no token, no cookie jar). The catalog is Obsidian's public `community-plugins.json`.

- Install writes `main.js`, `manifest.json` and `styles.css` (when present) into `<vault>/.obsidian/plugins/<id>/` plus a sidecar (`writer-plugin-install.json`) recording sha256 per file. Installing never trusts or enables anything; enabling, updating and uninstalling take effect immediately through `plugins-store.reconcile()`.
- READMEs are rendered with `marked` and a strict DOMPurify allowlist (`apps/desktop/src/components/plugin-browser/render-readme.ts`).

## Consequences

- Good, because a compromised page cannot redirect installs to an arbitrary host.
- Bad, because plugins hosted outside GitHub cannot be installed from the store (manual install into `.obsidian/plugins` still works).
- Neutral, because trust remains a separate per-vault decision (`2026-11-13-trust-vaults-before-running-plugins-no-in-page-sandbox.md`).

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/plugin_store.rs`, `commands/plugins.rs`, `apps/desktop/src/components/plugin-browser/`, `apps/desktop/src/stores/plugin-store-catalog.ts`, `plugins-store.ts`.
- **Patterns to avoid**: fetching marketplace content from the webview; suffix host matching.

### Verification

- [ ] `cargo test` covers `check_url` (non-allowlisted host, IP literal, userinfo, redirect off-list) in `plugin_store.rs`.
- [ ] `vp test` passes `tests/plugin-browser-*.test.ts` and `plugin-updates-store.test.ts`.
- [ ] Not yet verified against the live catalog in the real app (spec).
