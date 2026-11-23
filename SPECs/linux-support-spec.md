# Linux support

Status: designed with the user 2026-11-20, refreshed 2026-11-23 (git, logs, release from CI); being built. ADR: [`docs/decisions/2026-11-20-support-linux-with-appimage-deb-and-rpm-writers-own-title-bar-and-ci.md`](../docs/decisions/2026-11-20-support-linux-with-appimage-deb-and-rpm-writers-own-title-bar-and-ci.md).

## Decisions (summary)

- x86_64 AppImage, .deb, .rpm, built on Ubuntu 26.04 in CI (local runs in a Rancher Desktop container of the same image). Flatpak and aarch64 later.
- Writer's own title bar: decorations off, window controls on the right, a ☰ menu button (and Alt) opening the one menu; setting `appearance.native-decorations` for tiling WMs. Opaque window, no transparency.
- Closing the last window quits.
- `writer` on PATH: packages install `/usr/bin/writer`; the AppImage links into `~/.local/bin`.
- AppImage self-updates; .deb/.rpm notify with a download link.
- Secrets: Secret Service, else none ("No keyring found"), never a file.
- CI: GitHub Actions `ubuntu-26.04`: check, tests, clippy, fmt, bundles, e2e smoke under xvfb with `tauri-driver`.

## Inventory (2026-11-20, read-only; "verify" = needs a real Linux session)

### Blockers

1. `src-tauri/src/writer_cli.rs:169-173`: Linux launcher spawns `writer-desktop`, the binary is `desktop` → set `mainBinaryName` and use it.
2. `tauri.conf.json:42-43`: `targets: "all"` + `createUpdaterArtifacts` → per-OS bundle list; signing key only in CI.
3. Linux build prerequisites undocumented (webkit2gtk-4.1, libsoup-3.0, gtk3 dev, a C compiler for bundled SQLite) → README section and the CI install step.
4. `e2e/package.json:7` builds `--bundles app` → `--no-bundle` on Linux.
5. `e2e/wdio.conf.js:13-18` hardcodes `Writer.app/Contents/MacOS/desktop` → per-OS path; Linux uses `tauri-driver`.
6. `scripts/distribute.sh`, root `distribute` script, `docs/releasing.md`: macOS arm64 only → Linux lane; `latest.json` `linux-x86_64`.
7. No CI (`.github/` absent).

### Behaviour differs

1. `tauri.conf.json:17-24`: macOS title bar keys, transparency, `hudWindow` → `tauri.linux.conf.json` overlay: decorations off, transparent off; secondary windows (`lib.rs:223-246`) use the same overlay.
2. `App.css:55-57, 312, 399, 461, 529`: translucency assumed → opaque tokens on Linux (verify X11 without compositor).
3. `lib.rs:57-70`: close-to-hide is macOS-only → Linux quits on last close (decided).
4. `lib.rs:315-360`: native menu bar built on Linux with macOS-only items → menu definition + renderers; ☰ button on Linux. Decided in the build: GTK implements only About, Cut, Copy, Paste and Select All as predefined items, so on Linux Undo and Redo are dropped from the menu (the editor has Ctrl+Z) and Quit, Minimize, Full Screen and Close are ordinary items (`app.quit`, `window.minimize`, `window.fullscreen`, `window.close`) handled in Rust through `app_menu::Action`. A popup menu's accelerators never fire, so Ctrl+, and Ctrl+Q are registry bindings on Linux and nothing is reserved there (`shared/reserved-chords.json`). The "Install 'writer' command" item is left out of the Linux menu until the CLI install lane lands.
5. `lib.rs:384-393, 425-474`, `commands/shell_install.rs`, `commands/mod.rs:13`, `lib.rs:804-818`: CLI install macOS-only → shared core, Linux installer into `~/.local/bin`.
6. `commands/fs.rs:1105-1115`: reveal opens the parent only → opener reveal (FileManager1), fallback to the folder.
7. `commands/fs.rs:1030-1045`: trash may fail on mounts without a trash dir → clear error (verify).
8. `commands/workspace.rs:60-140`: one terminal table for macOS and Linux (see Open in Terminal).
9. `cli/clipboard.rs:34-40`: `writer --copy` needs wl-copy or xclip → document; error names them.
10. `watcher.rs:188-199, 470-485`, `commands/workspace.rs:554`: inotify watch limit → clear message with the sysctl hint; verify rename/move detection.
11. `Cargo.toml:36` keyring 4.2 → Secret Service; none → "No keyring found" (decided).
12. Single-instance plugin on sessions without a D-Bus session bus (verify).
13. `src/lib/keybindings/core-bindings.ts:205, 216`: `Meta+[`/`Meta+]` → per-OS keys (see Default hotkeys per OS).
14. `src/lib/os-drop.ts:40-44`: HiDPI drop coordinates on Linux (verify X11, Wayland, fractional).
15. `features/obsidian-host/web/host/api/network.ts:188-193`: fall-through host list lacks `writer-plugin://localhost` (verify).
16. `src/hooks/use-zoom-gestures.ts:4-15`, `mermaid-canvas.ts:33`: pinch on WebKitGTK as ctrl+wheel (verify).
17. `App.css:30, 57`: `color-mix` and `CSS.registerProperty` → minimum WebKitGTK 2.40 (Safari 16.4; the build flattens CSS nesting, so it is not probed), startup message if older.
18. `scripts/distribute.sh:157-160`, `tauri.conf.json:69`: `latest.json` darwin only → `linux-x86_64`.
19. `apps/website/src/latest-release.ts:35, 57`, `docs/website-deploy.md:48-65`: DMG only → per-OS asset.

### Cosmetic

1. `tauri.conf.json` `bundle.icon`: add the 512px PNG (`icons/icon.png`).
2. `app-layout.tsx:139-141`, `compact-file-layout.tsx:326-330`: 92px traffic-light inset → per-platform chrome inset.
3. Font stacks (`App.css:41-48`, `prosemark-theme.css:8, 117-119`, mermaid, math, html-block): fall back fine; add `system-ui`/`monospace` where missing.
4. Literals: `skills-chip.tsx:153` "Show in Finder", `file-browser.tsx:48` "⌘P", `secrets-section.tsx:37` and `feature-secrets-store.ts:72` "Keychain" → label helpers.
5. Docs and website copy: README, `docs/releasing.md`, `AGENTS.md:67`, `docs/design.md:40`, `docs/keyboard-shortcuts.md:5`, `docs/telemetry.md:66, 114`, `docs/website-analytics.md:22`, website root metadata and compare pages, `open-a-folder.md:33`, `customize-the-look.md`, `sidebar.md:46`, website font stack and Apple glyph.

### Already cross-platform

Log and data dirs, argv open path, multi-call `writer` dispatch, login-shell PATH, `claude` discovery and process-group kill, the unix CLI socket, fontconfig fonts, opener for the log folder, `#![cfg(unix)]` tests, platform UA detection, `Mod` = Ctrl, per-OS hotkeys and context-menu labels, drag regions, PDF.js worker, spellcheck dictionaries, e2e fixture scripts, telemetry `os`, file associations (verify the .desktop MIME entry).

### Since 2026-11-20 (refresh 2026-11-23)

20. `features/git/rust/commands.rs:872-883`: "Install git" is macOS-only (`xcode-select`) → Linux line "Install git with your package manager".
21. `features/agent/web/components/skills-chip.tsx:153` "Show in Finder" → label helper (cosmetic 4).
22. Git saved tokens → Secret Service, "No keyring found" without one; `gh`/`fj` unaffected; fj login in `$XDG_DATA_HOME/forgejo-cli` (done in `git/forgejo.rs`).
23. Release: the CI release workflow (ADR 2026-11-23) builds the Linux bundles; `latest.json` `linux-x86_64` → AppImage.

## Open in Terminal (macOS and Linux)

"Open in Terminal" on a folder's right-click menu (`folder-context-menu.ts:47`, `sidebar-surface-context-menu.ts:99`) opens that folder in a terminal; setting `workspace.default-terminal` (free text today), launcher `commands/workspace.rs` `terminal_launch_specs`.

- One terminal table, shared by both OSes: Ghostty, kitty, WezTerm, Alacritty, iTerm2 and Warp (macOS), foot, GNOME Terminal (Console), Konsole, xfce4-terminal, Terminal.app (macOS), `x-terminal-emulator` (Debian alternative), each with how to open a folder on that OS (`open -a <App> <dir>` on macOS; the program with its working-directory flag on Linux, e.g. `ghostty --working-directory=<dir>`, `kitty --directory <dir>`, `wezterm start --cwd <dir>`, `alacritty --working-directory <dir>`, `gnome-terminal --working-directory=<dir>`, `konsole --workdir <dir>`, `foot -D <dir>`).
- The setting becomes a dropdown of the terminals found on this machine (plus "Other…" for a name or path, today's behaviour), default "System default": Terminal.app on macOS; `$TERMINAL`, then `x-terminal-emulator`, then the first installed entry of the table on Linux.
- Detection is cheap and local (app bundle in `/Applications` and `~/Applications` on macOS, the executable on the login-shell PATH on Linux), done when the settings page opens, never at startup.

## Default hotkeys per OS

The keybinding registry already takes per-OS keys (`registry.ts` `PlatformKeys`, `Mod` = Cmd on macOS, Ctrl elsewhere); every default follows the platform's convention:

- No core or feature binding names `Meta` or `Ctrl` literally where the platforms differ; it uses `Mod` or a per-OS `{ mac, linux, other }` list. A test over every registered binding enforces it, with a named allowlist for bindings that are the same chord on every OS on purpose (`Ctrl+Tab`).
- Back/forward: macOS `Cmd+[` / `Cmd+]` everywhere (mouse side buttons send them) and `Alt+←/→` outside the note; Linux `Alt+←/→` everywhere, the note included (the desktop and browser convention; the capture-phase binding takes the keys from CodeMirror's default keymap, where Linux binds `Alt+←/→` to syntax-tree cursor motion, so that motion is given up on Linux and word motion stays on Ctrl+Arrow), and the mouse back/forward buttons (`mouseup` buttons 3 and 4) through the same commands.
- Linux defaults avoid chords the desktops reserve: anything with Super, `Ctrl+Alt+T` (terminal), `Ctrl+Alt+Arrow` (workspaces), `Alt+F2`, `Alt+Tab`, `Ctrl+Alt+Delete`, `Alt+Space`. A test checks the Linux defaults against that list.
- User overrides stay per OS (`hotkeys.json` has a section per OS).
- `docs/keyboard-shortcuts.md` shows each OS's keys (the site page renders the current OS first); the shortcuts list in Settings shows the current OS's chords.

## Lane 3 status (2026-11-23)

Built: items 6-10, 13 (reveal, trash message, terminal table and dropdown, `--copy` error, watch-limit message, per-OS history keys, mouse side buttons, HiDPI table, pinch), the label helper (`lib/platform-labels.ts`: file manager, secret store, install git), the WebKitGTK check (`lib/webview-support.ts`: it asks the web view for `color-mix` and `CSS.registerProperty`, not for nesting, minimum 2.40, and logs the refusal) and the git install hint. Item 15 needed no code (`writer-plugin://localhost` is not http, so it already falls through; a test pins it with the Windows subdomain). Item 13 found every font stack already ending in `system-ui`, `sans-serif` or `monospace`. Linux-only code is `reveal_in_file_manager_impl`'s Linux arm in `commands/fs.rs` and the `tauri_plugin_opener::reveal_item_in_dir` call; everything else compiles and is tested on macOS.

## Lanes

1. **Build and CI** (first): config overlay, `mainBinaryName`, prerequisites doc, e2e per OS, `.github/workflows/ci.yml`.
2. **Window**: decorations, window controls, chrome inset, menu definition and ☰ renderer, close, opaque theme, `appearance.native-decorations`.
3. **Behaviour and labels**: inventory items 6-10, 13-17 and the cosmetic literals.
4. **CLI install, updates, release lane**: Linux installer, updater for AppImage, notify for deb/rpm, `distribute.sh`, website download.
5. **Docs and website copy.**

## Build, CLI install and updates (lanes 1 and 4, as built)

- **Config.** `tauri.conf.json` sets `mainBinaryName` `writer-desktop` (never `writer`: that name is the CLI in `main.rs`'s multi-call dispatch; `writer_cli.rs` has a test that its constant equals it). Per-OS overlays merge over it: `tauri.macos.conf.json` (bundles `app`, `dmg`) and `tauri.linux.conf.json` (decorations off, no transparency, the whole window entry since arrays replace; bundles `appimage`, `deb`, `rpm`; the deb and rpm link `/usr/bin/writer` to `writer-desktop` from post-install scripts in `src-tauri/linux/`, removed on package removal but not upgrade; the bundler follows symlinks and copies custom files by content, so neither a link nor a copy of the binary can be listed in `files`). The 512px `icons/icon.png` is in `bundle.icon`.
- **Package list.** `scripts/linux-build-deps.txt` is the one list the README, CI (`.github/actions/setup-writer`) and `scripts/linux-container.sh` install from.
- **e2e per OS.** The same harness as macOS: `tauri-plugin-webdriver` (the `e2e` feature) and the `tauri-webdriver` intermediary both support WebKitGTK, so Linux needs no `tauri-driver` and no second harness. `e2e/app-binary.mjs` is the one place that knows the binary path and build flags per OS (`--no-bundle` on Linux; `WRITER_E2E_DEBUG=1` for a debug build; `CARGO_TARGET_DIR` honoured).
- **CI and release.** `ci.yml` (checks on `ubuntu-26.04` and `macos-latest`; Linux bundles and the e2e smoke under `xvfb`), `release.yml` (ADR 2026-11-23), logic in `scripts/release.mjs` with tests in `apps/desktop/tests/release-script.test.ts`.
- **CLI install.** Tauri-free core `src/cli_install.rs`; `commands/shell_install.rs` holds the per-OS installers and the commands `cli_status`, `install_cli`, `uninstall_cli` (macOS and Linux). Linux links `~/.local/bin/writer` to `$APPIMAGE` (else the running binary), never elevates; when `/usr/bin/writer` already links to this binary the status says `package` and there is nothing to install. `main.rs` also treats an AppImage started with `ARGV0` exactly `writer` as the CLI (the AppImage runtime sets it for a link to the file); `writer_cli.rs` launches `$APPIMAGE`, else the running binary. Settings > Command line shows the state and the "not on your PATH" line (login-shell PATH, not only the process's). The menu item ("Install 'writer' command") belongs to the window lane's menu definition and calls `commands::shell_install::install_cli_blocking` / `uninstall_cli_blocking` / `cli_status_blocking`.
- **Updates.** `updater.rs`: an AppImage (`APPIMAGE` set) and macOS self-update; any other Linux run is a package install and the "Update available" dialog offers Download (the release page) instead of installing.

## Tests

See the ADR's Implementation Plan. Real-session checklist: the ADR's Verification.
