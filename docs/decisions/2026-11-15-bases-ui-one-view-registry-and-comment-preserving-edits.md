---
status: accepted
date: 2026-11-15
decision-makers: Writer maintainers
backfilled: 2026-11-16
---

# Build the Bases UI on one view registry, virtualized lists and comment-preserving `.base` edits

> Backfilled on 2026-11-16. Date = `a41b2ff` "Bases: base_query commands, Obsidian-style CLI, table view with in-place editing" (table, `@tanstack/react-virtual`); `84c3d29` (2026-11-15) added the view registry, cards, list and `registerBasesView`, and `958436b` the embeds. Spec: [`SPECs/obsidian-bases-spec.md`](../../SPECs/obsidian-bases-spec.md) sections 4.3, 4.5, 4.6 and "Frontend status"; component notes: `apps/desktop/src/components/base-view/README.md`.

## Context and Problem Statement

A `.base` tab must stay smooth on 10,000-row results, accept third-party view types from plugins, and edit the user's `.base` file without destroying comments, key order, quoting or keys Writer does not understand. Writer never rewrites a `.base` unless the user changes it in Writer.

## Decision Outcome

- **Virtualized rendering.** `@tanstack/react-virtual` (added as a dependency for this work; none existed before) drives the table (`base-table.tsx`) and the cards and list views (`windowed-list.tsx`); sticky group headers use a range extractor, no scroll listener (`use-sticky-groups.ts`).
- **One view registry.** `apps/desktop/src/lib/bases/view-registry.ts` is the one registry of view types. Built-in table, cards and list register through `registerBaseView` exactly as a plugin's `registerBasesView` does (the host passes the plugin id as `owner`; plugin views are removed when the plugin is disabled). An unregistered type (kanban, map, unknown) renders a placeholder with an Edit YAML button and its settings stay in the file untouched.
- **One `.base` mutation module.** `apps/desktop/src/lib/bases/base-yaml.ts` expresses every config edit (sort, group, filters, properties, column size, views, view options) as a function from the current text to the new text built on the `yaml` `Document` API; a no-op returns the input and the write is skipped. The write path (`use-base-config.ts`) reads the file, applies one such function, writes and reloads. An edit is refused while the file has unsaved changes in a text tab.
- **Cell edits are not YAML round trips in TypeScript.** Property edits go to Rust, the one write path (`2026-11-15-patch-frontmatter-lines-not-the-whole-block.md`); the existing properties panel's `yaml-entries.ts` re-stringifies the whole object and must not be used for cell edits.
- **Embeds** (`![[x.base#View]]`, fenced `base` blocks) are CodeMirror block widgets following `docs/editor.md` (`components/editor-area/base-embed-decorations.ts`, `components/base-view/embedded.tsx`).

### Consequences

- Good, because one registry means built-in and plugin views share the same data model, option controls and teardown.
- Good, because comments and unknown keys survive every edit.
- Bad, because the YAML keys for cards and list options that the Obsidian docs do not name (`image`, `imageFit`, `imageAspectRatio`, `markers`, `indentProperties`, `separator`) are Writer's choice, listed in the spec, and may differ from Obsidian's.
- Bad, because the table, cards, list and embeds are unit-tested (jsdom) but not yet run in the real window (spec "Frontend status", `TODOS.md`).

## Implementation Plan

- **Affected paths**: `apps/desktop/src/lib/bases/` (`view-registry.ts`, `base-yaml.ts`), `apps/desktop/src/components/base-view/`, `apps/desktop/src/lib/obsidian-host/api/bases-view.ts`, `components/editor-area/page-kinds/` (the `base` page kind).
- **Patterns to follow**: a new view type is one `registerBaseView` call; a new config edit is one function in `base-yaml.ts`.
- **Patterns to avoid**: `stringify` of a whole `.base`; writing a `.base` on open, scroll or view switch.

### Verification

- [ ] `vp test` passes `tests/base-yaml.test.ts`, `base-view*.test.tsx`, `base-embed.test.tsx`, `obsidian-host-bases-view.test.tsx`.
- [ ] A `.base` with comments and unknown keys is byte-identical after a no-op session and differs only in targeted lines after a sort change.
- [ ] A 10,000-row base scrolls smoothly in the real app (open item).
