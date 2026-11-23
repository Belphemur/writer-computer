---
status: accepted
date: 2026-11-23
decision-makers: Writer maintainers
---

# Release from CI on a version tag, to Belphemur/writer-computer, for macOS and Linux

## Context and Problem Statement

Releases were cut locally by `scripts/distribute.sh` on the maintainer's Mac: macOS arm64 only, Developer ID signed and notarized, published as a draft on `joelbqz/writer-computer` (the original author's repository), with that author's Tauri updater key in `tauri.conf.json` and the updater endpoint `https://github.com/joelbqz/writer-computer/releases/latest/download/latest.json` (`docs/releasing.md`). The project now lives at `Belphemur/writer-computer` (public, default branch `writer-computer-agents`), Linux support is decided (ADR 2026-11-20 "Support Linux with AppImage, .deb and .rpm ..."), and the user asked (2026-11-23) for "our first release 0.9.0 with both mac and linux" with CI/CD for it. The maintainer has no Apple Developer ID today and does not hold the old updater private key.

## Decision Drivers

- One release, both platforms, built the same way every time (no maintainer laptop in the loop).
- The in-app updater keeps working: one signed `latest.json` naming every platform.
- No secret in the repository; secrets only as GitHub Actions secrets.
- Developer ID signing and notarization can be switched on later without redesign.

## Considered Options

- A. GitHub Actions: CI on every push and PR; a release workflow on a pushed `v*` tag builds macOS arm64 and Linux x86_64, merges one `latest.json` and creates a draft GitHub Release on `Belphemur/writer-computer`.
- B. Keep `distribute.sh` locally and add a Linux container lane to it.
- C. Manual `workflow_dispatch` releases.

## Decision Outcome

Chosen: **A**, with the user's answers (2026-11-23): publish to `Belphemur/writer-computer`; macOS **ad-hoc signed** for now; a pushed **`v*` tag** triggers it; releases are cut from **`writer-computer-agents`**.

1. **CI** (`.github/workflows/ci.yml`, on push and pull request): `vp check`, `vp test`, `cargo test`, `cargo clippy`, `cargo fmt --check` on Linux (Ubuntu 26.04: the `ubuntu-26.04` runner, or the `ubuntu:26.04` container on `ubuntu-latest` if that runner does not exist) and on macOS (`macos-latest`, arm64). A Linux bundle build (AppImage, .deb, .rpm) and the e2e smoke under `xvfb` with `tauri-driver` run on Linux.
2. **Release** (`.github/workflows/release.yml`, on `push: tags: ['v*']`):
   - Checks that the tag equals `v<version>` of `tauri.conf.json` (and `Cargo.toml`, `package.json`) and that the tagged commit is on `writer-computer-agents`; otherwise it fails before building.
   - macOS arm64 job: `tauri build --bundles app,dmg`, ad-hoc codesign (`codesign --force --deep -s -`), the updater tarball `Writer.app.tar.gz` and its `.sig` from the updater key. When the secrets `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` exist, the same job signs with the Developer ID and notarizes instead (one `if`, no second job).
   - Linux x86_64 job: AppImage, .deb, .rpm, and the AppImage's updater `.sig`.
   - A final job merges one `latest.json` (`darwin-aarch64` → the tarball, `linux-x86_64` → the AppImage, each with its signature) and creates a **draft** release `v<version>` on `Belphemur/writer-computer`. The notes come from the version's section in `CHANGELOG.md`. The maintainer reviews and publishes it.
   - Secrets: `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the new updater key), `WRITER_POSTHOG_KEY` (telemetry; a release without it builds with telemetry off, as `distribute.sh` allows).
3. **Updater.** A new updater key pair replaces the old one. The public key goes into `tauri.conf.json`; the private key lives only in the maintainer's `~/.tauri/` and the GitHub secret. The endpoint becomes `https://github.com/Belphemur/writer-computer/releases/latest/download/latest.json`. Installs of the old `joelbqz` builds do not auto-update to these releases (different key and endpoint); 0.9.0 is a fresh install.
4. **Ad-hoc macOS.** The DMG is not notarized: the first launch needs right-click > Open (or `xattr -d com.apple.quarantine /Applications/Writer.app`). The README and the release notes say so.
5. **`distribute.sh`** stays as the local fallback, retargeted to `Belphemur/writer-computer` and to the release branch. `docs/releasing.md` becomes "bump, changelog, tag, review the draft, publish", with the local script as an appendix.
6. **Version 0.9.0** is the first release made this way. The lead commits the version bump in the four files, the CHANGELOG section and the tag.

### Non-goals

- Developer ID signing and notarization now (ready behind secrets, off until they exist).
- aarch64 Linux, Flatpak, an apt/dnf repository (ADR 2026-11-20).
- Windows.
- Migrating `joelbqz` installs to the new updater.

### Consequences

- Good: a tag is the whole release; both platforms are built in clean runners; CI catches regressions on both OSes on every push.
- Good: no maintainer secret in the repository; turning on notarization means adding secrets, not changing the workflow.
- Bad: until a Developer ID exists, macOS users see Gatekeeper's warning on first launch.
- Bad: CI minutes on macOS runners cost more; release builds take several minutes per platform.

## Implementation Plan

- **Affected paths:** `.github/workflows/ci.yml` and `.github/workflows/release.yml` (new), `apps/desktop/src-tauri/tauri.conf.json` (updater `pubkey`, `endpoints`, per-OS bundle targets, `createUpdaterArtifacts`) and the Linux overlay of ADR 2026-11-20, `scripts/distribute.sh`, `docs/releasing.md`, `README.md` (install and "first launch" for ad-hoc macOS; how to test on Linux), `apps/website/src/latest-release.ts` (repository and per-OS asset), `CHANGELOG.md`.
- **Patterns to follow:** the same commands the docs list for validation; `tauri-apps/tauri-action` or the plain `tauri build` (whichever produces the updater artifacts and signatures for both OSes with the least custom code); one script for the `latest.json` merge (Node, in `scripts/`, unit-tested), never inline shell JSON.
- **Patterns to avoid:** a secret or key in the repository or in a log; publishing a non-draft release from CI; a second workflow per OS that duplicates steps (one matrix or reusable steps).
- **Tests:** the `latest.json` merge script (both platforms, a missing platform fails); the tag/version check (mismatch fails); `actionlint` on the workflows; a local run of the Linux build in the Rancher Desktop `ubuntu:26.04` container.

## Verification

- [ ] A push runs CI on Linux and macOS, green.
- [ ] A test tag on a fork or a pre-release tag (`v0.9.0-rc.1`) produces a draft with the dmg, the tarball and its sig, the AppImage and its sig, the .deb, the .rpm and a `latest.json` naming both platforms.
- [ ] An installed 0.9.0 finds a later release through the new endpoint and verifies its signature.
- [ ] No secret appears in a workflow log or in the repository.

## More Information

- Supersedes the release process in `docs/releasing.md` (local-only, joelbqz). Related: ADR 2026-11-20 Linux support (its CI item 8 is extended to macOS here), ADR 2026-11-16 local logs, the telemetry rules in `docs/telemetry.md`.
