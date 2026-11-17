# Reopen closed tab

Cmd+Shift+T (Ctrl+Shift+T elsewhere) reopens the most recently closed tab, like a browser. Repeating it walks back through closed tabs, newest to oldest.

## Behavior

- Each window keeps its own stack in memory (`closedTabs` in the editor store), newest last, capped at 25 (`MAX_CLOSED_TABS`); the oldest entry is dropped first. It is not saved in the session file and does not survive a restart (Chrome and Firefox restore the history only within a run); switching or closing the workspace in a window clears it.
- Reopening puts the tab back at its old index (clamped to the current tab count), with a fresh tab id, its back/forward history and, for a Bases tab, its view. It becomes the active tab. A lone empty new-tab page is replaced.
- Cursor and scroll position of the note are restored when the note is not open in another tab meanwhile.
- With nothing to reopen the shortcut does nothing.
- Closing the same note twice creates two entries, one per closure.
- Closing several tabs (Close others, Close all) leaves one entry each; reopening restores them in reverse order of closing, each at its own index, so the original strip comes back.

## What is remembered

Remembered: user-initiated closes (tab x button, middle click, Cmd+W, the tab context menu, the palette's Close Current Tab and Close All Tabs), file tabs, Bases tabs, Settings.

Not remembered: empty new-tab pages, plugin-view tabs (the live leaf dies with the tab), tabs removed because their file was deleted, and tabs closed by a failed open.

Stale entries:

- Rename or move of a note or folder rewrites the paths in the stack, so the reopened tab opens the renamed note.
- Deleting a note or folder drops the entries that showed it (history entries pointing at it are removed too).
- A note that cannot be read any more (deleted outside Writer) is skipped and the next older entry is tried.

## Entry points

- Keyboard: handled once by the global `useKeyboardShortcuts` keydown handler (no native menu accelerator exists, so there is no second path). Works while the editor or an input has focus (the editor binds nothing to Mod-Shift-t). It matches `key` t/T and, on layouts whose `key` is not a Latin letter, the physical `KeyT`. Ignored in the compact single-file window.
- Command palette: "Reopen Closed Tab", shown only while the stack is not empty.

## Out of scope

Persisting the stack across restarts, a native menu item, a tab-strip context menu item, reopening closed windows.
