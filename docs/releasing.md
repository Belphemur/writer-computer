# Releasing Writer

A release is a tag. Pushing `v<version>` runs `.github/workflows/release.yml`, which builds macOS arm64 and Linux x86_64 on GitHub's runners and leaves a **draft** release on `Belphemur/writer-computer`. You review the draft and publish it. Decision record: [ADR 2026-11-23](./decisions/2026-11-23-release-from-ci-on-a-version-tag-to-belphemur-writer-computer-for-macos-and-linux.md).

**Bump, changelog, tag, review the draft, publish.**

## 1. Bump the version

The version lives in four places that must agree (the workflow refuses a tag that does not match them):

1. `apps/desktop/src-tauri/tauri.conf.json` — `version`
2. `apps/desktop/src-tauri/Cargo.toml` — `[package].version`
3. `apps/desktop/package.json` — `version`
4. `apps/desktop/src-tauri/Cargo.lock` — refresh with `cargo update -p desktop --offline` from `apps/desktop/src-tauri/`

Patch bump for fixes, minor for new user-visible features, major for breaking changes or 1.0. Commit it alone (`Bump version to <version>`) so it reviews in isolation.

## 2. Changelog

Rename `## Unreleased` in `CHANGELOG.md` to `## <version>` (a date after it is fine: `## 0.9.0 - 2026-11-24`), and start a new empty `## Unreleased` above it. The draft's notes are that section verbatim, and the in-app update dialog shows them, so keep the bullets short and user-facing. The workflow fails before building when the section is missing or empty.

## 3. Check, push, tag

`vp check`, `vp test` and the Rust checks pass (CI runs them on Linux and macOS on every pull request and every push to `writer-computer-agents`; wait for it to be green on the commit you tag). Then, from `writer-computer-agents`, with the commit pushed:

```sh
git tag v<version>
git push origin v<version>
```

The workflow rejects a tag that is not `v<version>` of the version files, or whose commit is not on `writer-computer-agents`. `v<version>-rc.1` style tags are allowed and produce a pre-release draft (the version files still say `<version>`).

## 4. Review the draft

The workflow's jobs: **Check the tag** (tag, version files, branch, changelog section, signing key secret), **Build** for each platform in parallel, **Draft release**. Expect roughly an hour. Open the draft URL from the run summary and confirm the assets: one file per entry of `assets` in [`apps/desktop/shared/release.json`](../apps/desktop/shared/release.json) (the updater ones with a `.sig`), and `latest.json` naming `darwin-aarch64` and `linux-x86_64`. Nothing else should be there.

Edit the notes on GitHub if you want, then **Publish release**. Until you do, the in-app updater and the website's download button do not see it (the `latest` endpoint skips drafts and pre-releases).

## 5. Verify

- `https://github.com/Belphemur/writer-computer/releases/latest/download/latest.json` resolves to the new version.
- An installed older build (AppImage or macOS app) offers the update at next launch and verifies its signature. A macOS `writer` link made before 0.9.0 is broken (the binary is now `writer-desktop`): Settings > Command line says so, and Install repairs it. A `.deb`/`.rpm` install shows "Update available" with a download link instead of installing.

## Secrets and settings

Repository secrets (Settings > Secrets and variables > Actions); no secret ever appears in the repository or a log:

| Secret                                                                                                                     | Needed             | What                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`                                                                                                | yes                | The updater key (`~/.tauri/` on the maintainer's machine); its public half is `plugins.updater.pubkey` in `tauri.conf.json`.     |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`                                                                                       | if the key has one | Its password; leave unset for a passwordless key.                                                                                |
| `WRITER_POSTHOG_KEY`                                                                                                       | no                 | Without it the build has telemetry off ([telemetry.md](./telemetry.md)).                                                         |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | no                 | All six together switch macOS from ad-hoc signing to Developer ID signing and notarization. Any missing and the build is ad-hoc. |

**Ad-hoc macOS.** Until the Developer ID secrets exist the DMG is not notarized: the first launch needs right-click > Open (or `xattr -d com.apple.quarantine /Applications/Writer.app`). Say so in the release notes.

## Linux requirements

Every Linux package (AppImage, `.deb`, `.rpm`) is built on Ubuntu 26.04, so the binary links that release's glibc: it runs on glibc 2.43 or newer (the Ubuntu 26.04 era) and needs WebKitGTK 2.40 or newer at run time. An older distribution cannot use any of them: the `.deb`/`.rpm` do not help, they carry the same binary. A build step prints the highest `GLIBC_` symbol the binary needs (`scripts/release.mjs glibc`, `objdump -T`) and fails when it is above `glibcFloor` in [`apps/desktop/shared/release.json`](../apps/desktop/shared/release.json), the one place the floor is kept; raising it is a decision, and this section and the README's Install list change with it. Supporting older distributions means building on an older base, which is not planned.

## The shared release file

[`apps/desktop/shared/release.json`](../apps/desktop/shared/release.json) holds the facts several places need: the repository, the release branch, the glibc floor and the assets of a release (id, platform, bundle folder, file suffix, which one the updater downloads). `scripts/release.mjs`, `scripts/distribute.sh`, `release.yml`, the website (`vite.config.ts`, `src/release-assets.ts`) and a test in `updater.rs` read it; `ci.yml`'s `branches:` cannot, and a test pins it to the file. Change a fact there, never in a second place.

## Package scripts

The `.deb`/`.rpm` post-install script (`src-tauri/linux/post-install.sh`) links `/usr/bin/writer` to `writer-desktop` only when that name is free or already our link; `apps/desktop/tests/linux-package-scripts.test.ts` runs it against a temporary folder. CI checks that the built packages carry it. Installing a real package on a real distribution (including over a foreign `writer`) is a manual check: `bash scripts/linux-container.sh bundle`, then `dpkg -i` in a container.

## When things go wrong

- **The check job fails.** Nothing was built. The message says what to fix (version mismatch, branch, changelog section, missing secret). Fix it, commit, then move the tag: `git tag -f v<version> && git push -f origin v<version>` (only for a tag whose release was never published).
- **A build fails.** Fix on the branch, commit, move the tag as above; the workflow reruns from the start. Re-running one job from the Actions page also works when the cause was the runner.
- **"Could not create the draft" because the release exists.** An earlier run got that far. Delete the draft on GitHub (never a published release without asking first: users may already be updating from it), then re-run the `Draft release` job.
- **You decide not to publish.** Delete the draft, then drop the tag: `git tag -d v<version> && git push origin :refs/tags/v<version>`.
- **The version was wrong after publishing.** Stop and ask; do not delete a published release.

## Appendix: local release (macOS arm64 only)

`scripts/distribute.sh` (`pnpm distribute`) is the fallback when CI cannot be used. It builds, Developer ID signs, notarizes and uploads a draft for macOS arm64 only, so its `latest.json` lacks `linux-x86_64`: prefer the workflow, and use this only knowing the Linux updater then finds nothing.

It needs a `.env` at the repo root with `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `TAURI_SIGNING_PRIVATE_KEY` (a path to the key), optionally `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and `WRITER_POSTHOG_KEY` (or `WRITER_RELEASE_WITHOUT_TELEMETRY=1`). Draft user-facing notes into a file, then:

```sh
./scripts/distribute.sh --notes-file /tmp/release-notes.md
```

Pre-flight: it refuses unless you are on `writer-computer-agents` with a clean tree that is a fast-forward of `origin/writer-computer-agents` and the tag does not exist. Then it pushes the branch, builds (`tauri build --bundles app,dmg`), signs, notarizes, staples, writes `latest.json` for `darwin-aarch64`, creates the **draft** on `Belphemur/writer-computer` with the DMG, the updater tarball and `latest.json`, and tags and pushes `v<version>`. Review and publish as in step 4. If notarization fails, report Apple's log to the maintainer; do not retry blindly.

## Not covered

Windows, aarch64 Linux (the website sends such visitors to the releases page), Flatpak, an apt/dnf repository, rolling back a published release (escalate to the maintainer).
