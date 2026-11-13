# plugin-browser

Community-plugin marketplace UI. Props-driven; state lives in `@/stores/plugin-store-catalog`, backend calls in `@/lib/obsidian-host/store-client.ts`.

## Props (`PluginBrowser`)

- `onRequestTrust: () => void` — required. Shown as a "Restricted mode" banner button when the vault is not trusted. The host opens its confirmation dialog, calls `plugins_set_trust`, then should call `pluginCatalogStore.getState().refreshState()`.
- `onPluginsChanged?: () => void` — fired after a successful install, update, uninstall, enable or disable, so the host can reload plugins.
- `className?: string`.

## Mounting

Mounted once in `App.tsx` as `PluginBrowserDialog` (`./plugin-browser-dialog.tsx`), a modal with Escape/Close/backdrop dismissal and a focus trap. Open state is `isPluginBrowserOpen` in `@/stores/ui-store`; entry points are Settings > Community plugins > Browse and the palette command "Browse community plugins".

- `onRequestTrust` -> `plugins-store.requestTrust()` (the same confirmation as Settings), then `pluginCatalogStore.getState().refreshState()`.
- `onPluginsChanged` -> `plugins-store.reconcile()`: the marketplace writes the backend directly, so the running host is refreshed and brought in line (`planReconcile`: unload disabled/uninstalled/updated, load newly enabled/updated) without a restart.

It loads the catalog on mount. To scope a different store (tests, a fake client), wrap it in `PluginCatalogProvider store={createPluginCatalogStore(client)}`.

## Behavior

- Installing never enables; the detail pane shows an explicit Enable step (disabled while untrusted).
- Errors render inline (no toast mechanism exists). README is shown as escaped preformatted text (no markdown dependency).
- The "Updates available" filter only knows plugins whose detail was fetched; installed plugins are fetched in the background after each list load.
