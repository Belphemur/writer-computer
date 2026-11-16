---
status: accepted
date: 2026-11-16
decision-makers: Writer maintainers
---

# Render callouts in the editor with line decorations on the real quote lines

## Context and Problem Statement

Writers coming from Obsidian use `> [!info] Title` callouts for info boxes, warnings and tips. The editor showed them as plain blockquotes and the plugin markdown renderer had a minimal callout output. How do we render callouts in the live editor, and in plugin-rendered markdown, without giving up native editing of the text and without a new dependency? Spec: [`SPECs/callouts-spec.md`](../../SPECs/callouts-spec.md).

## Decision Drivers

- Typing, selection, undo, find and clipboard must behave natively in the body.
- Follow the editor's reveal-on-cursor convention (`docs/editor.md`).
- Theme and snippet CSS written for the documented DOM (`.callout[data-callout]`, `.callout-title`, `.callout-icon`, `.callout-title-inner`, `.callout-fold`, `.callout-content`) should work in both places.
- No new dependency; icons must work under the app CSP; the sanitizer allowlist stays strict.
- One source of truth for types and header syntax (`docs/consolidation.md`).

## Considered Options

- Replace the whole callout with a block widget (rendered DOM, nested editor or source toggle).
- Line decorations on the real blockquote lines, an icon widget over the `> [!type]` prefix, a chevron widget, and a `StateField` for folding.
- Style only with CSS from the existing `.cm-blockquote-line` classes.

## Decision Outcome

Chosen option: line decorations on the real lines, because the body stays ordinary editor content (no nested editor, no height-map surprises from a replacing widget) and the title text stays real text, so inline markdown, wiki links and links render through the existing hide and fold extensions.

- `src/lib/callouts/` holds the one parser (`syntax.ts`), the tree scan (`tree.ts`), hand-written stroke icons built with `createElementNS` (`icons.ts`), session fold state (`fold-state.ts`), shared DOM helpers (`dom.ts`) and the CSS. The editor (`components/editor-area/callout-decorations.ts`) and the plugin renderer both use them.
- A `StateField` (block-spanning replacement must not come from a plugin) emits the line decorations and widgets and, when folded, an inline replace over the body that is also registered as atomic ranges.
- Reveal: the raw header shows while a selection touches the callout; a folded callout stays folded while the caret is on its header line. The hide extension skips the `[!type]` marker, which lezer parses as a shortcut-reference `Link`.
- Fold state is in memory per document path and callout index, never in the file.
- The renderer builds the callout from marked tokens (not rendered HTML), and the post-pass fills icons after sanitising; the shared DOMPurify core gains `data-callout-fold`, `data-callout-metadata` and four classes, with no SVG in the allowlist.
- Callouts in list items are not decorated in the editor.

### Consequences

- Good, because editing, undo, find, export and print are unchanged: the document text is the only source of truth.
- Good, because snippets that set `--callout-color` and `--callout-icon` apply in the editor and in rendered markdown.
- Bad, because every line of a callout carries the `callout` class, so third-party `.callout` layout rules apply per line.
- Bad, because fold state keyed by index can land on a neighbour when callouts are inserted above, and nested callouts show only the inner colour on inner lines.
- Neutral, because the visuals and caret behaviour around folded callouts are unverified in a real window (see the spec).

## Implementation Plan

- **Affected paths**: `apps/desktop/src/lib/callouts/`, `components/editor-area/callout-decorations.ts` (wired in `editor-extensions.ts`), `lib/prosemark-core/hide/index.ts` (Link predicate), `drag-selection-gate.ts` (self-handling widget), `lib/obsidian-host/api/markdown-render.ts`, `theme-compat.ts`.
- **Dependencies**: none.
- **Patterns to follow**: `hideExtension` for tree-derived fields and `unfurlFreezeFacet`; `docs/editor.md` "Buttons inside widgets".
- **Patterns to avoid**: replacing widgets for the body; SVG in the sanitizer allowlist; persisting fold state in the note.
