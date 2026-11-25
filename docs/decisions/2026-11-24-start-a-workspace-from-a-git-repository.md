---
status: accepted
date: 2026-11-24
decision-makers: Writer maintainers, the user
---

# Start a workspace from a git repository

## Context and Problem Statement

The user (2026-11-24): on a new device, "import a workspace from git directly, like give the repo, it gets cloned and then we open Writer in it". Today a vault from a remote means running `git clone` in a terminal, then opening the folder. How does someone start from a repository inside Writer?

## Decision Drivers

- One step from a repository to an open vault, with no terminal.
- Reuse the git feature's engine, credentials and errors; no second clone path.
- Never leave a half-made folder; never write outside the vault's confinement.
- Credentials and URLs never logged.

## Considered Options

- A. "Clone from Git…" on the welcome screen and in the palette (chosen).
- B. CLI only: `writer git:clone`.
- C. Docs only: run `git clone`, then open the folder (today).

## Decision Outcome

Chosen option: **A**, because it is the only one that needs no terminal. B stays as a secondary entry (agents use it); C is what exists.

- **Entry**: a button in the welcome screen's `welcome-actions` slot and the palette command `git.clone` ("Clone from Git…"). From the welcome screen the vault opens in the same window; from a vault window, in a new one (`open_workspace_in_new_window`).
- **Input**: one "Repository" field: an HTTPS or SSH URL (checked by `check_url`, no password in the URL), or `owner/repo`, resolved through `forge::FORGES` (`gh` gives github.com, `fj` its auth host, a picker when several) to `https://<host>/<owner>/<repo>.git`. "Location": a folder picker (`pickWorkspace`) defaulting to the last parent. "Name": defaults to the repository name (the one `repo_name` rule).
- **Progress**: "Receiving 42%", then "Writing files 120/300", with Cancel. Cancel sets the interrupt and removes the folder only if this call created it (same device and inode).
- **Credentials**: the same `credential::answer`. A `gh` or `fj` source is bound to the host and recorded in the new vault's `.writer/git/state.json`.
- **After**: the vault opens, setup takes "Use existing repository", makes no commit, and tracking is set.
- **LFS**: with git and git-lfs, run `git lfs install --local`, then Writer's `lfs_fetch` and materialize. Without git-lfs the pointers stay and the status says "Large files not downloaded (n) · Install git-lfs"; without git, "… · Install git".
- **Errors** (one line plus Show logs): "Authentication failed" (with Sign in with GitHub or Forgejo), "Repository not found", "A folder named X is already there", "Offline", the local-network line, "The repository is empty" (it still opens).
- **Privacy**: the URL is never logged. UI text is terse, in `ModalShell`, at most one hint line.

### Consequences

- Good, because a new device is one dialog away from the user's notes.
- Good, because clone is the existing sync: init, add remote, point HEAD at the remote's default branch, `sync::sync` (the unborn HEAD takes the fast-forward adopt path, which already confines writes and materializes LFS). Single branch.
- Bad, because the engine needs ADR 2026-11-24 Lanes 1 and 3 first.
- Bad, because the folder-making and cancel rules are one more thing to test.

### Contract

`git_clone({ url, parent, name }) -> { path }`; event `git:clone-progress { phase, done, total }`; CLI `writer git:clone url=… dest=…`.

## Implementation Plan

- **Affected paths**: `src-tauri/src/git/clone.rs` and `net.rs::remote_head_branch` (HEAD symref from the ref map); `features/git/rust/` (`cli.rs`, `commands.rs`, `feature.json`: commands `git_clone`, `git_clone_cancel`); `src/components/welcome/index.tsx` (the `welcome-actions` slot); `features/git/web/components/clone-dialog.tsx`; bindings; `features/git/tests/clone.test.tsx`; `SPECs/git-sync-spec.md` "Start from a repository"; `CHANGELOG.md`.
- **Dependencies**: [ADR 2026-11-24 use gix for everything but push and LFS](2026-11-24-use-gix-for-everything-but-push-and-lfs.md), Lanes 1 and 3 (Lane 4 needs both), then Lane 5.
- **Patterns to follow**: contribution points and `writer-feature` skill; `ModalShell`; `commands::blocking`; the `forge` table.
- **Patterns to avoid**: gix checkout (filters, escapes confinement); a second clone or LFS path; logging the URL; opening the vault before the clone returns Ok.
- **Steps**:
  1. **Lane 4, engine**: `create_dir(dest)` (must not exist; record device and inode), `Repo::init`, `config_write::add_remote`, `remote_head_branch`, HEAD to `refs/heads/<default>`, `set_tracking`, `sync::sync(dest)`; write `refs/remotes/origin/HEAD`; remove the folder on error or cancel only if Writer made it. CLI `writer git:clone`.
  2. **Lane 5, UX**: the slot, commands, dialog, palette entry, progress event, errors, spec section.

### Verification

- [ ] The cloned tree equals `git clone`'s (`ls-files -s` and bytes); tracking is set; it opens as an existing repository with no commit.
- [ ] Protected paths are refused; an existing destination is refused; cancel removes only a folder Writer made.
- [ ] LFS with a fake `git-lfs` materializes files; without it pointers stay and the notice shows; without git the notice says so.
- [ ] An empty repository opens with "The repository is empty".
- [ ] `git_clone_cancel` stops an in-flight clone; the URL appears in no log.
- [ ] Dialog test: URL and `owner/repo` input, progress, each error line.

## Pros and Cons of the Options

### A. Clone from Git…

- Good, because no terminal, one engine.
- Bad, because a dialog and event to build.

### B. CLI only

- Good, because cheapest; the engine is needed anyway.
- Bad, because the target user is not at a terminal on a new device.

### C. Docs only

- Good, because no code.
- Bad, because it is the problem.

## More Information

Spec: [`SPECs/git-sync-spec.md`](../../SPECs/git-sync-spec.md) "Start from a repository" (planned). Builds on [ADR 2026-11-24 use gix for everything but push and LFS](2026-11-24-use-gix-for-everything-but-push-and-lfs.md) and [ADR 2026-11-18](2026-11-18-sync-vaults-with-a-built-in-git-feature-rust-merge-and-system-git-transport.md).
