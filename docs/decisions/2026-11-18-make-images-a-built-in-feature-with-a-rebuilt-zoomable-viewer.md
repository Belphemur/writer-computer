---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Make images a built-in feature with a rebuilt, zoomable viewer

## Context and Problem Statement

Image files open in a core image tab (`src/components/image-viewer/`, page kind `image`). It shows images at their intrinsic size with no zoom or pan; an SVG drew at 103 × 150 px in the middle of a full tab. The user asked (2026-11-18) to be able to zoom, to fit the space by default, to display every common image type ("webp, png, svg, gif, etc."), to rebuild the whole viewer, and to make images their own built-in feature. The built-in features pattern is set (ADR `2026-11-17-build-first-party-features-as-built-in-plugins-with-one-manifest-one-rust-trait-and-one-registry-line`, Step 5 migrations; `code-files`, commit `ab6718a`, is the model). The code-files spec said "images belong to core (viewer and attachments)": this ADR moves the viewer out; attachments stay core.

## Decision Drivers

- Images in notes (inline rendering, paste and insert, asset grants, chat images) keep working with the feature off.
- One list of image types (`apps/desktop/shared/attachments.json`), read by Rust and TS.
- SVG stays crisp at every zoom; animated GIF/WebP/APNG keep animating.
- Shortcuts through the keybinding registry; layout per `docs/design.md`.
- No new dependency.

## Considered Options

- A. A new `images` feature; the viewer rebuilt inside it (pure view-transform module + one component); the old viewer deleted.
- B. Keep the viewer in core and add zoom.
- C. Move the viewer to a feature and patch it.

## Decision Outcome

Chosen option: **A**.

1. **Feature**: `apps/desktop/features/images/` (`feature.json`, kill switch `features.images.enabled` on by default, light `web/index.ts`, the viewer as the lazy slot `page-view:image`, `tests/`). The `image` page kind stays in core with `feature: "images"`, like `code`. Core never imports the feature.
2. **Core keeps**: inline images in notes, paste/insert/import, attachment folders, asset protocol grants, chat image chips, and the sidebar listing setting `files.show-images` (the sidebar and attachments use it; it does not move).
3. **Formats**: `renderExtensions` in `shared/attachments.json` is the one list: png, jpg, jpeg, gif, webp, svg, avif, bmp, ico, apng, plus tif, tiff, heic, heif and jxl (decoded by the system webview where it can: WebKit on macOS decodes them; other webviews may not). The viewer, the sidebar listing, quick open and inline rendering all read that list. A file the webview cannot decode (the `<img>` errors) shows "Can't display this image here" with "Open in default app" (through the opener, `link-activation`'s `openExternal` path for files), never a broken icon.
4. **Viewer, rebuilt**: one pure module for the view transform (fit, zoom about a point, clamps 5%..3200%, pan bounds) tested in isolation; one component rendering a single `<img>` under a CSS transform (vector-crisp for SVG; animations keep running). Fit by default, scaling up as well as down; an SVG without usable width/height sizes from its `viewBox`.
5. **Controls**: pinch or Cmd/Ctrl + scroll zooms toward the pointer; Cmd/Ctrl `=` / `-` zoom and `0` returns to Fit, registered as keybinding commands active only in an image tab (listed in Settings > Hotkeys); double-click toggles Fit / 100%; drag or scroll pans when larger than the page. The footer keeps the file name and size and adds the zoom percent (a click returns to Fit) with − and +.
6. **Off**: an image file's tab shows the shared off page ("Images is turned off", Turn on, Open in default app, the same component as the code-files off page); inline images and the sidebar are unchanged.
7. **Delete**: `src/components/image-viewer/` once replaced; no dead path.

### Consequences

- Good: every common image type opens, fits, zooms and pans; the viewer loads only when an image tab opens.
- Good: the format list has one home.
- Bad: tif/heic/jxl show the fallback on webviews that cannot decode them.
- Neutral: the code-files spec line "images belong to core (viewer and attachments)" now reads "attachments belong to core".

### Non-goals

- Editing, crop, rotate; a gallery or slideshow; PDF; EXIF or metadata panels; converting formats.

## Implementation Plan

- **Affected paths**: new `apps/desktop/features/images/`; delete `src/components/image-viewer/`; `src/components/editor-area/page-kinds/image.ts` (`feature: "images"`, lazy slot); `shared/attachments.json` (`renderExtensions`, mime map); the Rust readers of that list (`code_files.rs` image predicates, `index`, `commands/images.rs`) and TS readers (`src/lib/` attachments/images helpers), each still reading the one list; the shared off-page component (from code-files); keybinding commands in the feature's `keybindings` contribution; `SPECs/builtin-plugins-spec.md` (section 15 Step 5 entry, migration row), `SPECs/code-files-spec.md` (the "images belong to core" line), `CHANGELOG.md`, `TODOS.md`.
- **Patterns to follow**: the code-files migration; `.agents/skills/writer-feature/SKILL.md`; `docs/design.md` (one scroller, `overflow-clip`, no DOM `scrollIntoView`, terse text); the keybinding registry.
- **Patterns to avoid**: a raw keydown listener; a rasterised canvas for SVG; a second format list; core importing the feature.
- **Tests**: transform math (fit up and down, zoom about a point, clamps, pan bounds, Fit/100% toggle); SVG sized from `viewBox`; every format in `renderExtensions` routes to the image tab; decode error shows the fallback; keybinding commands active only in an image tab; footer control; feature off page and inline images unaffected; startup chunk excludes the viewer; manifest/fragment contract; Rust tests that the list drives listing.

### Verification

- [ ] A small SVG fills the tab, crisp, and zooms and pans.
- [ ] png, jpg, gif (animated), webp, avif, bmp, ico, apng open; an undecodable file shows the fallback with Open in default app.
- [ ] Cmd+= / Cmd+- / Cmd+0 and double-click work and appear in Settings > Hotkeys.
- [ ] With the feature off, inline images render and an image tab offers Turn on.
- [ ] The viewer is not in the startup chunk; `src/components/image-viewer/` is gone.

## Pros and Cons of the Options

### A. Feature with a rebuilt viewer

- Good, because a clean, testable viewer and a kill switch.
- Bad, because more change at once.

### B. Zoom in the core viewer

- Good, because small.
- Bad, because the user asked for a feature and a rebuild; the viewer stays in the startup chunk.

### C. Feature, patched viewer

- Good, because less code moved.
- Bad, because the broken sizing model is kept.

## More Information

Related: [built-in features spec](../../SPECs/builtin-plugins-spec.md), [code files spec](../../SPECs/code-files-spec.md), `docs/design.md`, the hotkeys ADR `2026-11-18-let-users-rebind-every-command-through-one-keybinding-registry-with-per-os-overrides`.
