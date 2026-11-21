# Linux support

Status: designed with the user 2026-11-20, not started. ADR: [`docs/decisions/2026-11-20-support-linux-with-appimage-deb-and-rpm-writers-own-title-bar-and-ci.md`](../docs/decisions/2026-11-20-support-linux-with-appimage-deb-and-rpm-writers-own-title-bar-and-ci.md).

## Decisions (summary)

- x86_64 AppImage, .deb, .rpm, built on Ubuntu 22.04 in CI. Flatpak and aarch64 later.
- Writer's own title bar: decorations off, window controls on the right, a ☰ menu button (and Alt) opening the one menu; setting `appearance.native-decorations` for tiling WMs. Opaque window, no transparency.
- Closing the last window quits.
- `writer` on PATH: packages install `/usr/bin/writer`; the AppImage links into `~/.local/bin`.
- AppImage self-updates; .deb/.rpm notify with a download link.
- Secrets: Secret Service, else none ("No keyring found"), never a file.
- CI: GitHub Actions `ubuntu-22.04`: check, tests, clippy, fmt, bundles, e2e smoke under xvfb with `tauri-driver`.

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
4. `lib.rs:315-360`: native menu bar built on Linux with macOS-only items → menu definition + renderers; ☰ button on Linux.
5. `lib.rs:384-393, 425-474`, `commands/shell_install.rs`, `commands/mod.rs:13`, `lib.rs:804-818`: CLI install macOS-only → shared core, Linux installer into `~/.local/bin`.
6. `commands/fs.rs:1105-1115`: reveal opens the parent only → opener reveal (FileManager1), fallback to the folder.
7. `commands/fs.rs:1030-1045`: trash may fail on mounts without a trash dir → clear error (verify).
8. `commands/workspace.rs:116-127`: add kitty, alacritty, foot, wezterm.
9. `cli/clipboard.rs:34-40`: `writer --copy` needs wl-copy or xclip → document; error names them.
10. `watcher.rs:188-199, 470-485`, `commands/workspace.rs:554`: inotify watch limit → clear message with the sysctl hint; verify rename/move detection.
11. `Cargo.toml:36` keyring 4.2 → Secret Service; none → "No keyring found" (decided).
12. Single-instance plugin on sessions without a D-Bus session bus (verify).
13. `src/lib/keybindings/core-bindings.ts:205, 216`: `Meta+[`/`Meta+]` → per-OS keys, `Alt+ArrowLeft/Right` off macOS.
14. `src/lib/os-drop.ts:40-44`: HiDPI drop coordinates on Linux (verify X11, Wayland, fractional).
15. `features/obsidian-host/web/host/api/network.ts:188-193`: fall-through host list lacks `writer-plugin://localhost` (verify).
16. `src/hooks/use-zoom-gestures.ts:4-15`, `mermaid-canvas.ts:33`: pinch on WebKitGTK as ctrl+wheel (verify).
17. `App.css:30, 57`: CSS nesting and `color-mix` → minimum WebKitGTK 2.44 (verify), startup message if older.
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

## Lanes

1. **Build and CI** (first): config overlay, `mainBinaryName`, prerequisites doc, e2e per OS, `.github/workflows/ci.yml`.
2. **Window**: decorations, window controls, chrome inset, menu definition and ☰ renderer, close, opaque theme, `appearance.native-decorations`.
3. **Behaviour and labels**: inventory items 6-10, 13-17 and the cosmetic literals.
4. **CLI install, updates, release lane**: Linux installer, updater for AppImage, notify for deb/rpm, `distribute.sh`, website download.
5. **Docs and website copy.**

## Tests

See the ADR's Implementation Plan. Real-session checklist: the ADR's Verification.
