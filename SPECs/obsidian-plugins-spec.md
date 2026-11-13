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
- **Process spawn** (`plugin_proc.rs`, `plugin_consent.rs`, `plugin_env.rs`): see "Process and environment contract" below. Trusted vault only; native 3-way consent; cwd confined to the vault; max 8 live processes; process groups killed on window close, vault switch, trust revoke and app exit.
- **Asset scope**: `assetProtocol.scope` is `[]` in `tauri.conf.json`; the workspace root (recursive) is allowed when a workspace opens, a standalone file's folder (flat) plus its `<stem>-assets` folder when a standalone file opens. Tauri cannot remove an allow (`forbid_*` is permanent and wins), so grants last for the session instead of being revoked on close. Manual QA: open a vault with a note embedding `![](img/a.png)` and `![[b.png]]`, confirm both render; open the same note standalone with a sibling `note-assets/x.png`; confirm an image outside the opened folder (absolute path elsewhere on disk) no longer renders.
- **Authorization coverage**: now also `read_directory`, `read_file_entries` (the old lexical `starts_with` let `root/../x` through), `file_exists` (answers false outside reach), `reveal_in_file_manager`, `save_clipboard_image`, `find_file_by_name`. Standalone windows additionally get read-only probes of sibling entries and `<stem>-assets` (`authorize_probe`). Intentionally unscoped: `open_workspace`, `restore_workspace`, `open_workspace_in_new_window`, `open_file_in_standalone_window` (they pick a new root, normally from a native dialog or recents), `watch_standalone_file` (it defines the standalone file; widening it is its job), `save_session` / `load_session` / `remove_recent_workspace` (app-data keyed by a root string, no file access), `index_workspace` / `fuzzy_search` / `read_recent_files` (use the window's own index). `create_sidebar_entry` and the terminal commands already confine themselves to the root.

Seal: removed (Phase 0.2), not open. The TS host boots plugins for a trusted vault directly.

## Trust model (no in-page sandbox)

Trusting a vault means its plugins run with the app's privileges, exactly as in Obsidian itself. Plugin code shares the webview with Writer and can call any Writer IPC command. Restricted mode (default, per vault) means no plugin code is loaded at all. What still holds:

- **Restricted by default.** Nothing from `.obsidian/plugins` is evaluated until the user confirms trust for that vault; the confirmation says plainly that plugins are not sandboxed.
- **File access is confined by Rust**, not by the page: `authorize_path` limits every file command to the window's workspace root (symlinks and `..` resolved), whoever calls it.
- **Process spawn needs native consent** (dialog drawn by Rust, not spoofable from the page): run once, or always allow one program per plugin and vault (cleared when trust is revoked).
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

## Process and environment contract (Rust, 2026-11-13)

All commands: trusted vault only, window-bound, rejections are `AppError` strings. Top-level Tauri args are camelCase; struct fields are snake_case.

| Command                                         | Args                                                                                                                 | Returns                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `plugin_proc_spawn`                             | `request: {plugin_id, command, args?, cwd?, env?, stdin?: "pipe"\|"ignore", inherit_env?: bool}`, `onEvent: Channel` | proc id (u64)                                             |
| `plugin_proc_write` / `plugin_proc_close_stdin` | `procId`, `dataBase64` / `procId`                                                                                    | void                                                      |
| `plugin_proc_kill`                              | `procId, signal?: "SIGTERM"\|"SIGKILL"\|"SIGINT"\|"SIGHUP", group?: bool`                                            | void                                                      |
| `plugin_which`                                  | `name`                                                                                                               | absolute path or null                                     |
| `plugin_resolve_login_path`                     | none                                                                                                                 | PATH string                                               |
| `plugin_os_info`                                | none                                                                                                                 | `{platform, arch, homedir, username, shell, tmpdir, env}` |
| `plugin_fs_probe`                               | `paths: string[]` (max 256)                                                                                          | `{path, exists, is_file, is_dir, size\|null}[]`           |
| `plugins_consent_list`                          | none                                                                                                                 | `{plugin_id, program}[]`                                  |
| `plugins_consent_revoke`                        | `pluginId, program`                                                                                                  | void                                                      |

Spawn events (`type` tag, in order): `spawn{pid}`, then any `stdout`/`stderr{data_base64}`, then exactly ONE terminal event, always last: `exit{code: number\|null, signal: string\|null}` (signal NAME such as "SIGTERM"; emitted only after both pipes reached EOF, like Node's `close`, with a 10 s grace if a surviving grandchild keeps a pipe open) or `error{code: "ENOENT"\|"EACCES"\|"EPERM"\|"UNKNOWN", message}` when the program cannot be found or exec'd (no `exit` follows; the invoke still resolves with a proc id). Consent denial, a cwd outside the vault and a full process table reject the invoke itself (`EACCES: ...`, `EBUSY: ...`).

Spawn defaults: `cwd` = vault root (if given it must be inside the vault); `stdin` = pipe (`ignore` = /dev/null, writes fail with EPIPE); `inherit_env` = true (the app's real environment overlaid by `env`; false = only `env`). The child always leads its own process group. A bare `command` is resolved through `env.PATH` if given, else the app PATH plus the well-known install dirs.

Kill: `signal` defaults to SIGTERM and `group` to true (`kill(-pgid)`). The old behaviour was SIGKILL, but no caller used the command, so the graceful default won; the TS side escalates to SIGKILL after a grace period. Window close, vault switch, trust revoke and app exit still SIGKILL the group.

Consent: the dialog offers "Run once", "Always allow this program in this vault" and "Deny", and shows plugin id, resolved program, all args, cwd and env var NAMES. "Always" is stored in `<app_data>/plugins_proc_consent.json` as canonical vault path -> plugin id -> resolved absolute program (arguments are not part of the key). A remembered program skips the dialog but every spawn emits the window event `plugin-proc:spawned` `{plugin_id, program, args, cwd, pid}`. `plugins_set_trust(false)` clears the vault's remembered consents; `plugins_consent_revoke` removes one.

Helpers (no process of the plugin's choosing, so no dialog): `plugin_which` scans the login PATH, the app PATH and well-known dirs (`~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.volta/bin`, `~/.bun/bin`, nvm and fnm node bins) for an executable regular file; names with `/` or `..` are rejected, absolute paths are only checked for the executable bit. `plugin_resolve_login_path` runs `$SHELL -ilc` once (10 s timeout, SIGKILL, output markers, cached for the app run including the app-PATH fallback; debug log carries only the PATH length). `plugin_os_info.env` is an allow-list (HOME, USER, LOGNAME, SHELL, TMPDIR, LANG, LC*\*, TERM, XDG*\*, CLAUDE_CONFIG_DIR, EDITOR, PATH = login PATH) minus anything matching KEY, TOKEN, SECRET, PASSWORD or CREDENTIAL (case-insensitive). `plugin_fs_probe` returns metadata only, for paths inside the vault (canonicalized, symlink escapes read as missing), under `~/.claude` / `CLAUDE_CONFIG_DIR`, or exactly a path `plugin_which` returned for the window; anything else is `exists: false`.

Gaps: Windows is compile-only (no process groups beyond CREATE_NO_WINDOW, signals map to terminate); no PTY; signal names beyond the common POSIX set print as `SIG<n>`; the 8-process cap counts helper processes like `claude --version`.

## Status (Copilot e2e, 2026-11-13)

Unmodified obsidian-copilot 4.0.20 loads in the real built Tauri app (trusted vault) and completes a Claude Agent turn against a fake `claude` CLI: `apps/desktop/e2e/specs/copilot-fake-claude.spec.js` (run with `sh e2e/fixtures/copilot-fake-claude/run.sh`, see `e2e/README.md`; 7 tests, repeated green). Host bugs it found and fixed: Copilot's device id was seeded under a key Copilot never read (so the Claude path was ignored and Agent Chat showed "not set up"); `app.secretStorage` missing (startup unhandled rejection; now memory-only); `Element.onWindowMigrated` missing (Agent view `onOpen` failed); the CSS sanitizer deleted Copilot's whole minified stylesheet (per-line check tripped on `scroll-behavior:`); vault stat guessed "file" for folders the listing hides (`notifyExternal` failures); no Obsidian CSS variables (icons unsized). Also added `window.__writerPluginErrors` and an e2e-only `WRITER_E2E_EXTRA_PATH`.

Proves: load/enable/disable/re-enable, seed, palette commands, view in the right pane, load-time probes (`--version`, `auth status --json`, idle stream-json child) and the session child's argv, a streamed turn rendered in the DOM, graceful stop on plugin disable, no orphan after app quit (the quit path killed a live session).

Does NOT prove: the real `claude` CLI (versions, auth, `~/.claude` access), real LLM chat mode or BYOK keys (secretStorage is in-memory), permission cards, Stop/interrupt, SIGKILL escalation, Copilot's Settings panels, consent dialog UX (pre-approved through `plugins_proc_consent.json`), timer throttling with a hidden window, `bypassPermissions` refusal. Known limits seen: Copilot keeps a worked-in chat's process alive after its tab closes (its design); typing into Copilot's Lexical input needs `execCommand` under WebDriver; the plugin's global CSS slightly shifts Writer's sidebar search icon.
