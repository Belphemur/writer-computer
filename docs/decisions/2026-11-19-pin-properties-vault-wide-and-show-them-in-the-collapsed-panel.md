---
status: accepted
date: 2026-11-19
decision-makers: Writer maintainers
---

# Pin properties vault-wide and show them in the collapsed properties panel

## Context and Problem Statement

The properties panel ([ADR 2026-11-16](2026-11-16-show-note-properties-in-a-collapsible-panel-edited-by-byte-minimal-text-splices.md)) collapses to "Properties (14)" plus the note's tags. Everything else is hidden until it is expanded, so a task note's `status`, `priority` and `due` take a click to see. The user (2026-11-19) asked to pin properties "so when collapsed we still see that property like the tags", with a pin icon at the row's right next to the ×. They chose: pins apply to the whole vault; the collapsed header shows each pinned value as a chip with its type icon; a chip is editable in place; pinned rows come first when expanded.

## Decision Drivers

- One source of truth per property: its type already lives in `.writer/property-types.json` ([ADR 2026-11-17](2026-11-17-record-property-types-in-writers-own-file-and-read-obsidians-types-json-read-only.md)), which syncs with the vault.
- The collapsed header stays one line and terse (`docs/design.md`).
- Editing reuses the existing property editors; no second editor.

## Considered Options

- A. A `pinned` flag on the property's entry in `.writer/property-types.json`, with an order.
- B. Per-note pins, device-local.
- C. A separate `.writer/pinned-properties.json`.

## Decision Outcome

Chosen option: **A**.

1. **Storage**: each entry of `.writer/property-types.json` may carry `"pinned": <n>` (an integer, its position among pinned properties, 0 first); absent means not pinned. A property can be pinned before it has a declared type: its entry then holds only `pinned`, and its type stays inferred. Written through the one write path of `property_types.rs` (atomic, the existing commands extended or one `property_pin_set(name, pinned: bool)` command); `.obsidian/types.json` is never written. Older builds ignore the unknown key (entries are kept as raw JSON).
2. **Row**: a pin button at the row's right, next to the remove ×: shown on row hover and focus, always shown while pinned (filled pin icon, `--accent`). Title "Pin" / "Unpin". `tags` keeps its own collapsed display and is not pinnable (it already shows).
3. **Collapsed header**: after the tags, one chip per pinned property present in the note, in pin order: the property's type icon (or the enum value's icon or emoji when it has one) and the value, formatted as the panel does (dates short, `Nov 20`; links as their title; lists joined, truncated with `+n`). The property name is the tooltip. Absent or empty pinned properties show nothing. The row wraps no more than the existing tag chips do; overflow collapses to `+n`.
4. **Edit in place**: clicking a chip opens that property's existing editor (enum dropdown, date picker, link picker, text field) anchored to the chip through `AnchoredPopover`, without expanding the panel; the edit goes through the existing byte-minimal frontmatter write path.
5. **Expanded order**: pinned rows first, in pin order, then the others in the note's order. Display order only; the file's key order never changes.
6. **Bases and the CLI**: unchanged. The pin is panel display state only.

### Consequences

- Good: key properties visible at a glance in every note, editable without expanding.
- Good: one file, synced with the vault, shared across devices.
- Bad: pins are vault-wide; a property pinned for tasks also shows on other notes that have it (accepted by the user).

### Non-goals

- Per-note or per-type pins; reordering pins by drag (order is the order pinned, unpin and re-pin to change it) unless trivial; pinning in Bases views.

## Implementation Plan

- **Affected paths**: `src-tauri/src/property_types.rs` (the `pinned` key, read and write, tests), `commands/index.rs` (the command), TS `lib/property-types.ts` and `stores/property-types-store.ts` (pins exposed from the one store), the properties panel components (row pin button, collapsed chips, ordering, chip editor via `AnchoredPopover`), `SPECs/properties-types-spec.md` and the properties panel spec, `CHANGELOG.md`.
- **Patterns to follow**: the existing type entry read and write; the existing value editors and formatters (reuse, never re-render values differently in the chip); `docs/design.md` popovers and terse labels.
- **Patterns to avoid**: a second store of pins; a second formatter for chip values; reordering frontmatter keys.
- **Tests**: Rust: pin, unpin, order, a pin on an untyped property, raw unknown keys kept, never writing `.obsidian`. Web: the pin button shows on hover and stays when pinned; the collapsed header shows chips in pin order with the type or enum icon and short values; absent pinned properties show nothing; clicking a chip edits in place and writes the note; expanded order puts pinned first; `tags` has no pin.

### Verification

- [ ] Pinning `status` in one note shows its value chip in the collapsed header of every note that has `status`.
- [ ] Clicking the chip changes the value without expanding the panel.
- [ ] Pinned rows are first when expanded; the file's key order is unchanged.
