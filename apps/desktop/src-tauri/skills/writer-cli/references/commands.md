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

- `properties` — list properties of one file, or of the vault with counts. Params: `file=`, `path=`, `name=`, `sort=` (count), `format=` (yaml, json or tsv). Flags: `total`, `counts`, `types`.
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

## Graph

Every `graph:*` command takes `format=` (text, json or tsv; default text, use json from an agent) and prints errors as `writer: ...` on stderr. `file=` and `path=` work as elsewhere. Traversals are bounded (depth at most 4) and results are capped.

- `graph:neighbors` — notes within a few links of a note, each with `depth`, degrees and `via` (the kind and property of the first link of the way), plus the edges among them; JSON is `{center, nodes, edges, truncated}`. Params: `file=`, `path=`, `depth=` (1 to 4, default 2), `kind=` (link, embed, property; comma separated), `label=` (property name), `direction=` (in, out or both), `limit=` (default 50), `format=`.
- `graph:path` — the shortest chain of links between two notes, direction ignored, through notes only; exits 1 with `no path within N hops` otherwise. Params: `from=` (required), `to=` (required), `maxdepth=` (default 6), `format=`.
- `graph:relationships` — property links as `source, label, target, resolved, line`, for a note (as source or target) and/or one property name; with neither, the property names in use with `edges` and `notes` counts. Params: `file=`, `path=`, `label=`, `format=`.
- `graph:backlinks` — notes linking to a note with `kind`, property `label`, `line` and `section`; `context` adds the line holding each link (at most 240 characters, at most 50 links, read from the note). Params: `file=`, `path=`, `limit=` (default 20), `format=`. Flags: `context`.
- `graph:related` — notes not linked to the note that share linked notes with it, ranked by `score` (rare shared notes count more), with `shared` and `via`. Params: `file=`, `path=`, `limit=` (default 10), `format=`.
- `graph:hubs` — the most linked notes. Params: `limit=` (default 20), `format=`.
- `graph:components` — groups of connected notes, largest first, with one example each. Params: `limit=` (default 20), `format=`.
- `graph:orphans` — notes with no link in or out (`orphans` means no incoming link). Params: `limit=`, `format=`.

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
