---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Read PDFs in a built-in pdf feature rendered with pdf.js

## Context and Problem Statement

Writer cannot show PDFs: they are not listed, cannot be opened in a tab, `![[file.pdf]]` embeds render nothing, and the agent composer only accepts images (`apps/desktop/shared/agent-chat-images.json`). Vaults shared with Obsidian hold PDFs (papers, invoices, slides) and link to pages (`[[paper.pdf#page=3]]`). The user asked (2026-11-18) for "another plugin to be able to read pdfs", chose pdf.js, and the first version's scope: a tab viewer, search and text selection, embeds and page links, sidebar and quick open, and attaching PDFs in agent chats.

## Decision Drivers

- Same rendering on every OS (WebKit on macOS draws PDFs natively, Linux webviews cannot).
- Obsidian link syntax works (`#page=N`).
- Lazy: no PDF code in the startup chunk.
- Never write the PDF; never log its text or path.
- One list per file kind; built-in feature pattern (ADR `2026-11-17-build-first-party-features-as-built-in-plugins-...`).

## Considered Options

- A. A built-in `pdf` feature rendering with pdf.js (`pdfjs-dist`, Apache-2.0, new dependency).
- B. The system webview's PDF viewer in an `<embed>`.

## Decision Outcome

Chosen option: **A** (the user chose it).

1. **Dependency**: `pdfjs-dist` `6.5.438` (the current stable release, confirmed by the user on 2026-11-18), pinned exactly, Apache-2.0. Its worker runs as a module worker from the app bundle (no CDN; CSP unchanged except what a same-origin worker needs). Loaded only when a PDF tab or embed mounts.
2. **Feature**: `apps/desktop/features/pdf/` (`feature.json`, kill switch `features.pdf.enabled` on by default, light `web/index.ts`, the viewer as the lazy slot `page-view:pdf`, `tests/`). A core `pdf` page kind with `feature: "pdf"` (like `image`/`code`); off, a PDF tab shows the shared off page (Turn on, Open in default app).
3. **Tab viewer**: pages in one vertical scroller (virtualized: only pages near the viewport render, canvas plus pdf.js text layer); fit width by default; zoom with the same commands and gestures as the image viewer (shared view-transform helpers where they apply, keybinding registry commands active in a PDF tab); footer: page `x / n` (click to type a page), zoom percent, − and +. Links inside the PDF: external ones through `link-activation`, internal ones jump to their page.
4. **Search and selection**: Cmd/Ctrl+F in a PDF tab opens a find bar (next/previous, match count, highlights in the text layer); text is selectable and copyable (`data-selectable`, `docs/design.md`).
5. **Embeds and page links**: `![[file.pdf]]` renders an embedded viewer in the note (fixed height, its own scroller, Open in tab); `![[file.pdf#page=3]]` opens the embed at page 3; `[[file.pdf#page=3]]` opens the tab at page 3, through the existing anchor path (`pending-anchor.ts`, `revealAnchorInPlace`). Obsidian's `#height=` in embeds is honoured.
6. **Listing**: a core setting `files.show-pdfs` (default on) lists PDFs in the sidebar and quick open; the extension lives in `shared/attachments.json` (a `documentExtensions` list, `["pdf"]`, read by Rust and TS), the same file as image types.
7. **Agent attachments**: the composer accepts PDFs (picker, paste, drop, vault drag) and sends them to Claude as a `document` content block (base64, `application/pdf`). `shared/agent-chat-images.json` becomes `shared/agent-chat-files.json` (images and documents, media types, the size and page caps of the API), read by `agent/images.rs` (renamed for files) and `features/agent/web/lib/chat-images.ts` (renamed). The chip shows a PDF icon and page count; a click opens the PDF tab. The stream shape is recorded once with the real CLI in a temporary directory as a sanitized fixture (never in the vault, never reading `~/.claude`).

### Consequences

- Good: PDFs read, search, link and embed like in Obsidian, the same on every OS; agents can read them.
- Bad: a ~3 MB lazy dependency and its worker.
- Neutral: no annotation or form filling.

### Non-goals

- Annotations, highlights saved to the file, form filling, editing or merging PDFs.
- OCR of scanned PDFs; indexing PDF text in vault search (revisit later).
- Printing from the viewer.

## Implementation Plan

- **Affected paths**: `apps/desktop/package.json` (pdfjs-dist), Vite worker config if needed, `tauri.conf.json` CSP only if the same-origin worker needs it; new `apps/desktop/features/pdf/`; core page kind `src/components/editor-area/page-kinds/pdf.ts`; `shared/attachments.json` (`documentExtensions`); Rust listing (`code_files.rs` predicates, sidebar, index walker, `NameCache`) and settings `files.show-pdfs` in `shared/settings.schema.json`; embeds through the editor's embed registry (`editorExtensions` contribution, the bases embed is the model); anchors in `src/lib/pending-anchor.ts`; agent: `shared/agent-chat-files.json`, `src-tauri/src/agent/images.rs`, `agent/claude_stream.rs` (document block encoder), `features/agent/web/lib/chat-images.ts`, composer chips; fixtures `agent/fixtures/`; specs: new `SPECs/pdf-spec.md`, `SPECs/builtin-plugins-spec.md` (Step 5 entry), `SPECs/native-agent-spec.md` (Images in the composer becomes Files), `CHANGELOG.md`, `TODOS.md`.
- **Patterns to follow**: the images feature (lazy slot, off page, view transform, keybindings); the bases embed; one list per file kind; `docs/design.md`; `.agents/skills/writer-feature/SKILL.md`.
- **Patterns to avoid**: a CDN worker; rendering every page at once; a second PDF list; core importing the feature.
- **Tests**: page kind routing for `.pdf`; viewer virtualization (only near pages render), fit width, zoom commands, go to page, `#page=N` from a link and an embed; find bar (count, next, previous, highlight); embed height and `#height=`; feature off page; startup chunk excludes pdf.js; listing setting in Rust and TS; agent: a PDF chip encodes a `document` block (golden), caps refused with a message, the real-CLI fixture replays.

### Verification

- [ ] A PDF opens in a tab, scrolls, zooms and goes to a page; text selects and copies.
- [ ] Cmd+F finds text with a match count.
- [ ] `![[file.pdf#page=3]]` embeds at page 3; `[[file.pdf#page=3]]` opens the tab at page 3.
- [ ] PDFs show in the sidebar and quick open with `files.show-pdfs`.
- [ ] A PDF attached in the agent composer reaches Claude and it can quote it.
- [ ] pdf.js is not in the startup chunk.

## Pros and Cons of the Options

### A. pdf.js

- Good, because same on every OS, full control (embeds, page links, search).
- Bad, because a new dependency and a worker.

### B. System viewer

- Good, because no dependency.
- Bad, because no control over pages or search, no embeds, differs per OS.

## More Information

Related: the images ADR `2026-11-18-make-images-a-built-in-feature-with-a-rebuilt-zoomable-viewer` (shared viewer pieces), the link activation ADR, [native agent spec](../../SPECs/native-agent-spec.md) (Images in the composer). Sequenced after the images feature lands.
