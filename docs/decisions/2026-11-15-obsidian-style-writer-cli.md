---
status: accepted
date: 2026-11-15
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Give the `writer` binary an Obsidian-style command grammar on the shared index

> Backfilled on 2026-11-16. Date = `0e9ad64`, which added the "Obsidian CLI parity" section to `SPECs/writer-cli-spec.md`; the code landed in `a41b2ff` (`cli/`). The original `writer` launcher and its spec predate the history (`594cabd`, 2026-04-30). Spec: [`SPECs/writer-cli-spec.md`](../../SPECs/writer-cli-spec.md) "Obsidian CLI parity".

## Context and Problem Statement

The first CLI spec (spec authoring, `list`/`read`/`search`, `frontmatter`, clap-style `--flags`, markdown-only output, under ten commands) was narrow. With the vault index and the Bases engine available, users want Obsidian's CLI vocabulary, `writer [vault=<name|id|path>] <command> [param=value ...] [flag ...]`, to script a vault with no app running. Syntax and semantics come only from the public docs (clean room).

## Considered Options

- One binary that acts as the CLI by its name: the app binary checks `argv[0]` (`apps/desktop/src-tauri/src/main.rs`, `is_cli_invocation`: file stem equals `writer`) and routes to `writer_cli::run`; a launcher dispatches to a new `cli/` module for Obsidian-grammar commands (chosen).
- A second binary or sidecar: more packaging; the original spec had listed `src/bin/writer.rs`.
- Extend the clap command set with Obsidian names: two grammars in one parser; Obsidian's `param=value` form does not map to clap flags.

## Decision Outcome

Chosen option: parity commands use Obsidian's grammar; legacy commands keep clap-style flags and exit code 3 for launch failures. The dispatcher decides by command name: a first argument `vault=...`, or a name in the parity registry (or containing `:`), takes the Obsidian grammar (so a folder literally named `files` must be opened as `writer ./files`).

- `apps/desktop/src-tauri/src/cli/`: `args.rs` (grammar), `registry.rs` (one entry per command: name, parameters, flags, formats, handler), `format.rs` (one formatter set: json, csv, tsv, md, yaml, text, tree, paths), `vault.rs` (resolution: path, recent workspace id or name, else working directory), `cmd_*.rs`, `linkfix.rs` (move and rename rewrite wikilinks, embeds and markdown links), `clipboard.rs`.
- Works without the app: opens the same SQLite index (`Index::open_for_cli`), refreshes it with the warm diff, then queries. Writes go straight to files (atomic write), never through the index and never into `.obsidian`.
- Exit codes: 0 ok, 1 failure or invalid input, 2 usage or app-control command (`open`, `daily`, `plugins`, ... print `Not available in the Writer CLI: <cmd>`), 3 launcher failure.
- Deviations from Obsidian are listed in the spec (no active file, output shapes the public page does not show, `search` is not Obsidian's search language).

### Consequences

- Good, because adding a command is one registry entry plus a handler (`docs/consolidation.md`), and scripts written for Obsidian's CLI mostly carry over.
- Bad, because the parity surface is a moving target tracked from public docs only; some output bytes are readings of the docs.
- Bad, because the CLI and the app writing the same index at once is unverified; the open lock waits at most 15 s and SQLite's busy timeout is 10 s.

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/main.rs`, `writer_cli.rs`, `cli/`, `vault_ops.rs`, `index/`, `bases/`.
- **Patterns to avoid**: a handler that returns a string instead of a structured value; a write that bypasses `vault_ops`.

### Verification

- [ ] `cargo test` passes `cli/tests.rs` (fixture-vault builder, `WRITER_INDEX_DIR` set to a temp dir; no real vault is used).
- [ ] `writer files total`, `writer search query=...` and `writer base:query file=<name>` work in a vault with the app closed.
- [ ] `writer open` exits 2.
