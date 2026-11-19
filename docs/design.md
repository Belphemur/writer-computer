# Design rules

The layout and UI rules that keep the same bugs from coming back (a page drawn over the tab strip, a popup clipped, a white box on a dark canvas). Short and normative: each rule names the test that enforces it. A change that breaks a rule changes the rule and its test in the same commit, with a reason.

## 1. The window frame

- The window is one `h-screen w-screen` box (`src/components/app-layout.tsx`). Left to right: the sidebar column, the editor area, the open dock (the agent pane, the plugin pane), a full-height column.
- The tab strip, the sidebar toggle and the drag region float over the top `--chrome-bar-height` of the window (absolute, `z-30`..`z-50`). Nothing reserves that height by padding: use the token (`--chrome-bar-height`, `--chrome-drag-height`, `--chrome-control-*` in `src/App.css`).
- A dock ends the tab strip at its left edge; it never overlaps the editor area.
- Frame containers (the window root, the sidebar column and its wrappers, the editor area, `PageBody`, `html`, `body`, `#root`) use `overflow: clip` (`overflow-clip`), never `hidden`. A `hidden` box is still scrollable by script (`scrollIntoView`, `scrollTop`, focus), which drags the page under the chrome; a `clip` box cannot move. Enforced by: `tests/page-body-contract.test.tsx` ("frame containers are overflow: clip").

## 2. The page-kind contract

- Every page kind (note, graph, base, code file, plugin view, session changes, settings, ...) mounts in `PageBody` (`src/components/editor-area/page-body.tsx`): positioned, clipped, starting below the chrome bar. Enforced by: `tests/page-body-contract.test.tsx`.
- A page owns exactly one scroller (its root, `h-full overflow-y-auto`, or its editor's scroller). Frame boxes and ancestors never scroll.
- A page positions itself against `PageBody`, never the window: no `position: fixed`, no portal, no top padding for the chrome. Menus and popovers that must leave the body portal on purpose and are listed in that test's `OVERLAYS`, with the reason.
- A kept-alive page (`keepAlive`: its tab stays mounted while another is active) hides itself when `isActive` is false: `absolute inset-0 invisible pointer-events-none`, never left in the flow. The page body mounts every kept-alive tab, so a body that ignores `isActive` stays drawn over the active tab. Enforced by: `tests/page-body-contract.test.tsx` ("kept-alive page bodies hide when inactive") and per view, for example `features/images/tests/image-viewer.test.tsx` and `features/pdf/tests/pdf-viewer.test.tsx`.
- Adding a page kind: register it (`src/components/editor-area/page-kinds`), render inside `PageBody` and add nothing else to the frame. Built-in features follow `.agents/skills/writer-feature/SKILL.md`.

## 3. Scroll ownership

- Bringing an element into view inside a pane or page goes through `scrollIntoScroller` (`src/lib/scroll-into.ts`): it sets one scroller's `scrollTop` and touches nothing else. Never the DOM `scrollIntoView`, which scrolls every scrollable ancestor, `overflow: hidden` frames included. Enforced by: `tests/scroll-inventory.test.ts` (a raw DOM `.scrollIntoView(` fails; the allowlist is empty, any entry needs a reason), `tests/scroll-into.test.ts` (the helper), and per call site, for example `features/agent/tests/agent-session-changes.test.tsx` (the diff focus moves its own scroller and nothing above it).
- A page that is its own scroller passes it (`scroller: root.current`); a list inside a popup or a pane lets the helper find the nearest `auto`/`scroll` ancestor.
- CodeMirror: the `scrollIntoView: true` transaction flag and `EditorView.scrollIntoView(...)` only move the editor's scroller and are fine. Scroll handlers, margins and who owns the scroll container: [`docs/editor.md`](./editor.md).

## 4. Overlays, popovers and modals

What exists; do not add a layer.

- **Modal**: `ModalShell` (`src/components/modal-shell.tsx`): fixed backdrop and card, `z-50`, Escape, Tab trap, focus restore. No hand-written `aria-modal` or Tab trap. Enforced by: `tests/modal-inventory.test.ts`.
- **Popover under an anchor** (menus, pickers): `AnchoredPopover` (`src/components/editor-area/anchored-popover.tsx`): portalled to `document.body`, fixed, `z-50`.
- **Plugin popups** (Obsidian Menu, EditorSuggest, input suggest): the one body-level `popup-layer` (`src/lib/popup-layer.ts`, `POPUP_LAYER_Z = 10000`, click-through, no transform or filter so `fixed` children anchor to the viewport). `trackPopup` keeps the popup inside the window. Enforced by: `features/obsidian-host/tests/obsidian-host-popups.test.ts`.
- **Notice (toast)**: `showEditorNotice(message)` (`src/components/editor-area/editor-notice-store.ts`) is the one transient message; `EditorNoticeBanner` portals it to the body, fixed at the bottom centre, opaque (`--bg-base`), `NOTICE_Z` (`src/lib/popup-layer.ts`) above every other layer. No second toast. Enforced by: `tests/page-body-contract.test.tsx` (`OVERLAYS`).
- Tab strip `z-40`, toggle `z-50`, drag region `z-30`: the chrome sits above pages and below modals. A page never uses a z-index above its own content; if it needs to, it is an overlay and belongs in a list above.

## 5. Theme tokens and canvases

- Colours come from the theme variables (`--surface-*`, `--text-*`, `--border-color`, ...), never literals. Surfaces and text are `color-mix(... transparent)` so macOS vibrancy shows through: they are translucent.
- A canvas (graph, any `<canvas>`) cannot parse `color-mix()` and a translucent plate is see-through, so it resolves theme colours to opaque `rgb()` composited over the theme's base, with fallbacks (`features/graph/web/theme.ts`). Never hand a raw token to a canvas. Not test-enforced (jsdom has no canvas): review it.
- Every surface that draws content over another (a card on a page, a label plate) states its background: do not rely on a translucent parent.

## 6. Text selection

- The app is not selectable by default (`src/App.css`): chrome, rows and buttons do not catch a drag. Text a user reads and may copy (the agent pane, the Session changes tab, the PDF reader's scroller, any future reading surface) opts in with `data-selectable` on its root; buttons, tabs and icons inside stay non-selectable. Editors, inputs and plugin content are already selectable. Never a per-component `select-text` patch for a whole surface. Enforced by: `apps/desktop/tests/text-selection-contract.test.ts` (jsdom applies no CSS, so a selection test alone cannot catch it).

## 7. UI text

- Terse labels, sentence case, no explanatory prose; at most a one-line hint. Settings and panels: short label, a straightforward control, no paragraph. If a screen needs a paragraph, the screen is wrong ([`docs/soul.md`](./soul.md)).
- Shortcuts live in the keybinding registry and `docs/keyboard-shortcuts.md` (a test ties them).

## 8. Links

- Every clickable note, file, chat or URL reference behaves like a browser link (middle click and Cmd/Ctrl+click open a new background tab) through `src/lib/link-activation.ts`, never a hand-written `auxclick` or `button === 1`. Enforced by: `tests/link-activation-inventory.test.ts`. Spec: [`SPECs/link-activation-spec.md`](../SPECs/link-activation-spec.md).

## Checklist for a UI change

1. Does it mount in `PageBody` and own one scroller?
2. Does anything scroll by script? Use `scrollIntoScroller`.
3. Does a new container clip? `overflow-clip` if it is part of the frame.
4. A popup or modal? Use the existing one.
5. A colour on a canvas? Opaque.
6. Text people read and copy? `data-selectable` on its root.
7. Is the label as short as it can be?
