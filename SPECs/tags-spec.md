# Tags Spec

## Summary

Add lightweight tag support: users can write `#tag` inside markdown documents and Writer will index, render, and let them browse documents by tag.

## Goals

- Recognize `#tag` tokens in markdown body text.
- Index tags per document for fast lookup.
- Render tags as styled chips in the editor.
- Provide a tag browser (sidebar section or dedicated view) listing all tags and their documents.
- Support clicking a tag to filter the workspace by it.

## Non-Goals

- A new tags pane: none exists, so none is built for the hierarchy (the list shows parent counts through `writer tags counts`).
- Tag autocomplete inside the editor in v1 (follow-up).
- Renaming tags across the workspace in v1.

## Tag Recognition Rules

A tag is `#` followed by 1+ letters, digits, `_`, `-` or `/` (Unicode letters allowed, not all digits, no leading or double `/`; a trailing `/` is trimmed, so `#a/` is the tag `a`).

Tags do not match when:

- inside fenced code blocks
- inside inline code spans
- inside frontmatter
- as part of a URL fragment (e.g., `https://...#section`)
- preceded by anything but the line start, whitespace or one of `([{,;:"'` (so `a#b` and `a#fff` do not match; `color: #fff` does, as in Obsidian)

## Nested tags

Obsidian-compatible (public docs: https://help.obsidian.md/tags#Nested+tags). `#research/hlo/docs`, or `tags: [research/hlo/docs]` in frontmatter, is one tag with segments `research`, `hlo`, `docs`. Tags are case-insensitive and stored lowercase.

**One rule: a query tag matches a note when the query equals the note's tag or is a whole-segment prefix of it.** `research` and `research/hlo` match `research/hlo/docs`; `res`, `research/h` and `researcher` do not.

**One place:** the indexer (`index/note.rs`, through `markdown::with_ancestors`) stores every ancestor of a nested tag as its own `tags` row, so an equality lookup on `tags.tag` is the prefix rule and every consumer shares it with no per-caller prefix logic: `Index::tag_files` and `FileFilter.tag` (`index/query.rs`), Search `tag:` and the `tags` option (`index/search.rs`), `writer tag` / `writer tags` and `writer search tag:` (`cli/`), the Bases pushdown (`index/bases_source.rs`), and the agent project `#tag` sources (they call the same queries). `Index::tags()` counts files per tag with descendants included, so a parent's count includes its children. The one consumer that does not read the index is the Bases interpreter's `file.hasTag(...)` (`bases/functions.rs`, any-of, per the Bases docs "nested tags match"), which sees the file's tags as written and applies the same whole-segment prefix test; a differential Bases test checks both paths agree. `file.tags` and the Obsidian host's `getAllTags` list tags as written, like Obsidian (no ancestors).

Tests: the shared fixture `index::NESTED_TAG_NOTES` (`#research/hlo/docs`, frontmatter `Research/HLO`, `#Research`, `#researcher`) drives the index, Search, CLI and Bases tests.

## Indexing

- Index tags per file in the existing workspace index.
- Recompute on file save and on watcher updates.
- Expose a Rust command `list_tags() -> Map<tag, file_paths[]>`.

## UX Decisions

### Editor

- Tags render as small chips with a subtle background.
- Clicking a tag opens the tag browser filtered to that tag.

### Browser

- A sidebar section labeled `Tags` lists every tag with a document count.
- Selecting a tag opens a results pane (or filters the file tree) showing matching documents.

## Implementation Notes

- Add a Rust `tags.rs` module with parsing helpers and an index.
- Reuse the existing markdown parser when possible to skip code/frontmatter regions.
- Frontend ProseMirror plugin renders the inline tag chip decoration.
- Add `useTagIndex()` hook for the browser.

## Files Expected To Change

- `apps/desktop/src-tauri/src/tags.rs` (new)
- `apps/desktop/src-tauri/src/state.rs`
- `apps/desktop/src-tauri/src/commands/`
- `apps/desktop/src/components/editor-area/use-prosemark-editor.ts`
- new `apps/desktop/src/components/tag-browser.tsx`
- new `apps/desktop/src/hooks/use-tag-index.ts`
- frontend and Rust tests

## Acceptance Criteria

- Writing `#draft` in a document renders as a styled tag chip.
- The Tags browser lists every tag in the workspace with the documents that contain it.
- Clicking a tag in the editor opens the browser filtered to that tag.
- Tags inside code blocks and frontmatter are ignored.

## Inline tags in the UI (decided with the user, 2026-11-23)

The index already treats body `#tags` as the note's tags (`index/markdown.rs` `scan_tags`, merged in `index/note.rs`): search `tag:`, Bases `file.hasTag`/`file.tags`, the graph, `writer tags`. What this adds is the UI, in Obsidian's spirit:

- **Pill.** Outside the cursor or selection, a body `#my-tag` renders as a rounded pill in the property chip style (`property-chip.tsx` `CHIP`), `#` kept. When the cursor or selection touches it, it shows the raw text, like links and headings. Same recognition as the index: never in fences, inline code, front matter, URLs or headings' `# `, never all digits, nested `a/b` allowed.
- **One rule, two sides.** The TS recogniser mirrors `normalize_tag`/`is_tag_char`/`scan_tags` and is pinned to Rust by shared vectors (`shared/tag-vectors.json`, read by both test suites), like `task-vectors.json`. The spec's "trailing `/` is rejected" is corrected to what the index does and the vectors pin: a trailing `/` is trimmed. The TS recogniser is `src/lib/tags.ts` (`scanLineTags` for one line, `scanTags` for a body with its fences); the editor decoration is `components/editor-area/tag-decorations.ts` (a mark over the text, not a widget; fences from the syntax tree, everything else from the line scan).
- **Click.** Opens search for `tag:my-tag` (nested tags match). It goes through the one link-activation implementation (`tagLinkTarget` in `src/lib/link-activation.ts`). Search is the content-search palette, not a tab, so every gesture (left, middle, Cmd/Ctrl+click) opens that same palette seeded with `tag:my-tag `; there is no background tab to open. A click with a modifier never moves the cursor into the pill. To edit it, move the cursor in with the keyboard, or click its end.
- **Properties panel.** The tags row shows the YAML tags (editable, as today), then the note's body tags that are not already in YAML. These are read-only, in a quieter chip, with the tooltip "In the note". They come from the open buffer, so they update as the user types and do not wait for the index. A click on one searches the tag, like the pill. The row shows when the note has front matter (the panel is not drawn otherwise); with no YAML tags the body tags get a `tags` row of their own.
- **Not in scope:** tag autocomplete, renaming a tag across the vault, a tags browser or page.

- **Filter-only search.** A query made only of filters (`tag:my-tag`, `kind:pdf`, `path:x`) lists every matching file instead of nothing (`Index::search`, `filter_only`): opened files first, then newest modified (`rank::empty_query_key`, the one ranker's order), the same limit, offset and page shape as a text search (no snippets, score 0). An empty query, or one with only exclusions, still matches nothing.
