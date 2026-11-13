# Obsidian plugin host

Run Obsidian community plugins (first target: obsidian-copilot) inside Writer, install them from the community marketplace, then add Bases support. The host is a port of opensidian's (GPL-3.0-or-later, same license as Writer): its Rust modules are reused near as-is, its JS API shim is rewritten in TypeScript to fit Writer's stores and page-kinds. Opensidian's clean-room rule applies: no Obsidian code, CSS or binaries are read or copied; Bases is built from the public docs only. Plugins are loaded from the user's vault, never bundled (Copilot is AGPL-3.0).

## Decisions

- Port style: Rust modules reused, TS shim rewritten.
- Storage: `.obsidian/plugins/<id>/` and `.obsidian/community-plugins.json`, so an existing vault works unchanged. `.obsidian` stays hidden in the sidebar; only dedicated plugin commands read it.
- Trust: restricted mode by default, per-vault trust, GitHub-only marketplace allowlist, native consent for each process spawn.
- Bases: separate phase after Copilot works.

## Phase 0 — prerequisites

1. **Path containment (done).** `WorkspaceState::authorize_path` (`state.rs`) resolves symlinks and `..` and allows only the workspace root, a standalone window's one hosted file, or a pending open. `read_file`, `write_file`, `create_file`, `create_directory`, `rename_entry`, `delete_entry` check it and fail with `InvalidPath`. The `_impl` functions stay unscoped because `get_startup_state` reads the standalone file before it is registered. Tests in `state.rs`. Coverage is now complete, see Status below.
2. **Seal before plugin load (removed).** The plan was to capture `invoke` and neutralize `__TAURI_INTERNALS__` before any plugin script runs (opensidian `loader.js` `seal()`). It cannot work: Tauri defines `window.__TAURI_INTERNALS__` and every property on it (`invoke`, `ipc`, `postMessage`, ...) as non-writable and non-configurable, so any attempt throws "Attempting to change value of a readonly property". Verified by running the real built app in WKWebView. The in-page seal code, its tests and the `hostInvoke` indirection were deleted; all IPC uses plain `invoke` from `@tauri-apps/api/core`. See "Trust model" below.
3. **CSP.** Add a `writer-plugin:` scheme to `script-src`; `'unsafe-eval'` and `blob:` only for a trusted vault. The asset protocol scope is narrowed (done, see Status).

## Status (Rust backend, 2026-11-13)

Done in `apps/desktop/src-tauri`:

- **HTTP client** (`plugin_http.rs`): `plugin_http_request`, `plugin_http_stream_start` / `plugin_http_stream_cancel`. reqwest + rustls; trusted vault only; http/https only; localhost and private ranges allowed, cloud-metadata addresses refused (literal host on every hop and every DNS answer); 32 MiB request / 64 MiB buffered response caps; hop-by-hop headers stripped; manual redirects with credentials dropped on cross-origin hops; default 60 s timeout; nothing logged.
- **Process spawn** (`plugin_proc.rs`): `plugin_proc_spawn` / `_write` / `_close_stdin` / `_kill`. Trusted vault only; a native consent dialog on EVERY spawn (plugin id, resolved program, all args, cwd, env names; no "remember"); cwd confined to the vault; max 8 live processes; process groups killed on window close, vault switch, trust revoke and app exit. Trust is re-checked after the dialog returns. Only the dialog itself is untested (the consent is a trait with a test double).
- **Asset scope**: `assetProtocol.scope` is `[]` in `tauri.conf.json`; the workspace root (recursive) is allowed when a workspace opens, a standalone file's folder (flat) plus its `<stem>-assets` folder when a standalone file opens. Tauri cannot remove an allow (`forbid_*` is permanent and wins), so grants last for the session instead of being revoked on close. Manual QA: open a vault with a note embedding `![](img/a.png)` and `![[b.png]]`, confirm both render; open the same note standalone with a sibling `note-assets/x.png`; confirm an image outside the opened folder (absolute path elsewhere on disk) no longer renders.
- **Authorization coverage**: now also `read_directory`, `read_file_entries` (the old lexical `starts_with` let `root/../x` through), `file_exists` (answers false outside reach), `reveal_in_file_manager`, `save_clipboard_image`, `find_file_by_name`. Standalone windows additionally get read-only probes of sibling entries and `<stem>-assets` (`authorize_probe`). Intentionally unscoped: `open_workspace`, `restore_workspace`, `open_workspace_in_new_window`, `open_file_in_standalone_window` (they pick a new root, normally from a native dialog or recents), `watch_standalone_file` (it defines the standalone file; widening it is its job), `save_session` / `load_session` / `remove_recent_workspace` (app-data keyed by a root string, no file access), `index_workspace` / `fuzzy_search` / `read_recent_files` (use the window's own index). `create_sidebar_entry` and the terminal commands already confine themselves to the root.

Seal: removed (Phase 0.2), not open. The TS host boots plugins for a trusted vault directly.

## Trust model (no in-page sandbox)

Trusting a vault means its plugins run with the app's privileges, exactly as in Obsidian itself. Plugin code shares the webview with Writer and can call any Writer IPC command. Restricted mode (default, per vault) means no plugin code is loaded at all. What still holds:

- **Restricted by default.** Nothing from `.obsidian/plugins` is evaluated until the user confirms trust for that vault; the confirmation says plainly that plugins are not sandboxed.
- **File access is confined by Rust**, not by the page: `authorize_path` limits every file command to the window's workspace root (symlinks and `..` resolved), whoever calls it.
- **Process spawn needs native consent** on every spawn (dialog drawn by Rust, not spoofable from the page).
- **Network**: `plugin_http` works only for trusted vaults, http/https only, and refuses cloud-metadata addresses.
- **Store**: marketplace installs come from a GitHub-only allowlist.

Residual risks, stated honestly: a malicious plugin in a trusted vault can call any Writer IPC command that is not path-confined (settings, workspace switching and other commands listed as intentionally unscoped above), read and change every note in the vault, exfiltrate over `plugin_http` or the webview's own network access, and mislead the user in the UI. Users should only trust vaults and plugins they trust.

Future options, deferred or rejected for now:

- **Isolated plugin webview with its own capability set** (deferred): the only real boundary, since Tauri capabilities are per window and a plugin window would not get Writer's commands. Rejected for now because plugins need synchronous DOM and editor access (`app.workspace`, `registerEditorExtension`, views mounted into Writer's panes), which cannot cross a webview boundary without rewriting the API shim as an RPC layer.
- **Sandboxed iframe** (rejected for now): same DOM-access problem, and an iframe inside the main webview still reaches `window.parent.__TAURI_INTERNALS__` unless it is cross-origin, which would break the `writer-plugin://` loading and the API shim the same way.

## Phases 1–4

See the approved plan: Rust backend (`plugins.rs`, `plugin_store.rs`, consent/trust, https `desk_http`), TS host in `src/lib/obsidian-host/`, Copilot compatibility pass, then Bases (`.base` parser, expression evaluator, table view, embeds, migration).

## Deferred: Bases, indexing, SQLite (decided 2026-11-13)

Out of scope until the plugin host and Copilot work. To do later, in this order: (1) read the public Bases docs properly (reference notes already in the research scratchpad, with open questions on sort/layout keys and list functions); (2) design the vault index (properties, tags, backlinks, links) with a SQLite store for frontmatter, which would also back `MetadataCache`; (3) `.base` parsing, expression evaluation and views on top of that index; (4) migration tooling. Until then the in-memory `MetadataCache` in the TS host is enough for plugins.

## Open risks

API shim breadth, missing Editor/Workspace facades, Agent Mode (`child_process`), arbitrary JS in the webview (mitigated, not sandboxed). Frontend callers that read files outside the workspace root would now be rejected; none found yet, to be confirmed by running the app.

## Status (plugin networking, 2026-11-13)

Done: `requestUrl`/`request` over `plugin_http_request`; plugin-scoped streaming `fetch` over `plugin_http_stream_*`, exposed as a free variable `fetch` in the CJS wrapper and as an installable/idempotent `globalThis.fetch` patch while plugins are loaded; tests in `tests/obsidian-network-*.test.ts`. The loader now also passes the other wrapper free variables (`Error`, `__filename`, `__dirname`, `SharedArrayBuffer`) it previously left undefined. Gaps: `XMLHttpRequest`, `WebSocket`, `EventSource`; not yet verified against a real obsidian-copilot run.
