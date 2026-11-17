---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Represent the note graph as one typed edge table in the vault index

## Context and Problem Statement

The vault index (SQLite, `index/`) stores links in a `links` table: one row per link occurrence with the link text and a resolved target path or NULL. It cannot say which frontmatter property produced a link, where a link sits, or answer neighbourhood, path, hub and "related notes" questions; and every created or deleted file re-resolves every link in the vault (43 ms at 50k edges, about 1 s extrapolated at 1M). Two features need a real graph: a later graph view, and helping the LLM (the `writer` CLI and the agent pane) understand how notes relate. The `relationships` property type (`manager: [[Daniel]]`) adds named edges that must be first-class. Links resolve by file name only, in Rust (`index/resolve.rs`; ADR 2026-11-16), and the index is a rebuildable cache (ADR 2026-11-15). Full analysis, research and measurements: [`SPECs/note-graph-spec.md`](../../SPECs/note-graph-spec.md).

## Decision Drivers

- One source of truth: no second copy of the link knowledge beside `links`.
- Reads dominate (neighbourhoods, backlinks, paths); writes are frequent and small (one note saved, one file created).
- 5k notes and 50k edges expected, 100k notes and 1M edges supported.
- Keep resolution in the one Rust resolver; never resolve by title or alias.
- No note bodies copied into the index or leaked to prompts and logs.
- No new dependency; the bundled SQLite (3.54.1 via `rusqlite 0.43`, `libsqlite3-sys 0.40`) is the engine.

## Considered Options

- A. One typed `edges` table (adjacency list, indexed both ways) replacing `links`, recursive CTEs for small neighbourhoods, an in-memory adjacency snapshot for whole-graph work.
- B. Keep `links` and add a graph table or a graph extension (simple-graph, GraphQLite, sqlite-graph) beside it.
- C. A closure table, nested sets or materialized paths.
- D. Build the graph only in memory (petgraph) from `links` at startup.

## Decision Outcome

Chosen option: A.

- **Schema**: `edges(id, src_id -> files ON DELETE CASCADE, dst_id -> files ON DELETE SET NULL (NULL = unresolved), dst_key, target, kind link|embed|property, syntax wikilink|markdown, label, ambiguous, ord, line, section, display, subpath) STRICT`, with indexes `(src_id, dst_id)`, partial `(dst_id, src_id)`, `(dst_key)` and partial `(label, src_id)`. Property edges carry the property name in `label`. Tags and aliases are not edges (a SQL view unions tags in for the graph view). DDL and queries: spec sections 4.2 and 7.
- **Resolution**: stays in `PathIndex::resolve`; SQL stores its answer. A batch that adds or removes files re-resolves only edges whose `dst_key` equals the bucket key (normalised file name) of those files, with today's full pass as the fallback for large batches. Measured: one name 0.01 ms, the biggest bucket 0.8 ms.
- **Context for the LLM**: the index stores `line` and `section`; a capped snippet (240 characters) is read from the note on demand for the few edges returned. Nothing else of a note body is stored or sent.
- **Algorithms**: neighbourhoods use `WITH RECURSIVE` with `UNION` over `(id, depth)` (cycle-safe, bounded), shortest path, components and hubs run on a per-epoch `Vec`-based CSR snapshot, not in SQL.
- **Migration**: schema and parser version bumps (existing rebuild-on-mismatch is the backfill); `edges` is written beside `links` for one phase with a parity test, then readers switch and `links` is dropped. Phases: schema and parser, switch readers, `writer graph:*` CLI, agent context block, graph view.

### Consequences

- Good: property, body and embed edges in one model; backlinks, outlinks, neighbours, paths, hubs, orphans, unresolved and by-label queries are single statements measured at 0.01 to 41 ms on 5k notes and 50k edges; one write path; the plan reuses the epoch cache and watcher feed.
- Good: create, rename and delete cost milliseconds at any vault size instead of a full re-resolve.
- Good: no new dependency and no extension; the schema is about 6 MB at 50k edges.
- Bad: the parser must now track each link's line, section and property key, and the resolver must report ambiguity; the cold build gets a measurable overhead (budget +20%).
- Bad: whole-graph work needs a snapshot (2.4 ms at 50k edges, about 100 to 150 ms at 1M, extrapolated) and must be capped on hub-heavy vaults (a depth-3 walk from a hub reaches nearly the whole graph).
- Bad: file ids change on rename (delete plus create), so anything cached by id (layouts) must key by path.
- Neutral: Cypher or SQL/PGQ-style ad hoc graph queries are not offered.

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/index/` (`schema.rs` DDL and versions, `markdown.rs` and `frontmatter.rs` and `note.rs` for line, section and label, `build.rs` for `write_children` and bucketed re-resolution, `resolve.rs` for `bucket_key` and ambiguity, new `graph.rs` for the only graph SQL and the snapshot, `query.rs` and `mod.rs` readers and `cached_backlinks`), `bases_source.rs`, `cli/` (`cmd_graph.rs`, `registry.rs`), `src-tauri/skills/writer-cli/` (and `BUNDLE_VERSION`), `agent/` prompt assembly and `project_context.rs`, `commands/index.rs` for the graph view commands.
- **Dependencies**: `petgraph` (0.8.3, already in `Cargo.lock` transitively) becomes a direct dependency of `apps/desktop/src-tauri` for the in-memory graph snapshot; decided by the user on 2026-11-17 ("petgraph to be used directly"), exact pin, minimal features, added in phase 3. No other new dependency.
- **Patterns to follow**: derived data is written in `build::write_records`; reads go through `Index` methods; SQL stays out of `commands/`; `commands::blocking` for IPC; one resolver; edge changes only inside the batch transaction.
- **Patterns to avoid**: a second link table; resolving by title or alias; storing note text in the index; graph SQL outside `index/graph.rs`; logging note names or paths; enabling SQLite math functions.
- **Tests**: parser (label for single, list and nested property links; line; section); parity of `edges` with `links` on fixture vaults; bucketed re-resolution equals the full pass after create, delete and rename (property test over generated vaults, asserting resolution depends only on same-bucket candidates); `EXPLAIN QUERY PLAN` shape tests; CLI goldens for unchanged `links`, `backlinks`, `unresolved`, `orphans`, `deadends`; prompt block golden; the ignored benchmark of spec section 6.3.

### Verification

- [ ] `cargo test --release graph_bench -- --ignored --nocapture` meets the budgets of the spec at 5k notes and 50k edges.
- [ ] Old reader outputs and new reader outputs match on every fixture before `links` is dropped.
- [ ] A created, renamed and deleted note updates inbound edges without a full `resolve_links` pass (log counts only).
- [ ] No test or log output contains note text beyond the capped snippet.

## Pros and Cons of the Options

### A. One typed edge table

- Good, because it is the smallest model that answers every query, shares `files` as the node set, and keeps writes O(note).
- Bad, because deep traversals in SQL need care (`UNION`, depth and result caps).

### B. Keep `links` plus a graph table or extension

- simple-graph (JSON nodes and edges, Jinja SQL templates), GraphQLite (Cypher, algorithms, a loadable extension with its own tables) and sqlite-graph 0.1.0 (a seven-table schema extracted from another project) each duplicate the node and edge knowledge we already hold.
- Bad, because of the duplication, a loadable extension beside a `bundled` build, and young projects; none of our queries needs Cypher. SQL/PGQ exists in DuckDB (DuckPGQ), not SQLite.

### C. Closure table, nested sets, materialized paths

- These model trees. A note graph has cycles and many parents; a closure table is the transitive closure, about 22 million rows for a 5k-note, 50k-edge graph whose giant component reaches 4.7k notes, rewritten on every link edit.

### D. In memory only

- Good, because traversals are microseconds.
- Bad, because there is nothing to query from the CLI without the app, a rebuild from `links` loses the label and position data, and the snapshot is needed anyway on top of a durable table.

## More Information

Spec: [`SPECs/note-graph-spec.md`](../../SPECs/note-graph-spec.md) (sources with URLs, scratch benchmark numbers, queries). Related: [SQLite vault index](2026-11-15-sqlite-vault-index-in-app-data.md), [links resolve by file name](2026-11-16-links-resolve-by-file-name-and-rename-rewrites-links-through-one-rust-function.md), [Obsidian-style writer CLI](2026-11-15-obsidian-style-writer-cli.md), [record property types](2026-11-17-record-property-types-in-writers-own-file-and-read-obsidians-types-json-read-only.md). Revisit if users want ad hoc graph queries (GraphQLite), if a vault exceeds 1M edges (index size), or if resolution ever stops being a function of the file name.

**Accepted (2026-11-17).** The user chose to build the graph view on this design (rendering ADR `2026-11-17-render-the-graph-view-with-react-sigma-sigma-graphology-and-a-forceatlas2-worker`); implementation starts with the migration plan phases 1 to 3 of the spec.

**Addendum (2026-11-17, view needs).** The whole-vault `graph_slice` default limit is 10,000 nodes (was 3,000; target devices are GPU Macs). `graph_slice` gains `cardProperties?: string[]` and `GraphNode.cardValue?: string | null` (the first set value among those frontmatter properties, from the index's property tables, never a note read) for the view's close-up cards. Tag nodes are built by the view from `GraphNode.tags`, so `includeTags` may stay a no-op in the slice. The view's per-vault settings live in `.writer/graph.json` through `graph_config_read` / `graph_config_write`, confined and atomic; `.obsidian/graph.json` is never read or written.
