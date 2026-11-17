# Settings sidebar

Status: implemented; not run in a real window (jsdom and Rust tests only).

## Goal

The Settings tab was one endless scroll. It is now an Obsidian-style layout: a sidebar of sections on the left, only the selected section's options on the right. Community plugin options (the `PluginSettingTab` each plugin registers) are entries in the same sidebar.

## Sections (one registry)

`src/components/settings-panel/settings-sections.ts` is the single source of truth: `SETTINGS_SECTIONS` (id, label, group, `blocks`, `requiresWorkspace`). A block is a schema category, the theme cards, the community-plugins manager or the secrets manager; `settings-blocks.tsx` has exactly one renderer per block type (a `Record` keyed by the union, so a new type cannot be forgotten). Plugin entries are appended at runtime by `buildSettingsNav`. A test fails when a schema category is not claimed by a section.

| Group             | Section            | Content                                                               |
| ----------------- | ------------------ | --------------------------------------------------------------------- |
| General           | Editor             | schema categories Editor, Status Bar                                  |
| General           | Appearance         | Appearance, Typography, light and dark theme cards                    |
| General           | Files & vault      | Files, Workspace (incl. default terminal), Window, Search             |
| General           | Privacy            | Privacy (telemetry)                                                   |
| General           | Secrets            | stored secret names; set/replace, add, delete                         |
| Community plugins | Manage plugins     | trust switch, Browse, updates, installed plugins, auto-check setting  |
| Community plugins | one per plugin tab | the plugin's `PluginSettingTab`, labelled with the tab or plugin name |

Manage plugins and plugin entries need an open workspace. The sidebar footer has "Browse plugins..." (opens the marketplace dialog) when a workspace is open. No About or Terminal/CLI section: the panel has no such options. Settings search is out of scope.

## Plugin sections

Each `services.settingTabs` entry is one sidebar item `plugin:<owner>:<tabId>`. Selecting it mounts the tab through `mountSettingTab` (attach `containerEl`, `display()`); `hide()` and detach run on section change, Settings tab unmount and plugin disable. A throwing `display()` shows an inline error. If the remembered plugin section is unavailable (plugin disabled or still loading) the first section shows and the remembered id is kept. `app.setting.open()` / `openTabById(id)` open the Settings tab at that plugin's section (`openSettings(sectionId)`); an unknown id records an error and opens Settings. The old `plugin-settings` page kind and `PluginSettingsPage` were removed (old session entries of that kind are dropped on restore).

## Navigation and accessibility

The sidebar is a vertical `tablist` of `tab` buttons (roving tabindex, `aria-selected`, `aria-controls`); the pane is a `tabpanel` labelled by the selected tab, with an `h1` of the section name. ArrowUp/ArrowDown (and Left/Right) move and select with wrap-around; Home/End jump. Below the `md` breakpoint the sidebar becomes a horizontally scrolling strip above the content. Existing tokens only, no new dependencies. No shortcuts changed.

## Persistence

The selected section id lives in `ui-store` (`settingsSection`) and is stored in `preferences.json` under `settings.section` (a UI preference, not a settings-schema key). `hydrateSettingsSection` restores it when Settings mounts and never overrides a choice made in the meantime.

## Secrets section

Secrets are the `app.secretStorage` entries in the OS keychain (`plugin_secrets.rs`), shared by all plugins and vaults. The section lists names only: values never cross IPC to the UI (`secrets_list_ids` returns ids; there is no read command) and nothing is revealed, masked or copyable. Actions: set or replace (write-only password input, cleared after use), add (name + value; names are lowercase letters, digits and dashes: `SECRET_ID_RE` in the frontend, enforced again by the Rust command `secrets_set`), delete with a confirmation (`secrets_delete`). Empty and keychain-error states are explicit: the error state reads "Writer couldn't read the Keychain — plugins that need API keys will run without them" with Retry, which re-reads and also refills the running host's cache. The commands need no trusted vault. After a write, `plugins-store.syncSecret` mirrors it into the running host's cache (`SecretStorage.applyExternal`) so plugins see it without a restart. `SecretComponent` (Obsidian's secret picker, newly added to the host) lists `listSecrets()` from the same store, offers "Create new secret..." and hands the plugin only the chosen name, so a secret created in either place is selectable in the other (Settings refreshes its list when the section opens).

## Plugin updates

`stores/plugin-updates-store.ts` owns update state. Check = `plugin_store_detail` per installed plugin (the backend compares versions against the release manifest; on install it enforces `minAppVersion`, the GitHub-only host allowlist and sha256). Update = `plugin_store_install`, then `plugins-store.reconcile()`, which unloads the old version and reloads it only if it was enabled; an update never enables anything. The button reads "Check for updates", and "Update all (N)" when updates exist; rows show "Update available: vX -> vY" with an Update button and per-plugin progress or failure. Updates run one after another and a failure does not stop the rest. Checks and update runs never overlap (`status` is the lock). A check fails only if no plugin could be checked (a hand-installed plugin missing from the catalog does not count). Automatic checks run 30 s after a workspace opens and then every 3 hours while it is open, throttled by a timestamp persisted per vault (`plugins.update-checks` preference, stored with the last result so the badge survives a restart); they are silent on failure (console warning), manual checks show the error. "Manage plugins" carries a count badge. The setting `plugins.auto-check-updates` (default on, category "Community plugins") turns automatic checks off.

## Tests

`tests/settings-sections.test.ts` (registry, nav building, persistence), `tests/settings-panel.test.tsx` (nav, keyboard, plugin mount/unmount), `tests/secrets-section.test.tsx` (including `SecretComponent`), `tests/plugin-updates-store.test.ts`, `tests/plugin-settings-wiring.test.ts`; Rust tests in `plugin_secrets.rs` and `commands/plugins.rs`.
