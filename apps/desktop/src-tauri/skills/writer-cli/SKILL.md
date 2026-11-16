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
- Flags are bare words (`total`, `verbose`, `case`, `overwrite`, ...), never `--flag`. The only `--` options are `--copy` (also copy stdout to the clipboard) and `--help`.
- `file=<name>` resolves like a wikilink: no folder, no extension (`file=Recipe`). `path=<path>` is exact from the vault root (`path=Projects/Recipe.md`). Give one of them, not both. There is no "active file": commands that act on a file need `file=` or `path=`.
- In `content=` the escapes `\n` and `\t` become a newline and a tab; `\\` is a backslash.
- One pair of quotes surrounding a whole value is stripped after the shell has run. This matters for search phrases, see the `writer-search` skill.
- `writer help` lists every command, `writer help <command>` (or `writer <command> --help`) shows its parameters, flags and formats. That output is authoritative if it ever differs from these notes.

## Output and exit codes

- Results go to stdout, errors and warnings to stderr as `writer: <message>`. Output is plain and line oriented, safe to pipe.
- Commands with `format=` accept the formats listed in their help. Defaults: `search`/`search:context`/`tasks` text, `properties` yaml, `tags`/`backlinks`/`unresolved` tsv (no header), `outline` tree, `base:query` json.
- `total` prints only a count.
- Exit `0` success. Exit `1` the command ran and failed (file not found, refused write, invalid value, unparsable frontmatter or `.base`, index busy). Exit `2` usage error (unknown command, parameter or flag, missing required parameter, command not available in the Writer CLI). Check the exit code, not just the output.

## Command groups

See [references/commands.md](references/commands.md) for every command with its parameters and flags.

| Group      | Commands                                                                    |
| ---------- | --------------------------------------------------------------------------- |
| Vault      | `vault`, `vaults`                                                           |
| Files      | `files`, `file`, `folders`, `folder`                                        |
| Content    | `read`, `create`, `append`, `prepend`, `move`, `rename`, `delete`           |
| Search     | `search`, `search:context` (see the `writer-search` skill)                  |
| Properties | `properties`, `property:set`, `property:read`, `property:remove`, `aliases` |
| Tags       | `tags`, `tag`                                                               |
| Tasks      | `tasks`, `task`                                                             |
| Links      | `links`, `backlinks`, `unresolved`, `orphans`, `deadends`                   |
| Structure  | `outline`, `wordcount`                                                      |
| Bases      | `bases`, `base:views`, `base:create`, `base:query` (see `writer-bases`)     |
| Meta       | `help`, `version`                                                           |
| Skills     | `skills:sync` (reinstall the managed agent skills in this vault)            |

## Typical tasks

```
writer files folder=Projects                      # list notes under a folder
writer read file=Recipe                           # print a note
writer create name="Weekly review" content="# Week\n\n- [ ] plan"
writer append file="Weekly review" content="- [ ] follow up"
writer append path=Inbox.md heading="Today" content="- call back"
writer property:set file=Recipe name=status value=draft
writer tags counts sort=count
writer backlinks file=Recipe format=json
writer tasks todo verbose
writer rename file=Recipe name="Best recipe"      # updates links in other notes
```

## Safety

- `rename` and `move` rewrite wikilinks, embeds and Markdown links to the file in every note that points at it (frontmatter links included, links in code spans and fences untouched). Prefer them over renaming with `mv`, which leaves links broken.
- `delete` moves the file to the OS trash; `delete permanent` removes it for good. If the trash fails nothing is deleted.
- `create` never overwrites unless the `overwrite` flag is given. It always produces a Markdown note (`.md` is appended), so it cannot create a `.base` file; write those with normal file edits.
- `property:set`, `property:remove` and `task` edit only the targeted frontmatter line or checkbox character, so comments, key order and other text are preserved. Unparsable frontmatter is an error, not a rewrite.
- Writer never reads or writes inside `.obsidian` or `.git`, and refuses paths that leave the vault (`..`, absolute paths elsewhere, symlinks pointing outside).
- A note that is open in the Writer app with unsaved edits is not coordinated with the CLI; avoid editing the same note from both at once.
- Writes happen immediately, there is no dry run. Read the target first when unsure.
- Files under `.agents/skills/` and `.claude/skills/` whose frontmatter says `writer-managed: true` belong to Writer and are overwritten on the next sync. Do not edit them; add your own skills under a different name.

## Not available in the CLI

These Obsidian CLI commands need a running Obsidian-style app or features Writer does not have, and exit 2 with `Not available in the Writer CLI: <name>`: `open`, `search:open`, `templates` and `template*`, `bookmark*`, `diff`, `history*`, `sync*`, `plugin*`, `theme*`, `snippet*`, `publish*`, `workspace*`, `tab*`, `daily*`, `random*`, `unique*`, `web`, `dev*`, `command*`, `hotkey*`, `vault:*`, plus the `active` and `daily` flags. Use `file=` or `path=` instead of the active file, and ordinary file edits for anything else.

## When not to use it

For plain edits inside one note's body, editing the file directly is fine. Use the CLI when Writer-specific knowledge helps: link-safe moves, frontmatter edits, indexed queries (tags, backlinks, tasks, bases, ranked search).
