# Callouts (Obsidian-style admonitions)

Source of truth for syntax: the public Obsidian help page "Callouts" (https://obsidian.md/help/callouts). Clean-room: only that public page was used; nothing was read from an installed Obsidian app and no icon asset was copied. Decision record: [`docs/decisions/2026-11-16-callouts-in-editor.md`](../docs/decisions/2026-11-16-callouts-in-editor.md).

## Problem

`> [!info] Title` blockquotes are the Obsidian way to write info boxes, warnings, tips and so on. The editor drew them as plain blockquotes (a grey bar and the raw `[!info]` text), and plugin-rendered markdown (`MarkdownRenderer`, used by Copilot chat and other plugins) had a minimal callout renderer without icons, folding, nesting or sanitizer support for the documented attributes.

## Goals

1. The editor shows callouts with an icon, a coloured title bar and a tinted body, and editing stays native: the body is the real blockquote lines (no replacing widget), so typing, selection, undo, find and clipboard behave as for any quote.
2. The plugin `MarkdownRenderer` produces the documented DOM, so theme and snippet CSS written for it works in both places.
3. Foldable callouts (`[!type]+`, `[!type]-`) fold and unfold from a chevron; the state lives in memory for the session and is never written to the file.
4. Types, aliases and the fall-back to `note` follow the public page. Custom callouts work through CSS (`--callout-color`, `--callout-icon`).

Non-goals: an "Insert callout" command, changing the type from a context menu, persisting fold state, icon packs beyond the 13 built-ins.

## Syntax coverage

| Syntax                                                           | Editor                                                                                                            | Plugin renderer                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `> [!type]` + `> body`                                           | yes                                                                                                               | yes                                      |
| `> [!type] Title`                                                | yes (default title when absent: the typed name, capitalised)                                                      | yes                                      |
| Type is case-insensitive (`[!NOTE]`)                             | yes                                                                                                               | yes                                      |
| 13 built-in types and aliases                                    | yes (icon and colour by canonical type)                                                                           | yes                                      |
| Unknown type (`[!my-type]`)                                      | note colour and icon, type name as default title, `data-callout="my-type"`                                        | same                                     |
| Foldable `[!type]+` (open), `[!type]-` (collapsed)               | yes, chevron toggles                                                                                              | yes, title click toggles (not persisted) |
| Title-only callout (no body lines)                               | yes                                                                                                               | yes (no `.callout-content`)              |
| Nested callouts and nested blockquotes                           | yes (inner lines take the inner type's colour)                                                                    | yes                                      |
| Markdown in the title (bold, links, wiki links, code)            | yes (the title text stays real, editable text)                                                                    | yes                                      |
| Markdown in the body (lists, code, embeds, images, other quotes) | yes (the body is ordinary editor content)                                                                         | yes                                      |
| `[!type\|metadata]`                                              | parsed; `data-callout-metadata` set                                                                               | `data-callout-metadata` set              |
| `>[!note]` (no space after `>`)                                  | yes (CommonMark makes it a quote)                                                                                 | yes                                      |
| `> [!]`, `> [!note]Title` (no space), `> \[!note]`               | not a callout (plain quote)                                                                                       | not a callout                            |
| Callout inside a list item                                       | not decorated (plain quote); parsed and flagged `inList`                                                          | yes                                      |
| Custom type via CSS `.callout[data-callout="x"]`                 | yes, `--callout-color`, `--callout-icon`                                                                          | yes                                      |
| `--callout-icon: lucide-<id>` / `'<svg>…</svg>'`                 | the 13 built-in icon ids (with or without `lucide-`) and inline SVG strings (sanitised); other Lucide ids ignored | same, only when the element is connected |

Built-in types (public page): `note`; `abstract` (`summary`, `tldr`); `info`; `todo`; `tip` (`hint`, `important`); `success` (`check`, `done`); `question` (`help`, `faq`); `warning` (`caution`, `attention`); `failure` (`fail`, `missing`); `danger` (`error`); `bug`; `example`; `quote` (`cite`).

## Design

### One module for syntax, icons, fold state

`src/lib/callouts/`:

- `syntax.ts`: the type and alias table, `resolveCalloutType`, `defaultCalloutTitle`, `parseCalloutHeader(text)` (text from `[` to end of line). The only place that knows the syntax; the editor and the renderer both call it.
- `icons.ts`: hand-written Lucide-style stroke paths (24x24, `currentColor`) for the 13 types plus the chevron, built with `createElementNS` (no `innerHTML`, no external fetch, CSP-safe), and `parseCustomIcon` for `--callout-icon` values.
- `fold-state.ts`: session memory `Map<document path, Map<callout index, folded>>`. Index = position among the document's callouts in reading order.
- `dom.ts`: renderer post-pass (icons, chevrons, `is-collapsed`), the click toggle, and the computed-style read of `--callout-icon`.
- `callouts.css`: colour tokens (`--wc-callout-*`, mid-lightness oklch so they work on the app's light and dark themes), per-type selectors including aliases (a test keeps the CSS in step with the table), editor line styling and rendered styling.

### Editor (`components/editor-area/callout-decorations.ts`)

A `StateField` (block-spanning replace decorations must come from a field, like `hideExtension`) scans the syntax tree for `Blockquote` nodes whose first child paragraph starts with a valid header. Per callout it emits:

- Line decorations on every visible line: `cm-callout-line callout cm-callout-<kind>`, `data-callout`, `data-callout-fold`, `data-callout-metadata`; the header line also has `callout-title cm-callout-header`. User CSS written for `.callout[data-callout="x"]` therefore matches the editor lines.
- Title mark `callout-title-inner` over the real title text.
- Not revealed: the `> [!type]+ ` prefix is replaced by an icon widget (`.callout-icon`, plus the default title when none was typed). The quote marks of the body stay hidden by the existing hide extension.
- Foldable: a chevron widget (`.callout-fold`) at the end of the header line. Folded and not revealed: the body lines are replaced (inline replace over `[header end, last line end]`) and registered as atomic ranges.

Reveal on cursor follows the blockquote convention (`hideExtension` uses the whole node as its hide zone): when any selection range touches the callout (inclusive, header start to last line end), the header shows its raw `> [!type]+ Title` source and nothing is folded away, but the card styling stays so the box does not jump. Folding is the exception inside the header: a caret on the header line of a folded callout keeps the body folded; a caret in the body (or at the very end of the folded callout) unfolds it for editing and it folds again when the caret leaves. `unfurlFreezeFacet` is honoured so a pointer drag does not reflow the callout.

Fold toggle: a `mousedown`/`click` handler on `.callout-fold` (no caret move; `mousedown` is prevented) dispatches an effect carrying `{ index, folded }` and writes the same value to `fold-state.ts`. When folding while the caret is in the body, the caret moves to the end of the header. The field reloads its overrides from the store when `getFilePath()` changes (tab swap).

The source is never touched by rendering. Copy, cut, find, export and print read the document text, so they are unaffected; heading and anchor logic reads the document and the tree, not these decorations. Enter on a callout line continues with `> ` (lang-markdown's markup continuation; `blockQuoteEnter` still ends the quote on an empty `> `).

### Plugin renderer (`obsidian-host/api/markdown-render.ts`)

The `blockquote` renderer takes the quote's tokens (not rendered HTML), parses the first paragraph's first line with `parseCalloutHeader`, renders the title with `parseInline` (so bold, links, wiki links, code work) and the rest with the normal parser. Output:

```
div.callout[.is-collapsible][.is-collapsed][data-callout][data-callout-fold][data-callout-metadata]
  div.callout-title
    div.callout-icon        (filled by the post-pass)
    div.callout-title-inner
    div.callout-fold        (only when foldable; filled by the post-pass)
  div.callout-content       (omitted for a title-only callout)
```

The shared DOMPurify core (`lib/safe-html.ts`) allows the three `data-callout*` attributes (`data-callout-fold` is value-checked to `+`, `-` or empty) and the classes `callout-icon`, `callout-fold`, `is-collapsible`, `is-collapsed`. SVG is never in the allowlist: icons are created by the post-pass with `createElementNS` after sanitising.

## Decisions and known gaps

- Callouts inside list items are not decorated in the editor (list geometry is a separate, fragile system; see the list-selection specs). They render in the plugin renderer. Revisit with a real-window pass.
- Fold state is keyed by document path and callout index. Inserting or deleting a callout above another shifts the indexes, so a stale override can land on a neighbour until the app restarts. Renaming a file drops its state. Plugin-rendered folds are per render and not persisted.
- Nested callouts: each line takes the innermost callout's colour; the outer callout's bar is not repeated on inner lines.
- `--callout-color` is used as a CSS colour (the public page: "any valid CSS color"). The legacy `r, g, b` triple form still tints the background (a second declaration handles it) but the left bar and icon fall back to the default colour.
- `.callout` layout rules from third-party CSS (margins, padding) apply per editor line, because every line of a callout carries the class.
- Only the 13 built-in icon ids resolve from `--callout-icon: lucide-*`; other Lucide ids keep the type's icon. Computed-style reads need a connected element, so a detached render keeps the default icon.
- The chevron is mouse-only in the editor (no keyboard shortcut yet); the rendered chevron is a click target on the whole title.
- No "Insert callout" command or type picker.

## Verification

Unit: `tests/callouts-syntax.test.ts`, `tests/callouts-editor.test.ts`, `tests/callouts-render.test.ts`, `tests/callouts-fold-state.test.ts`. Not verified in a real window: the visual result of the tint, bar, radius and icon alignment, caret behaviour around a folded callout, clicking the chevron, `--callout-icon` overrides, light themes.
