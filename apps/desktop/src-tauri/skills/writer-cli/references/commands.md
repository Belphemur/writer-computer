# Writer CLI command reference

One bullet per command: `required` parameters are marked, everything else is optional. Flags are bare words. `file=` and `path=` select the target note (one of them). Run `writer help <command>` for the authoritative text. This list is generated from the command registry.

<!-- BEGIN GENERATED: commands (cargo test skill_doc) -->

## Vault

- `vault` — Show the current vault (one value with info=). Params: `info=` (name | path | files | folders | size).
- `vaults` — List the vaults Writer knows (recent workspaces). Flags: `total` (print only the count), `verbose` (include vault paths).

## Files

- `files` — List files. Params: `folder=` (only files under this folder), `ext=` (only this extension). Flags: `total` (print only the count).
- `file` — Show information about a file. Params: `file=`, `path=`.
- `folders` — List folders. Params: `folder=` (only folders under this folder). Flags: `total` (print only the count).
- `folder` — Show information about a folder. Params: `path=` (required; folder path), `info=` (files | folders | size (one value only)).

## Content

- `read` — Print a file's contents. Params: `file=`, `path=`.
- `create` — Create a note. Params: `name=` (note name (default Untitled)), `path=` (exact path), `content=` (initial text), `template=` (note whose text is the starting content). Flags: `overwrite` (replace an existing file), `open` (accepted, ignored (the app is not controlled)), `newtab` (accepted, ignored).
- `append` — Append text to a file. Params: `file=`, `path=`, `content=` (required; text to add), `heading=` (append to the end of this section). Flags: `inline` (no newline between the existing text and the new text).
- `prepend` — Insert text after the frontmatter. Params: `file=`, `path=`, `content=` (required; text to add), `heading=` (insert right after this heading). Flags: `inline` (no newline after the new text).
- `move` — Move (and optionally rename) a file and update links to it. Params: `file=`, `path=`, `to=` (required; destination folder or path), `format=` (text | json). Flags: `dry-run` (print the plan (files and link counts) and change nothing), `no-update-links` (do not rewrite links to the file (they are updated by default)).
- `rename` — Rename a file and update links to it. Params: `file=`, `path=`, `name=` (required; new name (extension kept if omitted)), `format=` (text | json). Flags: `dry-run` (print the plan (files and link counts) and change nothing), `no-update-links` (do not rewrite links to the file (they are updated by default)).
- `title` — Show, set or clear a note's display title (the title property); the file is not renamed. Params: `file=`, `path=`, `set=` (new display title (links showing the old title follow)), `format=` (text | json). Flags: `clear` (remove the title property (the note shows its file name)), `dry-run` (print the plan (files and link counts) and change nothing), `no-update-links` (do not rewrite links that show the old title as their alias).
- `delete` — Move a file to the trash. Params: `file=`, `path=`. Flags: `permanent` (delete for good instead of using the trash).

## Search

- `search` — List files whose text or name matches a query, best match first. Params: `query=` (required; words, "phrase", -word, a OR b, pre*, tag:/path:/file:/kind:/ext:, or /regex/), `path=` (limit to this folder), `limit=` (maximum number of files), `format=` (text | json). Flags: `total` (print only the count), `case` (case sensitive).
- `search:context` — Matching lines as path:line: text, best file first. Params: `query=` (required; words, "phrase", -word, a OR b, pre*, tag:/path:/file:/kind:/ext:, or /regex/), `path=` (limit to this folder), `limit=` (maximum number of lines), `format=` (text | json). Flags: `case` (case sensitive).

## Properties

- `properties` — List properties (of one file, or the vault with counts). Params: `file=`, `path=`, `name=` (only this property), `sort=` (count), `format=` (yaml | json | tsv). Flags: `total` (print only the count), `counts` (include occurrence counts), `types` (include each property's type).
- `property:set` — Set a property in a note's frontmatter. Params: `name=` (required; property name, or a.b for a key in a map), `value=` (required; value), `type=` (text | list | number | checkbox | date | datetime), `file=`, `path=`.
- `property:read` — Print a property value. Params: `name=` (required; property name, or a.b for a key in a map), `file=`, `path=`.
- `property:remove` — Remove a property. Params: `name=` (required; property name, or a.b for a key in a map), `file=`, `path=`.
- `aliases` — List aliases. Params: `file=`, `path=`. Flags: `total` (print only the count), `verbose` (include file paths).

## Tags

- `tags` — List tags. Params: `file=`, `path=`, `sort=` (count), `format=` (json | tsv | csv). Flags: `total` (print only the count), `counts` (include counts).
- `tag` — Show a tag. Params: `name=` (required; tag, with or without #). Flags: `total` (print only the file count), `verbose` (include the file list).

## Tasks

- `tasks` — List tasks (filter= takes a Bases expression over task rows). Params: `file=`, `path=`, `status=` (status character), `filter=` (expression, e.g. task.due < today() && !task.checked), `sort=` (task property, e.g. task.due or task.urgency), `limit=` (at most this many tasks), `format=` (text | json | tsv | csv). Flags: `total` (print only the count), `done` (completed only), `todo` (not completed only), `desc` (with sort=: descending), `verbose` (group by file with line numbers).
- `task` — Show or change one task. Params: `ref=` (path:line), `file=`, `path=`, `line=` (line number), `status=` (set this status character). Flags: `toggle` (flip done/not done), `done` (mark done), `todo` (mark not done).
- `task:add` — Add a task to the inbox note. Params: `text=` (task text), `due=` (YYYY-MM-DD), `scheduled=` (YYYY-MM-DD), `start=` (YYYY-MM-DD), `priority=` (highest | high | medium | low | lowest), `recurrence=` (e.g. every week), `path=`.
- `task:done` — Complete a task (a recurring one writes its next occurrence). Params: `ref=` (path:line), `file=`, `path=`, `line=` (line number).
- `task:edit` — Set or clear the fields of a task. Params: `ref=` (path:line), `file=`, `path=`, `line=` (line number), `due=` (YYYY-MM-DD), `scheduled=` (YYYY-MM-DD), `start=` (YYYY-MM-DD), `priority=` (highest | high | medium | low | lowest), `recurrence=` (e.g. every week), `clear=` (fields to remove, comma separated).

## Links

- `links` — Outgoing links of a file. Params: `file=`, `path=`. Flags: `total` (print only the count).
- `backlinks` — Files linking to a file. Params: `file=`, `path=`, `format=` (json | tsv | csv). Flags: `counts` (include link counts), `total` (print only the count).
- `unresolved` — Links that match no file. Params: `format=` (json | tsv | csv). Flags: `total` (print only the count), `counts` (include counts), `verbose` (include source files).
- `orphans` — Files nothing links to. Flags: `total` (print only the count).
- `deadends` — Files with no outgoing links. Flags: `total` (print only the count).

## Graph

Every `graph:*` command takes `format=` (text, json or tsv; default text, use json from an agent) and prints errors as `writer: ...` on stderr. `file=` and `path=` work as elsewhere. Traversals are bounded (depth at most 4) and results are capped. `graph:neighbors` JSON is `{center, nodes, edges, truncated}`; `graph:path` exits 1 with `no path within N hops` when there is none.

- `graph:neighbors` — Notes within a few links of a note, with how each is reached. Params: `file=`, `path=`, `depth=` (1 to 4 (default 2)), `kind=` (link | embed | property (comma separated)), `label=` (only this property name), `direction=` (in | out | both (default both)), `limit=` (most notes (default 50)), `format=` (text | json | tsv).
- `graph:path` — The shortest chain of links between two notes. Params: `from=` (required; start note, resolved like a wikilink), `to=` (required; end note), `maxdepth=` (most links to follow (default 6)), `format=` (text | json | tsv).
- `graph:relationships` — Property links (manager: [[X]]); with no file or label, the property names in use. Params: `file=`, `path=`, `label=` (only this property name), `format=` (text | json | tsv).
- `graph:backlinks` — Notes linking to a note, with kind, property, section and optionally the line. Params: `file=`, `path=`, `limit=` (most links (default 20, 50 with context)), `format=` (text | json | tsv). Flags: `context` (add the line holding each link (capped, read from the note)).
- `graph:related` — Notes not linked to a note but sharing linked notes with it. Params: `file=`, `path=`, `limit=` (most notes (default 10)), `format=` (text | json | tsv).
- `graph:hubs` — The most linked notes. Params: `limit=` (most notes (default 20)), `format=` (text | json | tsv).
- `graph:components` — Groups of connected notes, largest first, with one example each. Params: `limit=` (most groups (default 20)), `format=` (text | json | tsv).
- `graph:orphans` — Notes with no link in or out (orphans means no incoming link). Params: `limit=` (most notes), `format=` (text | json | tsv).

## Structure

- `outline` — Headings of a file. Params: `file=`, `path=`, `format=` (tree | md | json). Flags: `total` (print only the count).
- `wordcount` — Words and characters of a file. Params: `file=`, `path=`. Flags: `words` (words only), `characters` (characters only).

## App

- `status` — Show whether Writer is running, its version and the open vaults. Params: `format=` (text | json).
- `open` — Open a file in the vault's Writer window. Params: `file=`, `path=`, `line=` (line to reveal (from 1)), `anchor=` (heading slug to reveal). Flags: `newtab` (open in a new tab), `--launch` (start Writer first when it is not running).
- `reveal` — Reveal a file or folder in the sidebar of the vault's Writer window. Params: `file=`, `path=`.
- `active` — Show the active tab of the vault's Writer window: path, kind and line (never its text). Params: `format=` (text | json).

## Skills

- `skills:sync` — Install or update the Writer-managed agent skills in this vault. Flags: `check` (report what would change, write nothing).

## Meta

- `help` — List commands, or show help for one.
- `version` — Show the Writer version.

## Agent

- `project:archive` — Archive an agent project: flag it and move its folder into the archive folder (setting agent.projects-archive-folder, default Archive/Projects). Params: `path=` (required; vault-relative project folder, e.g. Projects/Client).
- `project:unarchive` — Unarchive an agent project: move its folder back to where it was archived from and clear the flag. Params: `path=` (required; vault-relative archived project folder, e.g. Archive/Projects/Client).

## Bases

- `bases` — List .base files.
- `base:views` — List the views of a base. Params: `file=`, `path=`.
- `base:create` — Create a note in a base view. Params: `file=`, `path=`, `view=` (view name), `name=` (note name), `content=` (initial text). Flags: `open` (accepted, ignored), `newtab` (accepted, ignored).
- `base:query` — Run a base view. Params: `file=`, `path=`, `view=` (view name), `format=` (json | csv | tsv | md | paths).

## Dataview

- `dql` — Run a Dataview query (TABLE, LIST, TASK, CALENDAR). Params: `query=` (the DQL text), `file=`, `path=`, `format=` (json | csv | tsv | md | paths).

## Excalidraw

- `excalidraw:create` — Create a drawing from a spec of boxes and arrows. Params: `path=` (required; new drawing, e.g. Diagrams/Arch.excalidraw.md), `spec=` (JSON: {"nodes":[{"id","text","shape"?,"x"?,"y"?,"color"?}],"edges":[["from","to","label"?]],"groups":[{"nodes":[ids]}],"direction":"LR|TB"}). Flags: `overwrite` (replace an existing file).
- `excalidraw:add` — Add boxes and arrows to a drawing. Params: `file=`, `path=`, `spec=` (required; JSON: {"nodes":[{"id","text","shape"?,"x"?,"y"?,"color"?}],"edges":[["from","to","label"?]],"groups":[{"nodes":[ids]}],"direction":"LR|TB"}).
- `excalidraw:connect` — Draw an arrow between two boxes of a drawing. Params: `file=`, `path=`, `from=` (required; box id), `to=` (required; box id), `label=` (text on the arrow).
- `excalidraw:read` — Print a drawing as a spec (boxes, arrows, groups). Params: `file=`, `path=`.
- `excalidraw:export` — Write the drawing as an SVG next to it (needs Writer running). Params: `file=`, `path=`.

## Icons

- `icon:set` — Give a file or folder an icon (shown in the sidebar, tabs and links); icon is emoji:<emoji> or icon:<Hugeicons name>, a bare emoji or a bare name also works. Params: `file=`, `path=`, `icon=` (required; emoji:🚀 or icon:Rocket01Icon), `color=` (#rrggbb).
- `icon:get` — Print the icon of a file or folder (exit 1 when it has none). Params: `file=`, `path=`, `format=` (text | json).
- `icon:remove` — Remove the icon of a file or folder. Params: `file=`, `path=`.

## Spelling

`check` runs the same local checker as the app (Harper for English, an installed Hunspell dictionary for other languages; no network). It skips code, links, front matter and math, reads the note's `lang:` property (or `lang=`) and the vault's `.writer/dictionary.txt`. `format=json` prints `{path, findings, missingLanguages}`; each finding has `line`, `column`, `start`, `end` (UTF-16), `text`, `kind` (spelling, grammar or style), `rule`, `message` and `replacements`. Findings are advice: change the note with an ordinary edit.

- `check` — Check a note's spelling and grammar with Writer's local checker. Params: `file=`, `path=`, `lang=` (check as this language, for example fr (default: the note's own)), `format=` (text | json).

<!-- END GENERATED: commands -->
