---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Open every link like a browser link through one link-activation module

## Context and Problem Statement

Writer shows clickable references to notes, files, chats and URLs in many places: the editor (wiki links, Markdown links, embeds), the properties panel, the sidebar, the palettes, the agent pane, Bases, and Obsidian plugin output. On 2026-11-17 the middle button worked in some of them and did nothing in others (relationship properties, then the agent chat). An inventory found eight separate hand-written `auxclick` / `button === 1` handlers, each slightly different. The user's rule: links behave like in a browser, everywhere, and "we shouldn't have to repeat code".

## Decision Drivers

- One behaviour for every link, matching what users know from browsers.
- One implementation (DRY): a new surface must not need its own click code.
- The webview never navigates; URLs open in the system browser, notes through the editor store's one open path.
- Works for React components, plain DOM (rendered Markdown, plugin output) and CodeMirror.
- Enforced by a test, not by review alone.

## Considered Options

- A. One module `src/lib/link-activation.ts`: a pure gesture table, one action, three thin bindings; an inventory test rejects hand-written handlers.
- B. A written rule in the guidelines; each surface implements it.
- C. Rely on the browser's default link behaviour (real `<a href>` everywhere).

## Decision Outcome

Chosen option: **A**.

1. **Gesture table** (`linkIntent`, `keyIntent`), the only place with button and modifier checks for links:

   | Gesture                                                                                 | Note, file or chat                | URL            |
   | --------------------------------------------------------------------------------------- | --------------------------------- | -------------- |
   | Left click, `Enter`                                                                     | current tab (pinned tab: new tab) | system browser |
   | Middle click, `Cmd`+click (macOS) / `Ctrl`+click (Windows, Linux), `Cmd`/`Ctrl`+`Enter` | new background tab                | system browser |
   | `Cmd`/`Ctrl`+`Shift`+click                                                              | new active tab                    | system browser |

   On macOS only `Cmd` counts (`Ctrl`+click is the context menu). A middle-button `mousedown` on a link is default-prevented (no autoscroll or paste). Tabs are not links: middle click closes a tab.

2. **Action** `activateLink(target, intent)` / `openPath`: notes and files through `openFile` / `openFileInNewTab(path, { activate })` (the store's `activate` option, default `true`), URLs through the one external opener, unresolved wiki links create the note then open it per the intent.
3. **Bindings**: `linkHandlers(target)` for React, `bindLinkActivation(container, resolve)` as a delegated DOM listener, `linkActivationExtension` for CodeMirror. Options: `middleOnly` where a plain click already selects or opens (file tree, palette rows); Bases cells open in a new active tab on left click so the base view is never replaced.
4. **Obsidian host**: `workspace.openLinkText(..., newLeaf, { active })` and `leaf.openFile(file, { active })` honor Obsidian's own `active` flag and route to the same action.
5. **Enforcement**: an inventory test fails on `button === 1`, `onAuxClick` or `"auxclick"` outside the module and the tab components, and on a direct `openFileInNewTab(` / `navigateToFile(` call outside an allowlist.

### Consequences

- Good: every surface behaves the same; a new link is one binding call.
- Good: middle click opens a background tab like a browser (previously the editor brought the new tab to the front).
- Bad: a gesture change touches one module but changes behaviour everywhere at once; the gesture-table test is the guard.
- Neutral: surfaces with no links (backlinks, outline, breadcrumbs in their current form) were left alone; they must use the bindings when they gain links.

### Non-goals

- `Shift`+click opening a new window (one window per vault today).
- Dragging a link onto the tab bar.

## Implementation Plan

- **Affected paths**: `src/lib/link-activation.ts` (module), `src/stores/editor-store.ts` (`openFileInNewTab` `activate` option), every link surface listed in `SPECs/link-activation-spec.md` section 3 (editor wiki-link extension and link navigation, property links, file tree and sidebar menus, Quick Open and Search in notes, agent pane components, Bases cells and cards, Obsidian host `markdown-render.ts`, `external-links.ts`, `views.ts`, `workspace-bridge.ts`), the editor link context menu ("Open link in new tab").
- **Pattern to follow**: call `linkHandlers`, `bindLinkActivation` or `linkActivationExtension`; open paths with `openPath`.
- **Pattern to avoid**: any hand-written middle-button or modifier check for a link; any direct tab-opening call from a click handler.
- **Tests**: `tests/link-activation.test.ts` (gesture table on three platforms, all bindings), `tests/link-activation-inventory.test.ts` (the guard), a background-tab case in `stores.test.ts`, per-surface tests (agent middle click, properties, Bases, Obsidian markdown links).

### Verification

- [x] Gesture table tests pass for macOS, Windows and Linux.
- [x] The inventory test passes with no hand-written handlers left.
- [x] `openFileInNewTab(path, { activate: false })` leaves the active tab and focus unchanged.
- [ ] Manual: middle click and `Cmd`+click in the editor, agent replies and plugin output keep focus on the current tab; middle `mousedown` starts no autoscroll.

## Pros and Cons of the Options

### A. One module and an inventory test

- Good, because behaviour and code exist once and the test keeps it that way.
- Bad, because every surface had to migrate once.

### B. A guideline only

- Good, because no shared code is needed.
- Bad, because it is what produced eight inconsistent handlers.

### C. Browser defaults

- Good, because no code.
- Bad, because the webview would navigate away from the app, and CodeMirror and plugin DOM are not plain anchors.

## More Information

Spec: [`SPECs/link-activation-spec.md`](../../SPECs/link-activation-spec.md) (gesture table, surface inventory, implementation notes). Implemented in commits 920d068 and f534ab9. Also listed in `AGENTS.md` (Guidelines). Revisit if Writer gains multiple windows (`Shift`+click) or a surface needs a gesture the table does not have.
