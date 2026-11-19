# Note graph spec

Status (2026-11-17): the data layer is implemented. Phases 1 to 3 of section 9 and the view commands of 8.5 are done (see "Implementation status" at the end); phase 4 (agent context) and the view's web half (`SPECs/graph-view-spec.md`) are separate. Sections 1 to 8 are the design as written; where the code differs the status section says how. ADR: [`docs/decisions/2026-11-17-represent-the-note-graph-as-one-typed-edge-table-in-the-vault-index.md`](../docs/decisions/2026-11-17-represent-the-note-graph-as-one-typed-edge-table-in-the-vault-index.md) (proposed). Related: [`obsidian-bases-spec.md`](./obsidian-bases-spec.md) section 4.1 (the index), [`filename-links-and-rename-spec.md`](./filename-links-and-rename-spec.md) (resolution by file name), [`writer-cli-spec.md`](./writer-cli-spec.md), [`managed-vault-skills-spec.md`](./managed-vault-skills-spec.md), [`native-agent-spec.md`](./native-agent-spec.md), [`properties-types-spec.md`](./properties-types-spec.md) (the `relationships` property type is being built by another change; this spec only consumes its output).

## 1. Problem

Writer's index stores links, but not a graph. A `links` table row says "this note contains this link text", resolved to a target path or NULL. That answers `backlinks`, `links`, `unresolved`, `orphans`, `deadends` and Bases `file.links`/`file.backlinks`. It cannot answer, cheaply or at all:

- which **property** created an edge (`manager: [[Daniel]]` is stored as an anonymous frontmatter link, `in_fm = 1`; the key is lost for single values and kept only in `prop_items.link_target` for list items);
- where in the note an edge sits (line, section) and what the sentence around it says (what an LLM needs to understand why two notes are linked);
- N-hop neighbourhoods, shortest paths, hubs, components, "related notes";
- which edges an event (note created, renamed, deleted) can change, without re-resolving every link of the vault.

Two features need this: a **graph view** later, and **LLM understanding of how notes relate** (the `writer` CLI and the agent pane). The user's request: "see how in sqlite we could represent the relationships ... keep a graph of the notes for a later feature of seeing the graph but also to help LLM better understand the links between the notes." A concurrent change adds a `relationships` property type (single link or list of links in frontmatter); its edges must be first-class.

Non-goals: a graph database, a second store, an in-vault file, semantic (embedding) similarity, writing anything to the vault, a graph UI (only its data contract), changing how links are resolved (file name, never title: ADR 2026-11-16).

## 2. Audit of what exists (2026-11-17, branch `feat/obsidian-plugin-host`)

Source files: `apps/desktop/src-tauri/src/index/{schema,build,query,mod,resolve,markdown,note,frontmatter}.rs`.

### 2.1 Stored today

| Knowledge                  | Where                                                                                                                                                                                                                    | Notes                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Files                      | `files(id, path UNIQUE, name, basename, ext, folder, size, ctime, mtime, fm_json, fm_error, body_hash, words, chars)`                                                                                                    | Every non-ignored file (md, attachments, `.base`, code files) has a row. Ids are autoincrement-style `INTEGER PRIMARY KEY`; a rename seen by the watcher is a delete plus a create, so the id changes. |
| Body wikilinks, embeds     | `links(src_id, raw, target_path, kind, in_fm, display, subpath)`; `kind` is `wikilink`, `embed`, `markdown`, `markdown_embed`                                                                                            | One row per occurrence. Same-file links (`[[#H]]`) store the file itself as target. No line, no section, no order column (order is `rowid`).                                                           |
| Frontmatter links          | same table, `in_fm = 1`; `props.vtype = 'link'` for a whole-value link, `prop_items(key, idx, link_target)` for list items                                                                                               | The property name is not on the `links` row. Whole-value links have no `link_target`.                                                                                                                  |
| Resolution                 | `links.target_path` = vault path or NULL. Resolver: `index/resolve.rs::PathIndex` (NFC + lowercase name, optional `.md`, partial path suffix, `./` `../`, tie-break nearest folder then shortest path then alphabetical) | In Rust only; it cannot be written as SQL. No "ambiguous" marker; no stored target name key.                                                                                                           |
| Unresolved                 | `links WHERE target_path IS NULL`; `Index::unresolved()` groups by `raw` case-insensitively in Rust                                                                                                                      |                                                                                                                                                                                                        |
| Tags                       | `tags(file_id, tag, source)` with ancestors (`a/b` also stores `a`), `source` body or frontmatter                                                                                                                        | `tags_tag` index.                                                                                                                                                                                      |
| Aliases                    | not a table: the `aliases`/`alias` props are read by `property:read` and Bases. Aliases never resolve a link (ADR 2026-11-16)                                                                                            |                                                                                                                                                                                                        |
| Headings                   | `headings(file_id, level, text, line)`                                                                                                                                                                                   | Usable to derive a link's section from its line.                                                                                                                                                       |
| Backlink cache for Bases   | `Index::cached_backlinks()`: `HashMap<target, Vec<source>>` rebuilt from a full `links` scan on every epoch change                                                                                                       | Feeds `file.backlinks` (`bases_source.rs`).                                                                                                                                                            |
| Name cache for quick open  | `names.rs::NameCache`, fed by `ChangeBatch`                                                                                                                                                                              | The pattern to copy for a graph snapshot.                                                                                                                                                              |
| Parser and schema versions | `SCHEMA_VERSION = "2"`, `PARSER_VERSION = "2"` in `meta`; mismatch, corruption or a different workspace root deletes the database and rebuilds it                                                                        | The index is a cache. No incremental migrations exist or are needed.                                                                                                                                   |

Database: `<app data>/index/<sha256(root)[0..16]>.sqlite3`, WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `temp_store=MEMORY`, 10 s busy timeout, an advisory `.lock` file serialises opens. One writer thread owns the write connection; reads use a pool of up to 4 idle read-only connections (`ReadPool`). Cold scan commits batches of up to 200 files; the watcher feeds `Index::index_paths` with debounced batches; `ChangeBatch { paths, full }` is emitted as `index://changed`.

### 2.2 How it is maintained

- `write_records` replaces a note's children (`delete_children`, then `write_children`) inside a savepoint per note; a failing note is logged and stored as a bare row with `fm_error`.
- When a batch creates or deletes a file (`set_changed`), `resolve_links(tx, paths, None)` re-resolves **every link in the vault** and updates the rows whose target changed. A body edit does not trigger it; the note's own links are resolved at write time against the in-memory `PathIndex`.
- Measured on the synthetic 5k-note, 50k-edge vault of section 6.1 with the repo's real `resolve.rs`: **43 ms** per full re-resolve. At 100k notes and about 1M edges that is about 1 s per create or delete batch (linear extrapolation, not measured), which blocks the single writer. At 5k notes the current code is fine; it is the 100k case and the cold build (many creates) that motivate bucketed re-resolution (section 5.2).

### 2.3 Volume

Assumed (the user's real vault is private and not inspected): 5k notes, 50k edges (10 per note), 3% unresolved, a heavy-tailed in-degree (a few hubs with 1k+ backlinks). Required to hold up to 100k notes and 1M edges. The existing perf smoke (`perf_smoke_3000_notes` in `index/tests.rs`) uses 12 links per note.

### 2.4 Readers of links today

- `Index::backlinks(path)`, `links(path)`, `unresolved()`, `orphans()` (no incoming link from another file), `deadends()` (no outgoing link to another file) in `index/query.rs`; the `writer` commands `graph:neighbors`, `graph:backlinks`, `graph:unresolved`, `graph:orphans`, `graph:deadends` (`cli/cmd_graph.rs`, `cli/registry.rs`; spec `writer-cli-spec.md`; the old `links`, `backlinks`, `unresolved`, `orphans`, `deadends` were removed by ADR 2026-11-19).
- Bases: `file.links`, `file.embeds`, `file.backlinks`, `link()` through `bases_source.rs` and `cached_backlinks`.
- `resolve_link` for the CLI `file=` parameter and the editor's `resolve_wiki_link` command; `relocate/` rewrites link text on rename using the index to find referrers.
- Property links: `prop_items.link_target` for the properties panel and Bases.

## 3. Research findings

Dates are the page's own date when it states one; SQLite documentation pages carry no date, so the SQLite version that introduced a feature is given instead. Fetched 2026-11-17.

### 3.1 What our SQLite is

`apps/desktop/src-tauri/Cargo.toml` has `rusqlite = { version = "0.43", features = ["bundled"] }`; `Cargo.lock` pins `rusqlite 0.43.0` and `libsqlite3-sys 0.40.0`, whose vendored `sqlite3.h` says `SQLITE_VERSION "3.54.1"` (checked in the cargo registry source). The bundled build is the same on every user's machine. Consequences, all checked in the scratch benchmark:

- Recursive CTEs (3.8.3, 2014), compound recursive selects (3.34.0, 2020-12-01), `STRICT` tables (3.37.0, 2021-11-27), `WITHOUT ROWID` (3.8.2, 2013-12-06), partial indexes, `RETURNING` are all available. The WAL-reset corruption bug is fixed in 3.51.3 and later ([WAL page](https://www.sqlite.org/wal.html)), so 3.54.1 is not affected.
- The bundled build has **no SQL math functions**: `ln()` failed with "no such function: ln" (measured). Scoring formulas use `1.0 / (1 + degree)`, not `1 / ln(...)`; do not enable `SQLITE_ENABLE_MATH_FUNCTIONS` for this.
- The `sqlite3` CLI on the dev machine is 3.54.0, close enough for `EXPLAIN QUERY PLAN` checks.

### 3.2 Recursive CTEs

Source: [SQLite, WITH clause](https://www.sqlite.org/lang_with.html).

- A recursive CTE is an initial select plus a recursive select (`UNION` or `UNION ALL`); it works as a queue. `UNION` "only add[s] rows to the queue if no identical row has been previously added", which stops cycles but keeps every generated row in memory; `UNION ALL` keeps repeats and uses less memory, and the page advises `UNION ALL` "when feasible".
- A `LIMIT` on the recursive select "will always stop the recursion"; an `ORDER BY` on it sets queue order: `ORDER BY 2` (a depth column) gives breadth-first, `DESC` gives depth-first. Without it the queue is FIFO but the page says not to rely on that.
- The recursive table may appear only once per recursive select, and no aggregates or window functions in it. A compound recursive select (two recursive terms, one per direction) is allowed since 3.34.0.

Measured on 5k notes and 50k edges (section 6.2):

- A depth cap alone with `UNION ALL` is unusable on a graph with hubs: depth 3 from the biggest hub produced **4,749,179 rows in 956 ms** (depth 2: 33k rows) for a result of 4.7k distinct notes.
- `UNION` over `(id, depth)` rows is a sound cycle guard: a node can appear once per depth, so the set is bounded by `depth * nodes`. Neighbourhood depth 3 of the biggest hub: **21 ms**, of a mid-degree note: 9 ms.
- A path string with `UNION ALL` and `instr(path, ',id,') = 0` is correct (a simple-path guard) but slow and wasteful: **58 ms** at depth 3 from a mid note with 104k intermediate rows. Use it only where the path itself is the result and depth is at most 3.
- Shortest path as a SQL BFS with a path column and `ORDER BY depth`: **2.0 s** for a distance-4 pair (it does not stop at the first hit). Rejected. Distance layers by `UNION` plus walk-back is 25 ms at depth 4; a Rust BFS with prepared statements is 50 ms; a BFS over an in-memory adjacency snapshot is **0.06 ms** after a 2.4 ms snapshot load.

### 3.3 Hierarchy models

Sources: Bill Karwin, _SQL Antipatterns_ (adjacency list, path enumeration, nested sets, closure table; summary via secondary sources, [O'Reilly](https://www.oreilly.com/library/view/sql-antipatterns/9781680500073/f_0024.html)), and [Hierarchical data: adjacency list, nested set, materialized path](https://kindatechnical.com/database/hierarchical-data-adjacency-nested-materialized.html). Weak sources; I could not read Karwin's text, so the reasoning below is mine and the numbers are measured.

- Nested sets, materialized paths and path enumeration encode a **tree** (one parent per node). A note graph is a general directed graph with cycles and many parents. They do not apply.
- A closure table stores every reachable pair. For a graph, that is the transitive closure: the biggest component reached 4,715 notes from one hub in 3 undirected hops, so its closure is on the order of 4.7k x 4.7k = 22 million rows for 50k edges, and every edge insert or delete must update a large part of it. Rejected: reads are not the bottleneck (section 3.2), writes are frequent and small.
- Adjacency list (one row per edge, indexed both ways) fits: 50k rows, cheap writes, O(degree) per hop, recursive CTE for N hops. Chosen.

### 3.4 SQLite graph extensions and proposals

- **simple-graph** ([dpapathanasiou/simple-graph](https://github.com/dpapathanasiou/simple-graph), MIT, 168 commits): two structures, nodes (JSON objects with a unique `id`) and edges (id pairs plus optional JSON properties); traversal is Jinja2 SQL templates written as CTEs. Same model as a plain edge table plus a JSON node store; the template layer is Python-oriented. Rejected: we already have the nodes (`files`) and want typed columns.
- **GraphQLite** ([colliery-io/graphqlite](https://github.com/colliery-io/graphqlite), MIT, 407 commits): a SQLite extension with Cypher, PageRank, Louvain, Dijkstra, BFS/DFS, components; Rust, Python and raw-SQL access; claims 98.5% of the openCypher TCK. It stores its own node/edge tables and loads as an extension. Rejected for now: a second schema that duplicates `files` and the edge table (DRY), a loadable extension beside a `bundled` build, a young project, and none of our queries needs Cypher. Worth revisiting only if users want ad hoc graph queries.
- **sqlite-graph** ([docs.rs 0.1.0](https://docs.rs/crate/sqlite-graph/0.1.0/source/README.md), MIT): version 0.1.0, extracted from the `ctxgraph` project, seven tables including bi-temporal edges, FTS5 and vectors, "designed for graphs up to about 100K nodes", and it says recursive CTEs "give you everything you need for multi-hop traversal". Rejected: it confirms the plain-table approach and brings a schema we would not use. A separate alpha C extension with Cypher also exists under the same name ([feedbagel write-up](https://feedbagel.com/post/sqlite-graph-extension-adding-graph-database-capabilities-to-sqlite)); not evaluated.
- **SQL/PGQ** (SQL:2023 property graph queries): implemented by the DuckPGQ extension for DuckDB ([DuckDB docs](https://duckdb.org/docs/current/guides/sql_features/graph_queries)), flagged there as a community extension under active development. SQLite has no SQL/PGQ and no official graph proposal in the release line we ship. Not applicable.
- **sqlean**: a set of general-purpose SQLite extensions (I did not verify its contents online in this task); it is not a graph tool. Not evaluated further.

Conclusion: a plain typed edge table plus recursive CTEs for small neighbourhoods, plus an in-memory adjacency snapshot for whole-graph work. No extension.

### 3.5 rusqlite and SQLite settings

- `Connection::prepare_cached` caches statements per connection ([rusqlite 0.43 docs](https://docs.rs/rusqlite/0.43.0/rusqlite/struct.Connection.html)); the existing code already uses it for every hot statement. The default capacity is small ("a relatively small number of cached statements"); graph queries add a handful, so set `set_prepared_statement_cache_capacity(64)` on the reader and writer connections only if profiling shows eviction.
- `WITHOUT ROWID` ([docs](https://www.sqlite.org/withoutrowid.html)) helps tables with a non-integer or composite primary key and rows under about 1/20 of a page (50 bytes at 1 KiB, 200 bytes at 4 KiB). An edge row is around 70 bytes with text columns and has a surrogate integer key, and the doc says to avoid it for single-integer keys. Not used.
- `STRICT` ([docs](https://www.sqlite.org/stricttables.html), 3.37.0) rejects wrong types and `PRAGMA quick_check` verifies column types; the file format is otherwise unchanged and only readers older than 3.37 would refuse the file, and we bundle 3.54. Used for `edges` (a new table); `files` and the older tables stay non-strict (changing them is out of scope).
- WAL ([docs](https://www.sqlite.org/wal.html)): readers do not block the writer, one writer at a time, checkpoints cannot pass the oldest reader. Reads here are millisecond-scale and the pool is 4, so checkpoint starvation is not a risk; keep `wal_autocheckpoint` at its default.
- No new PRAGMAs. `PRAGMA optimize` after a cold build (and `ANALYZE` in the benchmark) keeps the planner on the edge indexes; add `PRAGMA optimize` to the end of the cold scan, not per batch.

### 3.6 In-memory graph layout

- **petgraph** `Csr` ([docs.rs 0.8.3](https://docs.rs/petgraph/0.8.3/petgraph/csr/struct.Csr.html)): compressed sparse row, O(V+E) space, `neighbors_slice` and `out_degree` in O(1), built in O(V+E) by `from_sorted_edges`; no parallel edges; mutation is limited (rows must be appended in order; no edge removal), so it is a read-only snapshot structure. petgraph 0.8.3 is already in `Cargo.lock` as a transitive dependency of `tree_magic_mini`, but it is **not** a direct dependency, and this task adds none.
- The scratch benchmark shows a plain `Vec<Vec<u32>>` adjacency list built from `SELECT DISTINCT src_id, dst_id` takes 2.4 ms for 50k edges and BFS over it 0.06 ms; union-find over an edge scan finds components in 1.6 ms. Both need only `std`. Recommendation: build the snapshot with `std` (`Vec<u32>` offsets and targets, i.e. a hand-rolled CSR of about 40 lines) and keep petgraph as an option if a second algorithm (centrality, SCC) is needed. Adding it is a new dependency edge: an ADR addendum with the user's go.
- For the graph view, doing neighbourhood queries in SQL and sending only a subgraph is enough (section 8). A full-vault snapshot is for components, hubs and shortest path.

### 3.7 How other tools model it (public documentation and typings only)

- **Obsidian** (public typings, [obsidian.d.ts](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)): `MetadataCache.resolvedLinks: Record<sourcePath, Record<destPath, number>>` ("maps each source file's path to an object of destination file paths", with a count) and `unresolvedLinks` ("maps each source file to an object of unknown destinations with count"); `CachedMetadata` has `links`, `embeds`, `tags`, `headings`, `frontmatterLinks` (each with `key`, "the frontmatter property that contains the link", since 1.4.0) and `referenceLinks`; every item has a `position`; `getFirstLinkpathDest(linkpath, sourcePath)` resolves. Take-away: a weighted adjacency map for the graph, per-occurrence references with position for detail, and a **property key on frontmatter links**. Obsidian keeps no edge label beyond that key and no snippets. This matches our occurrence rows plus `label`.
- **Logseq** (community docs, [forum](https://discuss.logseq.com/t/general-question-about-data-structures-to-maximize-benefits-of-datalog-db-and-queries/20063)): DataScript (datalog) entities with `:block/refs` (outgoing references), `:block/page`, `:block/parent` and the inherited `:block/path-refs`. Take-away: the unit is the block and the graph is a ref attribute; our unit is the note, with `line` and `section` as the block-ish anchor. Sources were forum posts, not official schema docs.
- **SilverBullet** ([Object](https://docs.silverbullet.md/Object)): everything is an "object" with a `ref` and tags in one object index, with `link` objects among them. Take-away: one table for typed relations and a `kind` discriminator is the same shape as ours.
- **Foam** ([foambubble/foam](https://github.com/foambubble/foam)): a workspace of resources with wikilinks, a computed backlink/connection set (Connections Explorer) and a graph where tags can appear as nodes. Take-away: tags as optional graph nodes (we expose them as a view, not stored edges).
- **Dendron, Zettlr, Tana, Notion**: not researched here (no source fetched). Notion and Tana relations are typed, named, bidirectional properties: this is exactly the `relationships` property type with its name as the edge label.

## 4. Proposed design

### 4.1 Decisions in short

1. One table, `edges`, one row per link occurrence, replaces `links` (section 7: evolve, do not keep two tables).
2. A typed edge: `kind` is the origin (`link`, `embed`, `property`), `syntax` is how it was written (`wikilink`, `markdown`), `label` is the property name for `property` edges.
3. Nullable `dst_id` plus the raw `target` and a normalised `dst_key` (the file-name bucket). The resolver stays in Rust; SQL stores its answer.
4. Tags are not edges in storage (they have a table and ancestors). Aliases are not edges (they never resolve). A `graph_edges` SQL view unions tags in when the graph view or the prompt wants tag nodes.
5. Context snippets are **not stored**; the index stores `line` and `section`, and snippets are read from the note on demand, capped, for at most a few dozen edges per answer.
6. Whole-graph algorithms run on a per-epoch adjacency snapshot built from SQL; neighbourhoods and listings run as SQL.

### 4.2 DDL (target, schema version 3)

```sql
CREATE TABLE edges(
  id          INTEGER PRIMARY KEY,
  src_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  dst_id      INTEGER REFERENCES files(id) ON DELETE SET NULL, -- NULL = unresolved
  dst_key     TEXT    NOT NULL,   -- resolution bucket: NFC-lowercase last path segment, ".md" stripped; '' for a same-file link
  target      TEXT    NOT NULL,   -- link text as written (decoded for markdown links), without alias or #subpath
  kind        TEXT    NOT NULL,   -- 'link' | 'embed' | 'property'
  syntax      TEXT    NOT NULL,   -- 'wikilink' | 'markdown'
  label       TEXT,               -- property key for kind = 'property' (nested keys joined with '.'), else NULL
  ambiguous   INTEGER NOT NULL DEFAULT 0, -- 1 when the resolver had several candidates and tie-broke (dst_id set)
  ord         INTEGER NOT NULL,   -- 0-based document order inside the source (frontmatter first)
  line        INTEGER,            -- 1-based line in the file; NULL if unknown
  section     TEXT,               -- nearest preceding heading text (<= 120 chars); NULL for frontmatter or before the first heading
  display     TEXT,               -- alias text of [[x|alias]] / markdown link text (<= 200 chars)
  subpath     TEXT                -- #Heading or #^block part
) STRICT;
CREATE INDEX edges_src   ON edges(src_id, dst_id);                         -- out-neighbours, covering
CREATE INDEX edges_dst   ON edges(dst_id, src_id) WHERE dst_id IS NOT NULL; -- backlinks, in-neighbours, covering
CREATE INDEX edges_key   ON edges(dst_key);                                 -- re-resolution by file name
CREATE INDEX edges_label ON edges(label, src_id) WHERE label IS NOT NULL;   -- relationships by property name
```

Notes:

- `ON DELETE CASCADE` on `src_id` matches the other child tables. `ON DELETE SET NULL` on `dst_id` makes deleting a file turn its inbound edges into unresolved edges in the same statement (measured: deleting the biggest hub with 1.1k edges, 6.6 ms). The re-resolution step in 5.2 then lets a same-named file take over.
- Unresolved is `dst_id IS NULL`; there is no separate state column (one source of truth). `ambiguous` exists because an LLM should be told a bare link `[[index]]` matched several files; it needs `PathIndex::resolve` to also report whether it saw more than one candidate (a small change in `resolve.rs`, same module, one function).
- `kind` and `syntax` are two columns, not four composite kinds like today's `markdown_embed`, so "all embeds" and "all markdown-syntax edges" are both one predicate. The mapping from the old `LinkKind` is mechanical: `Wikilink` = (`link`,`wikilink`), `Embed` = (`embed`,`wikilink`), `Markdown` = (`link`,`markdown`), `MarkdownEmbed` = (`embed`,`markdown`); an edge from a frontmatter value is (`property`, either syntax) with `label` set. This replaces `in_fm` (= `kind = 'property'`).
- Edge cases: a property whose value mixes a link and plain text yields one edge per link; a list yields one edge per item with consecutive `ord`; an object-valued property yields the label `parent.child`. A link inside a code fence or span is not an edge (existing scanner rule). A same-file link (`[[#Heading]]`) is stored with `dst_id = src_id` and `dst_key = ''`; graph queries exclude `src_id = dst_id`, the listing commands keep today's behaviour.
- Size, measured: **50k edges = 3.5 MB table + 2.5 MB of indexes = about 6 MB** (`edges_src` 0.7, `edges_dst` 0.7, `edges_key` 1.0, `edges_label` 0.1). 100k notes and 1M edges extrapolate to about 120 MB, comparable to the old `links` plus its two indexes (which store the target path twice per row). `edges_key` is the largest index; if size matters at 1M edges, make it a partial index over only unresolved edges plus a per-name lookup through `files` (open question 4).
- Rejected columns: `src_path`/`dst_path` (use ids; `files` has the path), `weight` (derive: `COUNT(*)` per pair), a stored snippet (4.4), a `rel_type` enum (the property name is the label).

### 4.3 Node data

Nodes are the `files` rows plus derived values. No node table.

- `degree_in`, `degree_out`: computed in SQL or on the snapshot, never stored (storing means updating two rows on every edge change).
- `tags`: `tags` table; `folder`: `files.folder`; `ext` filters out attachments from the default graph view.
- Alias list: from `aliases()`; attribute of the node, not an edge.

### 4.4 Context for the LLM: line and section, snippet on demand

A snippet is the line containing the link with the markup kept, trimmed to 240 characters on a character boundary, plus the section name. It is read from the file at answer time, only for the edges being returned (default cap 20, hard cap 50), through the same confined read path as `writer read`. Why not store it: the index would hold a second copy of up to 240 characters of text per edge (about 12 MB at 50k edges, 240 MB at 1M), the privacy rule "note bodies stay in the vault" is simpler if no body text is ever copied into a database in the app data folder (FTS is contentless for the same reason), and the snippet would go stale between a save and the watcher batch. A stale `line` is detected cheaply: the line at `line` must contain the link text or the snippet is omitted (the edge is still returned). Alternative kept open: store it (open question 3).

### 4.5 Alternatives for the schema (rejected)

- Keep `links` and add an `edges` table: two copies of the same knowledge (DRY). Use one table.
- Per-pair table (`links(src, dst, count)`) like Obsidian's `resolvedLinks`: loses the label per occurrence and the line; the pair view is a `GROUP BY` away.
- Typed node and edge tables per kind (`property_edges`, `body_edges`): every query becomes a `UNION`; `kind` is a discriminator column, as in SilverBullet.
- Storing tags as edges to tag nodes: multiplies rows (ancestors), changes the meaning of degree and orphans; a view suffices.

## 5. Maintenance rules

### 5.1 Writing a note's edges

Same transaction and savepoint as `write_records`: `delete_children` deletes `edges WHERE src_id = ?` then `write_children` inserts the parsed edges with `dst_id` from the in-memory `PathIndex`, `dst_key` computed by one function next to the resolver (`resolve::bucket_key(target)`), `ord`, `line`, `section`. The parser needs three additions in one place (`index/markdown.rs`, `index/frontmatter.rs`, `index/note.rs`): line of each link, nearest heading, and the property key of each frontmatter link (all link spans already exist; headings already carry lines). `PARSER_VERSION` becomes `3` in the same change, so a stale database is rebuilt by the existing `check_existing` path and no backfill code exists. The properties panel's `relationships` type changes no index code: its values are wikilinks in frontmatter, which this path already turns into `property` edges.

### 5.2 Resolution on create, rename, delete

Resolution is a function of (link text, source path, set of vault paths). A change to the set of paths can only change edges whose `dst_key` equals the bucket key of an added or removed file name (the resolver matches the last segment case-insensitively, `.md` optional; relative and partial-path links end in the same segment). So, for a batch:

1. Collect `names_changed` = bucket keys of files added or removed in the batch (`lower(strip_md(name))`, NFC).
2. `SELECT e.id, f.path, e.target, e.kind, e.syntax FROM edges e JOIN files f ON f.id = e.src_id WHERE e.dst_key IN (...)` (index `edges_key`), resolve each with the unchanged `PathIndex::resolve`, `UPDATE edges SET dst_id = ?, ambiguous = ? WHERE id = ? AND (dst_id IS NOT ? OR ambiguous != ?)`.
3. If a batch carries more than N distinct keys (suggest 2,000, or `ChangeBatch.full`), fall back to today's full `resolve_links`. A folder rename or a git checkout takes this path.

Cases (all go through step 2, none has its own branch):

- **Create** `People/Daniel.md`: edges with `dst_key = 'daniel'` are re-resolved: unresolved ones attach; resolved ones may move to a closer same-named file (nearest-folder tie-break); `ambiguous` is recomputed.
- **Delete**: `ON DELETE SET NULL` already detached the inbound edges; step 2 for the deleted name re-attaches those that another file of the same name now satisfies; the others stay unresolved with `target` kept, so the unresolved listing shows what broke.
- **Rename** done by Writer (`relocate::apply`): it rewrites referrers first, then the file moves; the index sees a delete of the old path plus a create of the new one (new `files.id`), so both buckets are re-resolved. A rename done outside Writer is the same events, but referrers are not rewritten: the old name's inbound edges become unresolved, the new name's bucket picks up any pre-existing unresolved links to it. This is the documented behaviour of resolution by file name; the stable-id question is open question 5.
- **Body edit of the source**: its edges are replaced (5.1), nothing else changes.
- **Attachment added** (`photo.png`): bucket `photo.png`; same path.

Cost, measured with the real resolver: one name bucket (about 10 edges) is **0.01 ms**; the largest bucket in the synthetic vault (1,107 edges to one hub name) is 0.8 ms; the current full pass is 43 ms at 50k edges (section 2.2).

### 5.3 Concurrency, epoch, snapshot

- One writer thread and the read pool are unchanged. Edge writes sit in the existing batch transaction; readers see a consistent WAL snapshot.
- `Index.epoch` already moves after every writer job. Replace `BacklinkMap` (a full-table scan per epoch) by an `Arc<GraphSnapshot>` in `EpochCache`, built lazily on first whole-graph query: `Vec<u32>` CSR offsets and targets for both directions over distinct resolved non-self pairs of `md` files, plus per-node degrees. Build cost measured at 2.4 to 7 ms for 50k edges; at 1M edges about 100 to 150 ms (extrapolated), once per epoch, off the writer thread. `file.backlinks` for Bases reads the snapshot (one source for backlinks, DRY).
- The CLI process (`Index::open_for_cli`) uses the same code; it takes the same advisory lock when opening and reads through its own read connections.

### 5.4 Migration

The index is a cache; schema 2 to 3 is delete and rebuild (existing mechanism). Phases in section 9.

## 6. Benchmark

### 6.1 Scratch benchmark (done, outside the repo)

A throwaway crate in the scratchpad (`graphbench/`, not in the repo; it copies `index/resolve.rs` read-only and depends on `rusqlite = "=0.43.0"` with `bundled`, i.e. the same SQLite 3.54.1) built an in-memory-like vault: 4,999 notes in 60 folders (2% duplicate names), 50,000 edges by preferential attachment (heavy-tailed in-degree; 20% of notes never cited, 25% never link out), 10% `property` edges over 5 labels (`manager`, `reports-to`, `project`, `related`, `author`), 7% embeds, 3.1% unresolved (1,527), resolved with the real `PathIndex`. Result: 47,255 distinct resolved pairs, 284 connected components, biggest hub degree 1,125. Release build, macOS, Apple silicon, WAL file DB, `ANALYZE` run once.

### 6.2 Measured results

| Query                                                 | Time (min over repeats)         | Notes                                          |
| ----------------------------------------------------- | ------------------------------- | ---------------------------------------------- |
| backlinks(hub, 1.1k rows)                             | 0.56 ms                         | `edges_dst`, temp b-tree for order             |
| backlinks(mid) / outlinks(mid)                        | 0.011 / 0.009 ms                |                                                |
| neighbors depth 1 (hub / mid)                         | 0.28 / 0.011 ms                 | 966 / 21 nodes                                 |
| neighbors depth 2 (hub / mid)                         | 5.5 / 0.7 ms                    | 4,390 / 1,670 nodes                            |
| neighbors depth 3 (hub / mid)                         | 21 / 9 ms                       | 4,715 / 4,570 nodes                            |
| naive `UNION ALL` depth 3 from hub (rejected)         | 956 ms                          | 4.75 M rows                                    |
| path-guarded `UNION ALL` depth 3 from mid (rejected)  | 58 ms                           | 104k rows                                      |
| shortest path, SQL BFS with path column (rejected)    | 2,042 ms (distance 4)           | does not stop early                            |
| distance layers depth 4 / 5, then walk back           | 25 / 42 ms                      | SQL                                            |
| shortest path, Rust BFS, prepared statements          | 50 ms                           | no snapshot needed                             |
| shortest path, snapshot BFS                           | 0.06 ms (+2.4 ms snapshot load) |                                                |
| orphans (no in, no out) / no backlinks                | 0.79 / 0.62 ms                  | covering indexes, correlated `NOT EXISTS`      |
| unresolved grouped by name                            | 1.4 ms                          | scans the 1.5k-row subset through `SCAN edges` |
| degree ranking top 20                                 | 3.1 ms                          |                                                |
| edges by label `manager`                              | 0.34 ms                         | `edges_label`                                  |
| connected components (union-find over an edge scan)   | 1.6 ms                          | Rust                                           |
| related notes, shared neighbours weighted (mid / hub) | 13.7 / 41 ms                    | weight computed once per via-node              |
| related notes, weight computed per row (rejected)     | 26.9 / 78 ms                    |                                                |
| replace one note's edges (delete + 10 inserts)        | 0.05 ms                         |                                                |
| re-resolve one name bucket / hub bucket / everything  | 0.01 / 0.8 / 43 ms              | real `resolve.rs`                              |
| initial resolve + write of all 50k edges              | 170 ms                          | includes 48k `UPDATE`s                         |
| delete a hub file (1.1k inbound edges `SET NULL`)     | 6.6 ms                          |                                                |
| database size, 50k edges                              | edges 3.5 MB + 2.5 MB indexes   |                                                |

`EXPLAIN QUERY PLAN` (3.54): backlinks `SEARCH e USING INDEX edges_dst (dst_id=?)` plus a temp b-tree for the order; outlinks `SEARCH ... edges_src (src_id=?)`; re-resolution `SEARCH ... edges_key (dst_key=?)`; label `SEARCH ... edges_label (label=?)`; the neighbourhood recursion uses `SEARCH e USING COVERING INDEX edges_src (src_id=? AND dst_id>?)` and `... COVERING INDEX edges_dst (dst_id=?)` for its two terms; orphans two correlated covering searches. `unresolved` scans `edges` (1.4 ms; add `CREATE INDEX edges_unresolved ON edges(dst_key) WHERE dst_id IS NULL` only if a 1M-edge vault makes it slow).

### 6.3 Repo benchmark plan (to implement with the schema, in `index/tests.rs` next to `perf_smoke_3000_notes`)

A `#[test] #[ignore]` (run with `cargo test --release graph_bench -- --ignored --nocapture`) that builds the synthetic vault of 6.1 on disk through `Index::open_for_cli` (real files, real parser) at three sizes: 5k notes/50k edges (the budgets are asserted here), 20k/200k and 100k/1M (printed, with looser budgets, to catch super-linear behaviour). Budgets at 5k/50k, release build, generous by 3x to 5x over the measurements to absorb CI noise:

| Operation                                 | Budget |
| ----------------------------------------- | ------ |
| backlinks / outlinks of any note          | 5 ms   |
| neighbors depth 1                         | 5 ms   |
| neighbors depth 2                         | 25 ms  |
| neighbors depth 3 (hub, result capped 2k) | 80 ms  |
| shortest path, snapshot                   | 10 ms  |
| shortest path, no snapshot (first call)   | 100 ms |
| snapshot build                            | 30 ms  |
| orphans, unresolved, degree top 20        | 15 ms  |
| edges by label                            | 5 ms   |
| related notes (hub)                       | 100 ms |
| re-resolve for one created note           | 5 ms   |
| incremental write of one edited note      | 20 ms  |
| cold build overhead of edges vs `links`   | +20%   |

Also assert plan shape with `EXPLAIN QUERY PLAN` for backlinks, outlinks, label and re-resolution (no `SCAN edges`), and parity (section 9, phase 1).

## 7. Queries (ready to use)

`?1` is a `files.id` (resolve a name or path to an id with `SELECT id FROM files WHERE path = ?`, or `Index::resolve_link`). Results are rows of ids; the Rust layer joins to paths. All graph queries exclude `src_id = dst_id` unless stated.

```sql
-- Backlinks of a note, with detail (document order per source)
SELECT e.src_id, e.kind, e.syntax, e.label, e.ord, e.line, e.section, e.display, e.subpath, e.ambiguous
FROM edges e WHERE e.dst_id = ?1 AND e.src_id <> ?1 ORDER BY e.src_id, e.ord;

-- Outlinks of a note (resolved and unresolved), document order
SELECT e.id, e.dst_id, e.target, e.kind, e.syntax, e.label, e.line, e.section, e.display, e.subpath, e.ambiguous
FROM edges e WHERE e.src_id = ?1 ORDER BY e.ord;

-- N-hop neighbourhood, both directions, cycle-safe, depth-limited.
-- UNION (not UNION ALL) over (id, d) bounds the walk to depth * nodes; the LIMIT is a safety net on result size.
WITH RECURSIVE walk(id, d) AS (
  SELECT ?1, 0
  UNION
  SELECT e.dst_id, w.d + 1 FROM walk w JOIN edges e ON e.src_id = w.id WHERE w.d < ?2 AND e.dst_id IS NOT NULL
  UNION
  SELECT e.src_id, w.d + 1 FROM walk w JOIN edges e ON e.dst_id = w.id WHERE w.d < ?2
  LIMIT 200000
)
SELECT id, MIN(d) AS depth FROM walk WHERE id <> ?1 GROUP BY id ORDER BY depth, id LIMIT ?3;

-- Edges inside a subgraph (the graph view and the prompt use this after choosing the node set)
-- nodes(id) is a temp table or a VALUES list filled from the query above
SELECT e.id, e.src_id, e.dst_id, e.kind, e.label FROM edges e
WHERE e.src_id IN (SELECT id FROM nodes) AND e.dst_id IN (SELECT id FROM nodes) AND e.src_id <> e.dst_id;

-- Shortest path between two notes, step 1: distance layers from ?1 up to ?3 hops (undirected).
-- Step 2 (Rust): from ?2 walk back, at each step pick any neighbour with depth - 1 using the two prepared
-- neighbour statements. On a snapshot, run BFS in memory instead (preferred). Do not run BFS-with-path in SQL.
WITH RECURSIVE walk(id, d) AS (
  SELECT ?1, 0
  UNION
  SELECT e.dst_id, w.d + 1 FROM walk w JOIN edges e ON e.src_id = w.id WHERE w.d < ?3 AND e.dst_id IS NOT NULL
  UNION
  SELECT e.src_id, w.d + 1 FROM walk w JOIN edges e ON e.dst_id = w.id WHERE w.d < ?3
)
SELECT id, MIN(d) FROM walk GROUP BY id;

-- Orphans: markdown notes with no edges in or out (`graph:orphans`; the `incoming` flag relaxes it to "no incoming")
SELECT f.id FROM files f WHERE f.ext = 'md'
  AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.dst_id = f.id AND e.src_id <> f.id)
  AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.src_id = f.id AND (e.dst_id IS NULL OR e.dst_id <> f.id));

-- Unresolved targets, grouped by the file-name bucket, with counts and a sample source
SELECT dst_key, MIN(target) AS example, COUNT(*) AS edges, COUNT(DISTINCT src_id) AS notes
FROM edges WHERE dst_id IS NULL AND dst_key <> '' GROUP BY dst_key ORDER BY edges DESC, dst_key;

-- Degree ranking (hubs): distinct neighbours in plus out, resolved edges between markdown notes
SELECT id, SUM(c) AS degree FROM (
  SELECT dst_id AS id, COUNT(DISTINCT src_id) AS c FROM edges WHERE dst_id IS NOT NULL AND src_id <> dst_id GROUP BY dst_id
  UNION ALL
  SELECT src_id, COUNT(DISTINCT dst_id) FROM edges WHERE dst_id IS NOT NULL AND src_id <> dst_id GROUP BY src_id
) GROUP BY id ORDER BY degree DESC LIMIT ?1;

-- Relationships by property name (`manager: [[Daniel]]`); NULL ?1 = every property edge
SELECT e.src_id, e.dst_id, e.target, e.label, e.ord, e.line FROM edges e
WHERE e.kind = 'property' AND (?1 IS NULL OR e.label = ?1) ORDER BY e.label, e.src_id, e.ord;

-- Relationship labels in use, with counts (the vocabulary the agent should reuse)
SELECT label, COUNT(*) AS edges, COUNT(DISTINCT src_id) AS notes FROM edges
WHERE kind = 'property' GROUP BY label ORDER BY edges DESC;

-- Related notes (not already linked), ranked by shared neighbours weighted by 1 / (1 + degree) (Adamic-Adar style,
-- no ln(): the bundled SQLite has no math functions). Covers co-citation (two notes cited by the same note)
-- and co-reference (two notes citing the same note) in one score because neighbours are undirected.
WITH nb(id, w) AS (
  SELECT n.id, 1.0 / (1 + (SELECT COUNT(*) FROM edges x WHERE x.src_id = n.id) + (SELECT COUNT(*) FROM edges x WHERE x.dst_id = n.id))
  FROM (SELECT dst_id AS id FROM edges WHERE src_id = ?1 AND dst_id IS NOT NULL AND dst_id <> ?1
        UNION SELECT src_id FROM edges WHERE dst_id = ?1 AND src_id <> ?1) n
), two(y, via, w) AS (
  SELECT e.dst_id, nb.id, nb.w FROM nb JOIN edges e ON e.src_id = nb.id WHERE e.dst_id IS NOT NULL
  UNION
  SELECT e.src_id, nb.id, nb.w FROM nb JOIN edges e ON e.dst_id = nb.id
)
SELECT y AS id, COUNT(*) AS shared, SUM(w) AS score FROM two
WHERE y <> ?1 AND y NOT IN (SELECT id FROM nb) GROUP BY y ORDER BY score DESC LIMIT ?2;

-- Graph view edge list including tag nodes (a view, not stored): tag nodes get negative ids by rowid of a tag map in Rust,
-- so the SQL here only produces (src_id, tag) pairs
SELECT file_id AS src_id, tag FROM tags WHERE source IN ('frontmatter', 'body');
```

Connected components and hub-neighbour tie-breaks are computed on the snapshot (union-find, 1.6 ms), not in SQL: label propagation in a recursive CTE is quadratic in the component size.

Bounding rules for every traversal: depth at most 4 from the CLI (default 2), a result cap, and a hub guard for display (a node whose degree exceeds 300 is listed but not expanded unless named; the SQL neighbourhood above is exact, the guard lives in the Rust function that renders it).

## 8. LLM side and the future graph view

### 8.1 `writer graph` command family

Added through the existing registry (`cli/registry.rs`) and formatters; one function per command in a new `cli/cmd_graph.rs`; the data comes from `Index` methods in a new `index/graph.rs` (the only place with graph SQL). `file=` and `path=` resolve as in the other commands. Every command takes `format=json|tsv|text` (default `text` for a human, the skill tells the agent to use `format=json`), `limit=`, and prints `writer: ...` errors to stderr.

| Command                                                                                               | Output                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `graph:neighbors file=X depth=2 [kind=property] [label=manager] [direction=in\|out\|both] [limit=50]` | Nodes with `depth`, `degree`, `via` edge kind and label of the first hop, and the edges among the returned nodes.                    |
| `graph:path from=X to=Y [maxdepth=6]`                                                                 | The shortest path as a node list plus the edge (kind, label, direction) of each step; exit 1 with "no path within N hops" otherwise. |
| `graph:relationships [file=X] [label=manager]`                                                        | Property edges: `source`, `label`, `target`, resolved or not; with no `file=`, the label vocabulary with counts.                     |
| `graph:backlinks file=X [context] [limit=20]`                                                         | Like `backlinks`, plus `kind`, `label`, `section`, and with `context` a capped snippet (4.4) per edge.                               |
| `graph:related file=X [limit=10]`                                                                     | The related-notes query with `score` and `shared` (and the shared neighbours' names).                                                |
| `graph:hubs [limit=20]`, `graph:components`                                                           | Degree ranking, component sizes with one example per component.                                                                      |

`graph:` follows the existing `base:`/`search:context` colon style (ADR 2026-11-15, Obsidian-style grammar). The former `links`, `backlinks`, `unresolved`, `orphans`, `deadends` were removed by ADR 2026-11-19 (their jobs are `graph:neighbors direction=out`, `graph:backlinks`, `graph:unresolved`, `graph:orphans`, `graph:deadends`); until then they were re-implemented on `edges` in phase 2 with identical output (golden test). The managed skill `writer-cli` gets a "Graph" section and `references/commands.md` the table above (the skill source is `src-tauri/skills/`, compiled in; changing it bumps `BUNDLE_VERSION`, a test enforces it). A new `writer-graph` skill is not needed unless the section outgrows the CLI skill.

### 8.2 Graph context for the prompt

When notes are attached with `@` (native-agent spec section 5, "What Writer sends"), Writer already sends paths, not bodies. Add an optional, token-capped block per send, built by Rust from the snapshot, never from note bodies:

```
Graph context (from the vault index; names are file names, resolved by file name):
- Daniel Ortiz.md  [in: 14, out: 6, tags: #person #eng]
  manager -> Priya Rao.md
  reports (property "reports-to", 4 notes): Ana, Ben, Cho, Dee
  linked from: Q3 Review.md (section "People"), 1:1 notes/2026-11-03.md, +12
  related: Hiring plan.md (shares 5), Org chart.md (shares 4)
- Unresolved links in the attached notes: [[Budget 2027]] (2 notes)
```

Rules: ranked by relevance (property edges first, then direct body links by recency, then related notes by score), at most 40 lines or 1,200 tokens (estimated as characters / 4) per send and 12 lines per attached note, deterministic order so the prompt prefix is cache-stable between turns when the graph did not change, and omitted entirely when no attached note has edges. Snippets are not included by default (the agent can call `writer graph:backlinks context`); including them is a setting. The block is a new section in the existing prompt assembler (one function, one place), with a golden test in the style of `shared/agent-prompt-golden.json`. A setting turns it off.

### 8.3 Project manifest

The project source manifest (`agent/project_context.rs`: kind, label, count, up to 20 sample paths) gains one optional source kind: `Linked(note, depth)` = the depth-limited neighbourhood of a note (for example the whole "Daniel Ortiz" relationship cluster), resolved through the same `SourceIndex` port with a new `SourceQuery::Neighbors { note, depth, label }`. Samples stay paths; no text. The manifest diff-per-send logic is unchanged.

### 8.4 What must never leak

- Note bodies beyond the capped snippet (240 characters, only for returned edges, only on explicit request or setting). No frontmatter values other than link targets and property names. No full-note text in the prompt block, the CLI output of `graph:*` (apart from the snippet) or the index.
- Private vault paths in logs: log counts, depths and durations, never node names or paths (`SPECs/local-logging-spec.md`: never log note contents or secrets). The scratch benchmark and the repo benchmark generate synthetic names only; the private vault is never read.
- The snippet reader goes through the confined read path (`vault_ops`), so a link whose target or source is outside the vault (symlink escapes) is never opened.
- The graph-context block lists file names that the user already attached or that are linked from them; it is built from the user's own vault and sent only to the agent they chose, like any attachment. It does not add notes the user did not link or attach beyond the capped `related` entries, which carry names, not text.

### 8.5 Graph view data contract (later; no UI now)

Tauri commands (async, through `commands::blocking`), serde camelCase, next to `commands/index.rs`:

```ts
type GraphNode = {
  id: number;
  path: string;
  name: string;
  folder: string;
  ext: string;
  degreeIn: number;
  degreeOut: number;
  tags: string[];
  unresolved?: boolean;
};
type GraphEdge = {
  id: number;
  src: number;
  dst: number | null;
  kind: "link" | "embed" | "property";
  label?: string;
  target: string;
  ambiguous?: boolean;
};
type GraphSlice = { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean; epoch: number };
// graph_slice({ center?: path, depth?: 1|2|3, kinds?: [...], labels?: [...], folders?: [...], tags?: [...],
//               includeUnresolved?: boolean, includeTags?: boolean, limit?: number }) -> GraphSlice
// graph_stats() -> { notes, edges, unresolved, components }
```

- No `center` means the whole vault (limit default 10,000 nodes (user, 2026-11-17), highest degree first; `truncated` says so). Unresolved targets become ghost nodes (`id` negative, keyed by `dst_key`) only when asked.
- Incremental updates ride the existing `index://changed` event (`ChangeBatch { paths, full }`): the frontend refetches a slice only when the batch touches a path in its node set or `full` is true; or the backend emits `graph://delta` `{ epoch, nodes: GraphNode[] (upserted), removedNodeIds, edgesBySource: { [srcId]: GraphEdge[] } }`, computed from the changed paths (edges whose `src_id` is a changed file, plus nodes whose `dst_id` changed in step 5.2). Prefer refetch first (KISS, one code path), add the delta when a slice is large.
- Layout runs in a Web Worker so typing never competes with it: positions are a frontend concern and are not stored in the index. A force-directed layout library is chosen when the view is built; candidates to evaluate then (not researched here, not added): `d3-force` (small, in-worker friendly), `graphology` with ForceAtlas2 and `sigma.js` (WebGL, large graphs), `cytoscape.js`. The decision belongs to a later ADR with a date-checked comparison.

## 9. Migration plan

1. **Schema, parser, parity.** Add `edges` (section 4.2) and its writer next to `links`, both filled by `write_children` from the same parse; bump `SCHEMA_VERSION` and `PARSER_VERSION` (rebuild is the backfill); add `resolve::bucket_key`, the ambiguity flag, line/section/label in the parser. Dual-run is a test, not a long-lived state: a parity test over `tests/fixtures`-style vaults asserts, for every note, that the multiset of `(src, dst, target, kind-mapped)` in `edges` equals `links`, and that `bucket re-resolve` after create, delete and rename yields the same `dst_id`s as a full `resolve_links`. Parser tests cover property labels (single link, list, nested key) and lines/sections.
2. **Switch readers.** Re-implement `backlinks`, `links`, `unresolved`, `orphans`, `deadends`, `cached_backlinks`/snapshot and Bases `file.links`/`file.embeds` on `edges`; goldens prove unchanged CLI and Bases output; replace the full `resolve_links` in `index_paths` and `scan` by bucketed re-resolution with the full pass as fallback; drop `links` and `in_fm` in a schema bump (rebuild). Benchmarks of 6.3 land here.
3. **CLI `writer graph:*`**, skill and reference updates, `BUNDLE_VERSION` bump, e2e through the real CLI binary against a temp vault.
4. **Agent context**: the prompt block (8.2), the manifest source (8.3), setting and goldens.
5. **Graph view**: commands of 8.5, then the page kind, worker layout, library ADR.

Each phase is one commit and independently shippable; phase 1 changes nothing user-visible, so there is no `CHANGELOG.md` entry for this design (design only).

## 10. Risks

- Parser changes touch the hottest path (every note write): the benchmark's cold-build overhead budget (+20%) guards it.
- Resolution buckets rely on the resolver matching only on the last path segment. A future resolver rule that matches on something else (an alias, a title; both rejected by ADR 2026-11-16) would break the incremental argument; a test asserts that `resolve()` results depend only on candidates sharing the bucket key (property test over generated vaults).
- File ids are not stable across a rename (delete plus create): saved graph layouts, pinned views or any id cached by the frontend must key by path, not id.
- Hubs: a vault with a note linked from half the notes makes depth-3 neighbourhoods approach the whole graph (measured 4.7k of 5k nodes): every consumer must cap results and say `truncated`.
- Edge row count grows with repeated links to the same target; pair views must `DISTINCT`.
- A `STRICT` table in a database that an older Writer opened would fail: not a risk, the schema bump rebuilds, and an older build also sees a schema mismatch and rebuilds.
- Prompt block inflates tokens: hard caps and a setting.

## 11. Open questions for the user

1. **Decided (user, 2026-11-17): open vocabulary.** Any frontmatter key whose value holds a link (a single link or a list of links) becomes a `property` edge labelled with the key, whether or not the key is typed `relationships`. The type record decides only the UI, and `writer graph:relationships` shows the label vocabulary with counts. Body wikilinks and embeds are the primary edge source (`kind` = `link` / `embed`), also confirmed by the user.
2. **Decided (user, 2026-11-17): spec default.** `graph:*` orphans mean "no edges at all"; `graph:orphans` is "no edges at all" and its `incoming` flag is "no incoming" (the `orphans` command was removed, ADR 2026-11-19).
3. **Decided (user, 2026-11-17): spec default.** The capped context snippet is read from the note on demand, never stored in the index.
4. **Decided (user, 2026-11-17): accepted.** About 120 MB at 1M edges is fine; revisit `edges_key` only if a real vault gets near it.
5. **Decided (user, 2026-11-17): spec default.** No stable note identity across rename in phase 1; graph layouts key by path.
6. **Decided (user, 2026-11-17): spec default.** Agent block depth 2 and hub guard 300; tags are nodes only in the graph view.
7. **Decided (user, 2026-11-17): use `petgraph` directly.** The in-memory snapshot (BFS, shortest path, components, degree) is built on `petgraph` (`Csr` / its algorithms) instead of hand-rolled structures. It becomes a direct dependency of `apps/desktop/src-tauri` at implementation time with an exact version pin (0.8.3 is already locked transitively, so the lockfile gains no new crate for it, only a direct edge; check the feature set stays minimal, `default-features = false` where possible). The user's go on this dependency is given; the Cargo.toml edit lands in phase 3 (`writer graph` and the snapshot), not before. Section 3 and the benchmark note that a `Vec<Vec<u32>>` is fast enough stay as the measured baseline the `petgraph` version must match.
8. **Decided (user, 2026-11-17): in scope for phase 1.** `PathIndex::resolve` returns an `ambiguous` flag, which also covers the TODOS item about bare links that change target when a rename creates a duplicate name.

## 12. Implementation status (2026-11-17)

Done, with the benchmarks of 6.3 (`cargo test --release graph_bench -- --ignored --nocapture`, in `index/graph_tests.rs`):

- **Phase 1** `edges` (STRICT) with the parser additions (`index/markdown.rs` line and nearest heading, `frontmatter.rs` property key and line, `note.rs`), `resolve::bucket_key` and the `ambiguous` flag (`resolve_detailed`); `PARSER_VERSION` 3. The parity test against `links` ran while both tables existed.
- **Phase 2** readers (`backlinks`, `links`, `unresolved`, `orphans`, `deadends`, Bases `file.links`, `file.embeds`, `file.backlinks`) read `edges` with unchanged output; `links` and `in_fm` are gone (`SCHEMA_VERSION` 4); `cached_backlinks` is replaced by `Index::graph_snapshot()` (`index/snapshot.rs`, petgraph `Csr` and `UnionFind`, `=0.8.3`, `default-features = false`, feature `std`; the lockfile gained only the direct edge). Re-resolution is bucketed (`index/edges.rs`: `Scope::{All, Sources, Buckets}`, fallback to a full pass past 2,000 buckets or written notes). A cold build drops the four edge indexes and creates them once at the end (maintaining them per row made the cold build 70 to 100% slower; now within noise of the old `links` build); every other scan recreates them if a cut-short build left them missing. A property edge is never an embed, so a `![[x]]` inside a frontmatter value is a plain property edge (the old table kept the embed kind).
- **Phase 3** `writer graph:neighbors`, `graph:path`, `graph:relationships`, `graph:backlinks` (`context` flag), `graph:related`, `graph:hubs`, `graph:components` and `graph:orphans` (the command decision 2 implies; "no edges at all"), in `cli/cmd_graph.rs`; the `writer-cli` skill and reference updated (`BUNDLE_VERSION` 6); e2e through the real binary in `tests/graph_cli.rs`. Formats are `text` (default), `json`, `tsv`; `format.rs` gained `text`. The snippet reader is `index::graph::line_snippet` (240 characters, the line must still contain the link text).
- **View commands** (8.5), in the built-in feature `graph` (`features/graph/rust/`, `plugin:graph|*`, generated `web/bindings.ts`): `graph_slice`, `graph_stats`, and `graph_config_read` / `graph_config_write` for the view's own `.writer/graph.json` (opaque JSON, 256 KB cap, confined to the vault, atomic; never `.obsidian`). The CLI stays in core (spec 8.1), not in the feature. Differences from the 8.5 sketch: `graph_slice` takes one `request` object (the typed-command argument limit is 12); the request also takes `includeAttachments` (default false: non-markdown nodes are left out) and `cardProperties`; `includeTags` is accepted and does nothing (the view builds tag nodes from `node.tags`); `GraphNode.cardValue` is the first set value among `cardProperties` (matched case-insensitively, a list as its first items joined with commas, at most 60 characters, read from `props` and `prop_items`, only when `cardProperties` is non-empty); `GraphNode.tags` are leaf tags as written, while the `tags` filter also matches ancestors; `graph_stats`: `edges` = distinct resolved linked file pairs, `unresolved` = distinct unresolved targets, `components` = connected groups of notes (isolated ones count).

Measured (release build, Apple silicon, synthetic vault of 6.1 with 13 links per linking note and 25% of notes linking to nothing; `cargo test --release graph_bench -- --ignored`):

| Operation (hub = busiest note)             | 5k notes / 48.7k edges (budget)               | 20k / 195k                                  | 100k / 975k                        |
| ------------------------------------------ | --------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| cold build                                 | 0.47 s                                        | 4.0 s                                       | 45.7 s                             |
| snapshot build                             | 4.5 ms (30)                                   | 19 ms                                       | 106 ms                             |
| backlinks of the hub                       | 0.06 ms (5)                                   | 0.15 ms                                     | 1.3 ms                             |
| neighbors depth 1 / 2 / 3 (hub, cap 2k)    | 0.8 / 14 / 28 ms (5 / 25 / 80)                | 2.1 / 20 / 86 ms                            | 10 / 56 / 481 ms                   |
| shortest path, first call / snapshot       | 4.7 ms / 0.01 ms (100 / 10)                   | 20 / 0.3 ms                                 | 118 / 8 ms                         |
| orphans, isolated, unresolved, hubs top 20 | 0.7, 0.7, 1.5, 0.17 ms (15)                   | 3.6, 3.7, 7.0, 0.7 ms                       | 22, 22, 43, 4 ms                   |
| edges by label                             | 2.0 ms (5)                                    | 10 ms                                       | 63 ms                              |
| related notes (hub)                        | 3.5 ms (100)                                  | 10 ms                                       | 44 ms                              |
| re-resolve one created note (hub name)     | 0.09 ms (5)                                   | 0.18 ms                                     | 1.7 ms                             |
| incremental write of one edited note       | 0.5 ms (20)                                   | 0.6 ms                                      | 0.5 ms                             |
| `graph_slice` whole vault (10k cap) / JSON | 26 / 5 ms for 5k nodes, 47k edges (400 / 150) | 73 / 10 ms for 10k nodes, 87k edges, 7.2 MB | 89 / 5 ms for 10k nodes, 35k edges |
| `graph_stats`                              | 15 ms (40)                                    | 118 ms                                      | 886 ms                             |

`graph_stats` at 100k is the one slow spot (the distinct unresolved targets scan the edge table and the components pass runs per call); add the partial `edges_unresolved` index of 6.2 if a real vault gets there.
