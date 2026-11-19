# PDF reader

Status: designed, not started. Decision: [ADR 2026-11-18 read PDFs in a built-in pdf feature rendered with pdf.js](../docs/decisions/2026-11-18-read-pdfs-in-a-built-in-pdf-feature-rendered-with-pdf-js.md). Sequenced after the images feature (landed, `0e3cff1`), whose viewer pieces it reuses.

## Goal

Read the PDFs a vault holds the way Obsidian users expect: open one in a tab, scroll, zoom, find and copy text, follow `#page=N` links, embed it in a note, and attach it to an agent chat. Never write the PDF.

## Split

| Layer               | Owns                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust core           | PDF listing (sidebar, quick open, index walker, watcher, `NameCache`) from `shared/attachments.json` `documentExtensions` and the setting `files.show-pdfs`; confinement of every path; the agent's `document` content block (base64, media type, caps) in `agent/` |
| `features/pdf` (TS) | the viewer, find bar, embed widget, zoom commands; pdf.js loaded lazily                                                                                                                                                                                             |
| Core TS             | the `pdf` page kind (`feature: "pdf"`), link activation, `#page=N` anchors through `pending-anchor.ts`                                                                                                                                                              |

As much as possible stays in Rust; pdf.js is the renderer because the webview has no other cross-platform one.

## Dependency

`pdfjs-dist` `6.5.438`, pinned exactly, Apache-2.0. Its worker runs as a same-origin module worker from the app bundle (no CDN). Loaded only when a PDF tab or embed mounts; a startup-chunk test pins that.

## Files and listing

- `shared/attachments.json` gains `documentExtensions: ["pdf"]`, read by Rust (`include_str!`) and TS; no second list.
- Setting `files.show-pdfs` (core, default on, label "Show PDFs") lists PDFs in the sidebar and quick open, like `files.show-images`.
- Opening a `.pdf` routes to the `pdf` page kind. With the feature off it shows the shared off page (Turn on, Open in default app).

## Tab viewer

- One vertical scroller (`docs/design.md`: one scroller per page, kept-alive tabs hidden when inactive). Pages are virtualized: only pages near the viewport render a canvas and the pdf.js text layer; others are sized placeholders.
- Fit width by default. Zoom shares the image viewer's commands, gestures and view-transform helpers: pinch or Cmd/Ctrl + scroll toward the pointer, Cmd/Ctrl `=` / `-` / `0` (Fit width), registered as keybinding commands active only in a PDF tab.
- Footer: page `x / n` (a click turns it into an input; Enter goes there, Escape cancels), the zoom (`Fit` or a percent; a click returns to Fit), − and +.
- Links inside the PDF: external ones through `link-activation`; internal ones jump to their page.
- Text selection and copy: the text layer is `data-selectable`.

## Find

Cmd/Ctrl+F in a PDF tab opens a find bar over the viewer (the core find command, routed by the active page kind): match count `3 / 12`, Enter / Shift+Enter for next and previous, highlights in the text layer, Escape closes it.

## Links and embeds

- `[[file.pdf]]` opens the tab; `[[file.pdf#page=3]]` opens it at page 3 (an open tab scrolls to it).
- `![[file.pdf]]` renders an embedded viewer in the note: fixed height (default 480 px), its own scroller, page `x / n`, an "Open in tab" button. `![[file.pdf#page=3]]` opens at page 3; Obsidian's `#height=600` sets the height.
- Embeds go through the editor's embed registry (`editorExtensions` contribution; the bases embed is the model).

## Agent attachments

- The composer accepts PDFs from the file picker, paste, OS drop and a vault drag, beside images.
- `shared/agent-chat-images.json` becomes `shared/agent-chat-files.json` (images and documents: extensions, media types, the API's size and page caps), read by `agent/images.rs` (renamed for files) and `features/agent/web/lib/chat-images.ts` (renamed).
- A PDF is sent as a `document` content block (`source.type: base64`, `media_type: application/pdf`). Over the caps it is refused with one short line in the composer.
- The chip shows a PDF icon, the file name and the page count; a click opens the PDF tab.
- The stream shape is recorded once with the real `claude` CLI in a temporary directory as a sanitized fixture in `agent/fixtures/`, replayed by a golden test. Never in the user's vault, never reading `~/.claude`.

## Privacy

Never write a PDF. Never log its text, its name or its path.

## Tests

- Routing: `.pdf` opens the pdf page kind; feature off shows the off page.
- Viewer: only near pages render; fit width; zoom commands only in a PDF tab; go to page; `#page=N` from a link and from an embed.
- Find: count, next, previous, highlight, Escape.
- Embed: default height and `#height=`; "Open in tab".
- Listing: `files.show-pdfs` in Rust and TS from the one list.
- Startup chunk excludes pdf.js.
- Agent: a PDF chip encodes a `document` block (golden), caps refused with a message, the real-CLI fixture replays.

## Not in scope

Annotations or highlights saved to the file, form filling, editing or merging PDFs, OCR, indexing PDF text in vault search (revisit later; it would be Rust text extraction feeding the index), printing.
