---
name: writer-cli
description: Use the `writer` command-line tool to read, search and edit a Markdown vault (notes, properties, tags, links, tasks, bases) without opening the Writer app. Use when the working directory is a Writer or Obsidian-style vault and you need to list files, read or create notes, append text, rename or move notes with link updates, edit frontmatter properties, query tags, backlinks or tasks, or run a .base view. Prefer it over raw file edits for renames, moves, property changes and task toggles.
---

# Writer CLI

`writer` is a headless command line over a folder of Markdown notes (a vault). It works without the Writer app running and shares the app's vault index, so answers match what the app shows.

Check it is available with `writer version`. If the command is missing, the user installs it from the Writer app menu ("Install 'writer' Command Line Tool").

## Grammar

```
writer [vault=<name|id|path>] <command> [key=value ...] [flag ...] [--copy]
```

- `vault=` must be the first argument. Without it the vault is the nearest parent of the working directory that has a `.obsidian` folder, otherwise the working directory itself. Run from the vault root, or pass `vault=/absolute/path`.
- `key=value` parameters. Quote values with spaces in the shell: `writer create name="Meeting notes"`. Parameter names are case-sensitive and a repeated parameter is an error.
- Flags are bare words (`total`, `verbose`, `case`, `overwrite`, ...), never `--flag`. The only `--` options are `--copy` (also copy stdout to the clipboard), `--help` and, on `open`, `--launch`.
- `file=<name>` resolves like a wikilink, by **file name** (never by the note's `title:` property or first heading): no folder, no extension (`file=Recipe`), case-insensitive. With several files of that name the closest folder wins, then the shortest path, then alphabetical order; use `path=` to be exact. Links, backlinks, unresolved links and Bases `link()` all use this same rule. `path=<path>` is exact from the vault root (`path=Projects/Recipe.md`). Give one of them, not both. There is no "active file": commands that act on a file need `file=` or `path=`.
- In `content=` the escapes `\n` and `\t` become a newline and a tab; `\\` is a backslash. A JSON-valued parameter (`spec=` of the `excalidraw:` commands) is taken as written: only JSON's own escapes apply, and `spec=@Specs/a.json` (a vault file) or `spec=-` (standard input) stand for its text.
- One pair of quotes surrounding a whole value is stripped after the shell has run. This matters for search phrases, see the `writer-search` skill.
- `writer help` lists every command, `writer help <command>` (or `writer <command> --help`) shows its parameters, flags and formats. That output is authoritative if it ever differs from these notes.

## Output and exit codes

- Results go to stdout, errors and warnings to stderr as `writer: <message>`. Output is plain and line oriented, safe to pipe.
- Commands with `format=` accept the formats listed in their help. Defaults: `search`/`search:context`/`tasks` text, `properties` yaml, `tags` tsv (no header), `graph:*` text, `outline` tree, `base:query` json.
- `total` prints only a count.
- Exit `0` success. Exit `1` the command ran and failed (file not found, refused write, invalid value, unparsable frontmatter or `.base`, index busy). Exit `2` usage error (unknown command, parameter or flag, missing required parameter, command not available in the Writer CLI). Exit `4` `Writer is not running`: a command of the running app (`status`, `open`, `reveal`, `active`) found no app. Check the exit code, not just the output.

## As MCP tools in Writer's agent pane

In the agent pane every command below is also an MCP tool, `mcp__writer__<command>` with `:` written `_` (`graph:backlinks` is `mcp__writer__graph_backlinks`, `base:query` is `mcp__writer__base_query`). The tools are generated from the command list, so their parameters, flags and formats are the CLI's: a string per `key=`, a boolean per flag, `format` one of the formats the command lists. Use them instead of `Bash`: there is no shell quoting, a value is taken exactly as given (give real newlines, not `\n`; no surrounding quotes to add), read tools run without a prompt and write tools ask first. The same exit conditions come back as an error result with the `writer:` message. `help`, `version` and `skills:sync` are not tools. `writer mcp` is the server itself (`writer vault=<path> mcp`, JSON-RPC on stdio); Writer starts it for each chat.

## Command groups

See [references/commands.md](references/commands.md) for every command with its parameters and flags.

<!-- BEGIN GENERATED: groups (cargo test skill_doc) -->

| Group      | Commands                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vault      | `vault`, `vaults`                                                                                                                                                                   |
| Files      | `files`, `file`, `folders`, `folder`                                                                                                                                                |
| Content    | `read`, `create`, `append`, `prepend`, `move`, `title`, `delete`                                                                                                                    |
| Search     | `search`, `search:context`                                                                                                                                                          |
| Properties | `properties`, `property:set`, `property:read`, `property:remove`                                                                                                                    |
| Tags       | `tags`, `tag`                                                                                                                                                                       |
| Tasks      | `tasks`, `task:add`, `task:done`, `task:edit`                                                                                                                                       |
| Graph      | `graph:neighbors`, `graph:path`, `graph:relationships`, `graph:backlinks`, `graph:related`, `graph:hubs`, `graph:components`, `graph:orphans`, `graph:deadends`, `graph:unresolved` |
| Structure  | `outline`, `wordcount`                                                                                                                                                              |
| App        | `status`, `open`, `reveal`, `active`                                                                                                                                                |
| Skills     | `skills:sync`                                                                                                                                                                       |
| Meta       | `mcp`, `help`, `version`                                                                                                                                                            |
| Agent      | `project:archive`, `project:unarchive`                                                                                                                                              |
| Bases      | `bases`, `base:views`, `base:create`, `base:query`                                                                                                                                  |
| Dataview   | `dql`                                                                                                                                                                               |
| Excalidraw | `excalidraw:create`, `excalidraw:add`, `excalidraw:update`, `excalidraw:read`, `excalidraw:lint`, `excalidraw:export`, `excalidraw:preview`                                         |
| Git        | `git:status`, `git:log`, `git:diff`, `git:show`, `git:restore`, `git:sync`, `git:resolve`, `git:commit`                                                                             |
| Icons      | `icon:set`, `icon:get`, `icon:remove`                                                                                                                                               |
| Lint       | `lint`, `lint:fix`                                                                                                                                                                  |
| Spelling   | `check`                                                                                                                                                                             |

<!-- END GENERATED: groups -->

Search commands: see the `writer-search` skill. Bases commands: see `writer-bases`. `skills:sync` reinstalls the managed agent skills in this vault. `dql query="TABLE status FROM \"Projects\" WHERE priority > 1"` runs a Dataview query headless (TABLE, LIST, TASK, CALENDAR; same engine and rows as a ```dataview block, `dataviewjs` is never run) and prints it with `format=` (json default); add `file=` or `path=` to set `this`.

Icons: `icon:set path=Projects icon=📁` (or `icon=icon:Rocket01Icon`, a Hugeicons name) gives a file or folder the icon Writer shows in the sidebar, tabs and links; `icon:get` prints it, `icon:remove` clears it. They live in `.writer/icons.json` (never `.obsidian`); an icon from the Iconize plugin shows too, read-only, and `icon:remove` hides it. Renaming or moving with `writer move` keeps the icon.

## Typical tasks

```
writer files folder=Projects                      # list files under a folder
writer files ext=py                               # code files too: py, ts, sh... (see below)
writer read file=Recipe                           # print a note
writer create name="Weekly review" content="# Week\n\n- [ ] plan"
writer append file="Weekly review" content="- [ ] follow up"
writer append path=Inbox.md heading="Today" content="- call back"
writer property:set file=Recipe name=status value=draft
writer tags counts sort=count
writer graph:neighbors file=Recipe depth=2 format=json   # what surrounds a note, and why
writer graph:backlinks file=Recipe context format=json   # who links here, with the line
writer tasks todo verbose
writer move file=Recipe name="Best recipe"        # rename; updates links in other notes
writer move file=Recipe to=Archive                # move to a folder; also updates links
writer move file=Recipe name="Best recipe" dry-run   # show which files and how many links would change
writer title file=Recipe set="Best recipe"        # display title only (the `title` property); the file keeps its name
writer title file=Recipe clear dry-run            # preview removing it
```

## The running app

Only four commands talk to the Writer app (the **App** group); everything else works on the files with the app closed. They need Writer to be running and exit `4` with `writer: Writer is not running` when it is not. They reach the app over a local socket that only the same OS user can open, and they never return note text.

```
writer status                                    # is Writer running, its version, the open vaults
writer open path=Projects/Plan.md line=12        # open a note in the vault's window, at a line
writer open file=Recipe anchor=ingredients newtab   # at a heading; in a new tab
writer open file=Recipe --launch                 # start Writer on this vault first when it is closed
writer active                                    # the active tab: path, kind and cursor line
writer active format=json
```

- `open` focuses the vault's window (and opens it when the vault has none). `line=` and `anchor=` (a heading slug) are alternatives. The path must exist inside the vault.
- `active` answers with the vault-relative path, the tab kind (`file`, `base`, `code`, `image`, ...) and the cursor line of the window for this vault; it never prints the note or the selection. Use `read` for the text.
- `reveal path=...` shows a file or folder in the sidebar.
- Use these to point the user at a note you changed or to learn which note they are looking at; do not poll them.

## How notes relate (graph)

Use the `graph:*` commands, with `format=json`, to understand how notes are connected before reading many files: `graph:neighbors` (notes within `depth=` links, each with how it is reached: a body `link`, an `embed` or a `property` such as `manager`), `graph:path from=A to=B`, `graph:relationships` (property links like `manager: [[Daniel]]`; with no `file=` it lists the property names in use, reuse those names when you write new ones), `graph:backlinks context` (the line that holds each link, capped), `graph:related` (notes that share linked notes), `graph:hubs`, `graph:components`, `graph:orphans` (no link in or out; add `incoming` for notes nothing links to), `graph:deadends` (no outgoing link), `graph:unresolved` (links that match no file, with the notes holding them). The outgoing links of one note are `graph:neighbors file=X direction=out depth=1`. Results are capped; `truncated: true` means raise `limit=` or lower `depth=`. A note with hundreds of links is listed but not expanded. Links resolve by file name, so a bare `[[index]]` that matches several files is reported by the index as ambiguous.

## Safety

- Code and text files (py, ts, js, json, yaml, sh, rs, go, ... and `.agents/skills/<name>/` scripts) are listed by `files` and `search` (by name; their contents are not full-text indexed), and `read path=...` prints them. Generated folders (`node_modules`, `target`, `dist`, `build`, `__pycache__`, `.venv`, ...) and `.env`/secret-looking files are never listed. They are not link targets: `move` of a code file moves it and rewrites no links.
- `move` (to rename, give `name=`; to relocate, `to=`) rewrites wikilinks (`[[Old]]`, `[[Old|alias]]`, `[[Old#Heading]]`, `[[Old#^block]]`, `[[folder/Old]]`), embeds (`![[Old.png]]`), Markdown links (`[x](folder/Old%20Name.md)`), wikilink values in frontmatter properties and references in `.base` files, keeping each link's style, alias and heading; links in code spans and fences are untouched. It refuses an existing target, names with `/ \ : * ? " < > | # ^ [ ]`, control characters, hidden or reserved names, and anything inside `.obsidian`. It stages every edit first and roll back on an I/O error. `dry-run` prints the plan and writes nothing; `no-update-links` moves the file only. `format=json` prints `{from, to, dryRun, links, files, edits}`. Prefer it over renaming with `mv`, which leaves links broken.
- A note's title is its file name; the first heading is never a title. `title file=X set=<new>` writes the frontmatter `title` property, an explicit display override that never renames the file or changes a link target, and rewrites links that show the old title as their alias (`[[X|Old]]` and `![[X|Old]]` become `[[X|New]]`; other links are untouched). `clear` removes the property and the old alias. `dry-run`, `no-update-links` and `format=json` (`{path, old, new, dryRun, links, files, edits}`) work like for `move`; without `set=` or `clear` it prints the current title. To change the name links use, `move file=X name=<new>`.
- `delete` moves the file to the OS trash; `delete permanent` removes it for good. If the trash fails nothing is deleted.
- `create` never overwrites unless the `overwrite` flag is given. It always produces a Markdown note (`.md` is appended), so it cannot create a `.base` file; write those with normal file edits.
- `property:set`, `property:remove` and `task:edit` change only the targeted frontmatter line or checkbox character, so comments, key order and other text are preserved. Unparsable frontmatter is an error, not a rewrite.
- A key inside a property's map (a skill's `metadata:`) is a dotted name: `writer property:set file=Recipe name=metadata.version value=2`. A property whose name really contains a dot wins; a flow map or a map deeper than two levels is refused, not rewritten.
- Writer never reads or writes inside `.obsidian` or `.git`, and refuses paths that leave the vault (`..`, absolute paths elsewhere, symlinks pointing outside).
- A note that is open in the Writer app with unsaved edits is not coordinated with the CLI; avoid editing the same note from both at once.
- Writes happen immediately, there is no dry run. Read the target first when unsure.
- Files under `.agents/skills/` and `.claude/skills/` whose frontmatter says `writer-managed: true` belong to Writer and are overwritten on the next sync. Do not edit them; add your own skills under a different name.

## Not available in the CLI

These Obsidian CLI commands need a running Obsidian-style app or features Writer does not have, and exit 2 with `Not available in the Writer CLI: <name>`: `search:open`, `templates` and `template*`, `bookmark*`, `diff`, `history*`, `sync*`, `plugin*`, `theme*`, `snippet*`, `publish*`, `workspace*`, `tab*`, `daily*`, `random*`, `unique*`, `web`, `dev*`, `command*`, `hotkey*`, `vault:*`, plus the `active` and `daily` flags. Use `file=` or `path=` instead of the active file, and ordinary file edits for anything else.

Commands that were removed because another does the job exit 2 and name it (`writer: backlinks was removed: use graph:backlinks`): `links`, `backlinks`, `orphans`, `deadends`, `unresolved`, `rename`, `aliases` (use `property:read name=aliases`), `task` (use `tasks` to list, `task:add`, `task:done`, and `task:edit status=<symbol|name>` to set a status or reopen a task).

## When not to use it

For plain edits inside one note's body, editing the file directly is fine. Use the CLI when Writer-specific knowledge helps: link-safe moves, frontmatter edits, indexed queries (tags, backlinks, tasks, bases, ranked search).
