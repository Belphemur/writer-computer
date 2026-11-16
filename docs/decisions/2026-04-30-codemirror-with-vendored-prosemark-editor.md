---
status: accepted
date: 2026-04-30
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Edit markdown in CodeMirror 6 with a vendored Prosemark core

> Backfilled on 2026-11-16 from the git history. `@prosemark/core` is already a dependency in the initial commit (2026-04-30, `594cabd`); it was vendored into the repo on 2026-05-17 (`588df91`, PR #49). No earlier rationale is recorded for choosing CodeMirror itself.

## Context and Problem Statement

Writer edits plain markdown files in place and renders them "live" (hidden markers, folded tables, images, Mermaid, math) while the file on disk stays ordinary markdown. The editor must work on the document text as the single source of truth and handle long notes without lag.

## Considered Options

- CodeMirror 6 with Prosemark (`@prosemark/core`) decorations on top of the markdown syntax tree.
- A rich-text/WYSIWYG model (ProseMirror-style document tree): would need a lossless markdown round trip, which the product promise (files stay ordinary markdown) forbids. This option is not discussed in the repository; it is listed as the usual alternative only.
- Prosemark as an npm dependency (the starting point) versus a vendored copy.

## Decision Outcome

Chosen option: CodeMirror 6 plus Prosemark's decoration approach. On 2026-05-17 the upstream source (jsimonrichard/ProseMark `packages/core`, v0.0.7) was copied into `apps/desktop/src/lib/prosemark-core/` and the npm dependency dropped, so bug fixes can be made locally; the flat mirror of upstream `lib/` plus its LICENSE keeps a future upstream sync feasible (commit message of `588df91`).

### Consequences

- Good, because the document is always the markdown text; decorations only change presentation.
- Good, because editor bugs (list prefixes, selection geometry, tables) are fixed in-tree.
- Bad, because the project now owns a fork of the decoration layer and must re-apply fixes on any upstream sync.
- Bad, because correct decorations depend on CodeMirror internals (viewport, height map, parse frontier); `docs/editor.md` records the rules that cost time to learn (use the layout model, `renderedRanges`, `treeChanged`).

## Implementation Plan

- **Affected paths**: `apps/desktop/src/lib/prosemark-core/`, `apps/desktop/src/components/editor-area/` (`use-prosemark-editor.ts` and widgets), `apps/playground/` (browser harness for the editor core).
- **Patterns to follow**: `docs/editor.md` (layout-model APIs, block widgets, `renderedRanges`, `treeChanged`); one shared theme in `prosemark-theme.css`.
- **Patterns to avoid**: iterating `view.visibleRanges` in a decoration plugin; caret-placement to enter widget edit mode (use range select).

### Verification

- [ ] Editor tests under `apps/desktop/tests/` pass with `vp test`.
- [ ] The playground (`apps/playground/README.md`) renders the vendored core with the app theme.
- [ ] No `@prosemark/core` import remains in `apps/desktop/src/`.

## More Information

- Rules learned: [`docs/editor.md`](../editor.md).
- Related: [`2026-04-30-build-on-tauri-v2-react-zustand.md`](2026-04-30-build-on-tauri-v2-react-zustand.md).
