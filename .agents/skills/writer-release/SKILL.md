---
name: writer-release
description: Cut a new Writer version - bump the version files, cut the changelog section, commit, wait for CI, push the v<version> tag that runs the release workflow, and hand the draft to the maintainer. Use when asked to release, tag, ship or "make a new version" of the desktop app.
---

# Releasing a Writer version

The procedure and its rules live in [`docs/releasing.md`](../../../docs/releasing.md). Read it first; this skill is the agent's checklist over it and never restates its facts (the version files, the workflow's checks, the secrets, the recovery steps). If the doc and this skill disagree, the doc wins: fix the skill.

## Before you start

- Work in the main checkout, on `writer-computer-agents`, with a clean tree and everything merged and pushed. Run `git fetch` and confirm that `HEAD` equals `origin/writer-computer-agents`.
- Pass `-R Belphemur/writer-computer` to every `gh` call; gh otherwise resolves to another remote.
- Pushing a tag is outward-facing. Do it only when the maintainer asked for a release in this session. Publishing or deleting a release, deleting a pushed tag or force-moving one always waits for them (see `writer-decisions`), except the doc's "check job fails" case for a tag whose release was never published.

## Steps

1. **Pick the version.** `git tag --sort=-v:refname | head -1` is the last release. Read `## Unreleased` in `CHANGELOG.md`:
   - a patch bump for fixes only;
   - a minor bump for any new user-visible feature;
   - a major bump only when the maintainer says so.
2. **Bump** the files listed in `docs/releasing.md` §1. Refresh the lock with `cargo update -p desktop --offline` from `apps/desktop/src-tauri/`. Check that the files agree:
   `grep -n '"version"' apps/desktop/package.json apps/desktop/src-tauri/tauri.conf.json; grep -n '^version' apps/desktop/src-tauri/Cargo.toml`
3. **Changelog** (§2). Turn `## Unreleased` into `## <version> - <YYYY-MM-DD>`, and put a new empty `## Unreleased` above it. Skim the bullets. They become the release notes and the in-app update text, so they must be short, user-facing and current: drop lines that a later change contradicted. The section must not be empty.
4. **Commit** the bump alone with the message `Bump version to <version>`, signed (`git commit -S`), plus the repo's co-author trailer, then push. If signing fails (1Password locked), retry in a background loop; never commit unsigned.
5. **Wait for CI** on that exact commit: `gh -R Belphemur/writer-computer run list --branch writer-computer-agents` gives the run, then use `run watch`.
   - "Checks (Linux)" and "Linux bundles and e2e" must pass.
   - "Checks (macOS)" is often cancelled because no runner is free. A cancelled job is not a failure, so say so and go on.
   - A failed job is a failure: fix it first.
6. **Tag** (§3): `git tag v<version> && git push origin v<version>`. Then find the release run with `gh -R Belphemur/writer-computer run list --workflow release.yml --limit 1` and watch its **Check the tag** job. If it fails, follow the doc's "When things go wrong".
7. **Hand over.** The run takes about an hour and ends in a **draft**. Tell the maintainer:
   - the run URL;
   - that the draft needs their review and **Publish release** (§4, §5);
   - that macOS is ad-hoc signed until the Developer ID secrets exist.
     Never publish it yourself.

## After

- If the maintainer wants the local app on the new version, rebuild it from the bump commit (the build command is in the session or project memory). Ask first if they are using Writer.
- A release changes no ADR. If the procedure itself changed, update `docs/releasing.md` and this skill in the same commit.
