# Writer CLI command reference

One bullet per command: `required` parameters are marked, everything else is optional. Flags are bare words. `file=` and `path=` select the target note (one of them). Run `writer help <command>` for the authoritative text.

## Vault

- `vault` — show the current vault. Params: `info=` (name, path, files, folders or size; one value only).
- `vaults` — list the vaults Writer knows (recent workspaces). Flags: `total`, `verbose`.

## Files

- `files` — list files, one path per line. Params: `folder=`, `ext=`. Flags: `total`.
- `file` — information about one file. Params: `file=`, `path=`.
- `folders` — list folders that contain files. Params: `folder=`. Flags: `total`.
- `folder` — information about a folder. Params: `path=` (required), `info=` (files, folders or size).

## Content

- `read` — print a file's raw text. Params: `file=`, `path=`.
- `create` — create a note (`.md` is appended; no name gives `Untitled`). Params: `name=`, `path=`, `content=`, `template=` (a note whose text is the starting content). Flags: `overwrite`, `open`, `newtab` (the last two are accepted and ignored).
- `append` — add text at the end of a file, or of a section. Params: `file=`, `path=`, `content=` (required), `heading=`. Flags: `inline` (no newline between old and new text).
- `prepend` — insert text after the frontmatter, or right after a heading. Params: `file=`, `path=`, `content=` (required), `heading=`. Flags: `inline`.
- `move` — move (and optionally rename) a file and update links to it. Params: `file=`, `path=`, `to=` (required; destination folder or path), `format=` (text or json). Flags: `dry-run` (print the plan, change nothing), `no-update-links` (do not rewrite links to the file (they are updated by default)).
- `rename` — rename a file and update links to it. Params: `file=`, `path=`, `name=` (required; the extension is kept if omitted), `format=` (text or json). Flags: `dry-run` (print the plan, change nothing), `no-update-links` (do not rewrite links to the file (they are updated by default)).
- `title` — show, set or clear a note's display title (the title property); the file is not renamed. Params: `file=`, `path=`, `set=` (new display title (links showing the old title follow)), `format=` (text or json). Flags: `clear` (remove the title property (the note shows its file name)), `dry-run` (print the plan (files and link counts) and change nothing), `no-update-links` (do not rewrite links that show the old title as their alias).
- `delete` — move a file to the trash. Params: `file=`, `path=`. Flags: `permanent`.

## Search

- `search` — files whose text or name matches, best match first. Params: `query=` (required), `path=` (folder), `limit=`, `format=` (text or json). Flags: `total`, `case`.
- `search:context` — matching lines as `path:line: text`. Params: `query=` (required), `path=` (folder), `limit=`, `format=` (text or json). Flags: `case`.

## Properties

- `properties` — list properties of one file, or of the vault with counts. Params: `file=`, `path=`, `name=`, `sort=` (count), `format=` (yaml, json or tsv). Flags: `total`, `counts`.
- `property:set` — set a frontmatter property. Params: `name=` (required), `value=` (required), `type=` (text, list, number, checkbox, date or datetime), `file=`, `path=`.
- `property:read` — print a property value. Params: `name=` (required), `file=`, `path=`.
- `property:remove` — remove a property. Params: `name=` (required), `file=`, `path=`.
- `aliases` — list aliases. Params: `file=`, `path=`. Flags: `total`, `verbose`.

## Tags

- `tags` — list tags (lowercase, `#tag`). Params: `file=`, `path=`, `sort=` (count), `format=` (json, tsv or csv). Flags: `total`, `counts`.
- `tag` — show one tag. Params: `name=` (required; with or without `#`). Flags: `total`, `verbose` (adds the file list).

## Tasks

- `tasks` — list tasks as `path:line: [status] text`. Params: `file=`, `path=`, `status=` (status character), `format=` (text, json, tsv or csv). Flags: `total`, `done`, `todo`, `verbose` (grouped by file).
- `task` — show or change one task. Params: `ref=` (`path:line`), `file=`, `path=`, `line=`, `status=` (set this status character). Flags: `toggle`, `done`, `todo`.

## Links

- `links` — outgoing links of a file. Params: `file=`, `path=`. Flags: `total`.
- `backlinks` — files linking to a file. Params: `file=`, `path=`, `format=` (json, tsv or csv). Flags: `counts`, `total`.
- `unresolved` — links that match no file. Params: `format=` (json, tsv or csv). Flags: `total`, `counts`, `verbose`.
- `orphans` — files nothing links to. Flags: `total`.
- `deadends` — files with no outgoing links. Flags: `total`.

## Structure

- `outline` — headings of a file. Params: `file=`, `path=`, `format=` (tree, md or json). Flags: `total`.
- `wordcount` — words and characters of a file. Params: `file=`, `path=`. Flags: `words`, `characters`.

## Bases

- `bases` — list `.base` files.
- `base:views` — list the views of a base. Params: `file=`, `path=`.
- `base:create` — create a note in a base view. Params: `file=`, `path=`, `view=`, `name=`, `content=`. Flags: `open`, `newtab` (accepted and ignored).
- `base:query` — run a base view. Params: `file=`, `path=`, `view=`, `format=` (json, csv, tsv, md or paths).

## Skills

- `skills:sync` — install or update the Writer-managed agent skills in this vault (`.agents/skills` and `.claude/skills`). Flags: `check` (report what would change, write nothing).

## Meta

- `help` — list commands, or show help for one (`writer help search`).
- `version` — show the Writer version.
