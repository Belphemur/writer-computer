---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Record property types in Writer's own file and read Obsidian's `types.json` read-only

## Context and Problem Statement

A property name has one type across an Obsidian vault (text, list, number, checkbox, date, date and time, plus the special `tags` and `aliases`). Obsidian records the choice in `.obsidian/types.json`. Writer's properties panel now shows a type icon per row and lets the user change the type, so the choice has to live somewhere. Writer must never write into `.obsidian` (vaults are shared with Obsidian and its settings are not ours to change), but a vault that already has a `types.json` should show its types immediately. Before this change the plugin host's `metadataTypeManager.setType` kept a per-session map and the Bases pickers inferred types from the index.

## Decision Drivers

- Never write `.obsidian`.
- An Obsidian vault's existing types show up with no setup.
- One source of truth for the panel, the add-property suggestions, the plugin host and any later consumer (no duplicate type tables).
- Same storage conventions as the rest of Writer's per-vault state (`.writer/`, atomic replace, confined to the vault).
- No new dependency.

## Considered Options

- Write `.obsidian/types.json` like Obsidian does.
- Keep types only in memory or in the app-data folder.
- Own file `.writer/property-types.json` in Obsidian's format, plus a read-only read of `.obsidian/types.json`; Writer's record wins; inference when neither has the name.

## Decision Outcome

Chosen option: "Own file plus read-only Obsidian file". `src-tauri/src/property_types.rs` (Tauri-free) merges both records, infers a type from the index's observed value types when no record exists (`tags`/`aliases` by name), and reports every vault property with its effective type, its source (`writer`, `obsidian`, `inferred`) and how many notes hold a value that does not fit. The only write is an atomic replace of `.writer/property-types.json` (same `{"types": {name: type}}` shape, lower-cased names, Obsidian's type names), and `.writer` must resolve inside the vault. One IPC command (`property_types`) feeds one Zustand store, which the panel and the plugin host's `metadataTypeManager` read; `setType` from a plugin writes Writer's record.

### Consequences

- Good: an Obsidian vault shows its types at once; nothing outside `.writer` changes; a test scans the written paths and asserts `.obsidian` is untouched.
- Good: one registry in Rust and one in TypeScript (`lib/property-types.ts`), with the wire names shared.
- Bad: a type chosen in Writer is not seen by Obsidian (Obsidian keeps its own record); the two can disagree and Writer's wins in Writer.
- Bad: `.obsidian/types.json` is a deliberate, single-file read exception to "Writer never reads `.obsidian`" in `vault_ops::confine`; it is read by a dedicated function, never through the path helpers.
- Neutral: a second open window sees a change after its next fetch (30 s cache), not live.

## Addendum: the `relationships` type

Same decision area, no new ADR. Writer adds one type of its own, `relationships` (a single `[[link]]` or a list of links). It is stored only in `.writer/property-types.json`; an entry of that name in `.obsidian/types.json` is skipped and `.obsidian` is still never written. It is inferred without a record when every non-empty value of the property name across the vault is a link or a list of links (empty values neutral, one plain-text note breaks it), computed read-only from `prop_items` with no index schema change; a recorded type always wins and inference never writes. Plugins see it as `multitext` / `text` and cannot set it (`PropertyType::obsidian_name`).

## More Information

[SPECs/properties-types-spec.md](../../SPECs/properties-types-spec.md). Bases keeps typed values from the index (`bases/README.md` U19); the type record is a UI concern and never re-types a Bases value.
