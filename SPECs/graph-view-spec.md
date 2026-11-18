# Graph view (UX)

Status: **web half implemented 2026-11-17 (phases 3 to 6), Rust half and `.writer/graph.json` commands pending**. UX of the `graph` built-in feature. The data layer (edges table, snapshot, `graph_slice`, `writer graph:*`) is [`note-graph-spec.md`](./note-graph-spec.md) and its ADR `2026-11-17-represent-the-note-graph-as-one-typed-edge-table-in-the-vault-index` (proposed); section 8.5 there is the data contract this view consumes. Links follow [`link-activation-spec.md`](./link-activation-spec.md). Library ADR: [`docs/decisions/2026-11-17-render-the-graph-view-with-react-sigma-sigma-graphology-and-a-forceatlas2-worker.md`](../docs/decisions/2026-11-17-render-the-graph-view-with-react-sigma-sigma-graphology-and-a-forceatlas2-worker.md).

## 1. Decisions (user, 2026-11-17)

1. **Two entry points**: a global graph as an editor tab, and a local graph as a sidebar panel that follows the active note.
2. **Default content**: notes and links only. Tags, attachments, `.base` files and unresolved (missing) notes are off, each with a toggle.
3. **Grouping by any property**, not only tags: a "Group by" control picks a property (tags, folder or any frontmatter key); notes sharing a value cluster together and get that group's color. Off by default.
4. **Edges styled by kind**, label on hover: body link solid and thin, embed dashed, property link colored per property name; arrows when zoomed in. Relationship-property edges are off by default (section 13).
5. **Color groups you define**: an ordered list of rules mapped to colors, first match wins; node size follows link count.

## 2. Surfaces

### 2.1 Global graph tab

- Opened by the palette command "Open graph", a sidebar action (graph icon) and `writer://graph` style tab restore. One tab kind `graph` (page kind contributed by the feature); the tab survives restart with its filters and camera.
- One compact icon toolbar above the canvas: search (highlights matches, `Enter` centers the best match), Whole vault or local, node list, Fit (`F`), panel. One side panel to the right of the canvas (Display, Clusters, Filters, section 13). Nothing floats over the canvas but the info card of a selected node.
- The tab opens on the current note's local graph at the remembered depth (2 by default); with no note open it shows the whole vault. "Whole vault" drops the depth, the toggle returns to it.

### 2.2 Local graph panel

- A sidebar panel (contribution point `sidebarPanels`) showing the neighbourhood of the active note: depth slider 1 to 5 (default 2, remembered), the same panel, filter and display settings as the global graph but stored separately.
- The active note is the center node, drawn larger with a ring. Switching notes animates to the new neighbourhood (nodes already present keep their place).
- "Open in graph tab" button opens the global graph centered on the same note.
- With no active note: an empty state "Open a note to see its links".

## 3. What is drawn

### 3.1 Nodes

- A note is a circle; its label is the file name without `.md`, shown by the label mode (section 13: on hover by default), always for the center, selected notes and search matches.
- Size: `base + k * sqrt(degreeIn + degreeOut)`, capped.
- Optional nodes, each a toggle in Filters: **Tags** (a tag node per tag, edges from notes; nested tags link child to parent), **Attachments** (images and other files, square), **Bases** (`.base`, diamond), **Missing notes** (unresolved targets, hollow and dimmed; clicking one offers "Create note").
- **Orphans** (no edges) toggle, on by default in the global graph.

### 3.2 Edges

| Kind     | Style                           | Hover                     |
| -------- | ------------------------------- | ------------------------- |
| link     | thin solid, neutral color       | "links to"                |
| embed    | thin dashed                     | "embeds"                  |
| property | solid, color per property label | the label, e.g. `manager` |

Arrowheads appear past a zoom threshold. Multiple links between the same pair are drawn once (width grows slightly with the count). Hovering a node highlights it, its edges and its neighbours and dims the rest.

### 3.3 Filters panel

- Search query (same syntax as Search in notes: `path:`, `tag:`, words), applied as "show only matches and their links".
- Toggles: Tags, Attachments, Bases, Missing notes, Orphans.
- Edge kinds: Links, Embeds, Properties, with one checkbox per property label under Properties (from `writer graph:relationships`).
- Folders: include and exclude lists.

### 3.4 Groups panel

Two independent tools that combine:

1. **Color rules**: ordered list; each rule is a query (`path:`, `tag:`, `[property:value]`, words) and a color; first match wins; unmatched nodes use the accent color. Drag to reorder.
2. **Group by**: none (default) or a property: `tags`, `folder`, or any frontmatter key from the property list (Writer property types included, enums too). Each distinct value is a group: a soft force pulls its notes together, a faint hull is drawn behind the cluster with the value as label, and the group gets a color from a fixed palette unless a color rule matches first. A note with several values (a list property, several tags) joins its first value's group and draws a thin link to the others' hulls. A nested tag groups at its top segment by default, with a "nested level" control (1 to 3).

## 4. Interaction

- **Click a node**: open the note, following the link-activation rule (left click current tab; middle click and `Cmd`/`Ctrl`+click a background tab; `Cmd`/`Ctrl`+`Shift`+click a new active tab). In the local panel, a left click opens the note and recenters on it.
- **Drag a node**: moves it and pins it there until double-click or "Unpin all"; pins are per graph tab and keyed by path.
- **Right click a node**: Open, Open in new tab, Reveal in sidebar, Focus here (global graph: set as center with depth), Copy link, Attach to agent chat (when the agent feature is on).
- **Canvas**: scroll to zoom, drag to pan, `F` fit, `Esc` clears search and focus, arrow keys move between neighbours of the focused node, `Enter` opens it. Every node is reachable by keyboard and screen readers get a list fallback ("Nodes" list of the visible slice).
- **Live updates**: an edit that adds or removes a link updates the graph without resetting the camera; new nodes fade in near their neighbours.

## 5. Scale

- The global graph requests at most 10,000 nodes (highest degree first, per the data contract); a banner says "Showing 10,000 of N notes, refine with filters" when truncated.
- Hubs above 300 links are drawn but not auto-expanded in the local graph.
- Layout runs in a Web Worker; the canvas renders with WebGL so 10,000 nodes stay interactive. Libraries (ADR above, user's go 2026-11-17): `@react-sigma/core` over `sigma` 4 (WebGL), `graphology`, and `graphology-layout-forceatlas2`, whose synchronous iteration runs in our own module worker (`layout.worker.ts`), never a blob worker.

## 6. Settings and persistence

- The feature `graph` (kill switch `features.graph.enabled`) contributes a settings page: default depth of the local graph, label zoom threshold, forces (center, repel, link distance, group pull), animation on or off (also off when the OS asks for reduced motion).
- Filters, color rules and group-by are saved per vault in `.writer/graph.json` (Writer's own folder; never `.obsidian/graph.json`). The local panel and the global tab each have their own section.
- Camera and pins are per tab state (session restore), not in the vault file.

## 7. Agent integration

- With the agent feature on, the selection in the graph (one or more nodes, shift-click to add) can be attached to a chat with "Attach to agent chat", which sends paths, as `@` does.
- The graph context block for the prompt is the data spec's section 8.2; the view adds nothing to it.

## 8. Phasing

1. Data layer phases 1 to 3 of `note-graph-spec.md` (edges, readers, `writer graph:*`, `petgraph` snapshot): no UI.
2. `graph_slice` and `graph_stats` commands (8.5), library ADR.
3. Global graph tab: nodes, edges by kind, click and hover, filters, search.
4. Local graph panel.
5. Groups: color rules, then group by property with hulls.
6. Agent attach, keyboard navigation polish, list fallback.

## 9. Non-goals

- 3D graph, timeline playback, editing links by drawing edges.
- Storing positions in the index or the vault file (pins live in tab state only).
- Reading or writing `.obsidian/graph.json`.

## 10. Open questions

None. Decided 2026-11-17 (proposed defaults taken); superseded 2026-11-18 (section 13): a click selects and shows an info card, the gestures of the link table open, the local graph defaults to depth 2. ForceAtlas2 stays on 0.10.1; 0.11.0-rc1 (`backgroundIterations`) only if layout settling is measured too slow.

## 11. Implementation notes (web half, 2026-11-17)

- Code: `apps/desktop/features/graph/` (`feature.json`, `settings.schema.json`, `web/`, `tests/`). The page kind `graph` is core's (`page-kinds/graph.ts`, `Location` is a closed union, like `base`); its body is the lazy slot `page-view:graph`; the tab keeps camera and pins in its location (session), the vault keeps filters, color rules and Group by.
- One model (`model.ts`: slice to `GraphSpec` with the filters applied, then `applySpec` in place keyed by path), pure reducers (`reducers.ts`), the ForceAtlas2 worker supervisor (`layout.ts`, factory injected), groups and hull geometry (`groups.ts`, `hulls.ts`), one surface hook shared by the tab and the panel (`use-graph-surface.ts`).
- Group pull is a hidden anchor node per group with weighted edges from its members (ForceAtlas2 has no custom force). Tag nodes are built client-side from `GraphNode.tags` (the slice contract has no tag nodes). Property-based color rules and Group by read frontmatter through the core `index_get_metadata`, only when a rule or the property needs it.
- "Attach to agent chat" goes through the service `agent.context` (`features/agent/web/api.ts`), absent while the agent is off.
- At 10,000 nodes labels are hidden below the zoom threshold, and sigma's label grid (largest, so highest degree, first) limits the rest; hover, focus, search and center always label; edge hover hit-testing turns off when zoomed out past a camera ratio of 3.
- The layout worker is our own module over ForceAtlas2's synchronous API (`layout.worker.ts`, `layout-worker-core.ts`, `layout-worker-client.ts`), bundled as its own file; the CSP is `worker-src 'self'` with no `blob:` anywhere (the library's own `/worker` entry builds a blob worker, so it is not used).
- Pending: `.writer/graph.json` needs two Rust commands (`graph_config_read`, `graph_config_write`, see `web/ipc.ts`); until they exist the view uses defaults and does not save. Not verified in a real window: WebGL rendering, edge dashes and arrows, the center ring, hulls, drag-to-pin, frame rate at 10,000 nodes.

## 12. Level of detail (semantic zoom)

The graph shows more the further you zoom in and less the further you zoom out. One function (`features/graph/web/lod.ts`) turns the camera into one of four levels; the tab and the panel share it because it lives in the shared stage.

**Measure.** The on-screen spacing between neighbouring nodes in pixels: `min(width, height) / (sqrt(nodes) * cameraRatio)`. A 40-note graph at "fit" is already in Detail; a 10,000-node graph at "fit" is in Overview. The setting "Label zoom" scales the spacing, moving every boundary at once.

**Table (the one place the numbers live, `LOD_TABLE`).** A level starts at its minimum spacing; moving to a finer level needs 15% more zoom than the boundary and moving back 15% less (hysteresis), so the view never flickers at a boundary.

| Level     | From spacing | Nodes                                                                              | Edges                                                                            | Labels                                                 | Other                                    |
| --------- | ------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| Overview  | 0 px         | Grouped: one bubble per group, sized by note count. Flat: top hubs plus faint dots | Grouped: one line per pair of groups, width by link count. Flat: hub to hub only | Bubble: "value (count)". Flat: hubs only               | A click on a bubble zooms into the group |
| Structure | 8 px         | Every node a dot sized by degree                                                   | Thin and faint, kinds by color only (no dashes, no arrows)                       | Hubs, plus hovered, searched, center and focused nodes | Edge hover off                           |
| Detail    | 28 px        | As today                                                                           | Style by kind (dashed embeds), arrowheads                                        | Every node in view, within sigma's label grid density  | Edge hover with its label; hulls visible |
| Close-up  | 110 px       | Cards                                                                              | As Detail, and property labels drawn on the edges                                | Titles are on the cards                                | Missing notes show "Create note"         |

**Overview grouping.** One bubble per cluster (section 13: Group by, else folders or communities) when there are at least two; else the flat hubs mode (1.5% of the nodes by degree, at least 5). Notes with no value join "Other". The aggregation (counts, group-to-group link counts) is computed once per slice or grouping change (`aggregate.ts`); a frame only places each bubble at the centroid of its members (`overview.ts`, a canvas layer over the stage) while the reducers hide the sigma nodes and edges.

**Close-up cards.** An HTML overlay (`cards-layer.tsx`) for at most 150 nodes in view (center, hovered and focused first, then by degree): title, up to 3 tags, the note's type or status value. Chosen over a sigma node program because the cost is bounded by the cap however big the graph is, the browser lays out and keeps the text crisp, and a node program would need a text atlas and GLSL for tags and statuses. The overlay takes no pointer events; clicks and hover still reach sigma's picking.

**Card value (needs the Rust half).** The card's type or status comes from the slice, never from reading a note on the web side: `GraphNode.cardValue?: string | null` (the first set value of the properties the request names) and `GraphSliceArgs.cardProperties?: string[]`, filled from the setting `graph.card-properties` (default `type, status`; the user may name an enum property). Until `graph_slice` returns it the card shows no value line.

**Transitions.** At a level change the scene fades in (opacity from 0.3 to 1 over about 220 ms, nodes, edges and bubbles alike); instant when "Animate" is off or the system asks for reduced motion.

**Performance.** The overview draws at most a few hundred bubbles and 400 lines, or about 150 hubs with faint dots (sigma only), so 10,000 notes stay smooth zoomed out; real frame rate is a manual check.

## 13. Clusters, label modes and the side panel (2026-11-18)

ADR: [`2026-11-18-cluster-the-graph-by-detected-communities-and-open-it-on-the-current-notes-local-graph`](../docs/decisions/2026-11-18-cluster-the-graph-by-detected-communities-and-open-it-on-the-current-notes-local-graph.md). All options live in the surface's `display` object of `.writer/graph.json` (`labels`, `clusterBy`, `depth`); `graph_config_write` refuses an unknown value.

**Clusters.** Cluster by `communities` (default) or `folder` (top-level folder); an explicit Group by wins. Communities are Louvain (`graphology-communities-louvain`, fixed seed, run in the layout worker module on a fresh worker when a slice loads, `communities.ts`, `use-clusters.ts`). The name is the cluster's most-linked note, the tooltip subtitle its most common tag; clusters under 3 notes join "Other" (`clusters.ts`). The result is an ordinary group set, so hulls (name and count, from the structure level up), the overview bubbles (name and count; a click zooms in) and the Clusters list need no special case. ForceAtlas2 is tuned to separate clusters (repulsion `repel / 2.5`, gravity `center / 40`, the cluster anchors pull members together).

**Label modes** (`display.labels`, decided only in `lod.ts`): `hover` (default) labels the hovered node and its neighbours, the selected, focused and centered notes and search matches; `zoom` is the level-driven behaviour of section 12; `always` lets sigma's label grid place every node (hubs first). Edge labels (property names): in `hover` only on edges touching the hovered, focused or selected node, from the detail level; otherwise close-up only. Close-up cards: in `hover` only for the hovered, focused and selected notes; in `zoom` and `always` the 150-card cap. Hover is a view-state patch and a sigma refresh: no layout, no refetch.

**Edge kinds.** Links and embeds are on; Properties is off until enabled in Display (with one checkbox per label), and the `graph_slice` request carries only the enabled kinds. The slice depth goes to 5 (`MAX_SLICE_DEPTH`).

**Side panel** (`side-panel.tsx`): Display (Labels, Cluster by, Depth when local, edge kinds), Clusters (colour, name and count, largest first; Group by and colour rules under "Group by and colors"), Filters (search, node kinds, folders). No explanatory text.

**Interaction.** Hover dims all but the node and its neighbours; a click selects and shows the info card (title, folder, tags, Open, New tab, Focus, Unpin while pinned); middle and Cmd/Ctrl clicks open through the link gesture table; a double click opens; dragging pins; Escape or a click on the background clears the selection.

Not verified in a real window: hulls and bubble look, label density, the card position, drag-to-pin, 10,000-node frame rate. The detection measured about 100 ms for 10,000 notes and 30,000 links in the unit benchmark (off the main thread in the app).
