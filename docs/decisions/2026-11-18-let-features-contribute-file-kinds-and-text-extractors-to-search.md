---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Let features contribute file kinds and text extractors to search

## Context and Problem Statement

Search has two halves, both in the Tauri-free vault index (`src-tauri/src/index/`): file-name search (`names.rs`, quick open and `find_file_by_name`) and full-text search (`fts.rs`, the `notes_fts` FTS5 table, `search.rs`, `search_query.rs`; spec `SPECs/search-spec.md`). Which files the name index holds is a hardcoded core list, `code_files::ALWAYS_LISTED_EXTS = ["md", "base", "excalidraw"]`, plus the code-files and image policies; full-text search indexes notes only. So a PDF, a code file or a drawing cannot be found by its content, and every new file type (Excalidraw, PDF, the features to come) edits core lists. The user asked (2026-11-18): "we need to be able to find pdf file code file etc ... as part of search, basically different plugin should plug themselve in search to tell it to index / find their files", and chose: names and content; PDF text extracted in Rust; one mixed result list with a kind filter; a `kind:` operator for agents and the CLI; the extractor crate `pdf_oxide`.

## Decision Drivers

- One registry of file kinds instead of per-type branches in core (`docs/consolidation.md`).
- Search works headless (the `writer` CLI, agents) exactly as in the app.
- Local only; extracted text lives in the vault index and is never logged.
- Indexing stays incremental and never blocks the UI; a bad file never breaks the index.

## Considered Options

- A. A `file_kinds()` contribution on the Rust `Feature` trait (static data like `cli_commands()`), each kind with matching rules and an optional Rust text extractor feeding the existing FTS table; core contributes the kinds it owns.
- B. Extract in the webview (pdf.js, editors) and push text to the index over IPC.
- C. Keep hardcoded lists and add PDFs and code to them.

## Decision Outcome

Chosen option: **A**.

1. **File kind registry** (`src-tauri/src/index/kinds.rs`, Tauri-free): `FileKind { id, label, icon, matches: &[Suffix], listed_by: Gate, extract: Option<Extractor> }`.
   - `id` is the stable key used by `kind:` and the UI (`note`, `pdf`, `code`, `image`, `drawing`, `base`).
   - `matches` are file-name suffixes, longest first wins, so `.excalidraw.md` is a `drawing`, not a `note`.
   - `listed_by` names the gate: a feature switch, a core setting (`files.show-images`, `files.show-pdfs`) or the code-files policy.
   - Kinds come from core (`note`, `image`, whose page kinds core keeps) and from features through a new `Feature::file_kinds()` (static data, read by the app and the CLI like `cli_commands()`): `code-files` → `code`, `bases` → `base`, `excalidraw` → `drawing`, `pdf` → `pdf` (the `pdf` feature gains a Rust half for this).
   - A kind whose feature is off or failed is not listed and not indexed; turning it off drops its rows at the next sync, turning it on indexes them.
2. **One visibility seam**: `code_files.rs` stays the only place that answers "is this file listed" (sidebar, index walker, watcher, `NameCache`, `relocate`); its functions read the registry instead of `ALWAYS_LISTED_EXTS`, which is removed. Secret names, ignored folders and the size and binary guards keep applying to every kind.
3. **Extractors** (Rust, `fn(&Path, &[u8]) -> Result<Extracted, ExtractError>`, `Extracted { title: Option<String>, body: String }`):
   - `code`: the file text (UTF-8, the code-files size guard).
   - `pdf`: `pdf_oxide` `=0.3.78` with `default-features = false` (no `icc`, `legacy-crypto`, OCR, rendering or ML), plain text in reading order; title from the document info when present. Caps: files above 100 MB are named only; at most 2,000 pages; text truncated at the FTS body cap.
   - `drawing`: the text of Excalidraw elements, through the existing Rust codec.
   - `base`: names only. `image`: names only (no OCR).
   - Every extractor runs on the index writer path through `features::guard` (a panic or error skips that file's content, keeps its name, logs the kind and error class, never the path or text). Encrypted or malformed PDFs are named only.
   - Results are cached by `(path, size, mtime)` in the index, so a file is re-extracted only when it changes.
4. **Index**: `files` gains a `kind` column (schema and parser versions bumped, full rebuild on upgrade). Extracted text goes into `notes_fts` (title = file name or document title, body = extracted text; headings, tags and props empty), one table for every kind, ranked by the same bm25 weights and `rank.rs` scorer. Size measured on the dev vault and recorded in `SPECs/search-spec.md`.
5. **Query**: `search_query.rs` gains `kind:<id>` (repeatable, OR within kinds, `-kind:` negates) and `ext:<ext>`; unknown kinds are an explicit error listing the known ones. Same grammar in `writer search` and the managed `writer-search` skill (bump `BUNDLE_VERSION`).
6. **UI**: one mixed ranked list in quick open and content search; each row shows its kind icon (the icons feature's file icon wins when set) and, for content hits, the snippet; a chip row above results (All, then each listed kind by label) sets `kind:`. Chips come from the registry over IPC (`search_kinds` command), never a TS twin list. Opening a hit routes by page kind; a PDF content hit opens at its page when the snippet's page is known (`#page=N`).

### Consequences

- Good: a new file type plugs into listing and search by declaring a kind; no core edits.
- Good: PDFs, code and drawings are searchable by content, headless and in the app.
- Bad: one new dependency (`pdf_oxide`, 0.x, MIT OR Apache-2.0) and a larger index.
- Bad: a full index rebuild on upgrade.

### Non-goals

- OCR of images or scanned PDFs; content search inside binary formats other than PDF (Office, EPUB).
- Kinds contributed by Obsidian plugins in the plugin host.
- Semantic or vector search.

## Implementation Plan

- **Affected paths**: new `src-tauri/src/index/kinds.rs` and `src-tauri/src/index/extract/` (`code.rs`, `pdf.rs`, `drawing.rs`); `index/{schema,build,names,fts,search,search_query,rank}.rs`; `code_files.rs` (read the registry, drop `ALWAYS_LISTED_EXTS`); `features/mod.rs` (`file_kinds()` on the trait, `file_kinds()` collector, contract test); `features/{code-files,bases,excalidraw}/rust/` and a new `features/pdf/rust/` (kind declarations; the pdf feature's `feature.json` gains its Rust half); `commands/index.rs` (`search_kinds`); `cli/cmd_query.rs` (`kind:` and `ext:` in `writer search`); web: `src/components/command-palette/` content search and quick open (kind chips, row icons, snippet), `src/lib/` search IPC types; `Cargo.toml` (`pdf_oxide = { version = "=0.3.78", default-features = false }`, installed by the lead); specs: `SPECs/search-spec.md`, `SPECs/search-ranking-spec.md`, `SPECs/pdf-spec.md`, `SPECs/code-files-spec.md`, `SPECs/builtin-plugins-spec.md` (new contribution), `SPECs/writer-cli-spec.md`; the `writer-search` skill; `THIRD_PARTY_NOTICES.md` (pdf_oxide); `CHANGELOG.md`, `TODOS.md`.
- **Patterns to follow**: registry over per-case branches; static feature contributions like `cli_commands()`; the one visibility seam `code_files.rs`; `features::guard` at the extractor boundary; the index writer thread; `commands::blocking` for IPC; `docs/design.md` (terse chips, one scroller).
- **Patterns to avoid**: a second FTS table per kind; extraction in the webview; a TS copy of the kind list; logging paths or extracted text; blocking the main thread.
- **Tests**: registry (suffix precedence `.excalidraw.md`, gates by feature switch and setting, a failed feature's kind dropped, contract test that every kind's feature exists); `code_files` listing unchanged for notes, images and code (existing tests stay green) and secret names never indexed for any kind; extractors on fixtures (a text PDF, a multi-page PDF, an encrypted and a malformed PDF named only, the size and page caps, a panicking extractor contained); incremental reindex only on change (cache hit); `kind:`/`-kind:`/`ext:` parsing and unknown-kind error; mixed ranking across kinds; feature off drops rows and on restores them; CLI `writer search kind:pdf`; UI chips from `search_kinds`, row icons, PDF hit opening at its page.

### Verification

- [x] A word only inside a PDF finds that PDF in content search and `writer search`.
- [x] A code file and an Excalidraw drawing are found by their content.
- [x] `kind:pdf` and the PDFs chip show only PDFs; `-kind:code` hides code.
- [x] Turning a feature off removes its files from search; turning it on brings them back.
- [x] Adding a kind needs no edit in core listing or search code (shown by the pdf feature's kind).
- [x] A malformed PDF is still found by name and never breaks indexing.

## Pros and Cons of the Options

### A. Feature-contributed kinds with Rust extractors

- Good, because one registry, headless, incremental and contained.
- Bad, because a new dependency and an index rebuild.

### B. Extraction in the webview

- Good, because pdf.js is already installed.
- Bad, because only files opened while the app runs get indexed; the CLI and agents can't extract.

### C. Hardcoded lists

- Good, because the smallest change.
- Bad, because every file type edits core again; the problem the user named.

## More Information

Crate research 2026-11-18 (crates.io): `pdf_oxide` 0.3.78 (2026-09-08, MIT OR Apache-2.0, pure Rust, default features `icc` and `legacy-crypto` turned off), `pdf-extract` 0.12.1 (MIT, on `lopdf`) considered; the user chose `pdf_oxide`. Related: the code-files ADR and `SPECs/code-files-spec.md` (the visibility seam), the PDF ADR, the Excalidraw ADR, the icons ADR (row icons), `SPECs/search-spec.md`.
