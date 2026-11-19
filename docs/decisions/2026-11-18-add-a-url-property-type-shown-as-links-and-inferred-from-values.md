---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Add a URL property type shown as links and inferred from values

## Context and Problem Statement

Notes often hold web addresses in properties (`website`, `source`, `docs`). Today they are plain Text: shown as an input, not clickable, and nothing infers them. The property type system (`property_types.rs`, `SPECs/properties-types-spec.md`, ADR `2026-11-17-record-property-types-in-writers-own-file-and-read-obsidians-types-json-read-only`) has no URL type; Obsidian has none either. The user asked (2026-11-18) for a URL property type, "also automatic detection too", and chose each part below.

## Decision Drivers

- Every clickable reference behaves like a browser link through `src/lib/link-activation.ts` (ADR `2026-11-17-open-every-link-like-a-browser-link-through-one-link-activation-module`).
- One type source of truth; never write `.obsidian`.
- Never rewrite a value the user did not edit; byte-minimal splices.
- Terse UI.

## Considered Options

- A. A `url` type: value shown as link chips, edited on the side; one URL or a list; http, https, mailto and bare domains; inferred when every value is a URL.
- B. A Text field with an open button beside it.
- C. Any scheme accepted and opened through the OS.

## Decision Outcome

Chosen option: **A**.

1. **Type**: `url` joins `PropertyType` (Rust and TS, label "URL", a hugeicons link-square/globe icon distinct from Relationships' `Link01Icon`). Stored as `"url"` in `.writer/property-types.json` only; `obsidian_name` is `text` (a list: `multitext`); a plugin `setType('url')` is rejected like `relationships`. Offered in the type menu after Relationships.
2. **Valid value**: `http://`, `https://`, `mailto:`, or a bare domain (`example.com`, `example.com/path`, a dot-separated host with a TLD of 2+ letters, no spaces) which opens as `https://`. One shared predicate pinned by a vectors file `apps/desktop/shared/url-vectors.json` read by a Rust test and a TS test. Anything else stays as written, marked "Not a URL", and is never rewritten.
3. **Panel**: each URL is a link chip showing host + path (scheme and `www.` dropped, truncated with the full URL in the title); a click opens it through `link-activation` (`openExternal`; plain, Cmd/Ctrl and middle click as the link rules say); a pencil, or a click on the empty part of the row, edits the raw text (Enter saves, Escape cancels). A list shows one chip per item with × and "+" like the List editor.
4. **Lists**: one URL or a list of URLs (like Relationships).
5. **Inference (automatic detection)**: a property with no type in `.writer/property-types.json` or `.obsidian/types.json` is inferred `url` when every observed non-null value (scalars and list items, from the index) is a valid URL by the shared predicate; text and multitext otherwise as today. Inference never writes a type. A property whose name is `tags`/`aliases` is never inferred url.
6. **Converting**: to URL keeps values (invalid ones marked); away from URL keeps the text.
7. **Elsewhere**: Bases cells of a `url` property render as the same link chip (one shared chip component); the CLI and index treat the value as text.

### Consequences

- Good: web addresses in properties are clickable and inferred with no setup.
- Good: one predicate shared by Rust and TS.
- Bad: inference may type a property url that a user meant as text; changing the type fixes it and is stored.
- Neutral: other schemes (`obsidian://`, `file://`) are not URLs here.

### Non-goals

- Fetching titles or favicons (no network calls).
- Schemes other than http, https, mailto.
- Detecting URLs inside Text values of other types.

## Implementation Plan

- **Affected paths**: `src-tauri/src/property_types.rs` (variant, `parse`, `wire_name`, `obsidian_name`, `fits`, inference from observed values), the index's observed-values query if inference needs a URL check per value, TS `src/lib/property-types.ts`, `stores/property-types-store.ts`, `src/lib/property-conversion.ts`, `src/components/editor-area/property-value.tsx` (URL editor, link chip), `features/obsidian-host` metadataTypeManager mapping, `features/bases/web` cell rendering (through the shared chip, a core component), `apps/desktop/shared/url-vectors.json`, `SPECs/properties-types-spec.md` (Types table + "URL" section), `CHANGELOG.md`.
- **Patterns to follow**: Relationships (single or list, chips, writer-only type); `link-activation` for opening; shared vectors for Rust/TS twins; `docs/design.md`.
- **Patterns to avoid**: a hand-written `window.open` or `auxclick`; a second URL regex; rewriting a value on display.
- **Tests**: vectors (valid, bare domain, mailto, invalid with spaces, `javascript:` refused, ftp refused) in both languages; inference (all URLs → url; one non-URL → text; typed property not overridden; tags/aliases never); `obsidian_name`; panel chip opens via link activation (plain, Cmd, middle), pencil edit Enter/Escape, list add/remove, "Not a URL" mark and no rewrite; Bases cell chip; plugin shim sees `text`/`multitext`.

### Verification

- [x] A property whose values are all web addresses shows as URL with no setup.
- [x] A click opens the address in the browser; Cmd/middle click follow the link rules.
- [x] The pencil edits the raw text; Escape keeps the old value.
- [x] A non-URL value under the type is marked and never rewritten.
- [x] `.obsidian/types.json` is never written; plugins see `text`.

## Pros and Cons of the Options

### A. Link chips, inferred

- Good, because addresses read as links and need no setup.
- Bad, because inference can surprise; the type menu overrides it.

### B. Text field with open button

- Good, because editing stays one click.
- Bad, because the value never reads as a link.

### C. Any scheme

- Good, because it covers app links.
- Bad, because opening arbitrary schemes through the OS from note content is a trust risk.

## More Information

Related: [properties types spec](../../SPECs/properties-types-spec.md), [link activation spec](../../SPECs/link-activation-spec.md), the object type ADR `2026-11-18-add-an-object-property-type-edited-as-indented-rows-up-to-two-levels`.
