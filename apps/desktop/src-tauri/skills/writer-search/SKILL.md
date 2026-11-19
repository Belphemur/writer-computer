---
name: writer-search
description: Search the text of a vault with the `writer` CLI (full-text, ranked, with tag/path/file/kind/ext filters): notes, PDFs, code files and drawings. Use when the user asks to find notes, mentions, phrases, lines or a PDF's contents in the vault, or when you must locate where something is written before reading or editing it. Also use to decide between full-text search and the cheaper property, tag, link and file queries.
---

# Searching a vault with Writer

Two commands query the vault's full-text index (SQLite FTS5). Both are read-only. See the `writer-cli` skill for the general grammar, vault selection and exit codes.

```
writer search query=<query> [path=<folder>] [limit=<n>] [format=text|json] [total] [case]
writer search:context query=<query> [path=<folder>] [limit=<n>] [format=text|json] [case]
```

- `search` lists matching **files**, best match first (one path per line, or a JSON array of paths with `format=json`). `total` prints only the number of matching files. `limit=` caps files.
- `search:context` lists matching **lines** as `path:line: text`, best file first. JSON is an array of `{path, line, text}`. `limit=` caps lines, so it is the one to use before editing: the line numbers let you read just the right region. A PDF hit has a page instead of a line (`path:p3: text`, JSON `{path, page, text}`), and a drawing's text has neither (`path: text`).
- `path=<folder>` restricts to a folder (a vault-relative folder, not a pattern). The in-query `path:` filter below is different: it matches anywhere in the path.
- What is searched is the vault's listed files by **kind**: `note` (Markdown), `pdf` (the text of the pages, plus the document title), `code` (the text files the code-files setting lists), `drawing` (the text of an Excalidraw drawing's elements). `image` and `base` files are found by name only, and a PDF that is encrypted or damaged is found by name only. Hidden folders, `.obsidian`, secret-looking names (`.env`, `secrets.yaml`) and other attachments are not searched.

## Query syntax

Terms are separated by spaces and ANDed. Matching is by whole word, case-insensitive, and folds accents (`resume` finds `Résumé`).

| Write                     | Meaning                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `word`                    | notes containing the word                                                                                                                                       |
| `"two words"`             | the exact phrase                                                                                                                                                |
| `plan*`                   | prefix: `plan`, `planning`, `plans` (there is no stemming)                                                                                                      |
| `-draft`, `-"old name"`   | exclude notes containing it                                                                                                                                     |
| `alpha OR beta`           | either (`OR` must be uppercase; `AND` is implicit)                                                                                                              |
| `tag:project`, `tag:#a/b` | notes with that tag; nested tags match their ancestors                                                                                                          |
| `path:Projects/2025`      | note path contains the text (`folder:` is a synonym; quote it if it has spaces: `path:"my dir"`)                                                                |
| `file:recipe`             | file name contains the text                                                                                                                                     |
| `kind:pdf`, `-kind:code`  | only (or not) that file kind: `note`, `pdf`, `code`, `drawing`, `image`, `base`; repeat to allow several; an unknown kind is an error that lists the known ones |
| `ext:py`, `-ext:md`       | only (or not) that file extension, without the dot; repeat to allow several                                                                                     |
| `/regex/`                 | the whole query is a regular expression scan (see below)                                                                                                        |

Rules and limits:

- No parentheses or nesting, no `line:`/`section:` operators, no `[property:value]` queries. Words like `NEAR` or `:` inside text are plain data.
- A query with only exclusions or filters (`-draft`, `kind:pdf`) matches nothing (it is not an error): add a word. Punctuation-only terms are dropped.
- At most 2000 characters and 64 terms; beyond that it is an error (exit 1).
- Title matches rank highest, then headings, tags, property values and body text.
- `case` makes spelling exact (and accents significant). It examines at most the 5000 best matches.
- `/regex/` (the query starts and ends with `/`) scans note text and file names line by line in path order, case-insensitive unless `case` is given. It has no lookaround. It covers Markdown notes only; use it only when words and prefixes cannot express the pattern.

## Quoting for the shell and the CLI parser

The shell removes your outer quotes, then Writer strips **one more pair** of quotes if the value both starts and ends with the same quote character. So a query that begins and ends with a double quote (a lone phrase, or `"a" OR "b"`) would lose its quotes. Wrap the whole query in one extra pair of double quotes:

```
writer search 'query=""exact phrase""'                 # one phrase
writer search 'query=""red fox" OR "blue fox""'        # starts and ends with a phrase
writer search 'query=tag:project "exact phrase"'       # starts with a letter: no extra quotes needed
writer search:context 'query=-draft meeting*' path=Projects limit=20
writer search 'query=quarterly budget kind:pdf'        # only PDFs
writer search:context 'query=parse_config kind:code'   # only code files
```

When in doubt, run `writer search:context` and check that the hits contain the phrase.

## Choosing the right query

Use the cheaper, exact commands when the question is structured:

- Notes with a tag: `writer tag name=project verbose`, or `tag:project` inside a search to combine with words.
- A frontmatter value of one note: `writer property:read file=Recipe name=status`; the property names in use: `writer properties counts`.
- Files by name or folder: `writer files folder=Projects`, or `file:name` in a search.
- Who links to a note: `writer graph:backlinks file=Recipe format=json`; unlinked mentions are a search for the file name. A note's name is its file name: `[[Recipe]]` links to `Recipe.md`, never to a note that merely has `title: Recipe` or a `# Recipe` heading (those are searchable text, ranked below file-name matches).
- Open tasks: `writer tasks todo verbose`.
- Filtered tables over many properties: a base view, see the `writer-bases` skill.

Use search for words, phrases and anything in the body.

## Reading results

- Paths are vault-relative with forward slashes; pass them back as `path=`.
- Lines come from the file as it is on disk now. If a note changed after the index was updated, stderr carries `writer: <path> changed while searching; lines are current` and that hit may no longer contain the match: re-run the search or read the file.
- Many hits: add `limit=`, narrow with `path=`, `tag:` or `-exclusions`, or use `total` first to see the size.

## Index state and errors

The CLI refreshes the vault index before it answers, so results reflect the files on disk. The first run in a large vault, or after many changes, can take a moment.

- `writer: the vault index is busy (the Writer app may be scanning this vault); try again in a moment` (exit 1): another process holds the index. Wait a few seconds and retry; do not retry in a tight loop.
- Writer's own in-app search reports `the vault index is still being built; try again when it is ready` while the first scan runs. The CLI does not return that message, but the cause is the same: wait and retry.
- A usage error (exit 2) means a bad parameter or an empty `query=`. `limit=` must be a number.
- If a search surprisingly finds nothing, check the vault (`writer vault`), that you are not searching with `case` or a too-narrow `path=`, and that the word is a whole word (use `word*`).
