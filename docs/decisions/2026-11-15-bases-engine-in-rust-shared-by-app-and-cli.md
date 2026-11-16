---
status: accepted
date: 2026-11-15
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Implement the Bases engine in Rust, shared by the app and the CLI

> Backfilled on 2026-11-16. Date = `0e9ad64` "Bases engine and SQLite vault index in Rust". The spec was first committed on 2026-11-13 (`1a59ca5`) with a TypeScript-first proposal; section 4.2.1 was amended on 2026-11-15 to supersede it. Spec: [`SPECs/obsidian-bases-spec.md`](../../SPECs/obsidian-bases-spec.md) sections 4.2 and 4.6; engine map: `apps/desktop/src-tauri/src/bases/README.md`.

## Context and Problem Statement

Writer should open `.base` files and show the rows, columns, groups and summaries Obsidian shows, evaluating the documented filter, formula and summary expression language. The `writer` CLI (`base:query`) must evaluate bases with no app running. Behaviour comes only from the public Obsidian help pages and `obsidian.d.ts` (clean room, see `2026-11-13-run-unmodified-obsidian-plugins-through-a-ported-host.md`).

## Considered Options

- Rust engine (`apps/desktop/src-tauri/src/bases/`, no `tauri` types) next to the index, exposed by a `base_query` command and the CLI (chosen).
- TypeScript parser and evaluator (the first proposal): the CLI could not reuse it, and two implementations of the grammar and coercion rules would drift (`docs/consolidation.md`); every row would also cross IPC.
- Dataview-style query compatibility: a non-goal, a separate feature.

## Decision Outcome

Chosen option: Rust. The `.base` parser (unknown keys kept in `extra`), lexer, parser, interpreter (`note`, `file`, `formula`, `this`; errors are values with kind and span), the single function registry (`functions.rs`, which also feeds the formula editor through `base_functions`) and the query executor (`run_view`) live in `bases/`.

- The executor pushes a conservative superset of filters into SQL over the index, then verifies every candidate with the interpreter, so correctness never depends on SQL (a differential test compares both).
- The clock is injected; row data arrives through a `RowSource` trait, so the engine has no dependency on the index.
- Choices where the docs are silent are listed in `bases/choices.rs` and the spec's "Implemented semantics and open probes", to be checked one by one against real Obsidian by black-box experiments.
- TypeScript only renders views and edits `.base` files; plugin views (`registerBasesView`) receive the `base_query` result mapped to the public `BasesQueryResult` shape.
- Non-goals for v1: Map and Kanban views (shown as a placeholder naming the type, YAML untouched), custom formula functions, Dataview.

### Consequences

- Good, because the CLI and the app agree by construction, and evaluation sits next to the data.
- Bad, because Moment-style `format` tokens and regexp literals are reimplemented in Rust, and `regex` crate semantics differ slightly from JavaScript.
- Bad, because no run against the real Obsidian or the real app GUI has confirmed the parity; unknowns are tracked.
- `proptest` is not approved; use seeded generators or ask before adding dependencies.

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/bases/`, `commands/bases.rs`, `index/bases_source.rs`, `cli/cmd_bases.rs`.
- **Patterns to follow**: add a function as one `FUNCTIONS` entry; behaviour choice goes in `choices.rs` with a spec note.
- **Patterns to avoid**: an expression parser in TypeScript; engine code importing `tauri`.

### Verification

- [ ] `cargo test` runs `bases/tests.rs` (golden cases for every documented function) and the SQL-versus-interpreter differential test.
- [ ] `writer base:query file=<name> format=json` returns the same rows as the app's table view for the same base.

## More Information

- Frontend: [`2026-11-15-bases-ui-one-view-registry-and-comment-preserving-edits.md`](2026-11-15-bases-ui-one-view-registry-and-comment-preserving-edits.md). Index: [`2026-11-15-sqlite-vault-index-in-app-data.md`](2026-11-15-sqlite-vault-index-in-app-data.md).
