---
status: accepted
date: 2026-11-16
decision-makers: Writer maintainers
---

# Show note properties in a collapsible panel edited by byte-minimal text splices

## Context and Problem Statement

Writer keeps a note's frontmatter outside the CodeMirror document: `OpenFile.frontmatter` holds the YAML text, `OpenFile.content` the body, and `serializeDocument` joins them on save. The properties panel above the editor was always expanded, showed every property as two text inputs, and wrote back through `yaml-entries.ts`, which re-stringifies the whole object. That drops comments, rewrites quoting and list style, turns `{{date}}` placeholders into something else, and loses duplicate keys. In a real vault (aggregate numbers in [the spec](../../SPECs/properties-panel-spec.md), "Real-world shapes") the median note has 6 properties and 9 frontmatter lines, 10% have 14 or more, and nearly half of the notes would push the body below the fold. How should the panel show and edit properties without taking the top of every note and without ever reformatting the user's YAML?

## Decision Drivers

- The frontmatter block must stay byte-identical outside the property being edited (vaults are shared with Obsidian; ADR `2026-11-15-patch-frontmatter-lines-not-the-whole-block`).
- A large block must not push the body off screen, expanded or collapsed.
- Real vaults contain unparsable blocks, duplicate keys, flow collections, Templater placeholders, nested maps and space-separated `tags` strings; none may be corrupted.
- The panel must not re-render while the body is typed in.
- No new dependency (`yaml` is already used for `.base` edits and the index).

## Considered Options

- Keep the panel and `yaml-entries.ts`, add a collapse toggle.
- Move the frontmatter into the CodeMirror document and render a block widget.
- Keep the store as the owner of the frontmatter text; edit it with range-based splices built on the `yaml` Document; collapsible panel with a size heuristic.
- Send every edit through the Rust `note_property_set/remove` patcher.

## Decision Outcome

Chosen option: "Keep the store as the owner of the frontmatter text; edit it with range-based splices", because it fixes the data-loss problem without changing how files load, save, title or watch.

- **Source of truth.** `OpenFile.frontmatter` stays the one owner. `lib/frontmatter-properties.ts` parses it into typed rows and exposes edits (`setScalar`, `addProperty`, `removeProperty`, `renameProperty`, `appendListItem`, `removeListItem`, `setTagString`). Each edit replaces one value token, one list line or one property's lines, using the `yaml` node ranges, and then re-parses the result and compares it with the semantic outcome (the other properties unchanged, in order); a mismatch refuses the edit instead of writing it. `yaml-entries.ts` is no longer used by the app.
- **Refusal.** Unparsable YAML, duplicate keys, a flow-mapping or non-mapping root and non-scalar keys put the panel in a source-only state with a message; single values it cannot edit (nested maps, `{{date}}`, aliases, multi-line strings, unquoted `[[link]]` lists) are read-only rows that show their source. The raw text is always editable (Source toggle, or forced).
- **Collapse.** A header button (`aria-expanded`) toggles the panel. Collapsed it is one row: `Properties (N)` and up to three tag chips. The default is the setting `editor.properties-default-collapsed` (`auto`, `collapsed`, `expanded`); `auto` collapses blocks over 6 properties or 8 lines. A user toggle is remembered per note for the session (`stores/properties-panel-store.ts`, not persisted). Expanded, the body is capped at 40vh and scrolls inside.
- **Not a CodeMirror decoration.** The frontmatter is not in the editor document here, so the block-widget patterns in `docs/editor.md` do not apply and edits are not editor transactions: CodeMirror undo does not cover property edits (the Source textarea has native undo).
- **Not the Rust patcher.** Edits go to the store text (saved by the existing debounced save), not to disk, so the open buffer and the file cannot diverge; a disk write would need the watcher round trip and conflict handling for a note with unsaved body edits. The Rust patcher stays the write path for Bases cells and the CLI, where no buffer is open.

### Consequences

- Good, because comments, quoting, order, blank lines and unknown shapes survive every panel edit, covered by tests on synthetic fixtures modelled on the aggregate shapes.
- Good, because a large block costs one line by default and a bounded box when open.
- Good, because the panel subscribes to one file's frontmatter string; typing in the body does not render it.
- Bad, because two TypeScript YAML splice modules now exist (`base-yaml.ts` serialises and diffs, `frontmatter-properties.ts` uses node ranges); they edit different documents and share no code yet.
- Bad, because property edits are outside CodeMirror undo/redo.
- Bad, because CRLF files are not split into frontmatter and body at all by `parseFrontmatter` (the block stays in the body); unchanged here, but the panel never sees them.
- Neutral, because the setting key says "default-collapsed" while its value is a three-way choice.

## Implementation Plan

- **Affected paths**: `apps/desktop/src/lib/frontmatter-properties.ts`, `apps/desktop/src/components/editor-area/properties-panel.tsx`, `property-value.tsx`, `property-links.ts`, `use-vault-property-keys.ts`, `apps/desktop/src/stores/properties-panel-store.ts`, `apps/desktop/src/hooks/use-properties-panel.ts`, `apps/desktop/shared/settings.schema.json`.
- **Dependencies**: none (`yaml` is already installed).
- **Patterns to follow**: one function per edit that returns `{ok, text}`; every edit is verified by re-parse; a new row kind is one case in `rowOf` and one in `PropertyValue`.
- **Patterns to avoid**: `stringify` of the whole block; writing the value of a refused row; adding an `if (key === ...)` branch for a single property name.
- **Configuration**: setting `editor.properties-default-collapsed` (enum, default `auto`), listed in Settings > Editor by the existing registry.

### Verification

- [ ] `vp test` passes `tests/frontmatter-properties.test.ts` and `tests/properties-panel.test.tsx`.
- [ ] A note with comments, quoted values, a flow list and `{{date}}` is byte-identical outside the edited property after one edit of each kind.
- [ ] In a real window: toggle by click and keyboard, collapse state per note, a 30-property block stays within 40vh.

## More Information

Spec: [`SPECs/properties-panel-spec.md`](../../SPECs/properties-panel-spec.md). Related: `2026-11-15-patch-frontmatter-lines-not-the-whole-block.md`, `2026-04-30-one-settings-schema-shared-by-rust-and-typescript.md`.
