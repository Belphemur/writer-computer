# Code files and agent skill folders

Writer is also a notebook for agents. A skill is a folder with a `SKILL.md` and scripts, so code and text files now appear in the sidebar, open in a code editor with syntax highlighting, save like notes, and the agent skill folders (`.agents/skills`, `.claude/skills`) are visible. Since 2026-11-18 this is the built-in feature `code-files` (`apps/desktop/features/code-files/`, kill switch `features.code-files.enabled`; [builtin-plugins-spec](builtin-plugins-spec.md) section 15): the settings below live in its fragment under the `code-files.` prefix, the rules in `code_files.rs` stay the one seam core asks, and **switched off** only notes, bases and images are listed (no code files, no skills folders, no ignored-folder list), a code file opens as text and a restored code tab says "Code files is turned off". Rust applies the switch at once; the index and quick open follow at the next workspace open. Decision record: [ADR](../docs/decisions/2026-11-17-show-code-files-and-agent-skill-folders-through-one-visibility-policy-in-rust.md).

## What was true before

- `commands/fs.rs` listed only `.md` and `.base` (`is_listed_file`), plus folders that held them or were empty; every name starting with `.` was skipped.
- The index (`index/build.rs`) already stored a row for every non-hidden file of any type (metadata only; only `.md` is parsed and full-text indexed), but the walker used `hidden(true)` and skipped `node_modules`. `NameCache` (quick open, recents, "folder holds notes") mirrored only `ext IN ('md','base')`.
- The watcher ignored every dot segment (except `.writer` and `.gitignore`) and `node_modules`.
- A vault `.gitignore` was already honoured by the listing, the index walker and the watcher (`ignore.rs`, `git_ignore(true)`). Kept as is.
- Page kinds: `file` (note editor) and `base` (table); everything else opened as a `file`. `read_file` returned any UTF-8 file.
- Rename/move (`relocate`) rewrote links to any indexed file, attachments included.
- The plugin host lists a folder through `read_directory`; `getMarkdownFiles()` filters `md`.

## Behaviour

### What is shown

- **Code and text extensions**, setting `code-files.extensions` (list, global; default: py pyi ts tsx js jsx mjs cjs json jsonc yaml yml toml rs go java kt kts swift c h cpp cc cxx hpp hh cs rb php sh bash zsh fish sql css scss less html htm xml lua r scala dart ex exs tf tfvars ini conf cfg csv tsv log txt vue svelte graphql proto gradle ps1 bat dockerfile mk) plus the names `Dockerfile`, `Makefile`, `GNUmakefile`. `svg` is an image (see "Images"), `.ipynb` is not listed. The default lives in the feature's settings fragment `features/code-files/settings.schema.json`; the other shared rules in `shared/code-files.json`; both Rust (`code_files.rs`) and TypeScript (`features/code-files/web/rules.ts`) read them.
- **Never shown, never opened as text, whatever the setting:** `.env`, `.env.*`, `*.env`, `.pem/.key/.p12/.pfx/.keystore`, `id_rsa*`/`id_ed25519*`/`id_ecdsa*`, and names whose stem contains `secret`, `credential`, `password`, `private-key`. Dotfiles are hidden anyway.
- **Ignored folders**, setting `code-files.ignored-folders` (list, global; default `node_modules target dist build out .venv venv __pycache__ .next .nuxt .svelte-kit .turbo .cache .gradle .mypy_cache .pytest_cache .ruff_cache .tox coverage vendor Pods DerivedData`): a folder with such a name is hidden at any depth from the tree, quick open, the index and the watcher. Replacing the list replaces the default. A vault `.gitignore` is also respected (already true before this change; cheap and safe because the `ignore` crate matcher already existed). Note: a notes folder called `build` or `out` is hidden by default; edit the list to show it.
- **Dot-folders stay hidden** (`.obsidian`, `.git`, `.chats`, `.writer`, any other), with one explicit exception, setting `code-files.show-agent-folders` (boolean, global, default on): the `skills` subtree of a top-level `.agents` and `.claude`. `.agents` or `.claude` appears only when it holds a `skills` folder; everything else inside them (`.claude/settings.json`, `settings.local.json`, credentials) stays hidden, as does any dotfile or `.git`/ignored folder inside a skill (`.agents/skills/x/.env`, `.../node_modules`). A `.agents` below the vault root is not special. A vault `.gitignore` that lists `.agents/` hides it.
- **Symlinks** follow the rule in "Symlinks" below (a link to a folder or file of the same vault is shown; anything else is skipped).
- The `index` setting change takes effect for the index at the next workspace open (the tree reads the filesystem live).

### Images

Setting `files.show-images` (boolean, global, default on) adds an `images` kind to the one policy (`code_files::Policy.show_images`, `is_image_name_with`). Images are the renderable image extensions of `shared/attachments.json` (`renderExtensions`, the one list of image types: see `shared/attachments.json`), read once there for the attachment feature and here; the list is not copied.

- **One policy, no per-caller list.** The sidebar listing (`is_listed_file`, `markdown_file_entry`), `NameCache` (`listed_sql_predicate`, `is_listed_name`) and `is_listed_row` all go through it, so images follow the same folder rules as code: hidden folders, the ignored-folder list, `.gitignore`, symlinks (`rel_is_visible`). The watcher filters by folder, not by extension, so it needs no image rule. Turning the setting off hides images from the tree and quick open (`NameCache` reloads its rows at the next workspace open, like the extension list).
- **Index:** it already stores a `files` row for every visible file, images included, so `![[x.png]]` resolves by file name through the usual resolver and `relocate` rewrites `![[old.png]]`, `![[dir/old.png]]` and `[a](dir/old.png)` when an image is renamed or moved. Image content is never read or indexed (metadata only).
- **Size guard:** listing never reads the file. The size limits above (read-only, too large) apply to text; an image is drawn by the webview from the asset protocol, so no byte limit applies to opening it.
- **Opening:** page kind `image` (`page-kinds/image.ts`, `forPath` for the renderable extensions, whatever the setting), read-only viewer `components/image-viewer/`: fit to width (never enlarged past its own size), zoom with Cmd+= / Cmd+- / Cmd+0 (while an image tab is active these chords go to the viewer through `lib/zoom-target.ts`, not to the editor text zoom) and pinch (ctrl+wheel and WebKit gesture events), checkerboard behind transparency, footer with the file name, pixel size and zoom. Tab, Quick Open and tree labels keep the extension (`noteLabel`). Rename, move, delete, duplicate and the context menu are the generic ones.
- **Glyph:** hugeicons `ImageIcon` for every image name.
- **Disk sync:** an open image tab follows its file. The one `fs:file-changed` subscription (`hooks/use-file-watcher.ts`) hands every event to `lib/image-disk-sync.ts`, which ignores paths without a mounted viewer (`stores/image-viewer-store.ts` holds one entry per open viewer) and debounces per path (150 ms; the last event wins, so an atomic save's delete plus create is a reload). A change bumps the entry's `version`, which the viewer adds to the asset URL (`?v=N`) as the cache key; the old picture stays until the new one loads. When the pixel size is unchanged zoom and scroll stay; a different size resets to fit and scrolls to the top. A delete shows "This file was deleted" (a later create or modify at the same path brings the image back). In-app rename and move are followed by the page kind's `rewritePath` (the tab re-points to the new path). An external rename cannot be followed: the watcher reports the paths separately without pairing them, so the tab shows the old path's deleted state.
- Not done: rotate, EXIF.

### Tree

- Code files are sorted among files by file name **with** extension; folders first, as before. Rename (stem field, extension kept), move, delete (Trash), duplicate and the context menu work as for notes. Rename or move of a code file never rewrites links (`relocate::plan` returns no edits for a code file: code files are not link targets).
- Glyphs by language family (`FileIcon name=`): script (sh bash zsh fish ps1 bat mk, Makefile), code (default), web (html css scss less xml vue svelte), config (json yaml toml ini conf tf, Dockerfile), table (csv tsv), text (txt log), sql.
- `.agents`, `.claude` and their `skills` folder carry an "Agent skills" badge. A skill folder Writer installed (marker `writer-managed: true` in its `SKILL.md`, command `list_managed_skill_dirs`) carries "Managed by Writer, overwritten on update".

### Opening and editing

- New page kind `code` (`{ kind: "code", path }`, `page-kinds/code.ts`), claimed by `forPath` for a code path. It loads into the editor store like a note (so save, external reload, cursor/scroll restore, closed-tab reopen, back/forward, pinned tabs and session restore are the generic ones) but `parseOpenedFile` keeps the whole text as the body: a leading `---` is not frontmatter and there is no title override. The `.base` YAML view still uses the `file` kind.
- View: `CodeEditorPane` with the note editor's CodeMirror stack minus the markdown live preview: line numbers, fold gutter, active line, bracket matching and auto-close, indent on input, Tab indents, search/replace through the existing Cmd+F overlay, multi-cursor helpers, monospace (`--pm-code-font`). Colours reuse `generalSyntaxHighlights` and the `--pm-syntax-*` variables, so they match fenced code blocks in notes in light and dark. The language comes from `@codemirror/language-data` by file name (`LanguageDescription.matchFilename`) plus a few aliases (pyi, zsh, fish, dockerfile, jsonc, gradle); languages without one (ex, exs, tf, conf, graphql, bat, mk, Makefile, csv, tsv, log, txt) open as plain text.
- Indentation: tabs for Go and Makefiles, 2 spaces for web/config/shell/Ruby/Elixir/Dart/Scala/SQL, 4 otherwise; the first 300 lines of the file override it (tabs or the most common step of 2-8 spaces).
- Setting `code-files.word-wrap` (boolean, default off) wraps lines.
- Tab and window titles, recents and quick open show the file name **with** extension for code files (`noteLabel`), never a frontmatter title.
- **Save** is the generic save (atomic write, self-write record for the watcher, `files.trim-trailing-whitespace` and `files.insert-final-newline` apply). `write_file_impl` now copies the mode of the file it replaces onto the temporary file before the rename, so an executable script stays executable.
- **Limits** (`shared/code-files.json`): above 2 MiB the file opens **read-only** with a banner; above 20 MiB `read_file` refuses ("too large to open"). A NUL byte in the first 8 KiB or invalid UTF-8 refuses the read (binary), so such a file never opens as text.

### Managed skills

- `SKILL.md` opens as a note as usual; scripts open in the code editor. Opening any file under a managed skill folder shows a dismissible warning once per folder and session: edits are overwritten when Writer syncs.
- What the sync does today (unchanged): on every workspace open and startup, per managed folder: older version -> update; same version but a managed file was edited or is missing -> **restore** (overwrite); newer version -> leave and report; a skill without the marker (the user's) -> never touched. So an edit to a managed skill is lost at the next workspace open, not only at a bundle bump. To customise, copy the folder under another name and remove the `writer-managed` line.

### Search, mentions, CLI, plugin host

- Quick open and `fuzzy_search` (`NameCache`) list code files with their extension. Agent `@` mentions use that search, so code files and skill files appear; chips keep the extension (only `.md` is stripped).
- **Full-text search does not cover code content.** Cost: a second parser path, a re-hash on setting toggles and noisy results for little gain; the agent has `rg`. File names are searchable. (A future opt-in setting could add it; not built.)
- `writer files` lists indexed files of every type, so code files and `.agents/skills` files appear, `ext=py` filters, `writer read path=...` prints them; `writer rename/move` of a code file rewrites no links. The managed `writer-cli` skill says so (BUNDLE_VERSION 3).
- The plugin host's `vault.getFiles()` includes code files (as Obsidian lists every file); `getMarkdownFiles()` stays `md`-only; dot-folders (including the agent exception) are filtered out of the plugin vault listing.

## Symlinks

Decision record: [ADR](../docs/decisions/2026-11-17-follow-symlinks-that-stay-inside-the-vault.md). Bug that motivated it: `.agents/skills` linked to `LLM-Agents/skills` showed `.agents` with nothing in it.

- **One helper**, `fs_entry::resolve_entry` (Tauri-free), classifies every on-disk entry for the sidebar listing, the folder emptiness/classification checks (`directory_is_sidebar_visible`) and the `.agents`/`.claude` `skills` test. `symlink_in_path` and `write_target` serve the managed skills installer and the save path.
- **A link is followed only if** its canonical target is inside the canonical vault root, is not the root or an ancestor of the link's own folder, is visible by `rel_is_visible` _at its real path_ (a link into `.git`, `.obsidian`, an ignored folder or a dot-folder is hidden, exactly as the target would be), is not matched by the vault `.gitignore` at its real path, and exists as a file or folder. Otherwise it is skipped silently (debug log): outside the vault (so no read or write ever goes through an escape), dangling, cycle, hidden target, special file. With no vault open no link is followed.
- **Cycles:** a link to an ancestor is skipped outright; the recursive checks keep a visited set of canonical folders, so mutual cycles terminate (a mutual cycle can still be expanded by hand in the tree, each level listing the real folder).
- **Sidebar:** a followed link is an ordinary folder or file at its link path (`.agents/skills/x/SKILL.md`), with a small link badge and the tooltip "symlink to LLM-Agents/skills" (`DirEntry.symlink_target`, vault-relative real path, absent otherwise). The real folder is listed too: **both paths are shown**.
- **Index, search, links:** the index and the watcher never follow links (`ignore` walker without `follow_links`), so the real path is the only indexed one; the same file is never indexed twice and never duplicates quick open, search results or links. Consequence: a file opened through a link path has no index row under that path. The CLI works on real paths (`confine` resolves).
- **Open, edit, save:** reading and `authorize_path` already resolve links, so a file reached through a link opens and saves under its link path. `write_file_impl` writes to the resolved target (temp file and rename in the target's folder), so the link is never replaced; a dangling link is an error. A link leaving the vault is refused by `authorize_path`.
- **Rename, move, delete:** `rename_entry` and `relocate_entry` refuse a symlink itself ("rename or move the real file or folder instead"); entries inside a linked folder are real and are renamed in place. Deleting a link removes the link, never the target. New entries created inside a linked folder keep the link path in the tree.
- **Managed skills:** the installer skips (`skipped-symlink`, logged, not a problem) any bundled skill whose folder, or a folder above it (`.agents/skills`), is a symlink, and removes nothing through a linked skills folder. A link leaving the vault still reports `error` ("outside the vault"). Writer's bundled skills are therefore not installed into a linked skills folder; copy them there. Spec table: [managed-vault-skills-spec](managed-vault-skills-spec.md).
- **Name mirror lookups use real paths:** the index (and its in-memory name mirror, `NameCache`) holds real paths only, so `directory_is_sidebar_visible` asks `dir_has_listed` for the folder's canonical path. Root cause of the second "empty `.agents`" report: asked by the link path, the mirror said "no listed file here", and with the index ready that meant "verify the tree is folder-only", so a linked `skills` folder holding any file was hidden (not-ready listing worked, which is why the first fix's tests passed). Regression test: `symlinked_agent_skills_list_their_children_whatever_the_root_spelling_or_index` (vault under a symlinked parent, relative link `../LLM-Agents/skills`, index ready and not ready). The vault root is already canonicalized once when the workspace opens (`canonicalize_workspace_root`); `authorize_path` canonicalizes both sides. Skipped links log their reason kind at debug level (`WRITER_LOG=debug`).
- **Known gaps:** the watcher reports real paths, so a change in the real folder refreshes the link's subtree in the tree only on the next listing; a rename in the real folder while the link subtree is open is not echoed until then. Not verified in a real window.

## Safety summary

Nothing is read outside the vault (unchanged `authorize_path`/`confine`); nothing is written into `.obsidian`; secrets are never listed or opened as text; symlinks leaving the vault are never followed; code reads are guarded by size, NUL bytes and UTF-8.

## Tests

- Rust: `code_files` (rules, visibility, schema defaults, guarded read), `code_files_tests` (tree listing, titles, agent exception, symlinks, binary and invalid UTF-8, mode on save, index, relocate), `watcher` (agent skills watched, generated folders not), `managed_skills` (`managed_dirs`).
- TS: `features/code-files/tests/code-files.test.ts` (routing, language, tokens for py/ts/rs/json, editor setup, titles, mentions, tree order and glyphs, store load, plugin vault) and `features/code-files/tests/code-files-feature.test.tsx` (kill switch, rules service, off page, settings fragment, startup chunk). Rust feature-off behaviour: `code_files_tests::feature_off`, `index::tests`, `watcher`.

## Not done / known gaps

- No full-text search over code contents; no "open at line" for code hits.
- No `.ipynb`; `svg` is an image (listed by `files.show-images`, opened in the image viewer, never as text); Terraform, Elixir, GraphQL, batch files, Makefile and `.conf` have no highlighting in the shared language data.
- Changing the ignore list or the agent-folder switch re-applies to the index at the next workspace open.
- The code editor has no autocompletion or linting.
