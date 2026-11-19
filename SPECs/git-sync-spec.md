# Git sync

Status: designed, not implemented (future work, the user, 2026-11-18). Decision: [ADR 2026-11-18 sync vaults with a built-in Git feature](../docs/decisions/2026-11-18-sync-vaults-with-a-built-in-git-feature-rust-merge-and-system-git-transport.md) (proposed until work starts).

## Goal

Version history and multi-device sync for a vault through Git, with merges that understand notes, so a sync never loses a change and never leaves conflict markers in a note. As much as possible in Rust; the UI in React.

## Split

| Layer                                                        | Owns                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/git/` (Rust, Tauri-free, shared with the CLI) | reading the repository with `gix` (objects, refs, index, status, merge base, writing objects and commits), status, the 3-way merge, rebase replay, the scheduler, the managed ignore and attributes blocks, history, LFS decisions, the credential helper |
| System `git` (child process)                                 | `clone`, `fetch`, `push`, `lfs`: the network only                                                                                                                                                                                                         |
| `features/git/`                                              | Tauri glue, settings fragment, secrets declaration, CLI and IPC contributions, the web panel, status item, setup page, merge view and history tab                                                                                                         |

## Requirements

- `git` installed. The setup page detects it (with a `PATH` that adds Homebrew and the standard install dirs, which a GUI app lacks) and on macOS offers "Install Command Line Tools".
- `git-lfs` only when LFS is turned on.
- `gix` (MIT/Apache-2.0), exact version pinned when work starts, minimal features, no network features.

## Setup (Settings > Git)

A remote is optional (the user, 2026-11-19). Without one, Git is local version history: automatic commits, history, diff and restore, the merge view for conflicts the user makes locally; nothing is fetched or pushed. A remote can be added, changed or removed later from the same page.

0. **Local history only**: Writer runs `git init` if the vault is not a repo, writes the ignore block and makes the first commit. No remote, no sign-in, no network.
1. **Use existing repository**: the vault is already a repo; its remote and branch are used as they are, and a repo with no remote is the local-only mode.
2. **Add a remote**: paste an SSH or HTTPS URL; Writer runs `git init` if needed, writes the ignore block, makes the first commit, and pushes.
3. **Sign in with GitHub**: with `gh` installed and signed in, `gh repo create <vault name> --private` creates and links the repo. Without `gh`, the GitHub device flow (needs a registered GitHub OAuth App client id: open item).

If the vault has Obsidian Git settings (`.obsidian/plugins/obsidian-git/data.json`), its intervals and commit message prefill Writer's settings once (read-only).

## Credentials

- SSH: the user's ssh-agent and keys, untouched.
- HTTPS: Writer's binary in credential-helper mode, `writer git-credential` (the git credential protocol on stdin/stdout), registered per command with `-c credential.helper=`. It answers from the secret `features.git.token` (declared in `feature.json` `contributes.secrets`, stored by `features/secrets.rs` in the one Keychain item) or, when the user picked "GitHub CLI", from `gh auth token` read at that moment (never copied). The user's own helpers are tried first.
- Never: a token in argv, an environment dump, a log line, an event, a settings file or the vault.

## What is synced

Everything in the vault except device-local state. Writer keeps a managed block in the vault's `.gitignore`, only between `# writer:begin` and `# writer:end`; the user's own lines are never touched:

```
# writer:begin
.obsidian/workspace*.json
.obsidian/cache
.writer/index/
.writer/cache/
.writer/git/
.trash/
.DS_Store
Thumbs.db
# writer:end
```

Shared Writer config (`.writer/property-types.json`, `.writer/graph.json`, `.writer/icons.json`) and plugins' code and settings in `.obsidian/` are synced.

## Cadence

| Setting                | Default                  | Meaning                                                                               |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `git.commit-after`     | 60 s                     | commit changed files after this much quiet                                            |
| `git.sync-interval`    | 5 min                    | fetch, replay, push (not used without a remote)                                       |
| `git.sync-on-open`     | on                       | sync when the vault opens                                                             |
| `git.commit-message`   | `vault backup: {{date}}` | placeholders `{{date}}`, `{{hostname}}`, `{{numFiles}}`, `{{files}}` (Obsidian Git's) |
| `git.lfs`              | off                      | see LFS                                                                               |
| `git.lfs-threshold-mb` | 100                      | see LFS                                                                               |

Also on window close: commit, then (with a remote) push if the network allows within a short timeout. Writes by the app are seen through the watcher's self-write detection. A file with an open merge view is never committed until it is saved.

## Sync

With no remote, sync is step 1 only: commits on the cadence, never a fetch or push, never a network error.

1. Commit pending changes.
2. `git fetch` the tracking branch.
3. If the remote has commits the local branch lacks, replay the unpushed local commits in order on top of the remote head: for each commit, merge each changed file with base = that commit's parent, mine = the commit's version, theirs = the current rebuilt tree; write new commits with the same message, author and date.
4. `git push`. If rejected because the remote moved, go back to 2 (at most 3 rounds, then "Sync failed: remote keeps changing").

The state before a sync is recorded in `.writer/git/sync-state.json` (device-local). An interrupted sync (crash, quit) resumes from it on the next start or rolls back to the recorded head; the working tree is never left half-replayed.

## Merge

Per file, base / mine / theirs, in `git/merge.rs`:

- **Markdown**:
  - **Front matter**: merged per property. A property changed on one side takes that side. Added on both with the same value merges cleanly; changed on both to different values is a conflict on that property only. Key order follows mine, then theirs' new keys. Formatting stays byte-minimal through the frontmatter patcher (`index/patch.rs`).
  - **Body**: diff3 line merge over the shared line-diff core (extracted from `agent/line_diff.rs`, not copied). Non-overlapping edits, including adjacent lines, merge cleanly.
- **Other text** (`.base`, `.canvas`, `.excalidraw`, `.json`, code): line merge. JSON files whose three versions parse merge per top-level key first.
- **Binary**: no merge. The remote version stays at the path; mine is kept beside it as `name (conflict <device> <YYYY-MM-DD HHmm>).ext` and listed in the panel.
- **Delete vs edit**: the edit wins and the file is restored; the panel says so.
- **Rename**: detected by gix's rename tracking. Edits follow the renamed file.

A true overlap pauses the sync for that file only. Other files complete; the file is marked conflicted.

## Merge view

A page kind `git-merge` with three columns, Mine, Result and Theirs:

- Each conflicting hunk offers "Take mine", "Take theirs" and "Take both" (mine then theirs).
- The Result column is editable.
- Front matter conflicts show per property with the two values.
- "Save" writes the result through the one write path, completes the replay and resumes sync.
- "Cancel" keeps the file conflicted, and sync stays paused for it.

The note on disk keeps mine until Save; it never contains conflict markers.

## LFS

Off by default (hosting can cost money). When on and `git-lfs` is installed, files above the threshold are tracked through a managed block in `.gitattributes` (the same markers). When `git-lfs` is missing, the setting is disabled with "Install git-lfs to use this".

## History

A "History" tab for the current file:

- Its commits: date, device, message.
- Select one to see its diff against the current file.
- "Restore this version" writes it back as a new change. History is never rewritten.

Read through gix.

## Status and panel

- Status item: Synced · Pending n · Syncing · Conflict n · Offline · Error, and **Local** (committed, no remote; never Offline or Error for a missing remote). A click opens the panel.
- Sidebar panel:
  - changed files;
  - conflicts (each opens the merge view);
  - last sync time;
  - "Sync now" and "Pause sync" ("Commit now" and "Pause" without a remote, plus "Add a remote").
- Errors are one line ("Push rejected: authentication failed") with "Details" copying the sanitized git output (no URLs with credentials, no tokens).

## Agents and CLI

- `writer git:status` (changed, conflicted, ahead/behind; `remote: none` without one).
- `writer git:sync` (commits only when there is no remote): through the running app over the socket when it runs (so the app's scheduler and merge view own it), else headless with the same Rust engine. A conflict headless is reported and left for the app.
- `writer git:log path=…` and `writer git:diff path=… [rev=…]`.
- The managed `writer-cli` skill documents them.
- An agent chat's changes are committed as their own commit when the turn ends, with the chat title as the message (the Changes card already knows the files).

## Privacy and logging

Log operation names, durations and outcomes only. Never tokens, remote URLs with credentials, file contents or file paths.

## Tests

- **Merge**: property-level front matter, clean adjacent edits, true overlap, delete vs edit, binary keep-both, JSON per key, rename plus edit.
- **Replay**: order and authorship kept, a conflict pauses one file, resume and rollback from the recorded state, remote moved during push.
- **Transport** against a local bare remote: missing git, timeout, auth failure surfaced, PATH fix.
- **Credential helper**: answers from the secret, the `gh` path, never logs.
- **Ignore block**: keeps user lines and is idempotent.
- **LFS**: threshold, and `git-lfs` missing.
- **History**: list, diff and restore.
- **Scheduler**: debounce, interval, on close, paused while a merge view is open.
- **No remote**: local-only setup from a plain folder, commits on the cadence, no fetch or push attempted, status Local (not Offline or Error), history and restore work, adding a remote later pushes the existing history, removing it returns to Local.
- **CLI**: headless and through the socket.
- **Agent**: the chat commit message.

## Not in scope

Branches other than the current one, pull requests, submodule editing, a Writer-hosted sync service, encrypting the repository, mobile.
