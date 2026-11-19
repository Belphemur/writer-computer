---
status: accepted
date: 2026-11-19
decision-makers: Writer maintainers
---

# Prune the `writer` CLI to one command per job; drop Obsidian command parity

## Context and Problem Statement

The `writer` CLI ([ADR 2026-11-15](2026-11-15-obsidian-style-writer-cli.md)) adopted Obsidian's command grammar and vocabulary. Features then added richer commands next to the Obsidian names, so by 2026-11-19 `writer help` listed 64 commands with overlaps: `backlinks` and `graph:backlinks`, `orphans` and `graph:orphans`, `links` and `graph:neighbors`, `rename` and `move`, `task` and `task:done`/`task:edit`, `excalidraw:connect` and `excalidraw:add`, `aliases` and `property:read`; `help` also printed the "Links" and "Tasks" groups twice. Agents read these through the managed `writer-cli` skill, so every duplicate is a choice they have to make. The user (2026-11-19): "cleanup everything, Obsidian parity can be removed, we want DRY".

## Decision Drivers

- One command per job (`docs/consolidation.md`, DRY > SOLID > KISS).
- The richer implementation survives; the thinner one goes.
- Agents learn the CLI from the skill: fewer, clearer commands.

## Considered Options

- A. Remove the duplicates outright; keep the grammar.
- B. Keep the Obsidian names as aliases of the survivors.
- C. Keep everything.

## Decision Outcome

Chosen option: **A**. Obsidian command parity is no longer a goal; the grammar (`writer [vault=…] <command> [key=value …] [flag …]`, `file=` / `path=`, exit codes, the shared index, writes straight to files, never `.obsidian`) stays as decided in the 2026-11-15 ADR.

| Removed              | Use instead                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `links`              | `graph:neighbors file=… direction=out depth=1` (`direction=in                                        | out | both`, added if missing) |
| `backlinks`          | `graph:backlinks`                                                                                    |
| `orphans`            | `graph:orphans` (one command; an option chooses "no incoming link" or "no link at all", one default) |
| `deadends`           | `graph:deadends`                                                                                     |
| `unresolved`         | `graph:unresolved`                                                                                   |
| `rename`             | `move file=… name=…`                                                                                 |
| `aliases`            | `property:read name=aliases`                                                                         |
| `task`               | `tasks` (list, filter) and `task:add` / `task:done` / `task:edit`                                    |
| `excalidraw:connect` | `excalidraw:add` with `edges`                                                                        |

- An unknown or removed command fails with exit 2 and, for a removed one, names its replacement (one table, `cli/registry.rs`), so old scripts and agents learn the new name.
- `help` prints each group once: core and feature commands merge by group name.
- Namespaces: a command a feature or subsystem owns is `area:verb`; a top-level noun lists or shows (`files`, `tags`, `tasks`, `bases`).

### Consequences

- Good: 9 fewer commands, no two ways to do one thing, a shorter skill.
- Bad: scripts written for Obsidian's CLI need the new names (the error names them).

### Non-goals

- Changing the grammar, exit codes or output formats of the commands that stay.
- Renaming commands that have no duplicate.

## Implementation Plan

- **Affected paths**: `src-tauri/src/cli/` (`registry.rs`, the handlers of removed commands folded into the survivors, the removed-command table, `help` grouping), the graph commands (`direction=`, `graph:deadends`, `graph:unresolved`, the `graph:orphans` option), feature CLI contributions (`features/tasks`, `features/excalidraw`), the managed skills `writer-cli` and `writer-search` (regenerate with `WRITER_UPDATE_GOLDEN=1 cargo test skill_doc`, bump `BUNDLE_VERSION`), CLI goldens and e2e tests, `SPECs/writer-cli-spec.md` (drop "Obsidian CLI parity", document the table), `CHANGELOG.md`, CLAUDE.md where it names commands.
- **Patterns to follow**: one registry, survivors keep their handlers, shared output formatters.
- **Patterns to avoid**: aliases, a second handler for the same job.
- **Tests**: every removed name exits 2 naming its replacement; each replacement covers what the removed command printed (golden output for `graph:deadends`, `graph:unresolved`, `graph:neighbors direction=out`, `move name=`, `graph:orphans` option); `help` lists each group once; registry and skill goldens updated.

### Verification

- [x] `writer help` has no duplicate group and none of the removed names.
- [x] `writer backlinks file=X` exits 2 and says `use graph:backlinks`.
- [x] The `writer-cli` skill names only surviving commands.

## More Information

Supersedes the command-parity part of [Give the `writer` binary an Obsidian-style command grammar on the shared index](2026-11-15-obsidian-style-writer-cli.md); its grammar decision is restated above and stays.
