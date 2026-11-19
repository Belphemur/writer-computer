# Excalidraw (built-in feature)

Decision: [ADR 2026-11-18, draw natively with a built-in Excalidraw feature](../docs/decisions/2026-11-18-draw-natively-with-a-built-in-excalidraw-feature-compatible-with-obsidian-drawings.md). Feature folder `apps/desktop/features/excalidraw/`, kill switch `features.excalidraw.enabled` (on by default). Frame and scroll rules: `docs/design.md`.

## What it does

- Opens, edits and saves `*.excalidraw.md` (the Obsidian Excalidraw plugin's shape) and plain `*.excalidraw` (the standard JSON). Obsidian keeps opening what Writer saves.
- "New drawing" (palette, folder context menu) creates `Drawing.excalidraw.md` and opens it.
- `![[Arch.excalidraw.md]]` or `![[Arch.excalidraw]]` alone on a line renders the drawing in the note (SVG, cached by content hash); a click opens the tab.
- "Export drawing as SVG" writes `<name>.svg` next to the drawing. Setting `excalidraw.auto-export-svg` (off) keeps it current after every save and every outside change.
- Agents: `writer excalidraw:create|add|connect|read|export` and the managed skill `writer-excalidraw` (Rust half, works with the app closed except `export`).
- Live reload: a change made outside (agent, CLI, sync) merges into the open canvas; new elements are drawn in (about 300 ms, none with reduced motion).

## Files

- `.excalidraw.md`: front matter and banner untouched; `# Excalidraw Data`, `## Text Elements` (`text ^id`, 8-character ids), `## Embedded Files` (`id: [[target]]`), then the `%%`-fenced `## Drawing` block, `compressed-json` (lz-string base64, 256-character rows) or `json`. Unknown sections are kept byte for byte, CRLF is kept, an unchanged scene returns the original text.
- Images: in a `.excalidraw.md` a pasted image is saved as a vault attachment and listed under `## Embedded Files`; in a plain `.excalidraw` it stays inline in `files`.
- One write path per language: the TypeScript codec (`web/lib/excalidraw-md.ts`, the editor) and the Rust codec (`rust/excalidraw_md.rs`, the CLI), pinned to each other by `apps/desktop/shared/excalidraw-fixtures/` (sample files, lz-string vectors, `expected.json`). The format knowledge came from reading the Obsidian Excalidraw plugin's source (AGPL-3.0, cloned outside the repo); no code was copied.
- Listing: `.excalidraw.md` is a note; plain `.excalidraw` is listed while the excalidraw feature is on (the `drawing` file kind, `index/kinds.rs`; the code-files switch and the extension list do not matter) and opens in the drawing kind, never as text. Drawings are found by the text of their elements in search (`search-spec.md` "File kinds").

## Core and feature

- Core keeps the `drawing` page kind (`src/components/editor-area/page-kinds/drawing.ts`: `feature: "excalidraw"`, `claimsWhenOff`), `isDrawingPath` and `lib/drawing-files.ts`. Switched off, a drawing's tab says it is off (Turn on, Open as text), embeds stay plain links and the CLI commands say so.
- The embed's React block-widget host is shared with Bases: core `src/lib/react-block-widget.ts` (`ReactBlockWidget`, `HeightMemory`); neither feature imports the other.
- The feature owns the view (`page-view:drawing` slot, lazy), the embed editor extension, commands, the disk-sync workspace listener and the `excalidraw:export` window answer (`ipcRequests`). `web/index.ts` imports only light modules; a test pins that the startup graph and the entry chunk never reach `@excalidraw/excalidraw`.
- Coexistence: setting `excalidraw.handle-files` (`native`, `plugin`) is answered by the `excalidraw.files` service; `plugin` hands the files back to the Obsidian plugin. With the plugin running, the first drawing opened asks once whether to turn the plugin off in Writer's own plugin state (never `.obsidian/`).

## Rust

`rust/`: `lz.rs` (lz-string over UTF-16), `excalidraw_md.rs` (codec), `layout.rs` (layered layout: longest-path layers, barycenter order, new blocks below existing boxes), `elements.rs` (spec to elements: bound text, arrow bindings, groups, `customData.writerId`, `validate_scene`, `read_spec`), `cli.rs`, `ipc.rs` (the `excalidraw:export` socket command: must-be-open vault, confined path, one vault-relative SVG path back), `mod.rs` (`Feature`, the skill). No `tauri` types outside `mod.rs`/`ipc.rs`.

## Network, fonts

No request: `window.EXCALIDRAW_ASSET_PATH` is `/excalidraw-assets/`, served in dev and emitted on build by `features/excalidraw/vite-assets.ts` from the package. The Xiaolai CJK font (12 MB) is left out; CJK text falls back to the system font. The CSP is unchanged.

## Live reload

`DrawingSession` (`web/lib/session.ts`) owns the debounced save (600 ms), the reload and ignoring `onChange` during the draw-in. `reconcile` (`web/lib/reconcile.ts`) merges by id and version with Excalidraw's rule (local wins when its version is higher, or equal with the higher `versionNonce`); a map of base versions tells an outside deletion from an unsaved local addition. The merge is applied as elements only with `captureUpdate: NEVER`, so zoom, scroll and undo stay.

## Tests

Rust: lz vectors, codec fixtures and round trips, layout, spec building, CLI end to end, socket command, skill. TypeScript: `features/excalidraw/tests/` (codec twin, reconcile, draw-in, session, drawing file and pasted images, feature registration, manifest, page kind, startup-chunk and fonts build, embeds, export, takeover, new drawing).

## Not verified without a window

The Excalidraw canvas itself (typing, pasting an image, theme), the draw-in look, embed sizing, the takeover dialog, `exportToSvg` output, opening a saved file in Obsidian.
