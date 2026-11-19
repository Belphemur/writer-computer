# PDF reader

Status: implemented and tested in jsdom and Rust; not yet verified in a real window, and the real-`claude` stream fixture is not recorded (see "Implementation notes" at the end). Decision: [ADR 2026-11-18 read PDFs in a built-in pdf feature rendered with pdf.js](../docs/decisions/2026-11-18-read-pdfs-in-a-built-in-pdf-feature-rendered-with-pdf-js.md). Sequenced after the images feature (landed, `0e3cff1`), whose viewer pieces it reuses.

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

## Implementation notes

Where each part lives, and where the build departs from the design above.

- **Rust.** `shared/attachments.json` has `documentExtensions` (`["pdf"]`) and `documentMaxBytes`; `attachments.rs` reads them (`document_extensions`, `is_document_name`, `document_max_bytes`). `code_files.rs` carries `Policy.show_pdfs` (setting `files.show-pdfs`, core, default on, independent of the feature switch like images) in the one listing seam (`is_document_name_with`, the listed-row and SQL predicates), so the sidebar, quick open, the index walker and `NameCache` list PDFs from the one list. `commands/fs.rs`: `read_document` (binary over the IPC, confined like every path command, document types only, capped by `documentMaxBytes`) feeds the reader, so no asset-protocol grant is involved and hidden folders stay hidden (a chat's pasted PDF is read the same way); `open_image_in_default_app` became `open_attachment_in_default_app` (image or document types only).
- **Agent.** `shared/agent-chat-images.json` became `agent-chat-files.json` (`mediaTypes`, `documentMediaTypes`, `documentMaxBytes` 22 MB so the base64 stays inside the API's 32 MB request, `documentMaxPages` 100), `agent/images.rs` became `agent/files.rs` (`FilePart`/`FileKind`, `load_parts`), `ContextRef::Document { path }` is the new ref, and `claude_stream.rs` encodes a `document` block (`source.type: base64`, `media_type: application/pdf`) in attach order before the text. TS: `lib/chat-images.ts` became `lib/chat-files.ts` (`chatFileRef`, `attachChatFiles`, `pageRefusal`), the PDF chip and card chip, `lib/pdf-pages.ts`. The page cap and the chip's page count come from the `pdf.info` service the `pdf` feature provides (`features/pdf/web/api.ts`, `import type` only); with the feature off a PDF is still attached, without a count and without the page check (the byte cap is always checked, in TS and in Rust). A PDF in the chat note is kept with the message's other files (the note's `images` list) and comes back as a `document` ref by its extension.
- **Page kind.** `src/components/editor-area/page-kinds/pdf.ts` (`feature: "pdf"`, `claimsWhenOff: true`: a PDF is not text, off it shows the shared off page with Turn on and Open in default app). `#page=N`: `lib/pdf-anchor.ts` is the one parser (`page`, `height`), `linkAnchor` keeps `page=N` as the anchor of a PDF link, the tab takes the parked anchor when it mounts or becomes active, and `registerAnchorReveal` (now one entry per mounted view) lets an open active tab scroll at once.
- **Zoom shared with images.** Extracted to core: `lib/viewer-zoom.ts` (`Size`, `Point`, `ZOOM_STEP`, `wheelFactor`, `percent`), `hooks/use-zoom-gestures.ts` (Cmd/Ctrl + wheel and WebKit pinch), `hooks/use-element-size.ts`, `components/zoom-control.tsx` (the footer's − percent +). The image viewer uses them; its 2D view transform stays in `features/images`. Key contexts: `image-viewer`, `pdf-viewer` and the core `no-viewer` (replacing `no-image-viewer`: the editor's text zoom applies outside both).
- **Feature.** `features/pdf/`: `web/lib/pdf-lib.ts` is the only module that imports `pdfjs-dist` (lazy; the worker is `pdfjs-dist/build/pdf.worker.min.mjs?url`, emitted into the bundle: same origin, no CDN, `worker-src 'self'` already allows it), `lib/page-layout.ts` (pure geometry: layout, fit width, render range, current page, reading anchor), `lib/find.ts` and `lib/find-marks.ts` (matching over the page text and marking of the text layer), `components/pdf-reader.tsx` (the one reader: tab and embed), `pdf-viewer.tsx`, `pdf-embed.tsx`, `find-bar.tsx`, `page-box.tsx`, `embed-decorations.ts`. Commands and keys: `pdf.zoom-in`, `pdf.zoom-out`, `pdf.fit`, `pdf.find` (Cmd/Ctrl+F in a PDF tab: the editor's own find is CodeMirror's keymap, there was no core find command to route, so the feature binds it under the `pdf-viewer` context).
- **Deviations.** The stream shape of a document block was not recorded with the real CLI (the build ran against the fake `claude` and the API's documented block shape; a golden pins the encoder). Find highlights are `mark` elements wrapped around the matched characters of the text layer, only on pages that are drawn. pdf.js's standard fonts, packed CMaps and wasm decoders are copied from `pdfjs-dist` into the bundle under `/pdfjs-assets/` (`features/pdf/vite-assets.ts`, served in dev, emitted on build; URLs in `web/lib/asset-urls.ts`) and fetched only when a PDF needs them.
