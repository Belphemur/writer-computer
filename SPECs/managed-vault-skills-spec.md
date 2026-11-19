# Writer-managed agent skills in every vault

Status: implemented in code, not run in a real window (see "Not verified"). Code: `apps/desktop/src-tauri/src/managed_skills/` (logic, Tauri-free), `commands/skills.rs` (app glue), `cli/cmd_skills.rs` (`writer skills:sync`), sources in `apps/desktop/src-tauri/skills/`. Related: [`writer-cli-spec.md`](writer-cli-spec.md), [`search-spec.md`](search-spec.md), [`obsidian-bases-spec.md`](obsidian-bases-spec.md).

## Summary

Writer is an AI-ready editor. Every workspace (vault) always contains Writer-managed agent skills in both `<vault>/.agents/skills/` and `<vault>/.claude/skills/`, so Claude Code and other agents opened in the vault know how to use the `writer` CLI. The editor fully manages them: it installs them when a workspace opens (and at startup for the restored workspace), checks their version, and updates them when the bundled version is newer or the files are missing or altered.

## Goals

- An agent started in any Writer workspace finds accurate, current instructions for `writer` without the user setting anything up.
- One source of truth: the skills are reviewable Markdown in the repository, compiled into the binary; the docs cannot drift from the command registry (tested).
- Safe by construction: confined to the vault, atomic, idempotent, race-safe, never overwrites or deletes a user's own files.

## Non-goals

- No new dependency (`include_str!` and the existing `sha2` through `plugin_store::sha256_hex`).
- No editing of `.gitignore`, `.obsidian` or `.git`. No MCP server or other agent configuration (`CLAUDE.md`, `AGENTS.md`) is written.
- No per-vault setting in the UI yet, no user-authored skill management, no remote updates: a skill changes only with a Writer release.
- No UI notice component yet (none exists); the report is emitted as an event for one to consume.

## The bundled skills (version 1)

| Skill               | Purpose                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `writer-cli`        | Grammar `writer [vault=...] <command> [key=value ...] [flags]`, command groups, output formats, exit codes 0/1/2, vault resolution, commands unavailable in the CLI, safety notes. `references/commands.md` lists every command with its parameters and flags.                                                                        |
| `writer-search`     | `search` / `search:context`: query syntax (`"phrase"`, `-x`, `OR`, `x*`, `tag:`/`path:`/`file:`, `/regex/`), `case`, `limit`, formats, the shell/parser quoting trap, when to use property, tag, link, file or base queries instead, index-busy errors.                                                                               |
| `writer-bases`      | `bases`, `base:views`, `base:query`, `base:create`; the `.base` YAML (filters, formulas, properties, summaries, views); editing rules (preserve comments, never re-serialize); expression essentials. `references/expressions.md`, `references/recipes.md`.                                                                           |
| `writer-excalidraw` | `excalidraw:create`, `excalidraw:add`, `excalidraw:connect`, `excalidraw:read`, `excalidraw:export`; the JSON spec (nodes, edges, groups, direction), layout rules, what to do with the app closed, the export needing the app. `references/examples.md`. Contributed by the `excalidraw` feature from `features/excalidraw/skills/`. |

Each is a `SKILL.md` with `name` (equal to the directory) and a `description` that says what it does and when to use it (80 to 1024 characters, tested). Accuracy rule: every `writer <command> key=` mentioned in a skill must exist in `cli/registry.rs` (see Tests).

Search note: the `the vault index is still being built` message belongs to the app's in-app search commands. The CLI refreshes the index itself and reports `the vault index is busy (...)`; the search skill documents both and says what to do (wait, retry once, do not loop).

## Install layout and markers

For each root in `SKILL_ROOTS = [".agents/skills", ".claude/skills"]` and each bundled skill:

```
<vault>/<root>/<name>/SKILL.md
<vault>/<root>/<name>/references/*.md
```

Installed `SKILL.md` frontmatter is the source frontmatter plus:

```yaml
writer-managed: true
writer-skills-version: 1 # BUNDLE_VERSION of the Writer that wrote it
writer-content-hash: <sha256> # hash of the skill's source files (names + bytes)
writer-files: "references/commands.md" # the non-SKILL.md files Writer wrote
```

and a one-line HTML comment right after the frontmatter (and at the top of each reference file) saying the file is managed by Writer and overwritten on update. To adopt a skill as your own, copy it to another folder name or delete the `writer-managed` line: an unmarked skill is never touched again.

These files are meant to be committed and shared with the vault (they are plain text and identical on every machine with the same Writer version). Writer does not edit `.gitignore`; a user who does not want them tracked adds the two folders themselves or turns the setting off.

## Versioning

- `BUNDLE_VERSION` (`managed_skills/bundle.rs`): a monotonic integer for the whole bundle. Bump it whenever any bundled file changes.
- `BUNDLE_FINGERPRINT`: SHA-256 over every skill's name and content hash. `bundle_fingerprint_is_current` fails when the text changed without updating it, and prints the new value, so a forgotten version bump is a test failure.
- Per-skill content hash: stored in the marker; informational and tamper-evident. Whether files are altered is decided by comparing installed bytes with the rendered bundle bytes (stronger than comparing a stored hash, which a user edit does not update).

## Update policy

Decided per `<root>/<name>` by the installed `SKILL.md`:

| Installed state                                                                          | Action                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Directory missing, or only entries Writer would create (interrupted install, temp files) | **install**                                                                                       |
| Marked, `writer-skills-version` < bundled                                                | **update** (overwrite changed files; delete files the old marker listed that the bundle dropped)  |
| Marked, same version, any managed file edited, missing or unreadable                     | **restore** (the files are fully managed; edits are overwritten)                                  |
| Marked, same version, all files identical                                                | nothing (no write, mtimes unchanged)                                                              |
| Marked, version > bundled (a newer Writer ran here)                                      | **leave untouched**, log, report `skipped-newer`                                                  |
| The skill folder, or a folder above it (`.agents/skills`), is a symlink inside the vault | **never touch**, log, report `skipped-symlink`; nothing is removed through a linked skills folder |
| `SKILL.md` without the marker, or a non-empty folder without `SKILL.md`                  | **never touch**, log a warning, report `skipped-user-owned`                                       |
| Marked skill whose name is no longer bundled (version <= bundled)                        | **remove** the files Writer wrote, then the folders if empty; user files in them stay             |
| Unreadable or non-UTF-8 `SKILL.md`                                                       | treated as user-owned                                                                             |

Writes of one skill go references first, `SKILL.md` last, so a crash leaves no marker over missing files and the next run reinstalls. Two Writer versions opening the same vault do not fight: the older one leaves the newer one's skills alone.

## Safety

- Every path goes through `vault_ops::confine` (symlinks resolved, `..` and absolute paths rejected, `.obsidian` and `.git` refused). If `.claude` is a symlink out of the vault, that root is reported as an error and nothing is written through it. A symlink that stays inside the vault is followed (a common `.claude/skills -> ../.agents/skills` setup works; both roots then coincide and the second pass is a no-op).
- Atomic writes: unique temp file in the target directory (`.writer-skill-<pid>-<n>.tmp`), `fsync`, rename.
- Idempotent and race-safe: syncs in one process are serialised by a mutex (several windows can open the same vault); across processes the writes are atomic and deterministic, so concurrent runs converge on identical bytes (test `unlocked_concurrent_writers_leave_complete_files`). A symlink swapped in between the confinement check and the write (TOCTOU) is out of scope, as for the rest of `vault_ops`.
- Deletes only files named by the installed marker (and `SKILL.md`), only inside a marked skill, never recursively.
- Errors are per skill in the report; a failed or read-only root never stops the other root or the app.

## Triggers

- `prepare_workspace_state` (`commands/workspace.rs`), shared by the `open_workspace` and `restore_workspace` IPCs and the cold-start restore, calls `commands::skills::spawn_workspace_sync`: a named background thread, after the workspace root is set, non-blocking, skipped when the setting is off. A sync is about a dozen small reads on a warm vault.
- Result: logged (`log::info` for changes, `log::warn` for conflicts and errors) and, when something changed or needs attention, emitted to the window as the event `skills:sync-report` with `{root, report | error}`. There is no toast component in the app today; showing one is a UI follow-up.
- On demand: the Tauri command `sync_managed_skills({ check? })` (ignores the setting, it is an explicit request) and the CLI command `writer skills:sync [check]` (prints `<dir>\t<action>[\t<detail>]` per skill, conflicts on stderr, exit 1 on a write error). `check` writes nothing.

## Setting

`workspace.managed-agent-skills`: boolean, global scope (a workspace `.writer/config` cannot override it), default `true`, category `Workspace` so it renders in the existing "Files & vault" section without UI changes. Turning it off stops installs and updates; it does not remove installed skills. Defined once in `apps/desktop/shared/settings.schema.json`; Rust reads it with `get_global_or_default`.

## Tests

`managed_skills/tests.rs` (temp-dir vaults, synthetic content only): fresh install in both roots, idempotent second run (bytes and mtimes), upgrade from an older marker with a dropped file, edited/missing file restored, leftover of an interrupted install, unmarked same-name skill and unmarked folder preserved, adopting a skill by removing the marker, newer version untouched, obsolete removal (user files, user skills and newer-Writer skills kept), `check` writes nothing, symlink escape refused (root and skill folder), in-vault symlink followed, `.obsidian`/`.git`/`.gitignore`/notes untouched, concurrent runs (locked and unlocked). Bundle checks: table equals the `skills/` directory, valid frontmatter, fingerprint current, every `writer <cmd> key=` in the skills exists in the registry with that parameter, `references/commands.md` lists exactly the registry's commands with exactly their parameters, required marks and flags, every ```yaml example in `writer-bases` parses with the Bases engine. `cli/tests.rs`: `skills:sync`.

## Not verified

Not run in a real window or against a real Claude Code session; the exact filesystem-event noise from the writes (watcher, sidebar for hidden folders); Windows rename-over-existing and CRLF checkouts (a CRLF checkout changes the bundled bytes and so the fingerprint test, not the install logic); read-only vault behaviour is covered only by the per-skill error path; whether other agents (beyond Claude Code and tools that read `.agents/skills`) pick the skills up.

## Follow-ups

- Wire `workspace.managed-agent-skills` into the settings sidebar and show a notice from `skills:sync-report`.
- ADR: "Writer manages agent skills inside the user's vault" (decision: bundled in the binary, marker-based ownership, overwrite policy; alternatives: copy once and never update, write to a global `~/.claude/skills`, an MCP server).
