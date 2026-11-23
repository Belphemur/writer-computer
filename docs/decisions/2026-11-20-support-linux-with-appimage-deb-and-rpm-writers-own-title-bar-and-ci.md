---
status: accepted
date: 2026-11-20
decision-makers: Writer maintainers
---

# Support Linux with AppImage, .deb and .rpm, Writer's own title bar, and CI on Ubuntu

## Context and Problem Statement

Writer ships for macOS only (`docs/releasing.md`, `scripts/distribute.sh`, the website's DMG-only download). The user asked (2026-11-20) to prepare Linux support. An inventory of the repo (2026-11-20, read-only, nothing run) found no Rust compile blocker: every `cfg(target_os)` branch has a Linux arm or compiles out, and core paths (log and data dirs, the CLI socket, process-group kill, `claude` discovery, login-shell PATH, keybinding `Mod` = Ctrl, per-OS hotkeys) are already cross-platform. The blockers are packaging, the e2e harness, release and the absence of CI (no `.github/`). Behaviour differs in the window frame, menus, close, CLI install, reveal, a few keys, secrets, the watcher and clipboard. Details and the full list: `SPECs/linux-support-spec.md`.

## Decision Drivers

- Same app, same layout and chrome on both platforms; platform differences live in one place per concern.
- No guessed behaviour: whatever only a real Linux session can confirm is verified there before release.
- No new runtime dependency; packaging tools only in CI.
- Privacy and the secrets rules unchanged (never a plaintext secret).

## Considered Options

- Packages: A. AppImage + .deb + .rpm; B. AppImage only; C. plus Flatpak.
- Frame: A. Writer's own title bar (decorations off); B. native decorations above Writer's chrome bar.
- Support: A. CI + tests + release on x86_64; B. build-only beta; C. x86_64 + aarch64 now.
- Secrets: A. Secret Service, else none; B. encrypted file with a passphrase.

## Decision Outcome

All chosen with the user (2026-11-20):

1. **Packages**: AppImage, .deb and .rpm for x86_64, built in CI on Ubuntu 26.04 (the user's target, 2026-11-20; the AppImage then needs a glibc at least as new as 26.04's, so older distros use the .deb/.rpm of their era or wait for a later decision). Flatpak later (its sandbox conflicts with vault access, system `git` and the `claude` CLI). aarch64 later.
2. **Window frame**: decorations off on Linux; Writer's chrome bar draws minimize, maximize and close at the right (from `tauri-plugin-window` APIs, one component), double-click toggles maximize, `data-tauri-drag-region` as today. The macOS traffic-light gap (92px) becomes a per-platform chrome inset from one source (`lib/platform.ts` or a CSS variable set once). A setting `appearance.native-decorations` (Linux only, default off) restores the desktop's frame for tiling window managers. No transparency or vibrancy on Linux (opaque background), so X11 without a compositor never shows a black window.
3. **Menu**: one menu definition (today's `install_app_menu` items) with two renderers: the native macOS menu bar, and on Linux a ☰ button at the left of the chrome bar opening the same menu as a native context menu; Alt opens it too. No GTK menu-bar row. macOS-only items (Services, Hide, Hide Others, Show All, Install command via osascript) are not created on Linux.
4. **Close**: closing the last window quits (Linux convention); quitting does what quitting does on macOS (agent chats saved, git commits on close).
5. **`writer` on PATH**: .deb and .rpm install `/usr/bin/writer` (a symlink to the app binary, the multi-call `writer` dispatch in `main.rs`). The AppImage offers "Install 'writer' command", linking into `~/.local/bin` with no sudo; Settings says when `~/.local/bin` is not on PATH. `writer_cli.rs` launches the real binary name (set `mainBinaryName`, fix the `writer-desktop` default).
6. **Updates**: the AppImage self-updates through the Tauri updater (`linux-x86_64` in `latest.json`, signed). .deb and .rpm show "Update available" with a download link; the package manager installs. No apt/dnf repository.
7. **Secrets**: the Secret Service (`keyring` 4 on Linux, GNOME Keyring, KWallet or KeePassXC). When none answers, secrets are unavailable with one line ("No keyring found") and plugins run without them, as the 2026-11-17 secrets ADR does for an unreadable keychain. Never a plaintext or encrypted file. UI text says "keychain" on macOS and "keyring" on Linux, from one label helper.
8. **CI**: a GitHub Actions workflow on `ubuntu-26.04`: install the WebKitGTK/GTK/libsoup dev packages, `vp check`, `vp test`, `cargo test`, `cargo clippy`, `cargo fmt --check`, a `tauri build` of the three bundles, and the e2e smoke under `xvfb` with `tauri-driver`. macOS CI is added in the same workflow when the maintainers want it (out of scope here). Release: the Linux lane of `scripts/distribute.sh` (or a CI release job) uploads the three artifacts and the AppImage signature; the website's download button picks the asset per OS.
9. **Behaviour fixes** (one place each, details in the spec): "Show in Folder" selects the file through the opener's reveal (FileManager1 D-Bus), falling back to opening the folder; back/forward keys get a non-macOS chord (`Alt+ArrowLeft/Right`) in the keybinding registry's per-OS keys; drop coordinates are checked for HiDPI on Linux; the inotify watch limit failure surfaces a clear message with the `fs.inotify.max_user_watches` hint; `writer --copy` documents `wl-copy`/`xclip`; terminal fallbacks add kitty, alacritty, foot and wezterm; the Obsidian host's fall-through origin includes `writer-plugin://localhost`; WebKitGTK pinch arrives as ctrl+wheel and is handled by the existing zoom gestures; minimum WebKitGTK 2.44 (checked at startup with a clear message if older, to be verified against CSS nesting and `color-mix`).
10. **Copy**: README, docs and website say macOS and Linux; per-OS labels ("Show in Finder" vs "Show in Folder", ⌘ vs Ctrl) always through the existing helpers, never literals.

### Consequences

- Good: Linux users get the same Writer, self-updating as AppImage, native packages for apt/dnf users; CI catches Linux and general regressions on every push.
- Good: platform differences are concentrated (chrome inset, menu renderer, label helper, per-OS keys) instead of scattered `isMac` checks.
- Bad: a second release lane and a CI to maintain; Linux-only paths (window controls, menu button) need a real Linux session to verify.
- Bad: WebKitGTK is slower than WKWebView on some machines and versions; performance is checked on the CI image and one real desktop before release.

## Implementation Plan

- **Affected paths:** `apps/desktop/src-tauri/tauri.conf.json` (per-OS window config via `tauri.linux.conf.json` overlay, `mainBinaryName`, Linux bundle section, 512px icon), `src-tauri/src/lib.rs` (menu definition split from renderer, macOS-only items gated, close behaviour), `src-tauri/src/writer_cli.rs`, `src-tauri/src/commands/{fs.rs,workspace.rs}` (reveal, terminals), a Linux CLI install command next to `commands/shell_install.rs` (shared core, two installers), `src-tauri/src/watcher.rs` (watch-limit error), `apps/desktop/src/components/{app-layout.tsx,compact-file-layout.tsx}` and a new `window-controls.tsx`, `src/lib/platform.ts` (chrome inset, labels), `src/lib/keybindings/core-bindings.ts`, `src/lib/os-drop.ts`, `features/obsidian-host/web/host/api/network.ts`, literal labels found by the inventory, `apps/desktop/e2e/{wdio.conf.js,package.json}`, `scripts/distribute.sh`, `.github/workflows/ci.yml` (new), `apps/website/src/latest-release.ts`, README, `docs/releasing.md`, `docs/keyboard-shortcuts.md`, `docs/design.md`, `SPECs/linux-support-spec.md` (new).
- **Lanes:** (1) build and CI: config overlay, binary name, prerequisites doc, e2e harness per OS, CI workflow — first, so every later lane is tested on Linux; (2) window: decorations off, window controls, chrome inset, menu button, close; (3) behaviour fixes and labels; (4) CLI install and updates and release lane; (5) docs and website copy.
- **Tests:** unit tests for the per-OS chrome inset, menu definition (same items, macOS-only items absent on Linux), label helper, back/forward keys per OS, reveal fallback, `writer_cli` binary name; Rust tests for the Linux CLI installer in a temp HOME; the e2e smoke on Linux CI (open a vault, type, save, open the palette, close quits).

## Verification

- [ ] CI on `ubuntu-26.04` runs check, tests, clippy, fmt, the three bundles and the e2e smoke, green.
- [ ] On a real Linux desktop (GNOME Wayland and one X11 session): window controls, drag, double-click maximize, menu button and Alt, close quits, "Show in Folder" selects, back/forward keys, drop on HiDPI, pinch zoom, secrets with and without a keyring, a large vault (watch limit message).
- [ ] AppImage updates itself from a signed `latest.json`; .deb shows "Update available".
- [ ] `writer` works from PATH after .deb install and after "Install 'writer' command" in the AppImage.

## More Information

- Inventory and full item list: `SPECs/linux-support-spec.md`.
- Related: `2026-04-30-build-on-tauri-v2-react-zustand.md`, `2026-11-17-keep-all-plugin-secrets-in-one-keychain-item-...` (secrets degrade), `docs/releasing.md`.
- 2026-11-20, the user: the Linux base is Ubuntu 26.04, for CI and for local testing in a Rancher Desktop container (`ubuntu:26.04`, arm64 natively on Apple silicon, x86_64 in CI). The minimum WebKitGTK is the one 26.04 ships. If the GitHub-hosted `ubuntu-26.04` runner is not available, CI runs the same container image on `ubuntu-latest`.
- 2026-11-20, the user: "Open in Terminal" gets one terminal table for macOS and Linux (Ghostty included on both) and a dropdown of the installed terminals; default hotkeys are per OS with Linux conventions (back/forward `Alt+←/→` and the mouse buttons; no desktop-reserved chords), enforced by a test over every binding. Spec sections "Open in Terminal" and "Default hotkeys per OS".
- 2026-11-23, review against the work landed since 2026-11-20 (git feature phases 1-5, forge sign-in, signing, logs, agent changes, tags). What Linux adds:
  - **Git.** It uses the system `git`, `git-lfs`, `gh` and `fj`, found on the login-shell PATH as on macOS.
    - "Install git" (`xcode-select`) stays macOS-only. On Linux the row reads "Install git with your package manager".
    - The credential helper is the running binary (`writer git-credential`), registered per command with its absolute path. For the AppImage that path is the mounted image's, valid for that run only, which is fine because it is never written to a config.
    - A saved token lives in the Secret Service. With no keyring, the `token` source is unavailable with "No keyring found", and `gh`/`fj` still work.
    - fj's login is read from `$XDG_DATA_HOME/forgejo-cli/keys.json` (default `~/.local/share`).
    - Signing goes through git, so it is unchanged.
    - The "No route to host" Local Network hint and `NSLocalNetworkUsageDescription` stay macOS-only (already `cfg`-gated).
  - **Logs.** Settings > Git > Logs and "Open log folder" use the Linux log dir from `logging::log_dir` (`$XDG_STATE_HOME`, else `~/.local/state`).
  - **Labels.** New literals added since (for example "Show in Finder" in `features/agent/web/components/skills-chip.tsx`) go through the label helper with the others.
  - **CI and release.** CI and the release now cover macOS too, and the release is cut by a tag (ADR 2026-11-23 "Release from CI on a version tag ..."). The Linux lane of `distribute.sh` becomes the CI release job.
  - **Testing on a Mac.** The README documents testing in a Rancher Desktop `ubuntu:26.04` container: build, unit tests, and the e2e smoke under `xvfb`.
