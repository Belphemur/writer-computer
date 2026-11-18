---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Cluster the graph by detected communities and open it on the current note's local graph

## Context and Problem Statement

The graph view ([render ADR](2026-11-17-render-the-graph-view-with-react-sigma-sigma-graphology-and-a-forceatlas2-worker.md), spec `SPECs/graph-view-spec.md`) opens on the whole vault. On a real vault (2026-11-18) the user saw unlabelled dense balls joined by long edges, with no way to tell what each cluster is; a loose text toolbar and a floating legend of about 40 edge kinds (every relationship property) covering the canvas; and hover and click doing little. The overview's "one bubble per folder when Group by is off" rule groups by storage, not by topic. The user asked for clear clusters, a better first view, fewer edge kinds, one control surface and real interaction.

## Decision Drivers

- Clusters must mean something and be named, visible when zoomed out.
- The main thread never blocks: heavy work stays in the layout worker ([render ADR](2026-11-17-render-the-graph-view-with-react-sigma-sigma-graphology-and-a-forceatlas2-worker.md)), CSP `worker-src 'self'`, no `blob:`.
- Stable results: the same vault gives the same clusters on every open.
- 10,000-node cap, with detection plus layout inside the existing budget and no main-thread task over 50 ms.
- Links follow the [link activation ADR](2026-11-17-open-every-link-like-a-browser-link-through-one-link-activation-module.md).
- One place decides what is drawn (`features/graph/web/lod.ts`), one place stores view options (the graph config, `.writer/graph.json`).

## Considered Options

- A. Detected communities (Louvain, `graphology-communities-louvain`) as the default, top-level folder as a setting; local graph on open.
- B. Group by, else top-level folder only (no new dependency).
- C. Communities only, no setting.

## Decision Outcome

Chosen option: **A**.

1. **Cluster by** (graph setting, in the graph config): `communities` (default) or `folder` (the top-level folder). An explicit "Group by" (property, tag or folder) still wins over both, as today.
   - `communities`: Louvain over the notes-and-links graph of the current slice (enabled property edges count, weighted 1), run in the layout worker before the layout, with a fixed random seed so results are stable. Name: the cluster's most-linked note; subtitle: its most common tag. Clusters of fewer than 3 notes join "Other".
   - `folder`: one cluster per top-level folder, named by the folder.
2. **Display**: each cluster is a tinted hull with its label and note count, kept readable when zoomed out (the Overview level draws one labelled bubble per cluster, replacing the folder-bubble rule of the render ADR's 2026-11-17 addendum). A click on a cluster zooms into it. The legend lists clusters (colour, name, count), not edge kinds.
3. **Open**: the graph opens on the current note's local graph, depth 2, with a depth slider (1 to 5) and a "Whole vault" toggle; with no note open it starts on the whole vault. The last depth is remembered.
4. **Layout**: clusters are pulled apart (ForceAtlas2 settings tuned for separation: stronger repulsion, adjusted gravity, optional cluster attraction) and the layout stops once it settles.
5. **Edge kinds**: notes and links (links and embeds) are on by default; every relationship-property edge kind is off until enabled in the panel. The `graph_slice` request carries the enabled kinds, so disabled kinds are never fetched.
6. **Controls**: one compact icon toolbar (search, Whole vault / local, fit, panel) and one right side panel with sections Filters, Display (label mode, depth, cluster by, edge kinds), Clusters (the legend). Nothing floats over the canvas.
7. **Interaction**: hover dims everything but the node and its neighbours; a click selects and shows a small info card (title, folder, tags, Open, Open in new tab, Focus) through the link activation bindings, so middle and Cmd/Ctrl+click open a new tab; a double click opens the note; dragging a node pins it, with Unpin in the card. The label mode default (hover) from the 2026-11-18 render ADR addendum stays.
8. **Dependency**: `graphology-communities-louvain` `=2.0.2` (MIT, by the graphology author, published 2024-12-17; brings `graphology-indices`, `graphology-utils`, `mnemonist`, `pandemonium`), pinned in the pnpm catalog and imported only from `features/graph/web/` (the existing graph import boundary).

### Consequences

- Good: clusters are named by what they contain, and the first view answers "what is around this note".
- Good: the canvas is clear: no floating legend, few edge kinds by default.
- Bad: one more dependency, and Louvain can split or merge clusters differently after large vault edits.
- Neutral: folder clustering stays available for users who organise by folders.

### Non-goals

- Naming or saving clusters by hand.
- Re-running detection live while notes change (it runs when a slice loads).
- 3D views.

## Implementation Plan

- **Affected paths**: `apps/desktop/features/graph/web/` (layout worker `layout.worker.ts` gains the community pass; `lod.ts` and the overview/aggregate modules use clusters; a toolbar and side panel replacing today's text toolbar and floating legend; the info card; local graph mode and depth), the graph config (`graph_config_read/write`, `.writer/graph.json`: `clusterBy`, `depth`, `edgeKinds`, pinned positions if persisted) and its Rust validation in `features/graph/rust/`, `graph_slice` request (local root and depth, enabled kinds) in `src-tauri/src/index/graph.rs` if not already supported, `pnpm-workspace.yaml` catalog and `apps/desktop/package.json`, `SPECs/graph-view-spec.md`, `CHANGELOG.md`.
- **Patterns to follow**: work in the worker; `lod.ts` as the one drawing decision; sigma reducers and `refresh()` for hover; link activation bindings for every open; theme tokens.
- **Patterns to avoid**: running Louvain on the main thread; a second legend or panel; per-edge-kind hard-coding (kinds come from the slice).
- **Tests**: Louvain determinism (same input, same clusters), naming (most-linked note, top tag, "Other" under 3), folder mode, Group by precedence; local graph depth and toggle; edge kinds default off and requested from the slice; panel sections; info card actions through link activation (middle click new tab); pin and unpin; a 10k synthetic worker benchmark for detection plus layout time.

### Verification

- [x] The same vault gives the same clusters on reopen.
- [ ] Each cluster shows a hull, a name and a count when zoomed out; a click zooms into it.
- [ ] "Cluster by: folder" groups by top-level folder; an explicit Group by wins.
- [ ] The graph opens on the current note at depth 2; Whole vault shows the clusters.
- [x] Property edge kinds are off by default and not fetched until enabled.
- [x] No floating legend; one toolbar and one side panel.
- [x] Info card actions follow the link gesture table; double click opens; drag pins.
- [ ] 10k notes: no main-thread task over 50 ms during detection and layout. (Detection runs in a worker and took about 100 ms in the unit benchmark; the layout and frame times need a real window.)

## Pros and Cons of the Options

### A. Communities by default, folder as a setting

- Good, because clusters follow topics and folder users keep their view.
- Bad, because a new dependency and nondeterminism to control (fixed seed).

### B. Group by, else folder

- Good, because no dependency and predictable.
- Bad, because clusters follow storage, which is what looked unclear.

### C. Communities only

- Good, because less to build.
- Bad, because folder-organised vaults lose a meaningful view.

## More Information

Spec: [`SPECs/graph-view-spec.md`](../../SPECs/graph-view-spec.md). Supersedes the Overview folder-bubble rule in the render ADR's 2026-11-17 level-of-detail addendum (the four zoom levels stay). Package facts checked on the npm registry on 2026-11-18. Revisit if detection exceeds the budget at 10k notes or clusters prove unstable across small edits.
