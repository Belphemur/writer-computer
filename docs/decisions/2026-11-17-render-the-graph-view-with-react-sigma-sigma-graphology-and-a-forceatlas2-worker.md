---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Render the graph view with react-sigma, sigma.js 4, graphology and a ForceAtlas2 worker

## Context and Problem Statement

The `graph` built-in feature adds a global graph tab and a local graph sidebar panel ([`SPECs/graph-view-spec.md`](../../SPECs/graph-view-spec.md)). The data comes from the vault index through `graph_slice` / `graph_stats` ([`SPECs/note-graph-spec.md`](../../SPECs/note-graph-spec.md) section 8.5, ADR [one typed edge table](2026-11-17-represent-the-note-graph-as-one-typed-edge-table-in-the-vault-index.md)), capped at 10,000 nodes with `truncated`. That data ADR left the rendering and layout library to "a later ADR with a date-checked comparison"; this is it.

The view needs: interactive rendering of up to 10,000 nodes and their edges while the user types in the editor; a force layout that never runs on the main thread; edges styled by kind and property label; group-by-property clustering with hulls; live updates without resetting the camera; pins; keyboard access; React 19 and the Vite toolchain.

## Decision Drivers

- Smooth at the 10,000-node cap on an ordinary laptop; layout off the main thread.
- React 19 compatible, maintained in 2026, permissive license (MIT or Apache-2.0).
- Small dependency tree; out of the startup bundle (lazy, inside the feature).
- Low-level control for custom layers (group hulls), node and edge programs, and incremental updates.
- Graph algorithms stay in Rust (`petgraph`, data ADR); the browser only lays out and draws.

## Considered Options

Versions and dates checked on the npm registry on 2026-11-17.

- A. `@react-sigma/core` 6.0.0 (2026-10-14, MIT) over `sigma` 4.0.6 (2026-11-10, MIT, WebGL), `graphology` 0.26.0 (MIT) and `graphology-layout-forceatlas2` 0.10.1 (MIT; its synchronous iteration, run in our own worker).
- B. `reagraph` 4.32.0 (2026-06-25, Apache-2.0): React-first WebGL, built on three.js and react-three-fiber (about 20 dependencies).
- C. `react-force-graph-2d` 1.29.2 (2026-09-29, MIT): canvas 2D (WebGL only in its 3D variant).
- D. `cytoscape` 3.35.0 (2026-11-10, MIT): canvas, the richest algorithm set.
- E. `d3-force` in our own worker plus our own canvas/WebGL renderer.

## Decision Outcome

Chosen option: **A**.

1. **Dependencies** (user's go, 2026-11-17), exact pins in `apps/desktop/package.json`: `@react-sigma/core@6.0.0`, `sigma@4.0.6`, `graphology@0.26.0`, `graphology-layout-forceatlas2@0.10.1`. Nothing else (no `@react-sigma/layout-*` helpers unless a later change justifies one; no graphology algorithm packages, algorithms are Rust).
2. **Ownership**: only the `graph` feature (`apps/desktop/features/graph/`) imports them. Core never does; the feature's web entry is lazy, so the libraries stay out of the entry chunk.
3. **One graph model**: one module in the feature turns a `GraphSlice` into a graphology `Graph` and applies updates in place (add, drop, update attributes by path), used by both the tab and the panel. Ids from the index are not stable across renames, so graphology node keys are paths.
4. **Rendering**: `SigmaContainer` and the react-sigma hooks (`useLoadGraph`, `useRegisterEvents`, `useSigma`, `useSetSettings`) host the canvas. Node and edge styling (kind, property-label color, size by degree, dimming on hover) are sigma reducers fed from the feature's settings, not per-node React components. Group hulls are a custom layer drawn under sigma's canvas from node positions.
5. **Layout**: ForceAtlas2 in a Web Worker that is **our own module** (`features/graph/web/layout.worker.ts`, a Vite module worker bundled as its own file), driving the package's synchronous `iterate` over the same flat node and edge matrices the library builds, in small batches, and posting positions back as a transferable `Float32Array`. It is not `FA2Layout` from `graphology-layout-forceatlas2/worker`, which builds a blob worker and would need `blob:` in the CSP; with our file the CSP stays `worker-src 'self'`. A supervisor (start, stop, kill, running, settle by time budget, short burst for reduced motion) starts it on load and on structural change, stops it when the layout settles or the view is hidden, and drops a run whose graph changed under it. Settings come from the feature's force settings. Group-by-property adds attraction toward a group anchor node. Pinned nodes are fixed (the `fixed` flag of the matrix). Positions are frontend state (tab state for pins and camera), never written to the index or the vault.
6. **Interaction** follows the link-activation rule (`src/lib/link-activation.ts`): node clicks go through `linkIntent` and `activateLink`, never a hand-written button check.
7. **Fallback**: a node list (the visible slice, keyboard reachable) for screen readers and for WebGL being unavailable; on a WebGL context loss the view shows the list with a "Reload graph" action.

### Consequences

- Good: WebGL keeps 10,000 nodes interactive; sigma's published ceiling is far above our cap, leaving headroom if the cap is raised.
- Good: model, layout and renderer are separate libraries; a different layout (d3-force) could replace ForceAtlas2 without touching rendering.
- Good: react-sigma gives React-idiomatic hosting and event hooks while reducers keep per-frame work out of React.
- Bad: four new npm dependencies to keep updated. `graphology-layout-forceatlas2`'s stable release 0.10.1 dates from 2022-10-17, with a 0.11.0-rc1 on 2024-11-08 (adds `backgroundIterations`); it lives in the graphology monorepo, which is active (commits in 2026-11), and `@react-sigma/layout-forceatlas2` 6.0.0 (2026-10-14) still declares `^0.10.1`. A mature algorithm rather than an abandoned one; if it ever breaks with a future graphology, option E's `d3-force` in a worker is the replacement.
- Bad: react-sigma 6 and sigma 4 are recent major versions; pin exactly and upgrade together.
- Neutral: hulls are our own code (no library provides them); kept in one layer module.

### Non-goals

- 3D graphs, timeline playback, editing links by drawing edges.
- Graph algorithms in the browser (components, centrality, shortest path stay in Rust).
- Storing positions in the index or `.writer/graph.json`; reading or writing `.obsidian/graph.json`.
- Using these libraries outside the `graph` feature.

## Implementation Plan

- **Affected paths**:
  - `apps/desktop/package.json` and lockfile: the four pinned dependencies.
  - `apps/desktop/features/graph/` (new feature, per `.agents/skills/writer-feature/SKILL.md`): `feature.json` (kill switch `features.graph.enabled`), `settings.schema.json` fragment (local depth, label zoom threshold, forces, animation), `web/index.ts` (contributions: page kind `graph`, sidebar panel "Local graph", sidebar action, palette command "Open graph", settings page), `web/model.ts` (slice to graphology, in-place updates), `web/graph-canvas.tsx` (SigmaContainer, reducers, events), `web/layout.ts` (FA2 worker supervisor, pins, group attraction), `web/hulls.ts`, `web/filters/`, `web/groups/`, `web/node-list.tsx` (fallback), `web/store.ts` (view state; `.writer/graph.json` read/write through a feature command), `tests/`.
  - Rust: `graph_slice` and `graph_stats` as feature commands (`plugin:graph|*`, tauri-specta bindings) over the index, per the data spec; `.writer/graph.json` read/write confined to the vault.
  - `SPECs/graph-view-spec.md` (status), `SPECs/builtin-plugins-spec.md` (feature list), `CHANGELOG.md`.
- **Patterns to follow**: the built-in feature layout and lazy entry (bases, tables); `@/` and `@features/` imports and the boundary test; link activation for every node click; settings fragments; one model module shared by tab and panel.
- **Patterns to avoid**: a React component per node or edge; layout on the main thread; importing graph libraries from core; keys by index id; per-surface click handling.
- **Tests**:
  - Model: slice to graph and in-place updates keep unchanged nodes (positions) and drop removed ones; keys are paths.
  - Reducers: style per edge kind and property label, size by degree, hover dimming (pure functions).
  - Layout: the supervisor starts and stops; pinned nodes do not move (worker mocked in jsdom).
  - Link activation: left, middle, Cmd/Ctrl and Cmd/Ctrl+Shift clicks on a node call `activateLink` with the right intent.
  - Bundle: the entry chunk contains none of the four libraries (chunk-graph test as for bases).
  - Fallback list renders the visible slice and opens notes from the keyboard.
  - Perf: a 10,000-node slice builds the graph model under a budget in jsdom; real frame rate is a manual check.

### Verification

- [ ] The four dependencies are pinned exactly and imported only under `features/graph/`.
- [ ] The entry chunk has no sigma, graphology or react-sigma code.
- [ ] ForceAtlas2 runs in our own module worker (`layout.worker.ts`, its own file in the bundle, `worker-src 'self'`, no `blob:`); the main thread does not run layout iterations.
- [ ] Node clicks go through `src/lib/link-activation.ts` (inventory test passes).
- [ ] An index change updates the graph without resetting the camera or moving unchanged pinned nodes.
- [ ] Manual: typing in a note stays smooth with the global graph open on a 10,000-node vault; the local panel follows the active note.

## Pros and Cons of the Options

### A. react-sigma + sigma 4 + graphology + ForceAtlas2 worker

- Good, because WebGL, a worker layout and a separate graph model fit every driver, with React bindings for React 19.
- Bad, because four dependencies, one of them with its last stable release in 2022 (release candidate 2024-11).

### B. reagraph

- Good, because it is React-first with built-in layouts and WebGL.
- Bad, because it brings three.js, react-three-fiber and about 20 dependencies for a 2D graph.

### C. react-force-graph-2d

- Good, because it is the quickest to start with.
- Bad, because its 2D mode is canvas, not WebGL, and degrades at a few thousand nodes.

### D. cytoscape

- Good, because it has the richest algorithms and styling.
- Bad, because canvas rendering slows around 3,000 to 5,000 nodes, and its algorithms duplicate what Rust already does.

### E. d3-force plus our own renderer

- Good, because it is the smallest dependency and full control.
- Bad, because we would write and maintain a WebGL renderer, hit-testing and camera ourselves.

## More Information

UX spec: [`SPECs/graph-view-spec.md`](../../SPECs/graph-view-spec.md). Data: [`SPECs/note-graph-spec.md`](../../SPECs/note-graph-spec.md) and the [edge table ADR](2026-11-17-represent-the-note-graph-as-one-typed-edge-table-in-the-vault-index.md) (still proposed; the view is built after its phases 1 to 3). Sources consulted on 2026-11-17: npm registry entries of each package; [PkgPulse 2026 comparison](https://www.pkgpulse.com/guides/cytoscape-vs-vis-network-vs-sigma-graph-visualization-2026); [react-sigma layouts](https://sim51.github.io/react-sigma/docs/example/layouts/); [Linkurious overview](https://linkurious.com/blog/top-javascript-graph-libraries/). Revisit if the layout package stops working with graphology, if the node cap rises past what WebGL with labels handles, or if react-sigma falls behind sigma's major version.

**Addendum (2026-11-17, user).** Target devices are GPU-equipped Macs. The node cap is raised from 3,000 to **10,000** (data contract default limit and the view's banner). Cosmograph was considered and rejected: `@cosmograph/cosmograph` and `@cosmograph/react` 2.5.1 are CC-BY-NC-4.0 (incompatible with Writer's GPL-3.0) and pull in DuckDB-WASM, Arrow, Mosaic and a Supabase client. Its MIT engine `@cosmos.gl/graph` (3.6.0, 2026-11-04, GPU force simulation) is the named alternative if the cap must go far beyond 10,000 (whole-vault graphs of 50k+ notes); the data commands would not change. Sigma stays the choice for now.

**Addendum (2026-11-17, user): layout worker and CSP.** The layout runs in Writer's own Vite module worker (`features/graph/web/layout.worker.ts`) over ForceAtlas2's synchronous API, not the package's `graphology-layout-forceatlas2/worker` (which builds a `blob:` worker). The CSP keeps `worker-src 'self'` and no `blob:` anywhere; `obsidian-host-eval-csp.test.ts` enforces it. Considered and rejected: widening the CSP with `worker-src 'self' blob:` (it would let any page code, Obsidian plugins included, start blob workers).

**Addendum (2026-11-17, user): level of detail.** The view has four zoom levels from one table (`features/graph/web/lod.ts`), driven by on-screen node spacing with 15% hysteresis: Overview (one bubble per group, or per folder when "Group by" is off and at least two folders exist, else the top hubs), Structure (dots, faint edges, hub labels), Detail (all labels, edge styles, arrows, hulls), Close-up (HTML cards capped at 150 nodes in view, with title, tags and `cardValue`; property labels on edges). Aggregates are computed once per slice or grouping change, never per frame.

**Addendum (2026-11-18, user): label mode.** Node labels show only around the hovered node, the selection and search matches by default (`display.labels`: `hover`, with `zoom` the level-driven behaviour above and `always`). Edge labels follow the same rule and close-up cards need a hovered or selected node in `hover` mode. The decision stays in `lod.ts`; hover only refreshes sigma. The legend of edge kinds is gone (the Clusters list replaces it, see the 2026-11-18 clustering ADR). Spec: `SPECs/graph-view-spec.md` section 13.
