---
status: accepted
date: 2026-11-15
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Index note content in a contentless FTS5 table with unicode61, CJK spacing and bm25 weights

> Backfilled on 2026-11-16. Date = `f7a5822` "Full-text search on SQLite FTS5, quick open on the index, Bases polish". Spec (holds the schema, query language, tests and perf numbers): [`SPECs/search-spec.md`](../../SPECs/search-spec.md). Status is `accepted` because it ships in code and tests; it has not been run in a real window, and ranking weights are untuned on a real vault.

## Context and Problem Statement

Before this change Writer had only file-name search. Full-text search over note content was needed in the palette (Cmd+Shift+F) and for `writer search`, inside the existing vault index, for multilingual notes, and with line-accurate snippets for the CLI (`path:line: text`).

## Considered Options

- **Table kind**: regular (stores a copy of every column; `snippet()` works), external content (needs a body table the index does not have), contentless with `contentless_delete=1` (index only; chosen).
- **Tokenizer**: `unicode61 remove_diacritics 2` (chosen); `porter` (English-only stemming); `trigram` (substring matching, nothing under 3 characters, an indicative benchmark measured the index near 2.6 times the text).
- **CJK**: put a space around every ideograph, kana and Hangul syllable in indexed text, queries and per-line matching (chosen); a trigram table (about 2.6 times the text again for what unigram spacing already provides); a custom tokenizer.
- **Prefix indexes**: `prefix='2'` (chosen) versus `'2 3'` or none, measured on 3000 synthetic notes (5.4 MB and 204 ms versus 8.1 MB and 291 ms versus 4.1 MB and 127 ms).

## Decision Outcome

Chosen option: `notes_fts(title, headings, tags, props, body)` with `tokenize='unicode61 remove_diacritics 2'`, `prefix='2'`, `content=''`, `contentless_delete=1`, `rowid = files.id`, in `apps/desktop/src-tauri/src/index/fts.rs`.

- bm25 weights by column: title 10, headings 5, tags 4, property values 2, body 1. Notes with a body over 2 MiB are indexed by title, headings, tags and props only.
- Written in the same transaction as the rest of a note's rows by `build::write_records`; `fts::delete_files` is the only deletion path; no triggers.
- Snippets and line numbers come from the file on disk through a throw-away in-memory FTS5 table with the same tokenizer, so parity is by construction; a hit whose content hash differs is flagged `stale`, never hidden.
- User text is never FTS syntax: each term is a double-quoted string bound as a parameter; filters (`path:`, `file:`, `tag:`) are bound SQL conditions; `"phrase"`, `-exclude`, `a OR b`, `word*` are supported (`index/search_query.rs`).
- `writer search` and `search:context` run on the same index; `query=/regex/` stays an explicit regex scan.
- `rusqlite`'s bundled SQLite includes FTS5; a test asserts `ENABLE_FTS5` and `contentless_delete`.

### Consequences

- Good, because search shares the index, its freshness and its transaction, at roughly 0.95 times the text size and about 0.15 ms per 3 KB note on a cold build.
- Bad, because there is no stemming (`plan` does not find `planning`; use `plan*`), no substring matching outside CJK, Thai and Khmer are not segmented, CJK has no word boundaries, and it is not Obsidian's full search language.
- Bad, because `optimize` is not run automatically; whether to add an idle-time hook is open (`TODOS.md`).
- Revisit when real vaults show slow 3-or-more-character prefix queries, or CJK users need real word matching (a trigram table is the deferred alternative).

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/index/{fts,search,search_query,search_tests}.rs`, `commands/index.rs` (`index_search`), `cli/cmd_query.rs`, `apps/desktop/src/components/command-palette/content-search-*`, `apps/desktop/src/lib/content-search.ts`, `apps/desktop/src/lib/pending-anchor.ts`.
- **Patterns to follow**: all FTS writes through `fts::write_doc` and `fts::delete_files`.
- **Patterns to avoid**: interpolating user text into a `MATCH` expression; reading snippets from a stored copy.

### Verification

- [ ] `cargo test` passes `index/search_tests.rs` (ranking, phrase, prefix, exclusion, CJK ranges, stale flag, 2 MiB cap, schema-bump rebuild, 1500-string fuzz).
- [ ] `cargo test --release --lib perf_smoke -- --nocapture` reproduces the spec's perf table.
- [ ] `vp test` passes `tests/content-search.test.tsx`.
- [ ] Manual: the palette, focus return and line reveal in a real window (open).
