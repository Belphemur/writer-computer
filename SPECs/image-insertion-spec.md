# Image Insertion Spec

## Summary

Dropping or pasting an image into a note saves it into the vault's attachment folder and inserts an embed. The embed syntax and rendering are [`obsidian-image-embed-spec.md`](obsidian-image-embed-spec.md); this spec covers getting the file there and the link text.

## Sources

| Source                                               | How it reaches the editor                                                                                                                                                     | What is done                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Paste: screenshot, "copy image", copied image file   | `paste` event, `clipboardData.files` (then image `items`)                                                                                                                     | bytes saved                                |
| Drop from the browser                                | HTML5 `drop` with `dataTransfer.files`                                                                                                                                        | bytes saved                                |
| Drop from Finder                                     | Tauri `onDragDropEvent` (the window's OS drag-drop is on, so no HTML5 events for files), routed by `use-os-image-drop.ts`                                                     | file copied by path, bytes never cross IPC |
| Drag an image from the sidebar                       | the tree's pointer drag (`use-tree-drag.ts`) released over a note; the sidebar lists images (`files.show-images`, [`code-files-spec.md`](code-files-spec.md) "Images")        | link only, nothing copied                  |
| Browser drag or paste that carries only an image URL | `text/html` with an `<img src>` and no text of its own, or `text/uri-list` whose path ends in an image extension (`imageUrlsFromTransfer`); used only when no file came along | downloaded in Rust (below)                 |

All of them end in `insertImages` (`editor-image-insert.ts`). Non-image drops and pastes keep the old behaviour (a `.md` file dropped opens it, text pastes as text).

## Where files go

Setting `files.attachment-folder` (string, default empty). Forms, from Obsidian's public "Default location for new attachments" semantics:

- `attachments`, `assets/img`: a folder from the vault root. A leading or trailing `/` is ignored; `/` alone is the vault root.
- `./`: next to the note.
- `./name`: the subfolder `name` of the note's folder.

Empty: the vault's `.obsidian/app.json` `attachmentFolderPath` when it has one (read-only, same forms), else `attachments` at the root. The folder is created on demand. A window with no vault (a standalone file) saves to `<note stem>-assets/` next to the file.

One Rust write path, `attachments.rs` (Tauri-free): `sanitize_name`, `resolve_folder`, `save`. Paths go through `vault_ops::confine` (no `..`, no escape by symlink, never `.obsidian` or `.git`), the file is created with `create_new` (never overwrites), and nothing is ever written into `.obsidian`. Commands `save_attachment` (raw bytes as the request body, note and name in a header) and `import_attachment_file` (by path) in `commands/images.rs` are async, do their IO through `commands::blocking`, authorize the note with the window's workspace, and log nothing about image bytes or paths.

## Remote images (a link, no file)

`import_attachment_url` (`commands/images.rs`, async) calls `attachments::download_image`, the one download function. Rules:

- `http` and `https` only, checked with `plugin_http::check_url` (the same gate as the plugin host: no `file:`, `data:`, `ftp:`, no cloud-metadata hosts, also on every DNS answer). Redirects are followed up to 5 hops, each hop through the same gate; a hop to another scheme stops the download ("the server answered 302"). Timeout 15 s for the whole download.
- The size cap (50 MB, `maxBytes`) is checked on `Content-Length` and again while streaming, so a server that lies or sends no length never fills memory.
- The type is the `Content-Type` when it is an allowed image (`mimeExtensions` in `shared/attachments.json`, the one MIME table for Rust and TypeScript), else the leading bytes must match one (`sniff_extension`: png, jpeg, gif, webp, bmp, avif, heic, svg; the other types need a Content-Type or a file name). An HTML error page served as `text/html` is refused. The saved extension follows the detected type, not the URL.
- The name is the stem of `Content-Disposition` `filename` or of the last URL path segment, sanitised (as above); a missing or generic stem (`image`, `download`, `file`, `photo`, `index`, `blob`) becomes `Pasted image <timestamp>`. The file then goes through the same `save` (attachment folder, collisions, confinement), and `![[name]]` is inserted.
- If the download fails or is refused, the editor inserts a plain `![](url)` (spaces and parentheses percent-encoded) and shows the reason, for example "Image not downloaded: the server answered 404. Inserted a link to the address instead."
- The URL is never logged, not even its host on the happy path; a failure logs the host at debug level only.
- Uses the app's existing `reqwest` client stack (no new dependency); system proxy settings apply.

## Names, types, size

- Pasted blobs: `Pasted image YYYYMMDDHHmmss.<ext>` in local time. A browser's generic `image.png` counts as pasted. The extension comes from the MIME type.
- Dropped files keep their name. Forbidden characters (`/ \ : * ? " < > |` and the wikilink-breaking `# ^ [ ]`) become `-`, leading dots are dropped.
- A taken name gets ` 1`, ` 2`, ... before the extension.
- Types (`shared/attachments.json`, read by Rust and TypeScript): the one list in the file (png jpg jpeg gif webp svg avif bmp ico apng tif tiff heic heif jxl); the system webview decodes what it can, and the image viewer shows a fallback for a type it cannot. Anything else is refused with a notice and nothing is saved.
- Size cap 50 MB (`maxBytes` in the same file). Over it: a notice naming the size and the limit; checked in the frontend before reading the bytes and again in Rust.

## What is inserted

`![[target]]`, one per image, one per line, at the caret (paste) or the drop point (`posAtCoords`), as a single transaction (one undo step) with the caret after the text. The link style is the wikilink embed; no vault link-style setting exists yet.

`target` is the bare file name when the file sits next to the note or at the vault root (the resolver probes both), otherwise the vault-relative path (the resolver probes workspace-relative paths first). Both resolve by probing the disk, so the image renders immediately without waiting for the index or watcher. A vault image dragged from the sidebar gets the same rule. With no vault, the path relative to the note.

**Names a wikilink cannot carry.** `[ ] | # ^` end or split a wikilink (`]]`, alias, heading, block), and the wikilink grammar has no escape for them (only `\|` inside tables). An existing vault image whose target holds one of them is therefore inserted as a markdown image instead: `![](path)` with the path relative to the note, percent-encoded per segment (`embedLine`, `lib/attachments.ts`; the editor decodes it when resolving the image, see `image-src-resolver.ts`). Example: `assets/a [1] #x.png` from `notes/` becomes `![](../assets/a%20%5B1%5D%20%23x.png)`. Saved images never hit this (their names are sanitised).

The insertion point is tracked through edits made while the file is saving; if the editor was closed meanwhile nothing is inserted. A source that fails is reported and skipped, the rest still insert.

## Visual feedback

- While dragging over the editor a drop caret shows where the embed will land: CodeMirror's own for browser drags, `cm-image-drop-caret` for Finder and sidebar drags.
- A save that takes more than 200 ms shows "Saving image…" in the editor notice, replaced by the error notice if it fails.

## Not done

- Sizing or alt-text modifiers.
- Not verified in a real window: a real browser drag of an `<img>` (what the macOS webview puts in the drag data), downloads from real sites (cookies, hotlink protection answer 403 and fall back to `![](url)`).
