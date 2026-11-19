---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Give enum values an optional emoji or icon, picked from one core icon picker

## Context and Problem Statement

Enum properties (`SPECs/properties-types-spec.md` "Enum") store an ordered list of values in `.writer/property-types.json` and show a dropdown in the properties panel. Values are plain text. The user asked (2026-11-18) that each enum value can optionally get an emoji or an icon, the user's choice. The only icon picker today is the agent feature's project icon picker (`features/agent/web/components/project-icon-picker.tsx`: search over the Hugeicons free set, lazily loaded shards, virtualized grid), which core cannot import (a feature's internals are private).

## Decision Drivers

- One icon picker (DRY): core and features use the same one.
- Optional: a value without an icon looks as today.
- Old type files load unchanged; never write `.obsidian`.
- No new dependency.
- Terse UI.

## Considered Options

- A. Move the picker to core with two tabs, Icons and Emoji (a generated emoji JSON plus a type-or-paste field); set per value from the enum dropdown; shown in the properties panel and Bases cells and groups.
- B. Icons tab plus a type-or-paste emoji field only (no emoji data).
- C. A separate "Manage values" dialog per enum.

## Decision Outcome

Chosen option: **A** (the user chose each part).

1. **One picker in core**: the icon search, shards and grid move from `features/agent/web/` to core (`src/components/icon-picker/`, `src/lib/icon-picker/`); the agent's project picker becomes a thin wrapper adding its colours and Reset. A boundary test keeps core free of `@features/agent` imports.
2. **Tabs**: Icons (Hugeicons, as today) and Emoji: a search by name over a grid of emoji, plus "Type or paste" for any emoji. The emoji list is a generated JSON (`apps/desktop/src/lib/icon-picker/emoji.json`: emoji, name, keywords, group) built by a committed script from the Unicode `emoji-test.txt` (Unicode License v3, a data file, not a dependency), lazily loaded like the icon shards.
3. **Value of an icon**: one string per value, `emoji:<emoji>` or `icon:<HugeiconsName>`; rendered by one core `<EnumValueIcon>`.
4. **Storage**: the enum entry gains an optional `icons` map keyed by value: `{"type": "enum", "values": ["todo", "done"], "icons": {"done": "emoji:✅"}}`. Absent means no icon. Validated in Rust (`property_types.rs`: known prefix, a key that is in `values`, one emoji grapheme or a known-shaped icon name, size cap). Renaming a value keeps its icon; removing a value drops it; the auto-added values (enum auto-add) have none. Written only through `property_type_set` (the one write path).
5. **Set from the dropdown**: each value row in the enum dropdown has a small icon slot; a click opens the picker; the picker has "Remove icon". Keyboard: the slot is reachable with Tab within the row; Escape closes the picker first, then the dropdown.
6. **Shown in**: the properties panel (the value cell and its dropdown rows) and Bases (table cells, cards, group headers). Never in the note body.

### Consequences

- Good: values read at a glance; one picker for projects and enums.
- Good: old files and Obsidian are untouched.
- Bad: the picker move touches the agent feature; an emoji data file (a few hundred KB, lazy) ships in the bundle.
- Neutral: icon colours are not per value (they follow the text colour).

### Non-goals

- Per-value colours; icons on non-enum properties; icons in the note body; custom image icons.

## Implementation Plan

- **Affected paths**: move `features/agent/web/components/project-icon-picker.tsx` and `features/agent/web/lib/project-icon-search.ts`, `project-icon-shards.ts` (and the shard generator if any) to `src/components/icon-picker/` and `src/lib/icon-picker/`; agent wrapper keeps colours; `scripts/` emoji generator + `src/lib/icon-picker/emoji.json`; `src-tauri/src/property_types.rs` (`icons` validation and preservation, rename/remove), TS `src/lib/property-types.ts`, `stores/property-types-store.ts` (set/remove icon through `property_type_set`), the enum dropdown (`EnumSelect` in `src/components/editor-area/`), Bases cells/cards/group headers in `features/bases/web` (through the core `EnumValueIcon`), `SPECs/properties-types-spec.md` (Enum section), `SPECs/native-agent-spec.md` (project picker now core), `CHANGELOG.md`.
- **Patterns to follow**: lazy shards; the one write path; `docs/design.md` (popover layer, `scrollIntoScroller`, terse text).
- **Patterns to avoid**: a second picker; an emoji npm package; storing icons in the note.
- **Tests**: picker in core (search icons, search emoji by name and keyword, type-or-paste accepts one emoji and refuses text, Remove icon); agent project picker still works (existing tests pass through the wrapper); Rust validation (bad prefix, key not in values, multi-grapheme emoji, cap), rename keeps and remove drops an icon, old files load; dropdown slot opens the picker, Escape order; panel cell and Bases cell/card/group show the icon; no `@features/agent` import in core.

### Verification

- [ ] An enum value can get an emoji or an icon from its dropdown row, and lose it with "Remove icon".
- [ ] The icon shows in the properties panel and in Bases cells, cards and group headers.
- [ ] A value without an icon looks as before; old type files load unchanged.
- [ ] Projects still pick their icon through the same picker.

## Pros and Cons of the Options

### A. Core picker with Emoji tab

- Good, because one picker, searchable emoji.
- Bad, because a data file and a move of agent code.

### B. Type-or-paste only

- Good, because no data file.
- Bad, because emoji are not searchable in the app.

### C. Manage values dialog

- Good, because all values in one place.
- Bad, because a new screen for a small setting.

## More Information

Related: [properties types spec](../../SPECs/properties-types-spec.md), the URL type ADR `2026-11-18-add-a-url-property-type-shown-as-links-and-inferred-from-values`, the project icons in `SPECs/native-agent-spec.md` (4.8).
