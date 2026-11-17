# Pinned tabs

Right-click a tab and choose "Pin tab". Pinned tabs stay at the left of the tab strip, are compact, survive "Close others" and "Close all", and a middle click unpins them instead of closing them.

## Behavior

- Pinned tabs form the leading group of the strip. The store keeps the group contiguous (`pinnedTabCount` counts the prefix); `Tab.pinned` is the only flag.
- Pinning moves the tab to the end of the pinned group. Unpinning moves it to the start of the unpinned group. The active tab and its file do not change.
- The new-tab page (launcher) cannot be pinned: no pin item in its menu, no pin command.
- Every other kind can be pinned: notes, Bases, plugin file tabs, plugin view tabs, Settings.
- Reorder by dragging a tab sideways. The tab moves live; only tabs of its own group are candidates (`use-tab-drag.ts`), and the store's `moveTab` clamps again, so a pinned tab never lands among unpinned ones or the other way round. A drag does not select the tab it ends on.

## Look

- Compact: a pin glyph before the title, a narrower max width (132 px against 180 px), tighter padding, no hover fade and **no close x**. There are no per-kind tab icons in the strip, so the pin glyph is the icon.
- Same tokens as other tabs (`--tab-active-bg`, `--text-secondary`, `--text-icon-muted`); a hairline (`--line-subtle`) closes the pinned group when unpinned tabs follow.
- The tooltip and the accessible name carry the full title: "<title> (pinned)".

## Fixed pinned group

- The strip has two parts side by side: the pinned group (never scrolls, always visible) and the scrolling part holding only the unpinned tabs; a hairline sits between them. Only the unpinned tabs scroll horizontally (wheel, trackpad, drag), and they are clipped at the pinned group's edge with the strip's start fade, as if passing under it. If the pinned tabs alone exceed half the strip, the group takes at most half and scrolls on its own.
- Scrolling a tab into view (active tab changes: keyboard switch, new tab, reveal) works on the scrolling part only, so an unpinned tab never ends up hidden behind the pinned group. A pinned tab needs no scroll. The math is `scrollDeltaIntoView` in `src/hooks/use-scroll-active-tab-into-view.ts`, shared with the agent pane's chat tabs (`useScrollTabIntoView`, a `data-tab-scroll` container), which scroll a chat into view whenever it becomes active.
- Drag reorder is unchanged: candidates are the tabs of the dragged tab's own group, found under the shared `data-tab-strip` root that wraps both parts.

## Context menu

Right-click on any tab, every kind (before, only file kinds had a menu):

1. Pin tab / Unpin tab (hidden on the new-tab page), separator
2. Close, Close others, Close all
3. For file-backed tabs only: separator, Reveal in sidebar, Copy path

Disabled states: Close is disabled on a pinned tab (unpin first, same rule as middle click and Cmd+W); Close others is disabled when no other unpinned tab exists; Close all is disabled when every tab is pinned. There are no "Close to the right/left" items.

## Closing matrix

| Action                                                            | Unpinned tab | Pinned tab                                 |
| ----------------------------------------------------------------- | ------------ | ------------------------------------------ |
| Middle click                                                      | closes       | **unpins** (stays open)                    |
| x button                                                          | closes       | none                                       |
| Cmd+W, palette "Close Current Tab" (`closeActiveTab`)             | closes       | **unpins** first; the next Cmd+W closes it |
| Context menu Close                                                | closes       | disabled                                   |
| Close others (menu), Close all (menu, palette "Close All Tabs")   | closes       | **kept**                                   |
| Programmatic: `closeTab`, `closeFile`, file deleted or moved away | closes       | closes                                     |
| Programmatic: plugin disabled or view closed itself, failed open  | closes       | closes                                     |
| Error boundary recovery (`editorApi.closeActiveTab`)              | closes       | closes                                     |
| Workspace switch or close                                         | closes       | closes (state cleared)                     |

Pin protects against user bulk closes and accidents only. The rule lives in the store (`closeTabByUser`, `closeActiveTab`, `closeOtherTabs`, `closeAllTabs`); the UI, shortcut and palette call those, so there is one path. Cmd+W still hides the window when only an empty new tab is left; with only a pinned tab left it unpins it. "Close others" activates the kept tab first, so focus does not land on a neighbour. "Close all" with pinned tabs left does not add a new-tab page.

## Opening files

- Opening a file (sidebar, quick open, links, palette) that a pinned tab already shows focuses that pinned tab. No duplicate, no navigation in the current tab. A pinned tab matches only when its page kind is the one the path opens as (a `.base` pinned as YAML text does not capture a Bases open).
- Navigating from a pinned tab (a link click, quick open while it is active) opens the target in a new tab at the end of the strip, so the pinned tab keeps its page, like a browser's pinned tab. Back and forward inside a pinned tab still work and keep it pinned.
- A new tab opens at the end of the strip, after the pinned group; the explicit "Open in new tab" and Cmd+T behave as before.
- Cmd+1..9 and Ctrl+Tab / Ctrl+Shift+Tab walk the whole ordered list, pinned first. Back/forward history and strip scroll are unchanged.

## Reopen closed tab

A pinned tab closed programmatically with the reopen stack on (`closeTab` without `remember: false`) is remembered with its pinned flag and comes back pinned, inside the pinned group (index clamped to the end of the group). An unpinned entry is never reopened inside the pinned group. Users cannot close a pinned tab directly, so in practice this only matters for such programmatic closes.

## Persistence

The session file keeps `pinned: true` on each pinned tab (omitted when false) in tab order; the Rust `SessionTab` has `#[serde(default)] pinned`. Session files from before this feature load as all unpinned. On restore pinned tabs are moved to the front (stable), the saved active tab stays active, and a pinned launcher is ignored. Switching workspaces in a window saves and restores the session like any other tab state.

## Commands

Palette: "Pin Tab" / "Unpin Tab" for the active tab (hidden on the new-tab page and in the compact window). No new keyboard shortcut.

## Out of scope

Pinned tabs across windows, a pin keyboard shortcut, "Close to the right/left", per-kind tab icons, restoring a pinned flag for tabs closed by workspace switch.
