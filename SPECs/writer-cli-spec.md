# Writer CLI Spec

> Amended: the [command surface](#the-writer-command-surface) section supersedes the "no JSON output", "markdown only", "under ten top-level commands" and plain `--flag` non-goals for the commands it lists. The original `writer spec ...`, `frontmatter` and `list/read/search` commands keep working unchanged.

## Summary

Agent skills that teach Claude Code and other agents this CLI are installed into every vault by Writer: see [`managed-vault-skills-spec.md`](managed-vault-skills-spec.md) (`writer skills:sync`). They are tested against `cli/registry.rs`, so a command or parameter change here must be reflected in `src-tauri/skills/`.

Add a standalone-first, markdown-only `writer` CLI focused on spec authoring and validation.

The CLI should be useful even when the desktop app is not running. It should help users create structured spec documents, inspect markdown workspaces, edit frontmatter safely, and validate spec quality from the terminal and CI.

This feature is intentionally scoped so a single agent can implement it end to end in one pass. That means the initial version must stay narrow, avoid platform-specific installer work, and avoid larger programmatic surfaces such as HTTP APIs, MCP servers, TUIs, or JSON output.

## Background

Writer is currently a Tauri desktop application with a React frontend and a Rust backend. The Rust side already has useful primitives for:

- reading and writing files
- indexing markdown workspaces
- fuzzy searching markdown paths
- tracking workspace state

Those primitives currently sit behind Tauri commands, but they are close to being reusable from a CLI.

Because the underlying source of truth is plain markdown, a CLI does not add much value if it only mirrors generic shell operations. The CLI becomes worth building when it adds Writer-specific behavior:

- opinionated spec templates
- frontmatter-aware edits
- validation of required sections and metadata
- consistent markdown scaffolding
- workspace inspection tailored to markdown specs

## Product Thesis

The CLI should be a fast, markdown-native companion to the desktop app, not a replacement for every shell tool and not an app-wide remote control surface.

The first version should optimize for three jobs:

1. Create a new spec quickly and consistently.
2. Validate a spec or spec workspace in CI and pre-commit workflows.
3. Inspect markdown content and frontmatter without opening the GUI.

## Goals

- Build a headless CLI that works without a running GUI.
- Keep all inputs and outputs markdown, YAML, or plain text.
- Add Writer-specific value through templates and validation.
- Reuse as much existing Rust logic as possible.
- Keep the implementation small enough for one agent to complete end to end.
- Keep the CLI script-friendly through stable stdout, stderr, and exit codes.

## Non-Goals

- No JSON output.
- No local HTTP API.
- No MCP server.
- No interactive TUI.
- No plugin, theme, sync, or developer-tool command surface.
- No bundling the CLI into the desktop installer in v1.
- No requirement to control or focus a running Writer instance in v1.
- No full parity with the desktop command palette.
- No non-markdown export formats such as PDF in v1.

## Single-Agent Scope Boundary

This spec must remain implementable by one agent in a single end-to-end pass. To keep the scope realistic, v1 must follow these rules:

- The CLI lives inside the existing Rust package at `apps/desktop/src-tauri/`.
- The implementation may add shared Rust modules, but it should not begin with a full multi-crate refactor.
- The CLI should operate directly on the filesystem and markdown files.
- GUI integration is explicitly deferred unless it falls out naturally from existing code with almost no extra complexity.
- Output should stay plain text only.
- Validation should be deterministic and strict enough for CI.
- The command surface should stay under ten top-level commands in v1.

If a design choice increases scope materially, prefer the smaller alternative.

## Product Decisions

### Markdown-only output

The CLI will not support JSON. Output must be designed for humans first, while still being grep-friendly and stable enough for shell scripts.

### Standalone-first

Every v1 command should work without the desktop app running. The CLI should read and write markdown files directly.

### Spec-aware, not shell-clone

The CLI should avoid duplicating broad filesystem tooling unless the behavior is meaningfully Writer-specific.

### Narrow v1 surface

The first release should focus on:

- markdown workspace inspection
- frontmatter edits
- spec creation
- spec validation

## Primary User Workflows

### Create a new spec

Examples:

```bash
writer spec create "Login flow" --template feature
writer spec create "Quarterly planning" --template prd --dir specs/product
writer spec create "Use local caching for search index" --template decision
```

Expected result:

- a slugged `.md` file is created
- frontmatter is prefilled
- required sections are scaffolded
- the file is immediately ready to edit in any editor

### Validate a single spec

Examples:

```bash
writer spec validate specs/login-flow.md
writer spec validate docs/decision-cache-index.md
```

Expected result:

- validation diagnostics print to stderr or stdout in stable text format
- exit code is `0` for valid input, `1` for validation failures

### Validate a workspace in CI

Examples:

```bash
writer spec validate specs
writer spec validate .
```

Expected result:

- all markdown specs under the target path are checked
- each issue is reported on its own line
- CI can fail the build on invalid specs

### Inspect and edit frontmatter

Examples:

```bash
writer frontmatter show specs/login-flow.md
writer frontmatter get specs/login-flow.md status
writer frontmatter set specs/login-flow.md status review
```

Expected result:

- frontmatter can be printed, queried, and updated without opening the GUI
- updates preserve markdown body content
- rewriting the YAML block into a canonical format is acceptable in v1

### Search a spec workspace

Examples:

```bash
writer list specs
writer search login
writer read specs/login-flow.md
```

Expected result:

- users can inspect a spec workspace from the shell quickly
- filename search is fast and limited to markdown files

## V1 Command Surface

### Top-level commands

| Command                                       | Purpose                                | Notes                     |
| --------------------------------------------- | -------------------------------------- | ------------------------- |
| `writer list [path]`                          | List markdown files under a directory  | recursive                 |
| `writer read <file>`                          | Print file contents to stdout          | raw markdown              |
| `writer search <query>`                       | Fuzzy-search markdown filenames        | workspace-aware           |
| `writer frontmatter show <file>`              | Print full frontmatter block           | YAML only                 |
| `writer frontmatter get <file> <key>`         | Print one frontmatter value            | scalar or YAML fragment   |
| `writer frontmatter set <file> <key> <value>` | Update one frontmatter field           | rewrites YAML canonically |
| `writer spec create <title>`                  | Create a new spec from a template      | Writer-specific           |
| `writer spec validate [path]`                 | Validate one file or a whole directory | CI-friendly               |
| `writer completion <shell>`                   | Generate shell completions             | bash, zsh, fish           |

### Deferred commands

The following should not be part of the first implementation, but may be revisited later:

- `writer open`
- `writer grep`
- `writer outline`
- `writer spec format`
- `writer spec bundle`
- `writer spec links`

These are useful, but not necessary to make the first release valuable.

## CLI UX Rules

### Global behavior

- Use standard subcommand and flag syntax via `clap`.
- Print human-readable errors to stderr.
- Print command results to stdout.
- Avoid decorative formatting that makes shell usage awkward.
- Keep one result per line where possible.
- Paths should print relative to the resolved workspace root when practical, otherwise relative to the invocation directory.

### Supported global flags

These flags are recommended for v1:

- `--workspace <path>`: resolve relative operations against a specific workspace root
- `--quiet`: suppress non-essential success messages
- `--no-color`: disable colored diagnostics

V1 does not need `--json`, `--stdin`, or interactive prompts.

### Exit codes

- `0`: success
- `1`: validation failed
- `2`: invalid CLI usage
- `3`: runtime or IO failure

## Command Details

### `writer list [path]`

Purpose:

- list markdown files recursively beneath the target directory

Behavior:

- default path is current directory or `--workspace` if provided
- include `.md` and `.markdown`
- ignore hidden directories and files via the same traversal rules as workspace indexing
- return one relative path per line

Examples:

```bash
writer list
writer list specs
writer --workspace ~/work/project list docs
```

### `writer read <file>`

Purpose:

- print raw file contents to stdout exactly as stored on disk

Behavior:

- preserve frontmatter and body
- fail if the path does not exist or is not a markdown file

### `writer search <query>`

Purpose:

- fuzzy-search markdown files by relative path

Behavior:

- search within the resolved workspace root or current directory
- reuse the existing nucleo-based filename search where possible
- print one relative path per line in descending score order
- default result limit should be 20
- support `--limit <n>`

### `writer frontmatter show <file>`

Purpose:

- print the file's frontmatter block without the surrounding markdown body

Behavior:

- if no frontmatter exists, print nothing and exit `0`
- print YAML content without surrounding `---` delimiters to keep piping simple

### `writer frontmatter get <file> <key>`

Purpose:

- print one frontmatter field value

Behavior:

- if the key is missing, exit `3` with a clear error
- scalar values print on one line
- array or map values print as YAML fragments

### `writer frontmatter set <file> <key> <value>`

Purpose:

- set or create a frontmatter field

Behavior:

- if the file has no frontmatter, create one
- rewrite the YAML block into a canonical format
- preserve the markdown body unchanged
- support repeated `--tag <value>` style handling later, but v1 only needs single key/value updates

Example:

```bash
writer frontmatter set specs/login-flow.md status review
```

### `writer spec create <title>`

Purpose:

- create a new markdown spec using a built-in template

Required flags:

- `--template <feature|prd|decision>`

Optional flags:

- `--dir <path>`: destination directory, default `specs`
- `--status <value>`: default `draft`
- `--owner <value>`: may be repeated later, but v1 only requires single owner support
- `--tag <value>`: optional tag, may be repeated later if easy
- `--force`: overwrite if the destination file already exists

Behavior:

- generate a slug from the title
- write `<slug>.md` into the destination directory
- write frontmatter and template sections
- fail if the file exists unless `--force` is provided
- print the created path on success

### `writer spec validate [path]`

Purpose:

- validate a single file or every markdown file under a directory

Behavior:

- default path is current directory or `--workspace` if provided
- if the target is a file, validate only that file
- if the target is a directory, validate all markdown files recursively beneath it
- print one diagnostic per line
- return `1` when any validation issue is found
- return `0` when all checked files are valid

Example diagnostic format:

```text
specs/login-flow.md: missing required section "Acceptance Criteria"
specs/login-flow.md: invalid status "inprogress" (expected draft|review|approved|done)
specs/login-flow.md: broken link ./auth-overview.md
```

### `writer completion <shell>`

Purpose:

- generate shell completions using `clap_complete `

Supported shells:

- `bash`
- `zsh`
- `fish`

## Spec Template Model

The CLI only becomes meaningfully different from generic shell tooling if Writer defines a concrete spec shape. V1 should ship with three templates.

### Common frontmatter

Required fields:

- `title`: non-empty string
- `type`: one of `feature`, `prd`, `decision`
- `status`: one of `draft`, `review`, `approved`, `done`

Optional fields:

- `owners`: YAML list of strings
- `tags`: YAML list of strings

Canonical field order when creating or rewriting frontmatter:

1. `title`
2. `type`
3. `status`
4. `owners`
5. `tags`

### Common section rules

All spec templates should use H2 sections for major headings.

V1 validation should require exact H2 names for required sections. That constraint is intentionally strict to keep the first implementation deterministic.

Common required sections:

- `Summary`
- `Goals`
- `Non-Goals`

### Feature template

Required sections:

- `Summary`
- `Goals`
- `Non-Goals`
- `Requirements`
- `Acceptance Criteria`

Template body:

```md
---
title: Login flow
type: feature
status: draft
owners:
  - product
tags:
  - auth
---

## Summary

Describe the feature in 2-4 sentences.

## Goals

- Goal 1
- Goal 2

## Non-Goals

- Non-goal 1

## Requirements

- Requirement 1
- Requirement 2

## Acceptance Criteria

- [ ] Criterion 1
- [ ] Criterion 2
```

### PRD template

Required sections:

- `Summary`
- `Goals`
- `Non-Goals`
- `User Problems`
- `Requirements`
- `Acceptance Criteria`

Template body:

```md
---
title: Quarterly planning workspace
type: prd
status: draft
owners:
  - product
tags:
  - planning
---

## Summary

Describe the product decision or initiative.

## Goals

- Goal 1

## Non-Goals

- Non-goal 1

## User Problems

- Problem 1

## Requirements

- Requirement 1

## Acceptance Criteria

- [ ] Criterion 1
```

### Decision template

Required sections:

- `Summary`
- `Goals`
- `Non-Goals`
- `Context`
- `Decision`
- `Consequences`

Template body:

```md
---
title: Use local caching for search index
type: decision
status: draft
owners:
  - engineering
tags:
  - architecture
---

## Summary

State the decision at a high level.

## Goals

- Goal 1

## Non-Goals

- Non-goal 1

## Context

Explain the constraints and background.

## Decision

State the chosen approach.

## Consequences

- Consequence 1
- Consequence 2
```

## Validation Rules

### General markdown file rules

- Only validate `.md` and `.markdown` files.
- A validated file must parse as UTF-8 text.
- If frontmatter exists, it must be the first thing in the file.
- If frontmatter exists, it must be valid YAML.

### Required frontmatter rules

- `title` must exist and be non-empty.
- `type` must exist and match the expected template type.
- `status` must exist and be one of `draft`, `review`, `approved`, `done`.
- If present, `owners` must be a YAML list of strings.
- If present, `tags` must be a YAML list of strings.

### Required section rules

- Required H2 headings must exist exactly once.
- Headings are matched case-sensitively in v1.
- A required section must contain non-whitespace content.
- For templates with `Acceptance Criteria`, the section must contain at least one markdown list item.

### Internal markdown link rules

- Check standard markdown links of the form `[text](path.md)`.
- Ignore external URLs with a scheme such as `http:`, `https:`, or `mailto:`.
- Ignore bare fragment links such as `#section` in v1.
- Relative markdown links must resolve against the current file's directory.
- A broken internal markdown link is a validation error.

### Filename rules

- Created specs must use a slugged filename with `.md` extension.
- Validation may warn or fail on whitespace-heavy filenames, but v1 should keep this simple and only enforce the create path.

## Implementation Strategy

### Repo-level approach

Implement the CLI inside the existing Rust package instead of starting with a new workspace-wide refactor.

This keeps the work small enough for one agent and avoids unnecessary packaging complexity.

### Recommended Rust layout

Existing Tauri commands should delegate to reusable pure functions. New shared modules should live under `apps/desktop/src-tauri/src/`.

Recommended structure:

```text
apps/desktop/src-tauri/
  Cargo.toml
  src/
    bin/
      writer.rs
    core/
      mod.rs
      markdown.rs
      frontmatter.rs
      spec.rs
      workspace.rs
      output.rs
    commands/
      fs.rs
      search.rs
      ...
```

Suggested responsibilities:

- `core/markdown.rs`: basic markdown helpers, heading extraction, link extraction
- `core/frontmatter.rs`: parse, serialize, show, get, set
- `core/spec.rs`: templates, validation rules, diagnostic types
- `core/workspace.rs`: resolve workspace root, list markdown files, relative path helpers
- `core/output.rs`: plain-text diagnostic formatting
- `src/bin/writer.rs`: `clap`-based CLI entrypoint

### Dependencies

Add the following Rust dependencies if needed:

- `clap`
- `clap_complete`
- `serde_yaml`
- optionally `regex-lite` for lightweight markdown parsing if existing string scanning is too brittle

### Parsing strategy

V1 should use pragmatic parsing, not a full markdown AST.

That means:

- detect frontmatter with a simple line-based parser
- parse YAML using `serde_yaml`
- detect H2 headings with line scanning
- detect markdown links with a small regex or scanner

This is sufficient for the first release and small enough for one agent.

### Frontmatter rewrite strategy

`frontmatter set` may rewrite the entire frontmatter block into canonical YAML order. Preserving comments or custom formatting is not required in v1.

This tradeoff is acceptable because:

- it keeps the implementation simple
- it reduces edge cases
- it still preserves markdown body content exactly

### Search strategy

Reuse the existing markdown workspace indexing approach where practical.

- `list` can reuse recursive ignore-aware traversal logic
- `search` can reuse nucleo-based fuzzy matching on relative paths

### Validation strategy

Represent validation issues as a simple internal diagnostic struct with:

- file path
- optional line number
- message

No JSON serializer is needed.

## Files Expected To Change

- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/src/commands/fs.rs`
- `apps/desktop/src-tauri/src/commands/search.rs`
- `apps/desktop/src-tauri/src/error.rs`
- `apps/desktop/src-tauri/src/core/mod.rs`
- `apps/desktop/src-tauri/src/core/markdown.rs`
- `apps/desktop/src-tauri/src/core/frontmatter.rs`
- `apps/desktop/src-tauri/src/core/spec.rs`
- `apps/desktop/src-tauri/src/core/workspace.rs`
- `apps/desktop/src-tauri/src/core/output.rs`
- `apps/desktop/src-tauri/src/bin/writer.rs`
- new Rust tests under `apps/desktop/src-tauri/tests/` or adjacent unit test modules

The Tauri UI code should not need meaningful changes for this feature.

## Single-Agent Execution Plan

The implementing agent should follow this sequence and finish the work in one pass.

1. Add the CLI and YAML dependencies to `Cargo.toml`.
2. Create shared `core` modules and move or wrap reusable filesystem and search logic so both Tauri commands and the CLI can call them.
3. Implement markdown helpers for frontmatter extraction, heading scanning, and link detection.
4. Implement frontmatter operations: show, get, and set.
5. Implement built-in template generation for `feature`, `prd`, and `decision`.
6. Implement validation rules and plain-text diagnostics.
7. Implement the `clap` CLI binary with the v1 command surface.
8. Add unit tests for frontmatter parsing, template generation, heading extraction, link checking, and validation.
9. Add integration tests for the CLI commands against temp markdown workspaces.
10. Run formatting, tests, and linting for the Rust package.
11. Update docs or README only if needed to explain CLI usage.

## Test Plan

### Unit tests

Add tests for:

- frontmatter detection with and without body content
- frontmatter set on files with and without existing YAML
- heading extraction for exact required H2 headings
- internal markdown link extraction and resolution
- feature template validation success
- missing section failures
- invalid status failures
- broken internal link failures

### CLI integration tests

Use temporary directories and real filesystem fixtures to test:

- `writer list` returns markdown files only
- `writer read` prints exact file content
- `writer search` returns fuzzy matches in score order
- `writer frontmatter show` prints YAML block content
- `writer frontmatter get` returns a single field
- `writer frontmatter set` updates YAML and preserves body
- `writer spec create` creates the correct file and template
- `writer spec validate` returns `0` for valid specs
- `writer spec validate` returns `1` and diagnostics for invalid specs

### Verification commands

From `apps/desktop/src-tauri/`, the agent should run:

```bash
cargo fmt
cargo test
cargo clippy --all-targets --all-features
```

## Risk Review

### Main risks

- frontmatter rewriting can change YAML formatting unexpectedly
- markdown heading detection can be too strict or too loose
- link validation can misclassify external or fragment links
- trying to support too many commands will blow up scope

### Mitigations

- explicitly allow canonical YAML rewrite in v1
- require exact H2 names for deterministic validation
- keep internal link rules narrow and ignore unsupported link types
- defer `open`, `grep`, `outline`, and bundling features
- keep the implementation inside one Rust package instead of over-architecting

## Acceptance Criteria

- A user can create a new spec from the terminal with `feature`, `prd`, and `decision` templates.
- A user can inspect and update markdown frontmatter from the terminal.
- A user can validate a single spec file or a full directory of specs.
- Validation failures are easy to read and produce exit code `1`.
- The CLI works without the desktop app running.
- No JSON output is introduced.
- The implementation is completed within the existing Rust package and is small enough for one agent to deliver end to end.

## Future Follow-Ups

These are intentionally out of scope for this spec, but are natural next steps if the first CLI release lands well:

- `writer open` to launch or focus the desktop app on a file or workspace
- `writer grep` for content search
- `writer outline` for heading inspection
- `writer spec format` for canonical markdown formatting
- `writer spec bundle` for flattening linked markdown into a single `.md` artifact
- a later decision on HTTP API and MCP support once the core CLI surface proves useful

## The `writer` command surface

Obsidian command parity is not a goal (ADR [2026-11-19](../docs/decisions/2026-11-19-prune-the-writer-cli-to-one-command-per-job.md)): the grammar below stays, and every job has one command; see [Removed commands](#removed-commands). Status: implemented (see [Implementation status](#implementation-status) for the per-command table and the deviations). The vault index (Phase 0 of [obsidian-bases-spec.md](./obsidian-bases-spec.md), `apps/desktop/src-tauri/src/index/`) is implemented and exposes `Index::open_for_cli(root, app_data_dir)`; the commands below are built on it and on the Rust Bases engine (`base_query`, same spec).

### What this supersedes

For the commands in this section only (the legacy commands are untouched):

- "No JSON output" and "markdown only": the commands accept `format=` values (`json`, `csv`, `tsv`, `md`, `yaml`, `text`, `tree`, `paths`) exactly where Obsidian lists them. Defaults follow Obsidian's.
- "Under ten top-level commands": the surface is the list below.
- Plain `--flag` syntax: parity commands use Obsidian's syntax, `writer [vault=<name|id|path>] <command> [param=value ...] [flag ...]`. Legacy commands keep clap-style `--flags`. The dispatcher decides by command name: a name in the parity list (or containing `:`) takes the Obsidian grammar.
- "No non-markdown output": `read` and friends print the raw file; `format=md` prints a markdown table.

The grammar was modelled on the public Obsidian CLI docs, https://obsidian.md/help/cli (clean-room: no Obsidian application code is read). The command list is Writer's own.

### Syntax (exactly like the public docs)

- `writer <command> [param=value ...] [flag ...]`. Parameters are `name=value` (quote values with spaces). Flags are bare words (`overwrite`, `total`, `verbose`, `inline`, `case`, `done`, `todo`, `permanent`, `counts`, `open`).
- `vault=<name|id|path>` must be the first argument. Default vault: the nearest ancestor of the working directory that contains `.obsidian`, else the working directory itself (decision amended: the recents list is not a default). `vault=` takes a path (contains a separator, `.`, `..` or starts with `~`), else a recent Writer workspace by id or by folder name (read-only, `recent_workspaces.json` in the app data directory; an ambiguous name fails and lists the candidates), else a folder of that name in the working directory. Writer has no vault ids; `id` is the 16 hex characters of the index file name (`writer vaults verbose` prints them).
- `file=<name>` resolves like a wikilink (no folder, no extension), through `Index::resolve_link` (rules in the Bases spec 4.1.3 and `index/resolve.rs`). `path=<path>` is the exact vault-relative path. Without either, commands that need a file fail with a usage error (Writer has no active file when run headless; the `active` flag and `daily*` are app-control and out of scope).
- `--copy` copies the command output to the clipboard in addition to printing it (macOS `pbcopy`, Linux `wl-copy`/`xclip`, Windows `clip`); a missing clipboard tool is an error, not silently ignored.
- Multiline `content=` accepts `\n` and `\t` escapes.
- Output: stdout only for results; errors on stderr; exit codes `0` ok, `1` failure or invalid input (not found, refused write, unparsable frontmatter, lock contention), `2` usage (unknown command/parameter/flag, missing required parameter, app-control command), `4` Writer is not running (a command that needs the app found none). The launcher keeps its legacy code `3` for launch failures.
- The app does not need to run. The CLI opens the same SQLite index file as the app (derived from the release identifier `com.writer-computer`, override with `WRITER_INDEX_DIR`), refreshes it with the warm diff (mtime, size, hash), then queries. Writes (`create`, `append`, `prepend`, `move`, `rename`, `delete`, `property:set/remove`, `task:*`) go straight to the files, never through the index, never to `.obsidian`.

### Commands to implement

| Group      | Command                                                                                                                                                                             | Parameters / flags (as in Obsidian's docs)                                                                                                                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vault      | `vault`, `vaults`                                                                                                                                                                   | `info=name\|path\|files\|folders\|size`; `total`, `verbose`                                                                                                                                                                                                                                       |
| Files      | `file`, `files`, `folder`, `folders`                                                                                                                                                | `file`/`path`; `folder`, `ext`, `total`; `folder path= info=files\|folders\|size`                                                                                                                                                                                                                 |
| Content    | `read`, `create`, `append`, `prepend`, `move`, `title`, `delete`                                                                                                                    | `create name= path= content= template=` + `overwrite`; `append/prepend content= heading=` + `inline`; `move to= name=` (move, rename or both); `title set=` or `clear` (+ `dry-run`, `no-update-links`: the display title, see `SPECs/filename-links-and-rename-spec.md`); `delete` + `permanent` |
| Search     | `search`, `search:context`                                                                                                                                                          | implemented                                                                                                                                                                                                                                                                                       | full-text over the vault index (SQLite FTS5, [`search-spec.md`](search-spec.md)), best match first: whole words, `word*` prefix, `"phrase"`, `-exclude`, `a OR b`, `tag:`/`path:`/`file:`/`kind:`/`ext:` filters (kinds `note`, `pdf`, `code`, `drawing`, `image`, `base`: PDFs, code files and drawings are searched by content too; `search:context` prints `path:p3: text` for a PDF page), diacritics folded, CJK per character; `query=/regex/` stays an explicit regex scan (regex-lite, no lookaround, path order); `case` (exact spelling, checked on the file text), `path=<folder>`, `limit=` (files for `search`, lines for `search:context`), `format=text\|json`, `total`. Not Obsidian's full search syntax (no groups, `line:`, `section:`, `[property:value]`, substring matching) |
| Properties | `properties`, `property:set`, `property:read`, `property:remove`                                                                                                                    | `properties name= sort=count format=yaml\|json\|tsv total counts types`; `property:set name= value= type=text\|list\|number\|checkbox\|date\|datetime`;                                                                                                                                           |
| Tags       | `tags`, `tag`                                                                                                                                                                       | `tags sort=count format=json\|tsv\|csv total counts`; `tag name= total verbose`                                                                                                                                                                                                                   |
| Tasks      | `tasks`, `task:add`, `task:done`, `task:edit`                                                                                                                                       | `tasks status= format=json\|tsv\|csv` + `total done todo verbose`; `task:add text= due= ...`, `task:done ref=`, `task:edit ref= status= due= ... clear=` (feature `tasks`)                                                                                                                        |
| Graph      | `graph:neighbors`, `graph:path`, `graph:relationships`, `graph:backlinks`, `graph:related`, `graph:hubs`, `graph:components`, `graph:orphans`, `graph:deadends`, `graph:unresolved` | every one takes `format=text\|json\|tsv (default text)` and `limit=`; `graph:neighbors direction=in\|out\|both depth= kind= label=`; `graph:orphans` + `incoming`; spec `note-graph-spec.md`                                                                                                      |
| Structure  | `outline`, `wordcount`                                                                                                                                                              | `outline format=tree\|md\|json (default tree)`; `wordcount` + `words characters`                                                                                                                                                                                                                  |
| Bases      | `bases`, `base:views`, `base:create`, `base:query`                                                                                                                                  | `base:create file= path= view= name= content=`; `base:query file= path= view= format=json\|csv\|tsv\|md\|paths (default json)`                                                                                                                                                                    |
| Agent      | `project:archive`, `project:unarchive`                                                                                                                                              | `project:archive path=<project folder>`; `project:unarchive path=<archived project folder>`; the app's `project::archive`, no chat check (see below)                                                                                                                                              |
| Icons      | `icon:set`, `icon:get`, `icon:remove`                                                                                                                                               | `icon:set path=\|file= icon=emoji:<emoji>\|icon:<Hugeicons name> color=#rrggbb`; `icon:get path=\|file= format=text\|json` (exit 1 when none); `icon:remove path=\|file=`; feature `icons`, [`icons-spec.md`](icons-spec.md)                                                                      |
| Meta       | `help`, `version`                                                                                                                                                                   | `help [command]`, `version`                                                                                                                                                                                                                                                                       |

Agent projects (feature `agent`, so `features.agent.enabled` gates them): `writer project:archive path=Projects/Client` flags the project (`copilot-project-archived-at`, `writer-project-archived-from`) and moves its whole folder into the archive folder (global setting `agent.projects-archive-folder`, read from the app's config file; blank means `Archive/Projects`; a taken name gets " 2", " 3"); `project:unarchive path=Archive/Projects/Client` moves it back to where it came from and clears both keys. It is the same `agent::project::archive` function as the app's button, and prints `Archived <from> -> <to>`. The CLI has no chat sessions to check, so a chat running in the project in the app is the user's to stop first (the app refuses while a turn or a permission is open). Spec: [`native-agent-spec.md`](native-agent-spec.md) section 4.6.

Data sources: `files/folders/file/folder/vault*` are `query_files`, `list_folders`, `vault_summary`; `properties`, `property:read`, `tags`, `tag`, `tasks`, the `graph:*` commands, `outline` (headings), `wordcount` (words, chars) read the index tables; `search`/`search:context` query the `notes_fts` full-text table (and read the file text for line numbers; `/regex/` still scans note text); `base:*` run the Rust Bases engine over the index.

### Removed commands

One command per job. A removed name exits 2 and names its replacement (`REMOVED` in `cli/registry.rs`, the one table); `help` prints each group once, core and feature commands merged.

| Removed              | Use instead                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `links`              | `graph:neighbors file=<name> direction=out depth=1`                                           |
| `backlinks`          | `graph:backlinks`                                                                             |
| `orphans`            | `graph:orphans incoming` (nothing links to the note); plain `graph:orphans` is no link at all |
| `deadends`           | `graph:deadends`                                                                              |
| `unresolved`         | `graph:unresolved`                                                                            |
| `rename`             | `move file=<name> name=<new name>`                                                            |
| `task`               | `tasks` to list; `task:add`, `task:done`, `task:edit` to change                               |
| `excalidraw:connect` | `excalidraw:add` with `edges`                                                                 |

Output formats changed where the survivor is richer: the graph commands print a header and take `format=text|json|tsv`; `total`, `counts` and `verbose` are gone (use `format=json` and count). `task`'s done, toggle, reopen and `status=` are `task:done` and `task:edit status=<symbol|name>` (a symbol `x`, space, `/`, `-` or a custom one of the vault, or a name `done`, `todo`, `in-progress`, `cancelled`; `todo` reopens a done task and clears its done date through the tasks feature's one write path, an unknown status exits 1 naming the valid ones); there is no toggle.

### Out of scope (explicit)

App-control and application-state commands from the public list: `vault:open`, `search:open`, `daily*`, `templates`/`template:*`, `bookmark*`, `diff`, `history*`, `sync*`, plugin/theme/publish/workspace/web/developer commands, and the `active` and `daily` flags. They need a running Obsidian-style app or features Writer does not have. Reconsider only on explicit request. (`open` is not in this list any more: it, `reveal`, `status` and the `active` command are the app commands of "Talking to the running app" below; the `active` and `daily` _flags_ of other commands stay refused.)

### Implementation notes

- The parity grammar lives in one module (`writer_cli.rs` stays the launcher; a new `cli/` module owns argv parsing for parity commands with a registry of command specs: name, parameters, flags, formats, handler). Adding a command is one registry entry plus its handler (consolidation rule).
- Formatting (`json/csv/tsv/md/yaml/text/tree/paths`) is one shared formatter set over a table/tree value; commands return structured values, never strings.
- `property:set` and the `task:*` commands edit the file text surgically (frontmatter line patch, one task line) so unrelated bytes, comments and key order are preserved; unparsable frontmatter is an explicit error.
- Tests: CLI integration tests against the fixture-vault builder used by the index tests, with `WRITER_INDEX_DIR` pointing at a temp dir; no real user vault is ever used.

### Implementation status

Code: `apps/desktop/src-tauri/src/cli/` (grammar `args.rs`, one registry entry per command in `registry.rs`, shared table formatter `format.rs`, vault resolution `vault.rs`, handlers `cmd_*.rs`, link rewriting `linkfix.rs`, clipboard `clipboard.rs`, tests `tests.rs`). `writer_cli.rs` hands argv to `cli::` when the first argument is `vault=...` or a command name from the registry (so a folder literally named `files` must be opened as `writer ./files`). Property edits use `index/patch.rs` through `vault_ops.rs`, the same function the Tauri commands use. Dependencies added: none.

| Command                                                                                                                                                                                                                                      | Status      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault`, `vaults`                                                                                                                                                                                                                            | implemented | `vault` prints `key<TAB>value` lines (name, path, files, folders, size) or one value with `info=`; `vaults` lists existing recent workspaces (`verbose`: name, id, path)                                                                                                                                                                                                                                                                                                                                                                                          |
| `files`, `folders`                                                                                                                                                                                                                           | implemented | `folder=`, `ext=`, `total`; one path per line; `folders` only knows folders that contain files                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `file`                                                                                                                                                                                                                                       | implemented | `path`, `name` (without extension), `extension`, `size`, `created`, `modified` (epoch ms), tab separated                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `folder`                                                                                                                                                                                                                                     | implemented | `info=files\|folders\|size`; default prints path, files (recursive), folders (sub-folders), size                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `read`                                                                                                                                                                                                                                       | implemented | raw file text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `create`                                                                                                                                                                                                                                     | implemented | `.md` is appended unless present; no name gives `Untitled`, `Untitled 1`, ...; `template=` is a note in the vault (Writer has no templates folder) whose text is the start, `content=` is appended; `open`/`newtab` print a note on stderr and continue                                                                                                                                                                                                                                                                                                           |
| `append`, `prepend`                                                                                                                                                                                                                          | implemented | `heading=` (`Plan` or `## Plan`, first match, fence-aware), `inline`; prepend goes after the frontmatter                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `move`                                                                                                                                                                                                                                       | implemented | (`to=` moves, `name=` renames, both together do both; details and flags `dry-run`, `no-update-links`, `format=json`: `SPECs/filename-links-and-rename-spec.md`) rewrites wikilinks, embeds (`![[x]]`) and markdown links to the file in every note that links to it, frontmatter links included, keeping each link's style, `#heading` and `\|alias`; the moved note's own relative links are re-relativised. Links in code spans and fences are untouched. Always on (there is no setting to turn it off). `to=` with no extension or a trailing `/` is a folder |
| `delete`                                                                                                                                                                                                                                     | implemented | OS trash through the `trash` crate; on failure nothing is deleted and the error says so (no silent fallback); `permanent` removes the file                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `search`, `search:context`                                                                                                                                                                                                                   | implemented | plain case-insensitive substring or `/regex/` (regex-lite, no lookaround) over note text and, for `search`, file names; `case`, `path=<folder>`, `limit=` (files for `search`, lines for `search:context`), `format=text\|json`, `total`. Not Obsidian's full search syntax (operators, `tag:`, `file:`)                                                                                                                                                                                                                                                          |
| `properties`, `property:set`, `property:read`, `property:remove`                                                                                                                                                                             | implemented | vault-wide listing from the index (`counts`, `sort=count`, yaml is a list of names or `name: count`), per-file listing from the file; `property:set` keeps the property's existing type when `type=` is absent (new properties are text); `counts`/`sort` with a file are a usage error                                                                                                                                                                                                                                                                           |
| `tags`, `tag`                                                                                                                                                                                                                                | implemented | tags print as `#tag`, lowercase (the index does not keep display case), nested tags also count for their ancestors; csv/tsv/json carry no header; `tag` prints `#tag<TAB>count`, `verbose` adds the files (interpretation: the docs do not show the default output)                                                                                                                                                                                                                                                                                               |
| `tasks`                                                                                                                                                                                                                                      | implemented | `tasks`: `path:line: [status] text`, `verbose` groups by file, `done` = status `x`/`X`, `todo` = anything else                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `graph:neighbors`, `graph:backlinks`, `graph:unresolved`, `graph:orphans`, `graph:deadends`                                                                                                                                                  | implemented | text (a header row, then one note per line), json or tsv; `graph:neighbors direction=out depth=1` is the outgoing links; `graph:orphans` is no link in or out, `incoming` relaxes it to no incoming link; `graph:unresolved` has `link`, `count` and `sources`                                                                                                                                                                                                                                                                                                    |
| `outline`, `wordcount`                                                                                                                                                                                                                       | implemented | outline from the index (ATX headings only); `wordcount` prints `words<TAB>n` and `characters<TAB>n`, one bare number with `words` or `characters`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bases`, `base:views`, `base:query`                                                                                                                                                                                                          | implemented | `file=Name` also finds `Name.base`; `format=json` is an array of objects keyed by column id (plain values: dates as ISO strings, links as paths), csv/tsv/md carry a header of display names and the cells' display strings, paths lists the row files; grouped views are flattened in group order; a filter error, a view that is not found or an unparsable `.base` is exit 1 with the message                                                                                                                                                                  |
| `base:create`                                                                                                                                                                                                                                | partial     | creates a note named `name=` in the folder of the view's `file.inFolder(..)` filter, sets `prop == literal` conjuncts as properties and a single `file.hasTag(x)` as `tags`; other filters are not satisfied by construction                                                                                                                                                                                                                                                                                                                                      |
| `help`, `version`                                                                                                                                                                                                                            | implemented | `help <command>` and `<command> --help`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `open`, `vault:open`, `search:open`, `daily*`, `template*`, `bookmark*`, `diff`, `history*`, `sync*`, `plugin*`, `theme*`, `snippet*`, `publish*`, `workspace*`, `tab*`, `web`, `dev*`, `command*`, `hotkey*` and the `active`/`daily` flags | skipped     | `Not available in the Writer CLI: <cmd>` on stderr, exit 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Deviations from the Obsidian CLI, and why:

- No active file or active vault: commands that default to the active file require `file=` or `path=` (usage error otherwise); the vault defaults to the working directory.
- Output shapes the public page does not show (`files`, `tag`, `tags`, `tasks` text, `vault`, `folder`, `wordcount`, `search` text) are my reading of it; they are stable and listed above, but may differ from Obsidian's exact bytes. The `file` command separates key and value with a tab.
- `tags` lists tag names lowercased; `base:query` `file.tags` lists tags as written without the ancestors the index also stores, links to the same file (`[[#Heading]]`) are not in `file.links`.
- `search` is not Obsidian's search language (see the table and [`search-spec.md`](search-spec.md)). A phrase needs the doubled quotes the argument parser strips once: `query='""two words""'`.
- Exit code `1` also covers invalid input values; legacy `writer <path>` keeps `3`.
- Writes use the app's atomic write (temp file and rename); the app does not need to run, but a note open in the app with unsaved edits is not coordinated by the CLI.
- Unverified: no run against the real app or GUI; the CLI and the app writing the same index database at the same time (the open lock waits at most 15 seconds and fails with a message, SQLite's busy timeout is 10 seconds and is reported as "index busy"); clipboard tools on Linux and Windows; the OS trash on Linux and Windows.

## Talking to the running app

Decision: [ADR 2026-11-18](../docs/decisions/2026-11-18-let-the-writer-cli-talk-to-the-running-app-over-a-local-authenticated-socket.md). Code: `src-tauri/src/ipc/` (Tauri-free), `cli/cmd_app.rs`, `commands/ipc.rs` (glue), `src/hooks/use-ipc-requests.ts` and `src/lib/features/ipc-requests.ts` (the window's half). Vectors: `shared/ipc-vectors.json`.

Four commands (group **App**) need the running app; every other command stays headless:

| Command  | Params and flags                                            | Does                                                                                                                   |
| -------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `status` | `format=text\|json`                                         | Writer's version, the open vaults, whether this vault is open. Works outside a vault.                                  |
| `open`   | `file=`/`path=`, `line=` or `anchor=`, `newtab`, `--launch` | Open the file in the vault's window through the window's own open path (the one links and quick open use); focuses it. |
| `reveal` | `file=`/`path=` (a folder too)                              | Reveal the entry in the sidebar, showing the sidebar when hidden.                                                      |
| `active` | `format=text\|json`                                         | The vault window's active tab: vault-relative `path`, tab `kind`, cursor `line`. Never note text or the selection.     |

With no app (no token file, no socket, or a socket nobody listens on) they print `writer: Writer is not running` and exit **4** (distinct from usage `2` and failure `1`). `open --launch` starts the app on the vault through the launcher (`open -a Writer <vault>`, which the single-instance path handles), polls for the socket for up to 20 s, then sends the request; a launch that fails is exit 1, an app that never opens its socket exit 4. `--launch` is the only `--` flag besides `--copy` and `--help`, and only commands that list it take it.

### Excalidraw commands

Group **Excalidraw**, contributed by the `excalidraw` feature (`feature: Some("excalidraw")`, so they say "turned off" when the feature is off). Spec: [`excalidraw-spec.md`](./excalidraw-spec.md).

| Command              | Params and flags                             | Does                                                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `excalidraw:create`  | `path=`, `spec=` (JSON), `--overwrite`       | New drawing from a spec of boxes (`nodes`), arrows (`edges`) and `groups`, `direction` `LR` or `TB`, laid out without overlaps.                                                                                                          |
| `excalidraw:add`     | `file=`/`path=`, `spec=`                     | Add a block of boxes and arrows below the existing ones; an open tab draws it in.                                                                                                                                                        |
| `excalidraw:update`  | `file=`/`path=`, `spec=`                     | Change boxes by id (`text`, `shape`, `color`, `x`/`y`, `w`/`h`), re-label or recolour arrows `[from, to]`, `remove` boxes and arrows.                                                                                                    |
| `excalidraw:read`    | `file=`/`path=`                              | The drawing as a spec (boxes, arrows, groups), never the compressed data.                                                                                                                                                                |
| `excalidraw:export`  | `file=`/`path=`, `format=svg\|png`, `scale=` | Asks the running app for `<name>.svg` (default) or `<name>.png` next to the drawing (socket command `excalidraw:export`; exit 4 when Writer is not running).                                                                             |
| `excalidraw:preview` | `file=`/`path=`, `format=png\|svg`, `scale=` | Renders the drawing through the running app to `writer-previews/` in the OS temp dir (outside the vault) and prints the absolute path, for an agent to look at (socket command `excalidraw:preview`; exit 4 when Writer is not running). |

Writes keep unknown sections and front matter byte for byte and never touch `.obsidian/`.

### The channel

- **Endpoint.** Unix: `ipc/ipc.sock` and `ipc/ipc.token` in a dedicated `ipc/` folder of the app data dir, the folder `0700` (created if missing, mode corrected if wrong; the app data dir itself is never chmod-ed), the socket and token `0600`; the server also checks the peer's uid. Windows: the named pipe `\\.\pipe\writer-<hash of the user SID>` created with the descriptor `D:P(A;;GA;;;<user SID>)`, remote clients rejected, first instance exclusive (`ipc/windows.rs`, no new crate, never compiled or run on Windows so far). One server per app process, started after the features and stopped at exit (`RunEvent::Exit`), which removes the socket and the token. At startup a socket that refuses connections is stale and is unlinked; one that answers belongs to a live Writer and is left alone (no second server); a path that is not a socket is never deleted; a socket path over 100 bytes (macOS allows 104) is refused with an error naming the too-long data dir; a test checks the real default path fits. A launch that cannot make the endpoint safe runs without the socket and logs a warning.
- **Token.** A fresh `uuid` v4 per launch, written atomically (`plugins::write_atomic_private`, `0600` from creation) after the old token is deleted and before clients can use the new socket. Compared in constant time. A wrong or missing token gets one generic `unauthorized` and the connection closes; nothing else (command, version, vault) is looked at first. The client re-reads the token once on `unauthorized` (the app restarted in between).
- **Protocol.** One JSON object per line, UTF-8, at most 64 KiB, read within 5 s; one request and one answer per connection. Request `{"v":1,"id","token","cmd","vault","args"}`, answer `{"v":1,"id","ok":true,"result"}` or `{"v":1,"id","ok":false,"error":{"code","message"}}`. Codes: `bad_request`, `unauthorized`, `unsupported_version`, `unknown_command`, `feature_off`, `vault_not_open`, `invalid_args`, `invalid_path`, `not_found`, `timeout`, `too_large`, `unavailable`, `internal`. An unknown `v` or `cmd` is refused; at most 16 connections are served at once. An answer over 64 KiB becomes `too_large`.
- **Commands are a registry**, `ipc::commands::CORE` (`status`, `open`, `reveal`, `active`) plus what the running features contribute through `Feature::ipc_commands` (named `<feature id>:<name>`, `feature: Some(id)`, a contract test enforces both and that no core name is taken). A contributed command answers `feature_off` while its feature is off or failed and does not exist when the feature did not start. Each command has its own deadline (default 5 s, `open` 15 s because it may have to create and load a window; the client waits the same time) and runs in its own task: an overrun is `timeout`, a panic fails the feature like any other boundary (`features::fail_ipc_command`).
- **Vault and paths.** `vault` is an absolute path, canonicalised by the server. Each command declares how it uses it: `status` optionally, `reveal` and `active` require it open (`vault_not_open`), `open` opens its window when closed (`commands/ipc.rs` uses the same `open_new_workspace_window` a second `writer <folder>` uses). Every path argument is vault-relative and goes through `Call::confine_existing` (`vault_ops::confine`: no `..`, no absolute path outside, no symlink out, never `.obsidian` or `.git`) and must exist (a file for `open`). No command writes a note or runs code.
- **How a window is asked.** Core commands do not touch the UI from Rust: the glue emits `ipc:request` `{id, topic, payload}` to the vault's window; its web half (`use-ipc-requests.ts`) runs the handler registered for the topic (`ipcRequestHandlers`: core's `open`, `reveal`, `active`, and feature contributions) and answers with `ipc_reply`. A window announces `ipc_ready` once its startup has resolved; a request for a window that is not ready waits (inside the command's deadline), and only the window that was asked can answer (`ipc/bridge.rs`). `open` goes through `openFileAtLine` (with `line=`) or `openPathAtAnchor`, `active` reads the tab store and the live editor's selection line, and the server cuts whatever the window answers down to `path`, `kind` and `line` again.
- **Features.** A feature adds a command in Rust (`Feature::ipc_commands`, a plain async handler over `ipc::Call`) and its answer in the web half (`contributes.ipcRequests: [{ id: "<feature>.<name>", topic: "<feature>:<name>", handle }]`, activated on the first request, removed with the feature). The test-only fixture feature (`features/fixture.rs`, `fixture-hello:greet`) exercises both; the Excalidraw feature will add `excalidraw:export` (30 s deadline).
- **Logging.** One `info` line per connection (`target: "ipc"`): the command's registered name (`-` when it never got that far), the outcome (`ok` or the error code) and the duration. Never arguments, paths, contents, the client's own command string or the token ([`local-logging-spec.md`](local-logging-spec.md) "IPC").

### Tests

`ipc/tests.rs` (Rust, over an in-memory stream with a fake host, and a real Unix socket in a temp dir): the shared vectors both ways, endpoint modes (`ipc/` `0700`, files `0600`, a wrong mode corrected, the data dir untouched), stale and live sockets, token rotation, wrong or missing token, oversized and late requests, unknown version and command, each command's confinement (`../`, absolute, symlink out, `.obsidian`, missing, folder for `open`), `active` without text, deadlines and panics, feature commands registered and removed with the feature (`features/ipc_tests.rs`, `contract_tests.rs`), log content, the bridge, the client (not running, stale socket, timeout, rotated token), and the CLI (exit 4 and message, usage errors first, `open --launch` starting, not starting, failing and never coming up). jsdom: `tests/ipc-requests.test.tsx`, `tests/features-ipc-requests.test.ts`.

### Not verified

The Windows pipe, a second OS user being refused, `writer status`/`open`/`active` against the built app, window focus and the timing of `--launch` and of a window `open` creates.

## Spelling

`writer check path=Note.md [lang=fr] [format=text|json]` (group "Spelling", contributed by the built-in feature `spellcheck`, so it exists only while the feature is on). It runs the same engine as the editor ([`spellcheck-spec.md`](spellcheck-spec.md)): text output is one `path:line:column kind rule "word" message -> suggestions` row per finding (columns in characters), then a "no dictionary for <lang>" row per language nobody could check, JSON carries UTF-16 `start` and `end`, `kind`, `ruleId`, `replacements` and `missingLanguages` (languages with no installed dictionary). Settings come from the global config file and the personal dictionary from the vault's `.writer/dictionary.txt`; nothing is written and no network is used. Tested end to end in `features/spellcheck/rust/tests.rs`.

## Launcher for the agent pane

The agent pane's `claude` process gets a `writer` command without any user setup: Writer links `<app data>/bin/writer` to its own binary and puts that directory first on the child's PATH. It does not replace the optional "Install 'writer' Command Line Tool" symlink. Details and tests: [`native-agent-spec.md`](native-agent-spec.md) "Writer CLI for the agent".

## MCP server (`writer mcp`)

`writer [vault=<name|id|path>] mcp` serves the command registry as MCP tools on stdin and stdout, for the agent pane (decision: [`docs/decisions/2026-11-19-serve-the-writer-cli-as-an-mcp-server-to-the-agent.md`](../docs/decisions/2026-11-19-serve-the-writer-cli-as-an-mcp-server-to-the-agent.md); the agent side is in [`native-agent-spec.md`](native-agent-spec.md) "Writer CLI for the agent"). It is a command of its own (group Meta), not a tool. Code: `cli/mcp.rs`; no dependency (a hand-written JSON-RPC 2.0 subset).

- **Protocol.** One JSON object per line, in and out. `initialize` (answers the client's `protocolVersion` when it is 2025-06-18, 2025-03-26 or 2024-11-05, else the newest; capabilities: `tools`, no list change), `notifications/*` (no reply), `ping`, `tools/list`, `tools/call`. Anything else is error -32601. A request without an `id` gets no reply. `vault=` (or the working directory) is resolved once at start; no vault is a normal CLI failure and exit 1 before any output. Stdout carries protocol lines only.
- **Input limits.** A line is read without buffering more than 4 MiB (`MAX_MESSAGE_BYTES`); a longer one is dropped whole and answered with -32600 and `id` null, then the loop goes on. A line that is not UTF-8, not JSON (-32700), a batch, or not an object (-32600) is answered the same way. Only an I/O error on the pipes or the end of input stops the loop. A rejected message is logged by size only; arguments and results are never logged.
- **Tools.** `tool_specs` is `registry::commands()` minus `help`, `version`, `mcp` and `skills:sync`, minus the commands of a feature whose switch is off (the same `feature_off` gate as the command line, read at every list and call). The name is the command's with `:` written `_` (`graph:backlinks` is `graph_backlinks`; the agent sees `mcp__writer__graph_backlinks`). The description is the summary; the input schema (`additionalProperties: false`) has a string per parameter (its description, `required` for the required ones; `format` carries an `enum` of the command's formats) and a boolean per flag. No tool list is written by hand: a test asserts the list equals the registry minus the exclusions, a second one that every schema follows its `CommandSpec`.
- **Calls.** A call builds an `Invocation` and runs `cli::execute_invocation`, the same validation, feature gate and handler as `execute` (which is now parse + `execute_invocation`); values are taken as they are (no `\n` unescaping, no quote stripping), numbers and booleans become their text, `null` is "not given", the vault is the server's (`vault` is not an argument). Exit 0 returns stdout as one text content (a second one for stderr warnings); any other exit is `isError: true` with the error line without its `writer: ` prefix. A bad argument is an `isError` result the model can read, an unknown or excluded tool name or malformed `params` a JSON-RPC error -32602. One result is cut at 200 KiB with a note.
- **Read or write.** `CommandSpec::writes` is set on every command by the `cmd!` macro (`reads` or `writes`; leaving it out does not compile). Tool annotations: `readOnlyHint` is `!writes`, `destructiveHint` true on write tools, `openWorldHint` false. `open` and `reveal` count as writes (they move the user's window), so they ask. `mcp::tools()` lists every tool as a neutral `ToolSpec { name, writes }`; each agent backend's `ToolsAdapter` names them and turns the read ones into its permission rules (`agent/mcp_wiring.rs`, spec `native-agent-spec.md` "Writer CLI for the agent").
- **Tests** (`cli/mcp.rs`): initialize, ping and notifications, `tools/list` against the registry, schema per spec, valid unique names, the write set, success and failure calls, verbatim values, unknown tool / method / params, malformed and oversize input with the loop continuing, the cut, feature off, no vault; plus the fake-claude end to end in `tests/agent_fake_claude.rs`.

## `writer dql` (Dataview feature)

`writer dql query="TABLE file.name FROM #todo" [file=<note>|path=<note>] [format=json|csv|md|tsv|paths]` runs a Dataview query on the vault index with the same Rust engine as the note blocks and prints the rows; `file`/`path` sets `this`. Errors print the DQL line and column and exit non-zero. Provided by the `dataview` feature (absent when it is off); documented in the `writer-cli` skill. Spec: [`SPECs/dataview-spec.md`](dataview-spec.md).

## Tasks commands

`writer tasks filter=<expression> [sort=] [desc] [limit=]` filters task rows with a Bases expression; `task:add`, `task:done`, `task:edit` write one task line (feature `tasks`, answer "turned off" with it off). Spec: [`tasks-spec.md`](tasks-spec.md) section 5.
