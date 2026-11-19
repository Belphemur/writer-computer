# Keyboard shortcuts

<!-- The canonical shortcut map. It is also published as is at writer.computer/docs/keyboard-shortcuts/, so keep the prose readable for users and put implementation notes in HTML comments like this one, which the site leaves out. The first line must stay "# Keyboard shortcuts" (see apps/website/src/docs/pages.ts). -->

Every keyboard shortcut in Writer Computer. On macOS, Cmd is ⌘, Alt is ⌥ (Option) and Ctrl is ⌃.

These are the defaults. You can change any shortcut, and give one to any command, in Settings > Hotkeys; your keys are stored per operating system.

<!-- Settings > Hotkeys (SPECs/hotkeys-spec.md): the registry's effective keys are the defaults below with the user's `hotkeys.json` on top. The tables and `tests/keybindings.test.ts` keep reading the defaults. -->

## Global

These work anywhere in the window, whether or not you are typing in a note.

<!-- One entry per row in `apps/desktop/src/lib/keybindings/core-bindings.ts` (the keybinding registry; `useKeyboardShortcuts` only iterates it). `tests/keybindings.test.ts` fails when this table and the registry disagree, in either direction: add a shortcut there and here together. A binding whose id equals a palette command id makes the palette show the key. Cmd+Shift+F opens the palette in its `search-notes` mode (SPECs/search-spec.md): Enter opens the match in the current tab, Cmd+Enter in a new tab. It is free of conflicts: the editor's find is Cmd+F and nothing else binds Shift+F. -->

| Shortcut        | Action                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Cmd+P           | Command palette: search notes by name, and run commands                                                  |
| Cmd+O           | Same as Cmd+P                                                                                            |
| Cmd+Shift+P     | Command palette, also when no workspace is open                                                          |
| Cmd+Shift+F     | Search in notes: full-text search of note contents                                                       |
| Cmd+N           | Create new note                                                                                          |
| Cmd+T           | New tab                                                                                                  |
| Cmd+Shift+T     | Reopen the last closed tab (repeat for older ones, up to 25)                                             |
| Cmd+Shift+A     | Show or hide the Agent pane (focuses its message box when it opens)                                      |
| Cmd+W           | Close current tab (a pinned tab is unpinned first); hides the window when only an empty new tab is left  |
| Cmd+\\          | Toggle sidebar                                                                                           |
| Ctrl+Tab        | Next tab                                                                                                 |
| Ctrl+Shift+Tab  | Previous tab                                                                                             |
| Cmd+1 ... Cmd+9 | Jump to Nth tab                                                                                          |
| Cmd+= / Cmd++   | Zoom editor text in (numpad + works too)                                                                 |
| Cmd+-           | Zoom editor text out (Cmd+Shift+- and numpad − work too)                                                 |
| Cmd+0           | Actual size (zoom back to 100%); in an image tab, fit the image to the page; in a PDF tab, fit the width |
| Cmd+F           | In a PDF tab, find in the PDF (in a note, the editor's own find, below)                                  |
| Alt+ArrowLeft   | Navigate back (outside the note; inside it, moves by word)                                               |
| Alt+ArrowRight  | Navigate forward (outside the note; inside it, moves by word)                                            |
| Cmd+[           | Navigate back, everywhere including the note (Tab / Shift+Tab indent)                                    |
| Cmd+]           | Navigate forward, everywhere including the note                                                          |

Pinned tabs (right-click a tab, "Pin tab", or "Pin Tab" in the palette) stay at the left of the tab strip. A middle click on a tab closes it, but on a pinned tab it unpins it instead; Cmd+W (and "Close Current Tab" in the palette) does the same, so a pinned tab never closes by accident. "Close others" and "Close all" leave pinned tabs open. Cmd+1 ... Cmd+9 and Ctrl+Tab count pinned tabs first. See [SPECs/pinned-tabs-spec.md](../SPECs/pinned-tabs-spec.md).

<!-- Middle click and the Cmd+W rule are one store action (`closeTabByUser` / `closeActiveTab` in `editor-store.ts`); the tab strip's `onAuxClick` and `useKeyboardShortcuts` both go through it. -->

Zoom scales the note text only, in preset stops (50–300%); the sidebar, tab
strip, and status bar keep their size. The current zoom is also in
Preferences → Editor → Zoom, is kept between launches, and applies on top of
the editor font size, which it never changes. In an image tab the same chords zoom the image instead (Cmd+0 fits it to the page; double-click toggles Fit and 100%), and in a PDF tab they zoom the PDF (Cmd+0 fits the width; pinch or Cmd + scroll zooms toward the pointer). Cmd+F in a PDF tab opens its find bar: Enter and Shift+Enter step through the matches, Escape closes it.

<!-- The zoom is the global `editor.zoom` setting, multiplied on top of `editor.font-size`. -->

In the compact window a single note opens in, which has no sidebar or tabs,
Cmd+Shift+F, Cmd+Shift+A, Cmd+\\, Cmd+T, Cmd+Shift+T, Ctrl+Tab, Ctrl+Shift+Tab, and Cmd+1 ... Cmd+9 do nothing. Cmd+P, Cmd+O, Cmd+N, zoom, and history navigation still
work.

## Command palette

<!-- Palette-local keys, not registry bindings (so `tests/keybindings.test.ts` does not read this section): handled in the palette's `onKeyDown` through `cycleKindOnTab` in `components/command-palette/kind-choices.ts`, for both quick open and Search in notes (SPECs/search-spec.md "Kind chips"). Cmd+Enter / Ctrl+Enter opens the chosen result in a new tab. -->

| Shortcut  | Action                                                                |
| --------- | --------------------------------------------------------------------- |
| Tab       | Next kind chip (All, each kind, and Commands in quick open), wrapping |
| Shift+Tab | Previous kind chip                                                    |
| Cmd+Enter | Open the selected result in a new tab                                 |

## Agent

The Agent pane is the chat on the right. It shares the right side with the plugin pane: opening one closes the other. These work while focus is inside the pane.

<!-- Implemented in `features/agent/web/components/agent-pane.tsx` (pane-scoped chords, which stop propagation so the global hook's Cmd+W never sees them), `composer.tsx` (Enter, Esc order, ArrowUp recall, Cmd+Enter / Cmd+Shift+Enter / Cmd+Backspace for a pending permission) and `permission-card.tsx` (Enter / Esc with focus on the card). Cmd+Shift+A is the keybinding of the agent feature (`features/agent/web/index.ts`); it collides with no native menu accelerator (only Cmd+, exists) and no editor binding. Spec: SPECs/native-agent-spec.md section 3.6. Cmd+Shift+H opens the in-pane chat list until the history view lands (lane 4). Cmd+B / Cmd+I and the list-continuing Shift+Enter live in `composer-markdown.ts` (a CodeMirror keymap, so they only fire with the message box focused; they reuse `toggleBold` / `toggleItalic` of the note editor and collide with no global binding or menu accelerator). Tab is left alone. -->

| Shortcut                    | Action                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Cmd+Shift+A                 | Show or hide the Agent pane (works from anywhere in the window)                                  |
| Enter / Shift+Enter         | Send the message / new line (while the agent works, Enter queues the message)                    |
| Esc                         | In order: close an open menu, remove the queued message, stop the running turn, back to the note |
| Enter (focus on the card)   | Allow once, when a "Permission required" card has focus                                          |
| Esc (focus on the card)     | Deny, when a "Permission required" card has focus                                                |
| Cmd+Enter                   | Allow once, from the message box while a permission card shows; otherwise send now (see below)   |
| Cmd+Shift+Enter             | Always allow in this project, from the message box while a permission card offers it             |
| Cmd+Backspace               | Deny, from the message box while a permission card shows                                         |
| Cmd+Shift+N                 | New chat (only while the pane has focus; Cmd+N stays "create new note")                          |
| Cmd+Shift+H                 | Chat history                                                                                     |
| Cmd+[ / Cmd+]               | Previous / next chat                                                                             |
| Cmd+W                       | Close the chat (only while the pane has focus; asks first if it is working)                      |
| `@`                         | Add a note or folder as context (Arrow keys, Enter or Tab to pick)                               |
| `/`                         | Pick a Claude Code command                                                                       |
| ArrowUp in an empty message | Bring back your previous message                                                                 |
| Cmd+B / Cmd+I               | Wrap the selection in `**` / `*` (again to unwrap), from the message box only                    |
| Shift+Enter in a list       | New line that continues the bullet, number, task or quote; on an empty item it ends the list     |
| ArrowLeft / ArrowRight      | Between chat tabs                                                                                |

Cmd+Enter while the agent works forces your message in now: the step the agent is on (a running tool, or the text it is writing) is stopped and your message starts its next turn (it appears in the chat marked "Steer"). With an empty message box it sends the queued message that way, and the queued message has a "Send now" button. Enter still queues. While a permission card shows, Cmd+Enter allows once instead. When the agent is idle, Cmd+Enter is a normal send.

The command palette also has "Agent: Toggle pane", "Agent: New chat" and "Agent: History".

## App menu

<!-- Bound to the native app menu (Tauri menu accelerators) rather than the global JS handler. -->

| Shortcut | Action                                                |
| -------- | ----------------------------------------------------- |
| Cmd+,    | Open Preferences (Settings tab) in the focused window |

## Formatting

These apply while you are typing in a note.

<!-- Handled by the `markdownFormatting` CodeMirror extension. -->

| Shortcut                | Action                    |
| ----------------------- | ------------------------- |
| Cmd+B                   | Bold                      |
| Cmd+I                   | Italic                    |
| Cmd+K                   | Insert link               |
| Cmd+E                   | Inline code               |
| Cmd+Shift+X             | Strikethrough             |
| Cmd+Shift+8             | Bullet list               |
| Cmd+Shift+7             | Numbered list             |
| Cmd+Shift+.             | Blockquote                |
| Cmd+Shift+Enter         | Task list                 |
| Cmd+Alt+1 ... Cmd+Alt+6 | Heading 1-6               |
| Cmd+Alt+0               | Paragraph (strip heading) |

## Tables

A rendered table is edited in place: click a cell and type. Tab, Shift+Tab, Enter, Shift+Enter, Alt+Enter and Escape work in the cell as listed below, the arrow keys move to the next cell at the edge of a cell's text, and Cmd+Z undoes typing in the cell first. Arrow keys from the lines around a table land in its first or last cell. The other keys below (move row or column, format) apply in the table's source view: use the `</>` button on the table or "Table: Edit source / Done" in the command palette.

<!-- Implemented in `apps/desktop/features/tables/web/table-editing.ts` (high-precedence keymap, active only when the selection is inside a table shown as source, never inside a code block; the rendered table's cell keys are in `table-cells.ts`). They all yield when the Obsidian "Advanced Tables" plugin (`table-editor-obsidian`) is enabled through the plugin host, so a key is not handled twice; the palette commands and the toolbar stay. Alt+ArrowUp/Down replace "Move line" and Cmd+Enter replaces "Insert line below" inside a table only. Spec: SPECs/table-editing-spec.md. -->

| Shortcut                  | Action                                                                 |
| ------------------------- | ---------------------------------------------------------------------- |
| Tab                       | Next cell (in the last cell: add a row)                                |
| Shift+Tab                 | Previous cell                                                          |
| Enter                     | Same column, next row (new row at the end; on an empty last row: exit) |
| Shift+Enter               | Line break inside the cell (`<br>`)                                    |
| Alt+Enter                 | Line break inside the cell (`<br>`)                                    |
| Escape                    | Format the table and leave it below                                    |
| Cmd+Enter                 | Same as Escape                                                         |
| Alt+ArrowUp / Down        | Move the row up / down                                                 |
| Cmd+Alt+ArrowLeft / Right | Move the column left / right                                           |
| Cmd+Alt+Enter             | Add a row below                                                        |
| Cmd+Alt+F                 | Format table (align the pipes)                                         |

Every other table action (add or delete rows and columns, sort, align, transpose, duplicate row, clear cell, delete table, insert table, convert a selection or the clipboard to a table) is in the command palette as "Table: ...", in the right-click menu inside a table, on the row and column menus of the rendered table, and (in source view) on the toolbar that floats above the table. "Table: Expand table" opens a table fullscreen.

## Editing

These also apply while you are typing in a note.

<!-- Inherited from CodeMirror's basic setup. -->

| Shortcut             | Action                               |
| -------------------- | ------------------------------------ |
| Cmd+Z                | Undo                                 |
| Cmd+Shift+Z          | Redo                                 |
| Cmd+A                | Select all                           |
| Cmd+D                | Select next occurrence               |
| Cmd+Shift+L          | Select all occurrences               |
| Alt+ArrowUp          | Move line up                         |
| Alt+ArrowDown        | Move line down                       |
| Alt+Shift+ArrowUp    | Copy line up                         |
| Alt+Shift+ArrowDown  | Copy line down                       |
| Cmd+Shift+K          | Delete line                          |
| Cmd+Enter            | Insert line below                    |
| Tab                  | Indent / accept completion           |
| Shift+Tab            | Dedent                               |
| Cmd+F                | Find, with Replace in the find panel |
| Cmd+G                | Find next                            |
| Cmd+Shift+G          | Find previous                        |
| Escape               | Close find                           |
| Alt+Shift+ArrowLeft  | Extend selection by word left        |
| Alt+Shift+ArrowRight | Extend selection by word right       |
