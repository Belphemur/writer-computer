# Note-content search (SQLite FTS5)

Status: implemented in code, not run in a real window (see "Not verified").

Full-text search over note **content**, inside the existing vault index. Before this, the app had only file-name search (quick open). Code: `src-tauri/src/index/{fts,search,search_query}.rs`, `commands/index.rs` (`index_search`), `cli/cmd_query.rs` (`search`, `search:context`), and `src/components/command-palette/content-search-*` + `use-content-search.ts` (UI). Related: [`obsidian-bases-spec.md`](obsidian-bases-spec.md) section 4.1 (the index), [`writer-cli-spec.md`](writer-cli-spec.md) (Obsidian CLI parity).

## Research conclusions (step 1)

1. **`rusqlite` `bundled` includes FTS5; no Cargo feature is needed.** `libsqlite3-sys` 0.40.0 `build.rs` passes `-DSQLITE_ENABLE_FTS5` (plus FTS3, JSON1, RTREE, STAT4, `DBSTAT_VTAB`) for the bundled build, and bundles SQLite 3.54.1 (checked in the local crate source: `sqlite3.c` `SQLITE_VERSION "3.54.1"`). Sources: <https://docs.rs/crate/libsqlite3-sys/latest/source/build.rs>, <https://raw.githubusercontent.com/rusqlite/rusqlite/master/libsqlite3-sys/build.rs>, <https://raw.githubusercontent.com/rusqlite/rusqlite/master/libsqlite3-sys/upgrade.sh>. A test (`fts5_is_compiled_in_and_contentless_delete_works`) asserts `PRAGMA compile_options` contains `ENABLE_FTS5`, creates a `contentless_delete` table and requires SQLite >= 3.43, so a regression fails loudly. `dbstat` is also compiled in, which is how the perf test measures FTS size.
2. **Table kinds** (<https://www.sqlite.org/fts5.html>):
   - _Regular_ keeps a copy of every column; needed for `snippet()`/`highlight()` on stored text.
   - _External content_ (`content='tbl'`) avoids the copy but needs triggers or manual `'delete'` commands with the exact old values, and the old row must still be readable. The index has no body table, so this would mean adding one.
   - _Contentless_ (`content=''`) stores only the inverted index; column reads return NULL, so no `snippet()`. Plain contentless forbids `DELETE`/`UPDATE`. **`contentless_delete=1` (SQLite 3.43+)** allows `DELETE` by rowid and `INSERT OR REPLACE`.
3. **Tokenizers**: `unicode61 remove_diacritics 2` (value 2 strips all Latin diacritics; the default 1 misses some multi-diacritic letters; case folding is built in). `porter` is English-only stemming, wrong for multilingual notes. `trigram` gives substring matching but matches nothing under 3 characters, and a Japanese blog benchmark measured the index at about 2.6x the text (<https://www.issoh.co.jp/tech/details/9314/>, indicative only). `unicode61` makes an unbroken CJK run one token (<https://dev.to/omochi_dev/why-sqlite-fts5s-default-tokenizer-drops-your-japanese-substrings-and-the-one-line-fix-1k2d>); inserting a space between CJK characters in both text and query is the common workaround (<https://dev.to/foxck016077/sqlite-fts5-wont-tokenize-chinese-heres-the-7-line-bigram-fix-that-did-4fcc>).
4. **Ranking and highlighting**: `bm25(tbl, w1, w2, ...)` returns a _negative_ score (lower is better), weights are positional, k1=1.2 and b=0.75 are fixed. `highlight(tbl, col, open, close)` and `snippet(...)` need column text, so they work on regular and external-content tables only.
5. **Query syntax**: strings are double-quoted (embed `"` as `""`); barewords allow only ASCII letters, digits, `_` and non-ASCII; everything else is syntax. A `*` after a quoted string makes its last token a prefix; `"thr*"` is not a prefix query. `NOT` is binary and implicit AND binds tighter than NOT and OR, and `(one OR two) three` is a syntax error, so a translator must emit explicit parentheses. Quoting every term is the standard safe approach (SQLite mailing list: <https://mail-archive.com/sqlite-users@mailinglists.sqlite.org/msg118320.html>).
6. **Maintenance**: `INSERT INTO t(t) VALUES('optimize')` merges everything into one b-tree; `('merge', N)` does a bounded partial merge; `('integrity-check')` verifies the index (`rank=1` also compares with an external content table); `('rebuild')` is for external-content tables; defaults `automerge=4`, `crisismerge=16`. Index size with `detail=full` was 743 MiB vs 340 MiB (`column`, loses phrases) vs 134 MiB (`none`) on 1.6 GiB of mail.
7. **WAL**: one writer plus read-only connections; FTS5 writes a new segment per commit and merges inside the writing transaction; readers keep their snapshot. The existing writer thread and read pool need no change.

A separate research note (`fts-research.md`, another agent) reached the same facts; the disagreements are listed under "Decisions that differ from that note".

## Decisions

### Table

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, headings, tags, props, body,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2',
  content = '', contentless_delete = 1
);
```

`rowid = files.id`. One row per Markdown note. Schema version bumped to `2`; the index already discards and rebuilds a database on schema/parser mismatch, so older databases are rebuilt and the cold scan fills the table (test: `schema_bump_rebuilds_and_populates_fts`).

- **Contentless-delete, not a regular table.** Snippets and line numbers are always produced from the file on disk (the Obsidian CLI needs `path:line: text`, and the editor needs the line number of the file as it is now). A stored copy of every note would roughly double the table for nothing. Trade-off: no `snippet()`; the per-file line matcher below replaces it.
- **Columns and weights** (bm25, in column order): `title` 10 (file name without extension), `headings` 5, `tags` 4, `props` 2 (frontmatter _values_, not keys), `body` 1 (note text with the frontmatter block removed). Keys and YAML punctuation never rank.
- **`.base` files are listed by name, always.** The FTS table has one row per note, so a `.base` file has no text hits. When `fuzzy` is on (first page, not case-sensitive) its full file name (`tasks.base`, so both `tasks` and `tasks.base` work) is matched on every search, not only when few notes match, and the hits (at most 10, `fuzzy: true`, no snippets) lead the page; the few-hits fallback stays notes-only. `.base` contents are not searched (open design question).
- **Same transaction, one write path.** `fts::write_doc` is called from `build::write_records` (scan and watcher updates), `fts::delete_files` is the only deletion path (it removes the FTS row first because there is no foreign key to cascade from). No triggers. Renames arrive as remove plus add. Tests cover edit, rename, delete, folder removal, row-id reuse and a warm refresh.
- **Size cap.** A note whose body is larger than `FTS_MAX_BODY_BYTES` (2 MiB) is indexed by title, headings, tags and props only, and `ScanStats.fts_body_skipped` counts it; no line snippets are produced for it.
- **Not indexed**: non-Markdown files, attachments, `.obsidian`, hidden paths and `node_modules` (the indexer already skips those).
- **Prefix indexes: `prefix='2'`, not `'2 3'`.** Measured on 3000 synthetic notes (about 8.7 MB of text, one transaction, debug build): `'2 3'` 8.1 MB / 291 ms insert, `'2'` 5.4 MB / 204 ms, none 4.1 MB / 127 ms. Prefix queries were sub-millisecond to 0.5 ms in every variant at that size. The 2-character prefix is the case that helps while typing the first letters; longer prefixes are narrow enough without an index. Revisit if real vaults show slow 3+ character prefixes.
- **`detail=full` and `columnsize=1` kept**: phrase queries need positions; bm25 needs the doc sizes.
- **CJK**: every ideograph, kana and Hangul syllable gets its own token (`fts::space_cjk`, applied to indexed text, queries and per-line matching), so a word inside a Japanese sentence is found and a CJK query is a phrase of adjacent characters. No trigram table: it would cost about 2.6x the text again for a feature the unigram trick provides. Limits: Thai, Khmer and other scripts without spaces are not segmented; CJK matching has no word boundaries (`京都` also matches inside a longer word); highlighted ranges of adjacent CJK characters are merged.
- **No stemming, no substring matching for other scripts.** `plan` does not find `planning` (use `plan*`); `ned` does not find `needle`. Diacritics and case are folded: `resume` finds `Résumé`.
- **Maintenance**: `Index::fts_maintenance(Optimize | IntegrityCheck)` runs on the writer thread. Defaults of `automerge` are kept. `rebuild` does not apply (there is no content to rebuild from); the repair path is deleting the database, which the open path already does on any integrity or version problem.

### Query language (`search_query.rs`)

User text is never FTS syntax. Every term is emitted as a double-quoted string with `"` doubled, the whole expression is _bound_ as a parameter, and all filters are bound SQL conditions. Whitespace separated:

| Input                  | Meaning                                                  |
| ---------------------- | -------------------------------------------------------- |
| `word`, `"a phrase"`   | positive terms, ANDed                                    |
| `word*`, `"a phrase"*` | prefix on the last token                                 |
| `-word`, `-"a phrase"` | exclude notes containing it                              |
| `a OR b`               | alternatives (uppercase; `AND` is implicit and optional) |
| `path:x`, `folder:x`   | path contains `x` (`path:"my dir"` for spaces)           |
| `file:x`               | file name contains `x`                                   |
| `tag:x`, `tag:#x`      | note has the tag (nested tags match ancestors)           |

`as_you_type` (palette only) makes a trailing bare word with no space after it a prefix. Terms without any letter or digit (`---`) are dropped. A query with no positive term matches nothing and is not an error. `NEAR`, `AND`, `NOT`, `^`, `:`, `(`, `)` inside text are data. Limits (explicit `Invalid` errors): 2000 characters, 64 terms. Invalid tags in `SearchOptions.tags` are an `Invalid` error; an invalid `tag:` filter inside the query matches nothing.

Differences from Obsidian's search language: no parenthesised groups, no regex inside the query (the CLI keeps `/regex/` as an explicit mode, see below), no `line:`/`section:`/`block:`/`content:`/`match-case:` operators, no `[property:value]` queries, no `file:` globbing, and whole-word matching instead of substring matching (use `word*`).

### API (`index/search.rs`, no tauri types)

`Index::search(query, &SearchOptions) -> SearchPage { total, hits, truncated }`. Options: `folder`, `tags` (all required), `limit` (default 30, max 10000), `offset`, `case_sensitive`, `snippet_len` (default 160 characters, `0` = whole lines), `max_snippets` (default 3 lines per hit, `0` = no file reads), `as_you_type`. A hit is `{path, title, folder, score, snippets[{line, text, ranges[[start,end]]}], stale}`; `score` is `-bm25` (higher is better), ties sort by path. Ranges are UTF-16 code unit offsets into `text`, so JavaScript can slice with them directly.

- **Line snippets come from the file on disk.** For each hit on the page the file is read, and its lines go through a throw-away in-memory FTS5 table with the _same tokenizer_ (`FTS_TOKENIZE`) that is queried with the positive terms ORed; `highlight()` markers (control characters, stripped from the text first) give the ranges, and the best `max_snippets` lines by line-level bm25 are returned in line order. This gives tokenizer parity (diacritics, prefixes, CJK) without reimplementing it. Line numbers are 1-based in the file as it is (frontmatter lines count, a leading BOM is ignored, CRLF is handled). A hit that matched only through the title, headings, tags, properties or a phrase spanning lines has no snippet.
- **Staleness is flagged, never hidden.** The file's content hash is compared with the indexed `body_hash`; a mismatch or a vanished file sets `stale` (line numbers are still those of the current text, and a stale hit may no longer contain the match). The watcher normally refreshes the row within moments; the CLI refreshes the index before every command. Only evaluated when snippets are requested.
- **`case_sensitive`** is a post-filter on the highlighted text: only ranges equal to the query's own spelling survive (prefix terms: starting with it), so it also makes diacritics significant. Because it needs file text for every candidate, at most `CASE_SCAN_CAP` (5000) ranked matches are examined (`truncated` says when more existed), then offset and limit apply to the filtered list and `total` is the filtered count.

### Tauri command and UI

- `index_search({ query, folder?, tags?, limit?, offset?, ... })` in `commands/index.rs`, workspace-scoped like the other index commands. While the cold build is running it fails with `the vault index is still being built; try again when it is ready`, the same message and semantics the Bases commands use (`ensure_ready` there is private to `commands/bases.rs`, so this is a copy of the check and the string; consolidate when that file is free).
- **"Search in notes"**: a palette intent (`search-notes`) with its own dialog (`ContentSearchPalette`, selected by a three-line wrapper in `command-palette/index.tsx`), reachable from the palette command "Search in Notes" and **Cmd+Shift+F** (Ctrl+Shift+F elsewhere); free of conflicts (Cmd+F is the editor's find; nothing else binds Shift+F). Not available in the compact window (no workspace).
- 150 ms debounce, at least 2 characters, a ticket counter so only the newest request can write state. States: hint (too short), "Searching…" (previous results stay while a refinement loads), "No matches", "Index is being built…" (re-runs when a full `index://changed` arrives), and an alert with the error. Results show the title, folder and up to three matched lines with the match in `<mark>` React nodes (never HTML).
- Enter opens the note in the current tab, Cmd/Ctrl+Enter in a new tab, ArrowUp/Down move (cmdk), Escape closes. The first matched line is selected and scrolled into view after opening: `lib/pending-anchor.ts` got a line sibling (`setPendingLine`/`consumePendingLine`) consumed by `use-prosemark-editor.ts` on mount and on swap, like heading anchors; a note that is already showing is revealed directly (`components/editor-area/reveal-line.ts`).

### CLI (`writer search`, `writer search:context`)

Parameters are unchanged: `query= path= limit= format=text|json` and flags `total`, `case`. Everything except `/regex/` runs on the FTS index, best match first; the old path-ordered substring scan is gone. `search` lists files (name or text matches, ranked); `search:context` prints `path:line: text` for every matching line of each ranked file, `limit=` counts lines. `query=/regex/` keeps its previous meaning as an explicit regular-expression scan (regex-lite, no lookaround) in path order, because the documented behaviour must not silently disappear. Because the argument parser strips one layer of surrounding quotes from a value, a phrase is written `query='""two words""'` (outer pair stripped, inner pair kept). Differences from before: whole words (or `word*`) instead of substrings, ranking instead of path order, frontmatter values are searchable, and the query language above.

## Tests

Rust (`index/search_tests.rs`, `index/search_query.rs`, `cli/tests.rs`, synthetic temp vaults): FTS5 availability, ranking order, phrase/prefix/exclusion/OR/filters, diacritics, CJK tokens and UTF-16 ranges, snippet line numbers with frontmatter and windowing, sync on edit/rename/delete/folder delete/row-id reuse/warm refresh, stale flag, case post-filter, 2 MiB cap, schema-bump rebuild, maintenance commands, an arbitrary-input fuzz (1500 random strings, with and without `case_sensitive`, must never error), CLI goldens for text, json and `search:context`. TypeScript (`tests/content-search.test.tsx`): range splitting and HTML safety, debounce, stale-response protection, every state, retry on full index change, Enter and Cmd+Enter, palette command registration.

## Performance (perf smoke test, `perf_smoke_cold_build_and_query_latency`)

3000 synthetic notes of about 3 KB each (8.7 MB of text, 30 folders, frontmatter and a heading), run with `cargo test --release --lib perf_smoke -- --nocapture` (release optimisation, LTO off; the SQLite C code is compiled at the profile's optimisation level, so a plain debug `cargo test` is up to 4x slower on queries and 2x on the build). The test builds the same vault twice, once with the FTS rows suppressed (a test-only switch), and prints the numbers; its asserts are generous (builds under 60 s, queries under 1.5 s).

| Measure                                               | Release                            | Debug test build               |
| ----------------------------------------------------- | ---------------------------------- | ------------------------------ |
| Cold build without FTS rows                           | 60-180 ms                          | 130-190 ms                     |
| Cold build with FTS rows                              | 535-545 ms                         | 0.98 s                         |
| `optimize` afterwards                                 | 82 ms                              | 128 ms                         |
| Database size without / with FTS                      | 1.2 MB / 9.3 MB                    | 1.2 MB / 9.3 MB                |
| FTS tables, before / after `optimize`                 | 8.2 MB / 8.0 MB                    | 8.2 MB / 8.0 MB                |
| Query, one common word (595 of 3000 notes)            | 3.5 ms                             | 14 ms                          |
| Query, two words / phrase / exclusion / `tag:` filter | 3.0 ms / 0.15 ms / 3.0 ms / 3.0 ms | 13 ms / 0.4 ms / 13 ms / 12 ms |
| Query, rare word (1 hit, with snippet)                | 0.2 ms                             | 0.7 ms                         |
| Prefix `wef*` (2299 hits)                             | 4.3 ms                             | 16 ms                          |

Reading: the cold build is dominated by the FTS inserts (about 0.15 ms per 3 KB note); the index adds roughly 0.95x the text size (the prefix index and positions are the bulk). Incremental updates stay in the millisecond range (the existing `perf_smoke_3000_notes` incremental figure is unchanged at about 1.3 ms for one note). `optimize` is not run automatically after the cold build: it saves about 3 percent here and would hold the writer thread for seconds on very large vaults; `Index::fts_maintenance(Optimize)` exists for a later idle-time hook. Search costs are per page: snippet extraction reads and indexes the lines of at most `limit` files.

## Decisions that differ from the parallel research note

- **Contentless-delete instead of a regular table.** The note recommends a regular table so `snippet()` works; here the text for snippets must come from disk anyway (line numbers, staleness), so the stored copy would be pure cost.
- **`prefix='2'` instead of `'2 3'`**, from the measurement above.
- Query `OR` is supported with explicit parentheses instead of being left out.
- Same conclusions otherwise: `unicode61 remove_diacritics 2`, no porter, CJK spacing instead of a custom tokenizer or trigram, quoting every term, bound parameters, `ORDER BY` on negated bm25, filters as SQL, 2 MiB-class cap, drop-and-rebuild as the repair path.

## Not verified

- No real window run: the palette, the shortcut, the focus return after the dialog closes and the line reveal in the live CodeMirror editor are covered by jsdom tests and code reading only. The pending-line hand-off has three paths (new editor mount, document swap in the same tab, already-open note); only the pure parts are unit tested.
- Ranking quality on real notes (weights are a starting point; tune on a real vault).
- Behaviour with a very large vault (100k notes): size, cold-build time and the cost of `optimize` are extrapolations from 3000 notes.
- The accessibility of the dialog follows the existing palette (cmdk + Radix); Radix warns that the dialog has no `Description`, as the existing palette does.
