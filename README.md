# Writer Computer

Writer Computer is a free and open-source markdown editor for macOS and Linux. It is about a
6 MB download (under 10 MB installed), starts faster than Apple Notes and
Obsidian, and opens very large workspaces instantly. It is made for people who
keep their writing in plain-text folders, such as Obsidian vaults, docs repos and
personal wikis: open a folder and edit its files in place, and they stay ordinary
markdown on your disk. Download it for macOS or Linux from
[writer.computer](https://writer.computer) or the
[releases page](https://github.com/Belphemur/writer-computer/releases).

![Writer Computer](./assets/screenshot.png)

In the app and in casual use it is just "Writer". It is built with Tauri v2, React, Zustand, CodeMirror, and Rust. The app keeps documents on disk, respects workspace `.gitignore` rules, supports multiple windows, renders extended markdown such as tables and Mermaid diagrams, and ships from CI for macOS and Linux.

## Repository

- `apps/desktop/` — Tauri desktop app.
- `apps/desktop/src/` — React frontend.
- `apps/desktop/src-tauri/src/` — Rust commands, workspace state, watcher, updater, and CLI integration.
- `apps/website/` — landing page.
- `docs/` — project and agent workflow docs.
- `SPECs/` — feature specs and design notes.

## Install

Download from the [releases page](https://github.com/Belphemur/writer-computer/releases).

- **macOS (Apple silicon):** open the DMG and drag Writer to Applications. Builds are ad-hoc signed, not notarized: the first launch needs right-click > Open, or `xattr -d com.apple.quarantine /Applications/Writer.app`.
- **Linux, AppImage (x86_64):** `chmod +x Writer_*.AppImage` and run it. It updates itself. Needs glibc 2.43 or newer (Ubuntu 26.04's).
- **Linux, `.deb` / `.rpm`:** `sudo apt install ./Writer_*.deb` or `sudo dnf install ./Writer-*.rpm`. Writer shows "Update available" with a download link; your package manager installs it.
- **`writer` command:** the `.deb`/`.rpm` install `/usr/bin/writer`. From the AppImage or the macOS app, Settings > Command line links it into `~/.local/bin` (Linux, no sudo) or `/usr/local/bin` (macOS); Settings says when that folder is not on your PATH.

## Development

This repo uses Vite+ through the `vp` CLI. Use `vp` instead of calling the package manager or Vite tooling directly.

```bash
vp install
vp dev
```

## Validation

```bash
vp check
vp test
```

Rust validation runs from the Tauri crate:

```bash
cd apps/desktop/src-tauri
cargo test
cargo clippy
cargo fmt --check
```

## Testing

Run the validation above on macOS or Linux. Linux is also covered in CI on every push, and you can reproduce it locally in a container; see [Build and test on Linux](#build-and-test-on-linux).

## Privacy

Writer is local-first and stays that way. It ships opt-in usage telemetry that
is **off until you turn it on**, never sees your documents, file names, or
paths, and is not even compiled into builds made from a clone of this repo.
[`docs/telemetry.md`](./docs/telemetry.md) lists every event and property, and
the three independent ways to keep it off.

## Build and test on Linux

Writer builds on Linux (x86_64 in CI, Ubuntu 26.04, which ships WebKitGTK 2.52; the app needs WebKitGTK 2.40 or newer at run time). Install the build packages from the one list CI and the container script use, plus Node 22, pnpm and Rust:

```bash
xargs -a scripts/linux-build-deps.txt sudo apt-get install -y --no-install-recommends
```

(WebKitGTK 4.1, GTK 3, libsoup 3, a C compiler for the bundled SQLite, `patchelf`/`rpm` for the packages, `xvfb` for the e2e smoke.) Then `vp install`, `vp dev`, and the validation above work as on macOS. `vp exec tauri build` makes the AppImage, `.deb` and `.rpm` (the signing key is only needed for the updater artifacts; add `--config '{"bundle":{"createUpdaterArtifacts":false}}'` without it). The e2e smoke needs `cargo install tauri-webdriver --locked`, then from `apps/desktop/e2e`: `pnpm run build:app` and `xvfb-run -a pnpm run test:smoke` (see its README).

From a Mac, `bash scripts/linux-container.sh <mode>` does all of it in an `ubuntu:26.04` container (Rancher Desktop or any Docker; arm64 natively on Apple silicon): `check`, `test`, `bundle`, `e2e`, or `shell`.

## Releases

A release is a pushed `v<version>` tag: GitHub Actions builds macOS and Linux and leaves a draft release on [Belphemur/writer-computer](https://github.com/Belphemur/writer-computer/releases) to review and publish. See `docs/releasing.md`.
