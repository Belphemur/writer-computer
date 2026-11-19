---
status: accepted
date: 2026-11-18
decision-makers: Writer maintainers
---

# Draw natively with a built-in Excalidraw feature compatible with Obsidian drawings

## Context and Problem Statement

Drawings in the user's vault are made with the Obsidian Excalidraw community plugin, run through Writer's Obsidian plugin host. The user asked (2026-11-18) for Excalidraw "natively instead of having an obsidian plugin", for agents to build drawings, and for SVG export. Writer's agents use the `writer` CLI and managed skills (`managed_skills/`); the CLI reaches the running app through the socket of ADR `2026-11-18-let-the-writer-cli-talk-to-the-running-app-over-a-local-authenticated-socket`. The user chose each part below.

## Decision Drivers

- Existing drawings keep working, in Writer and in Obsidian: same file format, byte-stable where untouched.
- Clean-room: the format is implemented from its public shape, never by copying the plugin's code (`docs/soul.md`, the plugin compat rule: never patch plugins).
- Lazy: no drawing code in the startup chunk; no network (fonts and assets bundled).
- Agents can create and edit drawings with the app closed.
- One write path per file kind.

## Considered Options

- A. A built-in `excalidraw` feature on `@excalidraw/excalidraw` (MIT), Obsidian-compatible files, a Rust CLI for agents, SVG export by the app on change.
- B. Keep the Obsidian plugin.
- C. Variants for agents (Mermaid converted by the app; a skill only) and export (marker files; a Rust SVG renderer), rejected by the user.

## Decision Outcome

Chosen option: **A**.

1. **Dependencies** (new, the user's go): `@excalidraw/excalidraw` `0.18.1` (MIT, the latest release, 2026-04-20, peer React `^19.0.0` supported; the user chose the latest on 2026-11-18) and `lz-string` `1.5.0` (MIT, the compressed-json codec), both pinned exactly. Excalidraw's fonts and assets are served from the app bundle (`EXCALIDRAW_ASSET_PATH`), never a CDN; collaboration, the online library and any network call are off.
2. **Feature**: `apps/desktop/features/excalidraw/` (`feature.json`, kill switch `features.excalidraw.enabled` on by default, a settings fragment, light `web/index.ts`, the editor as a lazy page-view slot, Rust half for the CLI, the skill and the IPC export command; `tests/`). A core `drawing` page kind with `feature: "excalidraw"`; off, the shared off page (Turn on, Open as text for `.excalidraw.md`).
3. **Files**: opens and saves `*.excalidraw.md` in the Obsidian plugin's shape (front matter `excalidraw-plugin: parsed` and `tags: [excalidraw]`; `# Excalidraw Data`; `## Text Elements` with `text ^elementId` lines; `## Embedded Files`; the drawing in a `%%`-fenced `## Drawing` block as `compressed-json` or `json`), and plain `*.excalidraw` JSON. Reading accepts both encodings; writing keeps the file's encoding, keeps unknown sections and front matter keys byte-identical, and regenerates only `## Text Elements` and the drawing block. New drawings are `.excalidraw.md` with `compressed-json`. **Encoding and images** (the user, 2026-11-18: no zstd, keep compatibility): no other compression than the two Obsidian encodings (zstd was considered and rejected: Obsidian and other Excalidraw tools could not read it, the gain is small, and it would add dependencies). Plain `.excalidraw` stays the standard Excalidraw JSON that excalidraw.com and other tools open, embedded images included inline in its `files` as the standard requires. In `.excalidraw.md`, an image pasted or dropped onto the canvas is saved as a normal vault file in the attachments folder (core's attachment path, as for note images) and referenced from `## Embedded Files` (`<fileId>: [[image.png]]`), the way the Obsidian plugin stores them, so the drawing stays small and the images show in the sidebar and sync; existing inline images are kept as they are. Wiki links in text elements are real markdown in `## Text Elements`, so the index sees them. One codec module per language (TS for the editor, Rust for the CLI), pinned by shared fixtures `apps/desktop/shared/excalidraw-fixtures/` (round-trip both encodings, unknown sections kept).
4. **Plugin coexistence**: native takes over drawing files. If the Obsidian Excalidraw plugin is enabled in Writer, a one-time prompt offers to disable it in Writer (Writer's own plugin state; `.obsidian` is never written). A setting `excalidraw.handle-files` (`native` default, `plugin`) hands files back.
5. **Editor tab**: the Excalidraw canvas in PageBody (`docs/design.md`), theme following the app, save on change (debounced, through the one write path, self-write aware for the watcher), "New drawing" in the palette and the sidebar's new-file menu. Keyboard: Excalidraw's own keys inside the canvas; app commands through the keybinding registry.
6. **SVG export**:
   - "Export SVG" in the tab writes `<name>.svg` next to the drawing (the export is Excalidraw's own `exportToSvg`).
   - Setting `excalidraw.auto-export-svg` (off by default) keeps `<name>.svg` current after every save, and after every external change the app sees (agent, CLI, sync), rendered off-screen.
   - Embeds `![[Arch.excalidraw.md]]` / `![[Arch.excalidraw]]` render the drawing in the note (live SVG, cached by content hash); a click opens the editor.
   - Agents: `writer excalidraw:export path=...` asks the running app over the CLI→app socket (ADR `2026-11-18-let-the-writer-cli-talk-to-the-running-app-over-a-local-authenticated-socket`, the feature contributes the `excalidraw:export` IPC command) and prints the SVG path; with the app closed it fails with "Writer is not running".
7. **Agents build drawings**: Rust CLI commands `excalidraw:create`, `excalidraw:add`, `excalidraw:connect`, `excalidraw:read` take a compact spec: nodes `{id, text, shape?, x?, y?, color?}`, edges `[from, to, label?]`, groups. Rust fills element ids, seeds, versions, sizes from text, bound text, arrow bindings, and a simple layered automatic layout (own code, no dependency) for nodes without positions; spec ids are kept in each element's `customData.writerId` so later `add`/`connect` address them. Writes go through the same codec and `vault_ops` confinement. A managed skill `writer-excalidraw` (contributed by the feature, `BUNDLE_VERSION` bump) teaches the spec and the export.
8. **The drawing skill** (the user: "a proper skill on how to do the drawings"): beyond the command grammar, `writer-excalidraw/SKILL.md` teaches how to draw well: pick the diagram kind (flow, architecture, sequence-like lanes, mind map, comparison), keep one idea per box and short labels, left-to-right or top-to-bottom flow, consistent sizes and spacing, a small palette with meaning (one accent for the focus, grey for context), group related nodes, label arrows only when the verb matters, build in steps (`create` the skeleton, then `add`/`connect`), `read` the drawing back to check it, and export when the user wants an image. Worked examples (an architecture diagram, a flow) with their specs. Its claims are tested: every example spec in the skill is run by a test and must produce a valid drawing.
9. **Live while the agent draws** (the user's bonus): an open drawing tab reloads when its file changes on disk (watcher, not self-writes). Elements are reconciled by id and `version` (Excalidraw's own reconcile rule), so the user's selection and view stay, and the user's unsaved local edits win over an older remote element. Elements that are new in a reload appear with a short draw-in animation (stroke reveal, about 300 ms, off with reduced motion), so each `excalidraw:add`/`connect` call shows up as being drawn. The CLI writes once per command, so an agent building in steps is seen step by step.

### Consequences

- Good: drawings open natively and stay compatible with Obsidian; agents can draw; SVGs stay current.
- Bad: two new dependencies (Excalidraw is several MB, lazy) and its bundled fonts.
- Bad: two codecs (TS, Rust) guarded by shared fixtures.
- Neutral: exporting needs the app running.

### Non-goals

- Collaboration, the online library, Excalidraw+.
- The Obsidian plugin's scripts (ExcaliBrain, Script Engine), its `## Embedded Files` image editing beyond keeping them, LaTeX elements, frame-to-markdown sync.
- A Rust SVG renderer.

## Implementation Plan

- **Affected paths**: `apps/desktop/package.json`; Vite config for Excalidraw assets and fonts in the bundle; `tauri.conf.json` CSP only if bundled fonts or workers need it; new `apps/desktop/features/excalidraw/` (`web/` editor, codec `web/lib/excalidraw-md.ts`, embed via `editorExtensions`, export service, settings fragment; `rust/` CLI commands, codec `excalidraw_md.rs`, layout `layout.rs`, the `excalidraw:export` IPC command; `skills/writer-excalidraw/SKILL.md`); core page kind `src/components/editor-area/page-kinds/drawing.ts`; `cli/registry.rs` (feature CLI contribution through the `Feature` trait); `shared/excalidraw-fixtures/`; the plugin host's enabled-plugin state for the takeover prompt (`features/obsidian-host` through its public point, not internals); specs: new `SPECs/excalidraw-spec.md`, `SPECs/builtin-plugins-spec.md`, `SPECs/writer-cli-spec.md`, `SPECs/managed-vault-skills-spec.md`; `CHANGELOG.md`, `TODOS.md`.
- **Patterns to follow**: the bases feature (Rust CLI + skill + web view + embeds); `.agents/skills/writer-feature/SKILL.md`; shared fixtures for Rust/TS twins; `docs/design.md`.
- **Patterns to avoid**: copying the Obsidian plugin's code; a CDN; writing `.obsidian`; a second write path; network calls.
- **Tests**: codec round-trip of the fixtures in both languages (compressed and plain, unknown sections kept, text elements regenerated); CLI create/add/connect/read (ids kept, bindings valid, layout without overlaps, confinement); `excalidraw:export` over IPC returns the SVG path, and the not-running message; auto-export after save and after an external change; embed renders and caches; takeover prompt once, setting hands back; feature off page; startup chunk excludes Excalidraw; the skill installed with the bumped bundle; every skill example spec builds a valid drawing; an open tab reconciles an external change by id and version (local unsaved edit kept, view kept) and animates only new elements (none with reduced motion).

### Verification

- [ ] An existing Obsidian `.excalidraw.md` opens, edits and saves; Obsidian still opens it.
- [x] An image pasted into a `.excalidraw.md` drawing lands in the attachments folder and is listed under `## Embedded Files`; a `.excalidraw` file still opens on excalidraw.com. (Tested at the codec and save level; opening in excalidraw.com is manual.)
- [ ] "New drawing" creates a `.excalidraw.md`; `![[it]]` shows it in a note.
- [x] `writer excalidraw:create` with a spec makes a valid drawing that opens with boxes, labels and connected arrows. (Valid and overlap-free by test; the canvas look is manual.)
- [ ] "Export SVG" and auto-export write `<name>.svg`; `writer excalidraw:export` gets an SVG while the app runs.
- [ ] With the drawing open, an agent's `excalidraw:add` calls appear one by one, drawn in, without losing the user's view.
- [x] No network request; Excalidraw is not in the startup chunk. (Build test: entry chunk clean, fonts emitted; a network panel check is manual.)

## Pros and Cons of the Options

### A. Native feature

- Good, because native editing, agent drawings and export without the plugin host.
- Bad, because dependencies and a format to keep compatible.

### B. Keep the plugin

- Good, because no work.
- Bad, because agents cannot draw and the plugin host is the bottleneck the user wants out of.

### C. Other agent and export routes

- Good, because Mermaid is familiar to models; a socket is general.
- Bad, because Mermaid needs the app running for creation and marker files give no reply; the user chose the CLI and the socket.

## More Information

Related: the bases feature (CLI + skill + embed model), the images and PDF ADRs of 2026-11-18 (viewer pieces), the built-in features ADR, the plugin compatibility rule (never patch plugins).

Amendment (the user, 2026-11-19): `update` and `preview` so agents can change drawings and see them. `excalidraw:update` edits boxes and arrows by id and removes them; `excalidraw:preview` (and `export format=png`) renders through the running app and writes outside the vault; `excalidraw:connect` is folded into `add` by the CLI pruning ADR of 2026-11-19. Details in `SPECs/excalidraw-spec.md`.

- 2026-11-19: new drawings are native `.excalidraw` (plain JSON) by default, from "New drawing" and from `excalidraw:create` without a suffix, at the user's request; `.excalidraw.md` is written only when the path names it, and both formats stay read and edited as before.
