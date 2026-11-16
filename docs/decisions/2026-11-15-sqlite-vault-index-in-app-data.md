---
status: accepted
date: 2026-11-15
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Keep a SQLite vault index (rusqlite, bundled) in the app data directory

> Backfilled on 2026-11-16. Date = `0e9ad64` "Bases engine and SQLite vault index in Rust" (the design was drafted on 2026-11-13 in `1a59ca5`, "Add Obsidian Bases planning spec", as a deferred item). Spec: [`SPECs/obsidian-bases-spec.md`](../../SPECs/obsidian-bases-spec.md) section 4.1.

## Context and Problem Statement

Bases needs content-derived data (properties, tags, links, backlinks, headings, tasks) and sort/filter over thousands of notes without reparsing. The previous file list was an in-memory `Vec<IndexedFile>` (path, name, mtime) built per window. The `writer` CLI must read the same data with no app running, and tags were already planned against the old index (`SPECs/tags-spec.md`).

## Considered Options

- SQLite through `rusqlite` with the `bundled` feature, one database per vault, hybrid property model (chosen).
- JSON1-only (`json_extract` on a blob per note): no key-level index, a table scan per query; tens of ms at 10k notes but no cheap `hasLink`/tag joins.
- Typed columns per property: impossible; property names are an open set (243 in the sampled vault, 46 with mixed types).
- Keep extending the in-memory list (`SPECs/workspace-snapshot-spec.md`, still in the backlog): no persistence across launches, no query engine, not shareable with the CLI process.

## Decision Outcome

Chosen option: SQLite with an EAV table with typed shadow columns plus the raw frontmatter JSON per file (`fm_json`), written in one transaction from one parse.

- **Location**: `<app_data_dir>/index/<sha256(root)[0..16]>.sqlite3`; the vault stays clean (no `.writer` folder, never `.obsidian`). The CLI opens the same file (`Index::open_for_cli`, override with `WRITER_INDEX_DIR`).
- **Cache semantics**: `meta.schema_version` plus a parser version; on mismatch or corruption the file is deleted and rebuilt. Deleting it is always safe.
- **Concurrency**: WAL (`synchronous=NORMAL`), one writer thread, a small pool of read-only connections; workspace epoch and a cancel flag stop a stale walk.
- **Updates**: cold build in batches (up to 200 files per transaction), warm open diffs `(path, mtime, size)` and `body_hash`, live updates from the watcher's debounced batches, `index://changed` event to the UI.
- **Rules**: every non-ignored file gets a `files` row; only Markdown is parsed; tags store ancestors (`a/b` also stores `a`); links resolve like Obsidian (`index/resolve.rs`); unsaved editor buffers are not indexed.
- **No Tauri types** in `apps/desktop/src-tauri/src/index/`, so the CLI shares it.

### Consequences

- Good, because Bases, quick open, search (`2026-11-15-fts5-note-content-search-design.md`) and the CLI share one parse and one freshness mechanism.
- Bad, because the index is a second copy of vault data to keep correct: the file walker deliberately differs from the old one (no global gitignore, `.git/info/exclude` or parent `.gitignore`), which changed what quick open lists.
- Bad, because schema changes rebuild the database (acceptable for a cache), and the 100k-note case is extrapolated, not measured.

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/index/` (`mod.rs`, `schema.rs`, `build.rs`, `query.rs`, `resolve.rs`), `commands/index.rs`, `watcher.rs`, `apps/desktop/src-tauri/Cargo.toml` (`rusqlite = { version = "0.43", features = ["bundled"] }`).
- **Patterns to follow**: new derived data is a column or table written in `build::write_records`; reads go through `Index` methods.
- **Patterns to avoid**: SQL in `commands/`; writing the index from the CLI's file writes (they go to files, then the index refreshes).

### Verification

- [ ] `cargo test` runs `index/tests.rs`, including the schema-bump rebuild and warm refresh.
- [ ] Perf smoke: `cargo test --release --lib perf_smoke -- --nocapture` stays within the spec's targets (cold build for 3000 notes well under a second).
- [ ] Deleting the database file and reopening a vault restores identical query results.
