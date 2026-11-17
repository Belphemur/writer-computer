# Search Ranking Spec

## Summary

Quick open (`Cmd+P`) and "Search in notes" (`Cmd+Shift+F`) rank by text relevance **and** recency, and tolerate typos. One scoring module, one set of test vectors, so rankings stay consistent between the Rust backend and the TypeScript palette.

## Goals

- A recently opened (viewed) or recently modified (updated) file ranks higher, smoothly, between comparably good matches. A clearly better text match still wins over a stale or recent weak one.
- Typo-tolerant and subsequence matching on file names: `frlam` or `Francios Lamare` finds `François Lamarre`. Diacritics and Unicode normalization form (NFC/NFD) never matter.
- An empty query in quick open lists recent files: opened first (newest open first), then newest modified.
- Full-text search gets the same recency boost, and when few notes match exactly it appends similar notes (typos in names, headings and tags).

## Non-goals

- Fuzzy matching of note bodies (the FTS5 query stays exact, with the existing last-word prefix for as-you-type).
- Matching titles or aliases in quick open: links resolve by file name only (`filename-links-and-rename-spec.md`).
- Settings for the knobs: they are constants (below). Cheap to promote to `settings.schema.json` later.
- The `writer search` CLI: unchanged (exact, bm25 order); `SearchOptions.recency`/`fuzzy` default to off.

## Where it lives

| Piece                                                                  | File                                                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Scorer, recency, all tunables (Rust, the source of truth)              | `src-tauri/src/index/rank.rs`                                                             |
| TypeScript twin (compact window recents; palette helpers)              | `src/lib/search-rank.ts`                                                                  |
| Shared vectors, asserted by both                                       | `shared/search-rank-vectors.json`                                                         |
| Quick open (name cache, `fuzzy_search`, empty query = recents)         | `index/names.rs`, `commands/search.rs`                                                    |
| Full-text re-rank and fuzzy fallback (`SearchOptions.recency`/`fuzzy`) | `index/search.rs`, `commands/index.rs`                                                    |
| Opened history                                                         | `commands/recents.rs` (`opened_under`: global `recent_files.json`, filtered to the vault) |

Opened history is the app's existing recents list (30 entries, `opened_at`); modification time is `files.mtime` from the index.

## Text score (per file)

Query and path are folded: NFD, combining marks removed, lowercase, `_` and `-` become spaces. The query is split on whitespace; every word must match (any order); the file's score is the sum of the word scores plus whole-query bonuses.

Per word, against the file name stem (no extension) and, at weight `PATH_FACTOR = 0.5`, the whole path; the better wins. A word containing `/` matches the path only.

- Subsequence (words of 3+ chars; shorter words must be a contiguous substring), best alignment by dynamic programming:
  - each matched char: `MATCH 16` + the char's bonus
  - bonus: `BOUNDARY 14` after a non-alphanumeric char (word start), plus `NAME_START 10` at the start of the string; `CAMEL 10` on a lower-to-upper transition
  - `CONSECUTIVE 12` when the char directly follows the previous match
  - gap: `GAP_OPEN 6` + `GAP_EXTEND 2` per extra skipped char; leading offset `1` per char (cap 5)
- Typo fallback when the word is not a subsequence (words of 5+ chars): optimal-string-alignment (Damerau) distance to a whole path word or to that word's leading chars; at most 1 edit for 5-7 chars, 2 for 8+. Score `10 * len - 14 * edits + word-start bonus`, scaled by `PATH_FACTOR` for folder words. Always below a clean subsequence match.
- Whole query: stem equals the query `+120`, stem starts with it `+40`, coverage `+10 * min(1, queryChars / stemChars)`.

## Recency

```
boost = 0.5 * 0.5^(daysSinceOpened / 3)  +  0.3 * 0.5^(daysSinceModified / 5)      (range 0 .. 0.8)
rank  = text * (1 + boost)
```

`OPENED_HALF_LIFE_DAYS = 3`, `MODIFIED_HALF_LIFE_DAYS = 5`, `OPENED_WEIGHT = 0.5`, `MODIFIED_WEIGHT = 0.3`, all in `rank.rs` (twin: top of `search-rank.ts`). Multiplicative, so an exact stale name (about 360) beats a recent weak fuzzy match (about 100 times at most 1.8), and between equal text scores the recent file wins. Equal ranks sort by path, so results are deterministic. Quick open's `score` field is `round(rank * 10)`.

## Full-text search

- `SearchOptions.recency`: fetch the best `max(offset + limit, 200)` bm25 hits, multiply each score by `1 + boost`, re-sort (ties by path), then page. bm25 is scale-free, so a hit with much better bm25 outranks a recent weak one.
- `SearchOptions.fuzzy`: only on the first page. `.base` files (no text row) are name-matched on every search and lead the page (see `search-spec.md`); notes are appended only when fewer than 5 notes match exactly. The query's words are matched with the same scorer against each note's file name and, at weight 0.6, its headings and tags; hits need at least `11` text score per query char, exclude notes already found, rank with the recency boost, and are appended (at most 10), flagged `fuzzy: true` with no snippets. The palette labels them "similar name".
- The palette sets both flags; the CLI does not.

## Tests

- `rank.rs`: shared vectors, tier ordering, short words, NFC/NFD, highlight indices, recency decay, 10k-name timing (budget 50 ms in release).
- `names.rs`: ranking, typos, recency, empty query. `search_tests.rs`: recency tie-break, recency does not beat a much better match, fuzzy fallback; `perf_fuzzy_10k` (ignored) measures 10k notes.
- `tests/search-rank.test.ts` (same vectors), `tests/palette-ranking.test.tsx` (empty query shows recents first, typed query keeps backend order).

## Measured (release, 10k synthetic notes, this machine)

Name ranking 10k names: under 50 ms (asserted). Full-text fuzzy fallback: about 22 ms; recency re-rank: about 5 ms.
