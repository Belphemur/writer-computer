# Link activation: every link behaves like a browser link

Status: **accepted rule (user, 2026-11-17)**; implemented 2026-11-17 for the surfaces below, with the exceptions listed under "Implementation notes". Applies to every clickable reference to a note, file, folder, chat or URL anywhere in Writer, core and features alike.

## 1. The rule

A link in Writer opens the way a link in a browser opens. The user should never have to learn which surface supports which button.

| Gesture                                  | Note / file / chat target                                  | External URL (`http`, `https`, `mailto`) |
| ---------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| Left click                               | Open in the current tab (pinned tab: new tab, as today)    | System browser                           |
| Middle click                             | Open in a **new background tab** (focus stays where it is) | System browser                           |
| `Cmd`+click (macOS) / `Ctrl`+click       | New background tab                                         | System browser                           |
| `Cmd`/`Ctrl`+`Shift`+click               | New tab, **activated**                                     | System browser                           |
| Middle click on a **tab** (editor, chat) | Close that tab (unchanged; a tab is not a link)            | n/a                                      |
| Right click                              | Context menu with "Open in new tab" (same action as above) | Context menu with "Open link" / "Copy"   |

Rules that hold for every row:

- A middle-button `mousedown` on a link calls `preventDefault()`, so the webview never starts autoscroll or a primary-selection paste.
- The webview never navigates. A URL always goes through the one external opener; a note path always goes through the one tab-opening path in the editor store.
- Keyboard: `Enter` on a focused link behaves like a left click, and `Cmd`/`Ctrl`+`Enter` like `Cmd`/`Ctrl`+click.
- An unresolved wiki link (no such note) keeps its current behavior (create on left click). A middle click creates the note and opens it in a new background tab.
- Anything that is not a link (buttons, rows that select, tabs) does not react to the middle button, except tabs, which close.

## 2. One implementation (DRY)

Repeating this per component is forbidden (`docs/consolidation.md`, `.agents/skills/engineering-philosophy`). There is exactly one place for each piece:

1. **Intent** (`src/lib/link-activation.ts`, pure, no React): `linkIntent(event) -> "current" | "new-tab-background" | "new-tab-active" | null` from `button`, `metaKey`, `ctrlKey`, `shiftKey` and the platform. All tables above are this function; it has the only `button === 1` and modifier checks for links in the codebase.
2. **Action** (same module): `activateLink(target, intent)` where `target` is `{ kind: "note" | "file" | "chat"; path | id } | { kind: "url"; href }`. Notes and files go through the editor store's one open path (`openFile` / `openFileInNewTab(path, { activate })`; the store gains the `activate` option, default `true`, so existing callers are unchanged); chats through the agent store's one open path; URLs through the one external opener. A feature that owns a target kind registers its opener; core never imports a feature's internals.
3. **Bindings**, one per rendering technology, all thin wrappers over 1 and 2:
   - React: `useLinkHandlers(target)` returns `{ onClick, onAuxClick, onMouseDown, onKeyDown }`.
   - Plain DOM (rendered markdown HTML, plugin `MarkdownRenderer`, widgets): `bindLinkActivation(container, resolve)`, a delegated listener on `click`, `auxclick` and `mousedown` where `resolve(el)` maps a clicked element to a target or `null`; returns a disposer.
   - CodeMirror: one `EditorView.domEventHandlers` extension built on the same `linkIntent` and `activateLink` (the wiki-link extension, Prosemark link widgets, embeds).

A new clickable reference must use one of the three bindings. Hand-written `onAuxClick`, `button === 1` or `metaKey` checks for a link are a review failure; a test enforces it (section 4).

## 3. Surfaces (inventory 2026-11-17, all must use the bindings)

Today each of these handles the middle button on its own, or not at all:

- Editor: wiki links (`wiki-link-extension.ts`), Markdown links, embeds, editor context menu "Open in new tab".
- Properties: relationship links (`property-links.ts`, `property-wikilink.tsx`).
- Sidebar: file tree (`file-tree-node.tsx`), navigator, recent files, search results, backlinks and outline if they link to notes.
- Palettes: Quick Open and "Search in notes" result rows (middle click and `Cmd`+`Enter` open in a new tab).
- Agent pane: links and wiki links in rendered replies, mention pills (`pill-view.tsx`), `agent-links.ts`, attachments, tool rows naming a file, the Changes card, the context ledger, the chat list.
- Bases: link cells (`features/bases/web/view/cell-view.tsx`), card and list views.
- Obsidian host: `MarkdownRenderer` output and internal links (`features/obsidian-host/web/host/api/markdown-render.ts`), external links (`host/node/external-links.ts`), `workspace.openLinkText` with `newLeaf`.
- Tabs keep middle-click close (`editor-tabs.tsx`, `chat-tabs.tsx`); they are not links and stay out of `linkIntent`.

## 4. Tests

- `link-activation.test.ts`: the full gesture table above, for both platforms, as data-driven cases.
- One test per binding (React, DOM delegate, CodeMirror) dispatching `click`, `auxclick` (button 1), `mousedown` (button 1, default prevented), `Cmd`/`Ctrl`(+`Shift`)+click and `Enter`, asserting the action called and its `activate` flag.
- An inventory guard (like `tests/import-boundaries.test.ts`): no file outside `src/lib/link-activation.ts` and the tab components contains `button === 1`, `onAuxClick` or `"auxclick"`.
- Background open: `openFileInNewTab(path, { activate: false })` adds the tab without changing the active tab or focus.

## 5. Non-goals

- Opening in a new window (`Shift`+click in browsers): Writer has one window per vault; `Shift`+click behaves like a left click until multi-window exists.
- Drag-a-link-to-the-tab-bar.

## 6. Implementation notes (2026-11-17)

- `linkHandlers(target, { middleOnly })` is a plain function, not a `use*` hook (it uses no hook, and callers need it in conditionals and loops). There is no `onKeyDown`: `Enter` on a focused `<button>` or `<a>` is a native click that carries its modifiers, so it already behaves per the table. Rows that are not buttons use `keyIntent(event)` (Quick Open, Search in notes, Bases cells).
- `middleOnly` rows: the file tree (Cmd/Shift+click select rows there) and the palette rows (cmdk selects on click) open only on the middle button.
- Bases cells always open in a new tab (they must not replace the Bases view), so a left click there is a new active tab; middle and `Cmd`/`Ctrl` click are background tabs.
- Obsidian plugin-rendered internal links always open a new main tab (the plugin's own view must stay), and the gesture now chooses its activation: `openLinkText(link, source, true, { active: false })` (Obsidian's own `OpenViewState.active`; `leaf.openFile(file, { active })` the same) reaches the editor store as `openFileInNewTab(path, { activate: false })`. External links in plugin UI and plugin-browser READMEs use the shared bindings.
- Context menus: the editor's link menu has "Open link in new tab" and the sidebar file menus open through `openPath`.
- The compact recents list is bound too; a compact window has no tabs, so every gesture opens the file in place. Prosemark embeds (`![[image]]`, note embeds) have no click behaviour today, so there is nothing to bind.
- Swept (2026-11-17): every click that opens a note, file or URL goes through a binding or `openPath`. Backlinks, outline, search panel and breadcrumbs are not note-link surfaces in this tree; the new-tab page and welcome screen open the palette or a file dialog, not a link. A chat as a link target (`kind: "chat"`) is still not needed.
- Guard: `tests/link-activation-inventory.test.ts` (no `button === 1` / `auxclick` outside the module and the tabs; no direct `openFileInNewTab(` / `navigateToFile(` call outside the store, its wrapper, the module and the two intent adapters); behaviour: `tests/link-activation.test.ts`.
