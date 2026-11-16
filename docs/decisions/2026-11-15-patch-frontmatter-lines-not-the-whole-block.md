---
status: accepted
date: 2026-11-15
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Edit note properties with a byte-minimal frontmatter line patcher in Rust

> Backfilled on 2026-11-16. Date = `a41b2ff` (adds `index/patch.rs` and `vault_ops.rs`). The spec first proposed a TypeScript `patchFrontmatter` over `yaml`'s `parseDocument` (section 4.3.3, 2026-11-13); the implementation moved the edit into Rust so the CLI could share it. Spec: [`SPECs/obsidian-bases-spec.md`](../../SPECs/obsidian-bases-spec.md) section 4.3.3 and phase 3, [`SPECs/writer-cli-spec.md`](../../SPECs/writer-cli-spec.md) "Implementation notes".

## Context and Problem Statement

Editing a property from a Bases cell or `writer property:set` must not disturb the rest of the note. The existing properties panel (`apps/desktop/src/lib/yaml-entries.ts`) re-stringifies the whole frontmatter object, which drops comments and rewrites scalar styles. The CLI has no TypeScript runtime. The legacy CLI's `frontmatter set` is explicitly allowed to rewrite the block in canonical order (`SPECs/writer-cli-spec.md`); that is not acceptable for user-visible property edits in vaults shared with Obsidian.

## Considered Options

- A Rust text patcher that changes only the target key's lines (chosen).
- A TypeScript `yaml` `Document` edit (the spec's first proposal): preserves comments and order but exists only in the app, so the CLI would need its own.
- Re-serialising the frontmatter: simple, loses comments and styles.

## Decision Outcome

Chosen option: `set_property` and `remove_property` in `apps/desktop/src-tauri/src/index/patch.rs`: pure text in, text out. Everything else is preserved byte for byte (comments, key order, quoting, flow lists, CRLF, BOM, the body). A missing frontmatter block is created; lists are written as block lists, booleans as `true`/`false`, numbers bare, dates as `YYYY-MM-DD` or ISO datetimes, text is quoted only when YAML needs it. A note whose frontmatter does not parse is never touched: the call fails with `PatchError::Unparsable` and the cell is read-only with the reason.

File I/O lives in `apps/desktop/src-tauri/src/vault_ops.rs`, the one write path shared by `commands/bases.rs` (`note_property_set`, `note_property_remove`) and `cli/` (`property:set`, `property:remove`, `task toggle` edits a single status character). It uses atomic writes (temp file and rename), refuses non-markdown files, protected folders (`.obsidian`, `.git`) and symlinks leaving the vault. In the app, a note with unsaved edits in a tab is read-only in the table so unsaved text is never clobbered.

### Consequences

- Good, because a property edit shows up as a one- or few-line diff in git and never rewrites unrelated YAML.
- Bad, because a line patcher has to handle YAML shapes by hand (flow lists, multi-line scalars); anything it cannot handle must fail explicitly rather than guess.
- Bad, because the CLI does not coordinate with a note open with unsaved edits in the app.

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/index/patch.rs`, `vault_ops.rs`, `commands/bases.rs`, `cli/cmd_notes.rs`.
- **Patterns to follow**: every property write goes through `vault_ops`; add shapes to `patch.rs` with a test first.
- **Patterns to avoid**: re-stringifying frontmatter for property edits; a second implementation in TypeScript.

### Verification

- [ ] `cargo test` runs the patcher tests in `index/patch.rs` (comments, quoting, key order, CRLF, BOM, unparsable frontmatter) and `vault_ops.rs`.
- [ ] `writer property:set` on a note with comments changes only the target key's lines (`cli/tests.rs`).
