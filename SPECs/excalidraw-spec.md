# Excalidraw (built-in feature)

Decision: [ADR 2026-11-18, draw natively with a built-in Excalidraw feature](../docs/decisions/2026-11-18-draw-natively-with-a-built-in-excalidraw-feature-compatible-with-obsidian-drawings.md). Feature folder `apps/desktop/features/excalidraw/`, kill switch `features.excalidraw.enabled` (on by default). Frame and scroll rules: `docs/design.md`.

## What it does

- Opens, edits and saves `*.excalidraw.md` (the Obsidian Excalidraw plugin's shape) and plain `*.excalidraw` (the standard JSON). Obsidian keeps opening what Writer saves.
- "New drawing" (palette, the sidebar's New section) creates a native `Drawing.excalidraw` (plain Excalidraw JSON) and opens it. `excalidraw:create` with a path without a suffix also writes `.excalidraw`; `.excalidraw.md` (the Obsidian plugin's shape) is written only when the path asks for it, and existing `.excalidraw.md` drawings are read and edited in their own format (2026-11-19, the user: "It should be native").
- `![[Arch.excalidraw.md]]` or `![[Arch.excalidraw]]` alone on a line renders the drawing in the note (SVG, cached by content hash); a click opens the tab.
- "Export drawing as SVG" writes `<name>.svg` next to the drawing. Setting `excalidraw.auto-export-svg` (off) keeps it current after every save and every outside change.
- Agents: `writer excalidraw:create|add|update|read|preview|export` and the managed skill `writer-excalidraw` (Rust half, works with the app closed except `preview` and `export`). An agent looks at its work with `preview` (a PNG outside the vault) and fixes it with `update`: the skill teaches the loop create or add, preview, update, preview.
- Live reload: a change made outside (agent, CLI, sync) merges into the open canvas; new elements are drawn in (about 300 ms, none with reduced motion).

## Files

- `.excalidraw.md`: front matter and banner untouched; `# Excalidraw Data`, `## Text Elements` (`text ^id`, 8-character ids), `## Embedded Files` (`id: [[target]]`), then the `%%`-fenced `## Drawing` block, `compressed-json` (lz-string base64, 256-character rows) or `json`. Unknown sections are kept byte for byte, CRLF is kept, an unchanged scene returns the original text.
- Images: in a `.excalidraw.md` a pasted image is saved as a vault attachment and listed under `## Embedded Files`; in a plain `.excalidraw` it stays inline in `files`.
- One write path per language: the TypeScript codec (`web/lib/excalidraw-md.ts`, the editor) and the Rust codec (`rust/excalidraw_md.rs`, the CLI), pinned to each other by `apps/desktop/shared/excalidraw-fixtures/` (sample files, lz-string vectors, `expected.json`). The format knowledge came from reading the Obsidian Excalidraw plugin's source (AGPL-3.0, cloned outside the repo); no code was copied.
- Listing: `.excalidraw.md` is a note; plain `.excalidraw` is listed while the excalidraw feature is on (the `drawing` file kind, `index/kinds.rs`; the code-files switch and the extension list do not matter) and opens in the drawing kind, never as text. Drawings are found by the text of their elements in search (`search-spec.md` "File kinds").

## Core and feature

- Core keeps the `drawing` page kind (`src/components/editor-area/page-kinds/drawing.ts`: `feature: "excalidraw"`, `claimsWhenOff`), `isDrawingPath` and `lib/drawing-files.ts`. Switched off, a drawing's tab says it is off (Turn on, Open as text), embeds stay plain links and the CLI commands say so.
- The embed's React block-widget host is shared with Bases: core `src/lib/react-block-widget.ts` (`ReactBlockWidget`, `HeightMemory`); neither feature imports the other.
- The feature owns the view (`page-view:drawing` slot, lazy), the embed editor extension, commands, the disk-sync workspace listener and the `excalidraw:render` window answer (`ipcRequests`, `web/render.ts`: SVG markup or base64 PNG through Excalidraw's `exportToSvg` / `exportToBlob`, one renderer for `export` and `preview`). `web/index.ts` imports only light modules; a test pins that the startup graph and the entry chunk never reach `@excalidraw/excalidraw`.
- Coexistence: setting `excalidraw.handle-files` (`native`, `plugin`) is answered by the `excalidraw.files` service; `plugin` hands the files back to the Obsidian plugin. With the plugin running, the first drawing opened asks once whether to turn the plugin off in Writer's own plugin state (never `.obsidian/`).

## Rust

`rust/`: `lz.rs` (lz-string over UTF-16), `excalidraw_md.rs` (codec), `layout.rs` (layered layout: longest-path layers, barycenter order, new blocks below existing boxes), `elements.rs` (spec to elements: bound text, arrow bindings, groups, `customData.writerId`, `validate_scene`, `read_spec`), `cli.rs`, `elements/update.rs` (`excalidraw:update`), `previews.rs` (the temp folder of previews), `ipc.rs` (the `excalidraw:export` and `excalidraw:preview` socket commands: must-be-open vault, confined path; the window hands the image to Rust, since the socket carries 64 KiB, and the CLI gets one path back: vault-relative for `export`, absolute for `preview`), `mod.rs` (`Feature`, the skill). No `tauri` types outside `mod.rs`/`ipc.rs`.

## `update` and `preview`

`excalidraw:update path=... spec=...` edits the file directly like `add` (works with Writer closed), with the same spec types, colours and sizes (`w`, `h`; an arrow may be `{"from","to","label","color"}`) plus `remove`:

- `nodes[]` patch the box named by `id` (the id it was created with, or its element id): `text` (`""` clears), `shape` (rectangle, ellipse, diamond), `color`, `x`+`y` (move: the label goes along and every arrow ending on the box is redrawn straight between its ends, labels back on the middle), `w` and `h` (the text must fit, else an error naming the box). A relabelled or reshaped box grows to fit, never shrinks.
- `edges[]` address an arrow by `[from, to]` (all arrows from `from` to `to`) and set a label (`""` clears) and/or a colour; they never create an arrow (use `add`).
- `remove.nodes` deletes boxes with their label and every arrow on them and those labels; `remove.edges` deletes arrows `[from, to]`. Boxes that lost an arrow move on (version), so an open tab reloads exactly what changed (the reconcile rule already drops what a file no longer has and takes the higher version).
- An unknown id, arrow or colour is exit 1 naming it, and the whole update is checked on a copy so nothing is written. `direction`, `groups` are refused; `remove` is refused by `create` and `add`. Elements not named, freehand, images and the file's sections stay byte for byte, in both encodings.

`excalidraw:preview path=... [format=png|svg] [scale=0.5..4]` asks the running app (exit 4 `Writer is not running` otherwise) to render the drawing and prints the absolute path of the image, in `writer-previews/` under the OS temp dir (`0700`, files `0600`, never in the vault, files older than an hour swept by the next preview). Default `png`, scale 1. `excalidraw:export` shares the renderer and the socket path and writes `<name>.svg` (default) or `<name>.png` beside the drawing in the vault. Neither logs a path or contents.

## Network, fonts

No request: `window.EXCALIDRAW_ASSET_PATH` is `/excalidraw-assets/`, served in dev and emitted on build by `features/excalidraw/vite-assets.ts` from the package. The Xiaolai CJK font (12 MB) is left out; CJK text falls back to the system font. The CSP is unchanged.

## Live reload

`DrawingSession` (`web/lib/session.ts`) owns the debounced save (600 ms), the reload and ignoring `onChange` during the draw-in. `reconcile` (`web/lib/reconcile.ts`) merges by id and version with Excalidraw's rule (local wins when its version is higher, or equal with the higher `versionNonce`); a map of base versions tells an outside deletion from an unsaved local addition. The merge is applied as elements only with `captureUpdate: NEVER`, so zoom, scroll and undo stay.

## Tests

Rust: lz vectors, codec fixtures and round trips, layout, spec building, CLI end to end, socket command, skill. TypeScript: `features/excalidraw/tests/` (codec twin, reconcile, draw-in, session, drawing file and pasted images, feature registration, manifest, page kind, startup-chunk and fonts build, embeds, export, takeover, new drawing).

## Not verified without a window

The Excalidraw canvas itself (typing, pasting an image, theme), the draw-in look, embed sizing, the takeover dialog, `exportToSvg` output, opening a saved file in Obsidian.
