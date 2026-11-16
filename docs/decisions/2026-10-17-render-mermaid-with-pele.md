---
status: accepted
date: 2026-10-17
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Render Mermaid diagrams with Pele instead of beautiful-mermaid

> Backfilled on 2026-11-16. Date = `93cde62` "Render Mermaid diagrams with Pele instead of beautiful-mermaid". It replaces the renderer introduced on 2026-05-07 (`d93058b`, "Mermaid canvas widget + beautiful-mermaid renderer (#28)"); no ADR existed for that earlier choice. Spec: [`SPECs/pele-diagrams-spec.md`](../../SPECs/pele-diagrams-spec.md); QA: `SPECs/Agent/pele-qa-2026-10-17/README.md`.

## Context and Problem Statement

`beautiful-mermaid` drew 6 of Mermaid's 22 diagram types (flowchart, sequence, class, state, ER, XY chart) and showed "Invalid mermaid header" for the rest. Colours were passed in as renderer options, so theme, accent and contrast changes needed a re-render.

## Considered Options

- Pele (npm `pele`, MIT, zero dependencies): renders every Mermaid 12.1 diagram type to SVG synchronously and themes with CSS variables.
- Keep beautiful-mermaid: leaves 16 types unsupported.
- The official `mermaid` package: not present in the repo ("there was no `mermaid` package left to remove"); it is async, which conflicts with the synchronous `toDOM` render rule in `docs/editor.md`. The spec does not weigh it in detail.

## Decision Outcome

Chosen option: Pele, behind one function `renderMermaid(source)` in `apps/desktop/src/components/editor-area/mermaid-renderer.ts`.

- Colours come from `--pele-*` variables mapped from the app theme in `mermaid-canvas.css`, so light/dark, accent and contrast recolour on screen without re-rendering.
- DOMPurify stays, as a private instance, because notes come from outside the app and Pele is new; tests show it leaves Pele's output unchanged.
- Rendering stays synchronous (no `pele/lazy`); results, including errors, are cached in an LRU.
- Pele's own `mount()`/zoom is not used; the existing canvas keeps pan, zoom, fullscreen and the edit-code panel.

### Consequences

- Good, because all diagram types render and invalid input shows an explicit error state.
- Bad, because layout differs from Mermaid and beautiful-mermaid, Mermaid theme variables and `%%{init}%%` colours do not apply, HTML labels and click callbacks are unsupported, and rendering runs on the main thread (a worker is not done).
- Bad, because only paint changes are allowed in CSS: changing text width makes Pele labels overflow.

## Implementation Plan

- **Affected paths**: `apps/desktop/src/components/editor-area/mermaid-renderer.ts`, `mermaid-canvas.ts`, `mermaid-canvas.css`, `mermaid-decorations.ts`, `mermaid-fullscreen.ts`, `apps/desktop/tests/mermaid.test.ts`, `docs/editor.md`.
- **Dependencies**: `pele` in the catalog (`apps/desktop/package.json`); `beautiful-mermaid` and `elkjs` removed.
- **Patterns to avoid**: calling Pele outside `renderMermaid`; skipping sanitisation; font-weight or letter-spacing overrides on diagram text.

### Verification

- [ ] `vp test` passes `apps/desktop/tests/mermaid.test.ts` (real Pele and DOMPurify under jsdom).
- [ ] No `beautiful-mermaid` in any `package.json` or the lockfile.
- [ ] Every type in `SPECs/Agent/pele-qa-2026-10-17/` renders in both themes in the built app (manual).
