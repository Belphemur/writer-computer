# File-name links and `writer rename` Spec

Decision: [ADR](../docs/decisions/2026-11-16-links-resolve-by-file-name-and-rename-rewrites-links-through-one-rust-function.md).

## Summary

A note is addressed by its **file name**, never by its title. `[[Name]]` resolves to the file called `Name.md` wherever it lives; the note's frontmatter `title:` and first `# Heading` take no part in link resolution, backlinks, the index or the CLI. The same rule is used by every consumer (index, `writer`, Bases, editor, plugin host). On top of it, `writer rename` / `writer move` and the app's sidebar rename rewrite every link to the file so nothing breaks.

## What Obsidian documents (public pages only)

Sources: <https://obsidian.md/help/links>, <https://obsidian.md/help/aliases>, <https://obsidian.md/help/cli>, the public `obsidian.d.ts` (`getFirstLinkpathDest`, `getLinkpath`, `FileManager.renameFile`, `generateMarkdownLink`) and the "Files and links" settings page.

1. A link points at a note by name: `[[Three laws of motion]]` is `[[Three laws of motion.md]]`. Other file types need their extension (`[[Figure 1.png]]`). A path-qualified link starts at the vault root with forward slashes.
2. Aliases are for suggestions and insertion (picking one inserts `[[Real Note|alias]]`). No page uses a heading or a `title` property to resolve a link.
3. `[[Note#Heading]]`, `[[#Heading]]` (same note), `[[Note#^block-id]]` (id: letters, digits, dashes); `# | ^ : %% [[ ]]` do not work inside a target.
4. Markdown-link destinations are URL-encoded (`%20`) or written in `<...>`.
5. Renaming updates internal links when "Automatically update internal links" is on.
6. CLI: `rename file=<name> path=<path> name=<name>` (`name` required; no extension keeps the extension) and `move file=<name> path=<path> to=<path>` (destination folder or path; also the way to rename and move at once). `file=` resolves like a wikilink, `path=` is exact from the vault root. Both default to the active file in Obsidian; Writer has no active file, so one of `file=`/`path=` is required.

Not documented publicly (so a deterministic rule is chosen here, to be re-checked against Obsidian if its behaviour is ever observed through public means): case sensitivity, duplicate-name tie-breaking, shortest-path versus relative link format. Chosen: case-insensitive name match; with several matches the closest folder wins (most leading folders shared with the linking note), then the fewest path components, then the shortest path, then alphabetical. Newly written links use the shortest unambiguous form for bare links, and keep path-qualified / relative links in their original style.

## Where a "title" drove behaviour (investigation)

A note's title can come from frontmatter `title:` then a leading `# Heading` (`commands/fs.rs::extract_title` for the sidebar, `lib/frontmatter.ts` for tabs). File name stem and title disagree whenever either exists and differs.

| Area                                                                                                                                              | Used                                                                                      | Status                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Index `files.basename`, FTS `title` column, `SearchHit.title`                                                                                     | file stem (never the H1/frontmatter title)                                                | already file-name based; H1 is in the `headings` FTS column, frontmatter text in `props`; bm25 weights `title 10, headings 5, tags 4, props 2, body 1`, so a name match outranks all of them (test added) |
| Index `links`, backlinks, unresolved, orphans (`index/build.rs`, `index/resolve.rs`)                                                              | `PathIndex::resolve`, file name                                                           | already file-name based; tests added                                                                                                                                                                      |
| `writer` `file=`, `links`, `backlinks`, `unresolved`                                                                                              | `Index::resolve_link` (same resolver)                                                     | already file-name based                                                                                                                                                                                   |
| Bases `file.name`, `link()`, `file.hasLink()`                                                                                                     | path basename, `RowContext::resolve_link` (same resolver)                                 | already file-name based                                                                                                                                                                                   |
| Quick open / `fuzzy_search` / `find_file_by_name` (`index/names.rs`)                                                                              | file path/name                                                                            | already file-name based; file-name match ranks above folder match                                                                                                                                         |
| **TS `resolveWikiLink` (editor click, property links, base cells, base embeds)**                                                                  | its own copy: `fuzzy_search` by stem, duplicate = unresolved, path link = exact path only | **changed**: calls the Rust resolver (`resolve_wiki_link` command), so duplicates, partial paths and attachments behave like backlinks                                                                    |
| **Plugin host `getFirstLinkpathDest`** (`obsidian-host/api/vault.ts`)                                                                             | in-memory copy; tie-break only "same folder" first                                        | **changed**: same tie-break as the Rust resolver                                                                                                                                                          |
| Sidebar label, compact recents, command-palette filter, tab/window title (`use-file-tree-label.ts`, `editor-tabs`, `editor-store` `parsed.title`) | `title` (frontmatter / H1) falling back to the stem                                       | **left as is** (display only, not resolution); command-palette filter also matches the title                                                                                                              |
| `read_directory(titles)` (`commands/fs.rs`)                                                                                                       | `extract_title`                                                                           | display only; left                                                                                                                                                                                        |
| Editor `[[` autocomplete                                                                                                                          | `fuzzy_search` (file name); inserts the stem, or the vault path when stems collide        | already file-name based                                                                                                                                                                                   |
| `![[image]]` resolution (`resolveWikiImage`)                                                                                                      | probes next to the note, then `find_file_by_name` (shallowest, alphabetical)              | left; differs slightly from the nearest-folder rule on duplicates                                                                                                                                         |

The index schema did not change (the stored data was already file-name based), so there is no `SCHEMA_VERSION`/`PARSER_VERSION` bump and no rebuild on first launch.

## Resolution rules (`index/resolve.rs`)

1. Empty target (`[[#Heading]]`) is the note itself. `./x` and `../x` are relative to the note.
2. Exact vault path, case-insensitive, `.md` optional; Markdown links are tried relative to the note first.
3. A target with `/` matches files whose path ends with it (`b/c` matches `a/b/c.md`).
4. A bare name matches a Markdown file's name without `.md`, or any file's full name (`photo.png`, `x.base`).
5. Several matches: closest folder, fewest components, shortest path, alphabetical. No match: unresolved.
6. `#Heading`, `#^block` and `|alias` are split off before resolution.

## `writer rename` and `writer move`

`rename file=<name>|path=<path> name=<new>` and `move file=|path= to=<folder-or-path>` (both existed; this change makes them safe and complete).

- Flags: `dry-run` (print the plan: renamed path, files and link counts; write nothing), `no-update-links` (move only). `format=json` prints `{from,to,dryRun,links,files,skipped,edits[{path,links}]}`. Exit codes: 0 ok, 1 failure/validation, 2 usage.
- Name rules (`relocate::validate_file_name`): non-empty, no leading/trailing space or trailing dot, at most 255 bytes, none of `* " \ / < > : | ? # ^ [ ]` or control characters, not hidden (leading dot), not a Windows reserved name; the extension is kept when `name=` has none. Refuses to overwrite, to leave the vault and to touch `.obsidian`/`.git`.
- Referrers are the index's backlinks of the file, the file itself (its relative links follow it) and every `.base`; each candidate is re-read and every link re-resolved before and after the move, so a stale index row can only miss a file, never cause a wrong edit.
- Rewritten: `[[Old]]`, `[[Old|alias]]`, `[[Old#H]]`, `[[Old#^b]]`, `![[Old.png]]`, `[[folder/Old]]` (stays path-qualified), `[x](Old.md)`, `[x](folder/Old%20Name.md)`, `[x](<folder/Old Name.md#H>)`, wikilink values in frontmatter properties, `[[...]]` and `link("...")`/`file("...")` literals in `.base` files. A bare link stays bare while it still resolves to the file, otherwise it becomes path-qualified. Links in code spans, fences, URLs and links that did not resolve to the file are untouched. Edits are byte-minimal splices.
- All-or-nothing: plan (no write) -> verify no referrer changed since planning -> stage every new text in a hidden temp file next to its target -> move the file (a case-only rename goes through a temporary name) -> commit the staged files by atomic rename -> write the moved note's own rewrite. An I/O error undoes what was done; if something cannot be undone the error lists exactly which files were rewritten and whether the file moved.
- App: `relocate_entry` (Tauri, `blocking`) runs the same `relocate::plan/apply` for the sidebar rename and drag-move of a **file**; folders and the plugin host's `vault.rename` keep the plain `rename_entry`. While the cold index build runs the file is moved without link updates (a partial link graph would miss referrers) and a warning is logged. The watcher picks the rewrites up; they are deliberately not marked as self-writes so open tabs reload.

## Tests

Rust: `index/resolve.rs` (case, duplicates, path-qualified, extension, unicode, spaces, alphabetical tie), `index/search_tests.rs` (title column = stem, links independent of H1/frontmatter title, file-name rank first), `relocate/linkfix.rs` and `relocate/tests.rs` (plan/apply, validation, collisions, stale referrer, staging failure, moved note's own links), `cli/tests.rs` (every link form, dry-run, JSON, opt-out, collisions, case-only, attachments, duplicates, idempotence). TS: `tests/wiki-links.test.ts`, `tests/bases-page-kind.test.ts`, `tests/obsidian-host-vault.test.ts`.

## Known limits

- Renaming a file can make an existing bare link to _another_ file with the new name resolve differently (closest-folder rule); not detected.
- Folder rename/move does not rewrite links to the files inside.
- Referrers that are `.canvas`, JSON or other non-Markdown, non-base files are not rewritten.
- A referrer open in a tab with unsaved edits is rewritten on disk; the usual external-change handling applies.
- Backlinks come from the index; a note edited less than the watcher debounce ago may not be listed yet.
