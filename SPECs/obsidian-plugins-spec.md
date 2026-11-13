# Obsidian plugin host

Run Obsidian community plugins (first target: obsidian-copilot) inside Writer, install them from the community marketplace, then add Bases support. The host is a port of opensidian's (GPL-3.0-or-later, same license as Writer): its Rust modules are reused near as-is, its JS API shim is rewritten in TypeScript to fit Writer's stores and page-kinds. Opensidian's clean-room rule applies: no Obsidian code, CSS or binaries are read or copied; Bases is built from the public docs only. Plugins are loaded from the user's vault, never bundled (Copilot is AGPL-3.0).

## Decisions

- Port style: Rust modules reused, TS shim rewritten.
- Storage: `.obsidian/plugins/<id>/` and `.obsidian/community-plugins.json`, so an existing vault works unchanged. `.obsidian` stays hidden in the sidebar; only dedicated plugin commands read it.
- Trust: restricted mode by default, per-vault trust, GitHub-only marketplace allowlist, native consent for each process spawn.
- Bases: separate phase after Copilot works.

## Phase 0 — prerequisites

1. **Path containment (done).** `WorkspaceState::authorize_path` (`state.rs`) resolves symlinks and `..` and allows only the workspace root, a standalone window's one hosted file, or a pending open. `read_file`, `write_file`, `create_file`, `create_directory`, `rename_entry`, `delete_entry` check it and fail with `InvalidPath`. The `_impl` functions stay unscoped because `get_startup_state` reads the standalone file before it is registered. Tests in `state.rs`. Not yet covered: `file_exists` (existence leak), `reveal_in_file_manager`, the asset protocol scope (`**`), and other commands that take paths (`images.rs`, search).
2. **Seal before plugin load.** Capture `invoke` in the host, then neutralize `__TAURI_INTERNALS__` before any plugin script runs (opensidian `loader.js` `seal()`). Needs a spike to confirm the app keeps working afterwards.
3. **CSP.** Add a `writer-plugin:` scheme to `script-src`; `'unsafe-eval'` and `blob:` only for a trusted vault. Narrow the asset protocol scope.

## Phases 1–4

See the approved plan: Rust backend (`plugins.rs`, `plugin_store.rs`, consent/trust, https `desk_http`), TS host in `src/lib/obsidian-host/`, Copilot compatibility pass, then Bases (`.base` parser, expression evaluator, table view, embeds, migration).

## Deferred: Bases, indexing, SQLite (decided 2026-11-13)

Out of scope until the plugin host and Copilot work. To do later, in this order: (1) read the public Bases docs properly (reference notes already in the research scratchpad, with open questions on sort/layout keys and list functions); (2) design the vault index (properties, tags, backlinks, links) with a SQLite store for frontmatter, which would also back `MetadataCache`; (3) `.base` parsing, expression evaluation and views on top of that index; (4) migration tooling. Until then the in-memory `MetadataCache` in the TS host is enough for plugins.

## Open risks

API shim breadth, missing Editor/Workspace facades, https and streaming fetch for LLM calls, Agent Mode (`child_process`), arbitrary JS in the webview (mitigated, not sandboxed). Frontend callers that read files outside the workspace root would now be rejected; none found yet, to be confirmed by running the app.
