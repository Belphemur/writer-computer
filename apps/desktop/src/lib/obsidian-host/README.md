# obsidian-host

TypeScript core of Writer's Obsidian-plugin host. Adapted from opensidian (GPL-3.0-or-later). Spec: `SPECs/obsidian-plugins-spec.md`. The app side lives in `src/stores/plugins-store.ts`, `src/components/plugins/`, `src/hooks/use-plugins.ts` and `workspace-bridge.ts` / `editor-bridge.ts` here.

## Architecture

```
PluginHost (loader.ts)            lifecycle, status map, script injection, require
  ├─ HostIpc (ipc.ts)             Rust backend boundary (faked in tests)
  ├─ App (api/app.ts)             what a plugin sees as `this.app`
  │    ├─ Vault + MetadataCache   over an injectable VaultIo (api/vault.ts, api/vault-io-tauri.ts)
  │    ├─ Workspace               over an injectable WorkspaceBridge (api/views.ts)
  │    └─ HostServices            commands / ribbon / status bar / setting tabs / registrations
  └─ obsidian-module.ts           the object `require("obsidian")` returns (ES5-subclassable classes)
```

- **Teardown has one write path.** Everything a plugin registers goes into an `OwnedRegistry` keyed by plugin id (`api/core.ts`); disabling is `plugin.unload()` (runs `register`/`registerEvent`/`registerInterval` cleanups, then `onunload`) followed by `services.sweep(id)` and removing the style tag. Workspace views and open modals are swept through `services.addSweeper`.
- **Loading.** `main.js` is injected as `<script src="writer-plugin://localhost/<id>/main.js?n=K">`. Rust serves it wrapped as `__writerPluginDefine("<id>", function (module, exports, require, process, global, Buffer) { ... })`. The global is installed non-writable by the loader; only a define for a pending load is honoured.
- **Status.** `host.getSnapshot()` / `host.subscribe` follow the `useSyncExternalStore` contract: `{trusted, booted, installed, status: {id: {state: "enabled" | "failed" | "disabled", error?}}}`. A failing plugin is torn down fully; its enabled flag stays set (Obsidian parity).
- **No in-page sandbox.** Tauri defines `__TAURI_INTERNALS__` non-writable and non-configurable, so the page cannot be sealed. A trusted vault's plugins run with the app's privileges (like Obsidian); Rust-side path authorization, native spawn consent and trusted-vault gating are the remaining defences. See the spec's Trust model.
- **App wiring.** `usePluginHostLifecycle` (mounted in `App`) attaches the store when a workspace window has resolved startup and detaches on workspace change; standalone/compact windows and the welcome screen never boot. `attach` reads backend state first and only boots when the vault is trusted (`plugins_state`); a boot failure is shown as `bootError` under Settings > Community plugins.
- **Host wiring points.** The host UI owns what is visible: it implements `WorkspaceBridge` (mount `leaf.containerEl`, reveal, active file/editor), renders `services.ribbon`/`statusBar`/`settingTabs` items (each has a ready DOM element), calls `app.workspace.markLayoutReady()`, and forwards file-watcher events to `app.vault.notifyExternal`.

## IPC contract (Tauri commands)

| Command                                                     | Args                               | Returns                                                     |
| ----------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| `plugins_state`                                             |                                    | `{trusted, enabled: string[], installed: {id, manifest}[]}` |
| `plugins_set_trust`                                         | `trusted`                          |                                                             |
| `plugins_set_enabled`                                       | `id, enabled`                      |                                                             |
| `plugin_read_asset`                                         | `id, kind: "manifest" \| "styles"` | string (a missing `styles` may throw: treated as no styles) |
| `plugin_data_read` / `plugin_data_write`                    | `id` / `id, json`                  | `string \| null` /                                          |
| `plugin_store_list` / `_detail` / `_install` / `_uninstall` | `- / id / id / id`                 | opaque (typed `unknown` for now)                            |

## Implemented vs stubbed

Real: Events, Component, Plugin (commands, ribbon, status bar, setting tabs, views, loadData/saveData with serialized writes), Notice, Scope/Keymap, Modal, SuggestModal, FuzzySuggestModal, Setting + Text/TextArea/Toggle/Dropdown/Button/ExtraButton/Slider/Search/Color components, PluginSettingTab, Menu, TAbstractFile/TFile/TFolder, Vault, DataAdapter/FileSystemAdapter, MetadataCache (frontmatter, links, embeds, tags, headings, resolved/unresolved links, `changed`/`resolved`/`deleted`), View/ItemView/FileView/TextFileView/MarkdownView, WorkspaceLeaf, Workspace, Editor facade, Obsidian DOM helpers, debounce, normalizePath, YAML, fuzzy search, `require` map (`obsidian`, app CodeMirror/Lezer, `path`).

Compat details: the DOM helpers (`createEl`, `Node.doc/win/instanceOf`, `activeDocument`, ...) are installed by `PluginHost` when the first plugin loads and removed when the last one is torn down (`installDomHelpers` returns the uninstaller). `Platform.isDesktopApp` is false (no Electron/Node) while `isDesktop` is true. `vault.on("create")` replays for pre-existing files inside `markLayoutReady()`, before `layoutReady` flips. `registerBasesView` returns `false`.

Stubbed or partial:

- `requestUrl` is fetch-based (CORS, CSP apply). TODO: Rust-backed https client.
- `moment` is the real library (static import here; the whole host is a lazy chunk, so it stays out of the entry bundle).
- `MarkdownRenderer` is an escaped-paragraph placeholder; `setMarkdownRenderer(fn)` plugs in the app's renderer.
- Icons: registered SVGs render; other names render a neutral glyph (`data-icon`, `lucide-<name>` class). No icon pack is bundled.
- `registerEditorExtension` is live: the plugins store feeds the recorded extensions into the shared `pluginExtensionCompartment` (`editor-bridge.ts`, added by `createEditorExtensions`), reconfigured on enable/disable; a rejected extension resets the editors and shows an error. `editor.cm` is the active CodeMirror view.
- `registerMarkdownPostProcessor`, `registerMarkdownCodeBlockProcessor`, `registerExtensions`, `registerObsidianProtocolHandler`, `registerHoverLinkSource` only record into `services.registrations` (swept on disable); the host does not act on them yet. Leaves of every placement open in the one right-hand plugin pane (no left sidebar or main-area leaves); the pane is toggled from the command palette.
- No binary file IO (`readBinary` rejects), no `fs`, no Node built-ins besides `path`; `process` is a minimal object and `Buffer` is whatever the page provides.
- Intervals/timers a plugin creates with bare `setInterval` and listeners it adds to `window` itself are not tracked; use `registerInterval`/`registerDomEvent` (Obsidian's contract).
- Modals carry no owner, so disabling any plugin closes all open plugin modals.

## Tests

`tests/obsidian-host-*.test.ts`. `lifecycle`, `commands`, `vault` run in the node environment against `testing.ts` fakes; `dom` and `compat` use jsdom (`// @vitest-environment jsdom`). Tests import with relative paths (`../src/...`): `tests/` is outside tsconfig `include`, so the `@/` alias does not resolve for the type-aware checker.
