# Dropping files from the OS (Finder)

Files and folders dragged from Finder onto Writer land in one of three places. One pipeline serves all three: one subscription, one coordinate rule, one Rust seam.

## The dispatcher (`src/lib/os-drop.ts`)

- While the window's drag-drop is on, the webview gets no HTML5 events for Finder files, so the only source is Tauri's `onDragDropEvent`. `useOsDrop()` (mounted once, in the editor area) subscribes and dispatches to the registered targets: the open note (`editorOsDropTarget`), the sidebar tree (`useTreeOsDrop`) and the agent composer (`chat-image-target.ts`, a feature, through the registry). A target says whether a CSS point is over it, shows a highlight while a drag with files hovers it (`hover(point | null)`) and takes the drop (`drop(point, paths)`).
- **The position.** Tauri types it as physical pixels, but only Windows reports them. macOS (wry's `draggingLocation`, view points) and Linux (GTK widget coordinates) already report CSS pixels. The old code divided by `devicePixelRatio` everywhere, which on a Retina screen halves the point: the composer, at the bottom right, was never under the (halved) pointer, so the drop and the highlight did nothing. `dropPoint` divides on Windows only; tested with a 2x macOS drop at the composer's point.

## The Rust seam (`src-tauri/src/dropped.rs`, Tauri-free)

- `classify`: a dropped path is inside the vault (after links resolve; `.obsidian` refused) or outside.
- `copy_file`: a file from outside is copied into a vault folder, any type, by the attachments write path (`attachments::save_chat_file`: confined, never overwrites, ` 1`, ` 2` suffix, a partial file removed on failure). Refused: a secret-looking name (`code_files::is_secret_name`, the one rule) and a file over `maxFileBytes` (25 MB, `shared/attachments.json`; an image keeps its own 50 MB cap).
- `copy_tree` (the sidebar only): a folder from outside is copied recursively into a staging folder and renamed, so it appears whole. Links are not followed, secret names are skipped and counted, and a folder over `maxTreeBytes` (500 MB) or `maxTreeFiles` (5000) is refused before anything is written.
- Messages are terse and prefix-free; the target adds its own ("Not attached:", "Not added:"). Nothing is logged (no names, no paths).

## The three targets

- **Agent composer.** `agent_import_chat_file` (generalised, not duplicated): outside the vault a file is copied into the chat's `assets/` and shown as a file chip; inside the vault nothing is copied and the path comes back to be mentioned. A folder from outside is refused. Images and PDFs stay image and document blocks. Anything else, and any folder, is the `@File` / `@Folder` chip built by `mentionPatch` (the one builder, shared with "Attach to chat" and the sidebar drag). The sidebar's own pointer drag asks the composer through `lib/vault-drop-target.ts` with files and folders.
- **Open note.** `import_attachment_file`: a Finder file of any type is copied into the note's attachment folder and linked at the drop point (`posAtCoords`), or, already in the vault, linked where it is. `linkLine`: images and PDFs `![[name.ext]]`, a note `[[Note]]`, anything else `[[name.ext]]`; several files go on separate lines in one undo step. A vault file dragged from the sidebar is linked the same way (no copy). There is no link-style setting today, so wikilinks are always used (a name a wikilink cannot carry becomes a markdown link).
- **Sidebar tree.** `drop_import(destDir, sources)`: the folder under the pointer is highlighted (a file row means its folder, empty space the vault root, `folderAtPoint`, the one hit test of the tree's pointer drag too). Outside items are copied there. A Finder item that is already in the vault comes back as `inVault` and is moved through the existing move path (`relocate_entry`, links rewritten), never copied. The new items are selected afterwards.

## Attachment folder

`files.attachment-folder`: empty now means `./attachments` (next to the note, created on first use) instead of `attachments` at the vault root; the vault's Obsidian setting still wins over it when it has one (read-only). One resolver, `attachments.rs`; a paste, a drop and a copy all use it.

## Tests

`tests/os-drop.test.ts` (coordinates, dispatch), `features/agent/tests/agent-chat-files.test.tsx` and `agent-chat-image-target.test.ts` (chips, mentions, refusals), `tests/image-insert-editor.test.ts` and `attachments-lib.test.ts` (links), `tests/tree-os-drop.test.ts` (tree), Rust `dropped.rs`, `agent/files.rs`, `attachments.rs`.
