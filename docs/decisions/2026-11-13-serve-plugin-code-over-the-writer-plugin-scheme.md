---
status: accepted
date: 2026-11-13
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Serve plugin code over a `writer-plugin://` URI scheme under a scoped CSP

> Backfilled on 2026-11-16. Date = `4fadcd0` "Add Tauri IPC seal and plugin CSP for the plugin host" (the CSP part survived the seal's removal) and `ab56648` (Rust backend with the scheme). Spec: [`SPECs/obsidian-plugins-spec.md`](../../SPECs/obsidian-plugins-spec.md), Phase 0 item 3 and "Asset scope".

## Context and Problem Statement

A plugin's `main.js` is one CommonJS bundle. Writer's page CSP has no `'unsafe-eval'` and no `blob:`, so the bundle cannot be evaluated from a string. The webview also must not read arbitrary files for plugins.

## Considered Options

- A custom URI scheme served by Rust, wrapping the bundle in a function that hands the host's `module`, `exports` and `require` to it (chosen).
- `eval` / `new Function` / `blob:` URLs: need `'unsafe-eval'` or `blob:` in `script-src` for every vault; the spec allows them only for a trusted vault and the implementation avoided them entirely.
- Loading through the asset protocol: ties plugin code to a broad file scope.

## Decision Outcome

Chosen option: the `writer-plugin` scheme (`apps/desktop/src-tauri/src/plugins.rs`, registered in `lib.rs` via `register_uri_scheme_protocol`). URL shape `writer-plugin://localhost/<id>/main.js?n=<reload>` (rewritten to `http://writer-plugin.localhost/...` on Windows). Rust serves only `/<id>/main.js` for a trusted vault whose `.obsidian/community-plugins.json` lists the id, with a plain-name id, no symlinked directories and a regular `main.js` under a size cap; everything else is 403/404. The loader (`apps/desktop/src/lib/obsidian-host/loader.ts`) injects a `<script src>` and a pending-define handshake hands the factory to the load that asked for it.

The CSP in `apps/desktop/src-tauri/tauri.conf.json` adds `writer-plugin:` (and the `.localhost` form) to `script-src`, `style-src`, `font-src` and `img-src`. `assetProtocol.scope` is `[]`: the workspace root (recursive) is granted when a workspace opens, a standalone file's folder (flat) plus `<stem>-assets` when a standalone file opens. Tauri cannot revoke an allow, so grants last for the session.

### Consequences

- Good, because the page never needs `unsafe-eval`, and restricted mode serves nothing.
- Bad, because `script-src` still has `'unsafe-inline'` and `img-src` allows `https:`; narrowing is open (see `2026-11-13-narrow-the-app-csp-img-src.md`).
- Bad, because asset grants cannot be revoked within a session.

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/plugins.rs`, `lib.rs`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src/lib/obsidian-host/loader.ts`, `ipc.ts` (`pluginScriptUrl`).
- **Patterns to avoid**: widening the scheme to other paths or files; adding `unsafe-eval` or `blob:`.

### Verification

- [ ] `cargo test` covers the scheme's path, id, trust and symlink checks in `plugins.rs`.
- [ ] A vault with an embedded `![](img/a.png)` and `![[b.png]]` renders both; an absolute path outside the opened folder does not (manual, spec "Asset scope").
