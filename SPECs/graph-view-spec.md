# Graph view (UX)

Status: **draft for review (2026-11-17)**. UX of the `graph` built-in feature. The data layer (edges table, snapshot, `graph_slice`, `writer graph:*`) is [`note-graph-spec.md`](./note-graph-spec.md) and its ADR `2026-11-17-represent-the-note-graph-as-one-typed-edge-table-in-the-vault-index` (proposed); section 8.5 there is the data contract this view consumes. Links follow [`link-activation-spec.md`](./link-activation-spec.md). Library ADR: [`docs/decisions/2026-11-17-render-the-graph-view-with-react-sigma-sigma-graphology-and-a-forceatlas2-worker.md`](../docs/decisions/2026-11-17-render-the-graph-view-with-react-sigma-sigma-graphology-and-a-forceatlas2-worker.md).

## 1. Decisions (user, 2026-11-17)

1. **Two entry points**: a global graph as an editor tab, and a local graph as a sidebar panel that follows the active note.
2. **Default content**: notes and links only. Tags, attachments, `.base` files and unresolved (missing) notes are off, each with a toggle.
3. **Grouping by any property**, not only tags: a "Group by" control picks a property (tags, folder or any frontmatter key); notes sharing a value cluster together and get that group's color. Off by default.
4. **Edges styled by kind**, label on hover: body link solid and thin, embed dashed, property link colored per property name with a legend; arrows when zoomed in.
5. **Color groups you define**: an ordered list of rules mapped to colors, first match wins; node size follows link count.

## 2. Surfaces

### 2.1 Global graph tab

- Opened by the palette command "Open graph", a sidebar action (graph icon) and `writer://graph` style tab restore. One tab kind `graph` (page kind contributed by the feature); the tab survives restart with its filters and camera.
- Canvas fills the tab. Top-left: a search field (highlights matches, `Enter` centers the best match). Top-right: buttons Filters, Groups, Fit (`F`), and a settings cog for forces. Bottom-left: a small legend (edge kinds, property labels, groups), collapsible.
- Opening the tab with an active note centers on it, without filtering.

### 2.2 Local graph panel

- A sidebar panel (contribution point `sidebarPanels`) showing the neighbourhood of the active note: depth slider 1 to 3 (default 1), the same filter and group settings as the global graph but stored separately.
- The active note is the center node, drawn larger with a ring. Switching notes animates to the new neighbourhood (nodes already present keep their place).
- "Open in graph tab" button opens the global graph centered on the same note.
- With no active note: an empty state "Open a note to see its links".

## 3. What is drawn

### 3.1 Nodes

- A note is a circle; its label is the file name without `.md`, shown when zoomed in past a threshold or on hover, always for the center and for search matches.
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
- Layout runs in a Web Worker; the canvas renders with WebGL so 10,000 nodes stay interactive. Libraries (ADR above, user's go 2026-11-17): `@react-sigma/core` over `sigma` 4 (WebGL), `graphology`, and `graphology-layout-forceatlas2` in its Web Worker mode.

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

None. Decided 2026-11-17 (proposed defaults taken): a click in the global graph follows the link-activation rule as is; the local graph panel defaults to depth 1. ForceAtlas2 stays on 0.10.1; 0.11.0-rc1 (`backgroundIterations`) only if layout settling is measured too slow.
