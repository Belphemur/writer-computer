# plugin-browser

Community-plugin marketplace UI. Props-driven; state lives in `../stores/plugin-store-catalog.ts`, backend calls in `../host/store-client.ts`.

## Props (`PluginBrowser`)

- `onRequestTrust: () => void` — required. Shown as a "Restricted mode" banner button when the vault is not trusted. The host opens its confirmation dialog, calls `plugins_set_trust`, then should call `pluginCatalogStore.getState().refreshState()`.
- `onPluginsChanged?: () => void` — fired after a successful install, update, uninstall, enable or disable, so the host can reload plugins.
- `className?: string`.

## Mounting

Mounted once while the `obsidian-host` feature is on (its `overlays` contribution, `FeatureOverlays` in `App.tsx`) as `PluginBrowserDialog` (`./plugin-browser-dialog.tsx`), a modal with Escape/Close/backdrop dismissal and a focus trap. Open state is `usePluginBrowserStore` (`../stores/plugin-browser-store.ts`); entry points are Settings > Community plugins > Browse and the palette command "Browse community plugins".

- `onRequestTrust` -> `plugins-store.requestTrust()` (the same confirmation as Settings), then `pluginCatalogStore.getState().refreshState()`.
- `onPluginsChanged` -> `plugins-store.reconcile()`: the marketplace writes the backend directly, so the running host is refreshed and brought in line (`planReconcile`: unload disabled/uninstalled/updated, load newly enabled/updated) without a restart.

It loads the catalog on mount. To scope a different store (tests, a fake client), wrap it in `PluginCatalogProvider store={createPluginCatalogStore(client)}`.

## Behavior

- Installing never enables; the detail pane shows an explicit Enable step (disabled while untrusted).
- Loading: the list shows a skeleton (`role="status"`, `aria-busy`) while `listStatus` is `idle`/`loading` and no rows are loaded; this is distinct from "No plugins match" and from the inline error + Retry. Re-opening keeps the loaded rows while the catalog refreshes. The detail pane shows its own skeleton while a plugin's detail is fetched.
- Selection: the list is a `listbox` of `option` rows (`aria-selected`, `aria-activedescendant`); the selected row uses `--surface-selected` plus an accent left border. Up/Down/Home/End move the selection (`list-nav.ts`), Enter selects, the selected row scrolls into view.
- README: `render-readme.ts` (`renderReadme(markdown, { repo })`, pure) parses with `marked` (GFM; raw HTML passes through) and sanitizes with DOMPurify; `readme-view.tsx` renders it once per README string (`useMemo`) in a `.plugin-readme` container styled by `readme-view.css` (every rule scoped to that class, app tokens only).
  - Sanitization policy: explicit tag allowlist (text, headings, lists, tables, `pre`/`code`, `blockquote`, `details`, `img`, `a`, no script/style/iframe/object/embed/form/input/svg/math/link/meta/base) and attribute allowlist (`href src alt title align width height colspan rowspan open start rel target`). No `style`, `class`, `id`, `data-*`, `aria-*` or `on*` attributes. URLs: only `http:`, `https:`, `mailto:`, `tel:` (`javascript:`, `data:`, `file:`, `blob:` removed); image `src` is http(s) only. Task-list checkboxes render as glyphs (no `<input>`). Links always get `target="_blank" rel="noopener noreferrer nofollow"`; headings get `readme-<slug>` ids for in-page anchors.
  - Relative image URLs resolve to `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>`, relative links to `https://github.com/<owner>/<repo>/blob/HEAD/<path>` (repo from the catalog entry, validated as `owner/name`; paths cannot climb out of the repo). Relative URLs are dropped if the repo is not valid.
  - Links: clicks are always intercepted (the webview never navigates). http(s)/mailto/tel go to the system browser via `openUrl`; `#anchor` scrolls inside the pane; everything else is ignored.
  - READMEs over 500,000 characters are truncated before parsing, with a "README truncated." note.
  - CSP: unchanged. `img-src` already allows `https:` app-wide, so remote README images (raw.githubusercontent.com, shields.io, ...) load from any https host; a README can therefore make the webview request an arbitrary https image URL (tracking pixel). Narrowing `img-src` is an app-wide decision.
- Errors render inline (no toast mechanism exists).
- The "Updates available" filter only knows plugins whose detail was fetched; installed plugins are fetched in the background after each list load.
