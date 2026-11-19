---
status: proposed
date: 2026-11-18
decision-makers: Writer maintainers
---

# Sync vaults with a built-in Git feature: Rust logic and merge, system git for transport

> **Deferred (user, 2026-11-18): future work.** The design below is agreed and specified in [`SPECs/git-sync-spec.md`](../../SPECs/git-sync-spec.md); implementation waits. Accept this ADR when the work starts, after confirming the `gix` version and the GitHub OAuth App client id.

## Context and Problem Statement

Writer has no version history or sync. The Obsidian Git plugin (MIT, 3.5M downloads) shells out to the system `git`, has no merge of its own and leaves conflict markers in notes for the user to resolve (research 2026-11-18 of `Vinzent03/obsidian-git`: `src/gitManager/simpleGit.ts`, `src/editor/conflicts/`). The user asked (2026-11-18) for a native Git feature "to be used as proper sync engine too", with a three-way merge, designed together; as much as possible in Rust. Choices made with the user: logic in Rust with gitoxide for reading and system git for the network (gitoxide cannot push today, and LFS needs `git-lfs`); automatic commit, pull and push; automatic 3-way merge then a merge view; any remote plus a GitHub sign-in (through `gh` when installed); credentials in the existing secrets module; notes, attachments and shared config synced; rebase of local commits; v1 with note history and restore, optional LFS, agent and CLI access, a status item and a panel.

## Decision Drivers

- Never lose a change: every merge keeps both sides in history; a failed step leaves the working tree as it was.
- Merges that understand notes: two devices editing different properties never conflict.
- Logic in Rust, shared by the app and the `writer` CLI; the UI in React.
- Credentials never in the vault, a settings file, a log or an event.
- The user's existing git setup (SSH keys, credential helpers, `gh`) keeps working.

## Considered Options

- A. Hybrid: Rust (gix to read the repository; our status, merge, rebase replay, scheduler and history), system `git` for fetch, push and LFS.
- B. libgit2 (`git2`) for everything.
- C. System `git` for everything, Rust only for the merge of conflicting notes.

## Decision Outcome

Chosen option: **A**.

1. **Feature**: `apps/desktop/features/git/` (kill switch `features.git.enabled`, off by default until a vault is set up; settings fragment; Rust half `rust/` with the engine Tauri-free in `src-tauri/src/git/` so the CLI shares it; web half for the panel, merge view, history tab, status item). New dependency: `gix` (MIT/Apache-2.0), minimal features (read objects, refs, index, status, merge base, write objects and commits; no network), pinned exactly, confirmed with the user before install.
2. **Transport**: `git` is run with `std::process::Command` for `fetch`, `push`, `clone` and `lfs`, with `GIT_TERMINAL_PROMPT=0`, `-c core.quotepath=off`, `LC_ALL=C`, a `PATH` that adds Homebrew and the standard install dirs (a GUI app's PATH lacks them), a timeout, and output parsed from porcelain or exit codes only. Missing `git`: the setup page says so, with "Install Command Line Tools" on macOS.
3. **Credentials**: SSH remotes use the user's ssh-agent and keys. HTTPS remotes use a credential helper that is Writer's own binary in helper mode (`writer git-credential`, the git credential protocol on stdin): it answers from `features.git.token` in the secrets module (`features/secrets.rs`, the one Keychain item, declared in `contributes.secrets`), or, when the user chose GitHub CLI, from `gh auth token` read at the moment of use (never copied). The user's own helpers keep priority if they answer first. Tokens are never logged, never in argv, never in an event.
4. **Setup**: a remote is optional (the user, 2026-11-19): with none, the feature is local version history (automatic commits, history, diff, restore, the merge view), with no fetch, push, sign-in or network, and a status of Local rather than Offline or Error; a remote can be added or removed later. Settings > Git: "Local history only" (`git init` if needed, the ignore block, a first commit), "Use existing repository" (the vault is already a repo), "Add a remote" (paste a URL), or "Sign in with GitHub": with `gh` installed and signed in, `gh repo create --private` makes and links the repo; without it, the GitHub device flow (needs a registered GitHub OAuth App client id, an open item for the maintainers). If the vault holds Obsidian Git settings (`.obsidian/plugins/obsidian-git/data.json`), its intervals and commit message prefill Writer's settings once, read-only.
5. **What is synced**: everything except device-local state, through a managed block in the vault's `.gitignore` written only between `# writer:begin` / `# writer:end` markers (the user's lines are kept): `.obsidian/workspace*.json`, `.obsidian/cache`, `.writer/` caches and the index (shared `.writer/` config such as `property-types.json` and `graph.json` stays synced), `.trash/`, OS files (`.DS_Store`, `Thumbs.db`). Plugins' code and settings in `.obsidian/` are synced.
6. **Cadence** (settings, defaults): commit changed files after `git.commit-after` seconds of quiet (60) and on window close; fetch, replay and push every `git.sync-interval` minutes (5), on vault open and on "Sync now"; commit message `git.commit-message` (default `vault backup: {{date}}`, placeholders `{{date}}`, `{{hostname}}`, `{{numFiles}}`, `{{files}}`, the Obsidian Git ones). Writes by the app itself are seen through the watcher's self-write detection; nothing runs while a merge view is open for a file.
7. **Rebase replay**: after a fetch, unpushed local commits are replayed in order on top of the remote head (a cherry-pick with our merge per file, base = the commit's parent), producing new commits with the same messages and authors; then pushed. If the remote moved again during push, fetch and replay again (bounded retries). The pre-sync state is recorded (`.writer/git/sync-state.json`, device-local) so an interrupted sync resumes or rolls back.
8. **The 3-way merge** (Rust, `git/merge.rs`): per file with base, mine and theirs.
   - Markdown: front matter merged per property (a property changed on one side takes that side; changed on both to different values is a conflict on that property only; key order follows mine), the body merged line by line (diff3 over the shared line diff of `agent/line_diff.rs` or its extracted core), with adjacent-but-separate edits merged cleanly.
   - Other text files (`.base`, `.canvas`, `.json`, code): line merge; JSON files whose both sides parse merge per top-level key first.
   - Binary files: no merge; the remote version stays at the path and mine is kept as `name (conflict <device> <date>).ext`, listed in the panel.
   - True overlaps stop the sync for that file only (others complete); the file is marked conflicted and opens in the merge view.
9. **Merge view** (web, a page kind `git-merge`): three columns, Mine, Result, Theirs (CodeMirror merge view, already in the editor stack if present, otherwise a read-only diff of the two sides beside an editable result), per hunk "Take mine", "Take theirs", "Take both", and the result editable; "Save" writes the file through the one write path, completes the replay and resumes sync. Front matter conflicts show per property. The note is never left with conflict markers.
10. **LFS** (optional, setting `git.lfs` off by default because of hosting cost): when on and `git-lfs` is installed, files above `git.lfs-threshold-mb` (100) are tracked with LFS (`.gitattributes` managed block); when `git-lfs` is missing the setting says so and stays off.
11. **History and restore**: a "History" tab for the current file (its commits with date, device and message; a diff against any version; "Restore this version" writes it as a new change, never rewriting history). Read through gix.
12. **Status and panel**: a status item (Synced, Pending n, Syncing, Conflict n, Offline, Error) opening a sidebar panel: changed files, conflicts (open the merge view), last sync, "Sync now", "Pause sync".
13. **Agents and CLI**: `writer git:status`, `git:sync` (asks the running app over the socket when it runs, else runs headless), `git:log path=…`, `git:diff path=… [rev=…]`; the managed skill documents them. An agent chat's changes are committed as their own commit with the chat title as message when the turn ends (the Changes card already knows the files).

### Consequences

- Good: history and sync with merges that understand notes, and no conflict markers in notes.
- Good: the user's git, SSH and `gh` setup works unchanged.
- Bad: requires `git` installed; a new dependency (`gix`); our own merge and replay code to maintain.
- Neutral: no mobile; no submodules management; one branch.

### Non-goals

- Branches other than the current one, pull requests, submodules editing.
- A Writer-hosted sync service.
- Encrypting the repository.
- Running repository hooks differently from git's own behaviour.

## Implementation Plan

- **Affected paths**: new `src-tauri/src/git/` (`repo.rs` gix reads, `status.rs`, `transport.rs` system git, `credential.rs` helper mode, `merge.rs`, `frontmatter_merge.rs`, `replay.rs`, `scheduler.rs`, `ignore.rs` managed blocks, `history.rs`, `lfs.rs`, `tests/` with temporary repos and bare remotes); `apps/desktop/features/git/` (`feature.json` with secrets, settings fragment, `rust/` glue and CLI and IPC contributions, `web/` panel, status item, merge view page kind, history tab, setup page); `writer_cli.rs` / `cli/` (`git-credential` helper mode and `git:*` commands); the line diff core shared with `agent/line_diff.rs` (extract, do not copy); specs: new `SPECs/git-sync-spec.md`, `SPECs/builtin-plugins-spec.md`, `SPECs/writer-cli-spec.md`; `CHANGELOG.md`, `TODOS.md`; `THIRD_PARTY_NOTICES` if any Obsidian Git code is adapted (MIT notice kept).
- **Patterns to follow**: Tauri-free core with Tauri glue (like `relocate/`, `bases/`); `commands::blocking`; the secrets module; the watcher's self-write detection; one write path; `docs/design.md`.
- **Patterns to avoid**: tokens in argv, env dumps or logs; conflict markers in notes; a second diff implementation; network calls through gix.
- **Tests**: merge (property-level front matter, clean adjacent edits, true overlap, delete vs edit, binary keep-both, JSON per key); replay (ordered, authorship kept, conflict pauses one file, resume and rollback from the recorded state, remote moved during push); transport (missing git, timeout, auth failure surfaced, PATH fix) against a local bare remote; credential helper protocol (answers from the secret, `gh` path, never logs); ignore block keeps user lines; LFS threshold and missing `git-lfs`; history and restore; scheduler (debounce, interval, on close, paused while a merge is open); CLI commands headless and through the socket; agent chat commit message.

### Verification

- [ ] Two clones of a test vault editing different properties of the same note sync with no conflict.
- [ ] Overlapping edits open the merge view; Save completes the sync; no conflict markers ever appear in the note.
- [ ] A token is stored only in the Keychain and never appears in logs or argv.
- [ ] With `gh` signed in, "Sign in with GitHub" creates a private repo and syncs.
- [ ] History shows a note's versions and restores one as a new commit.
- [ ] LFS stays off unless enabled and `git-lfs` is present.

## Pros and Cons of the Options

### A. Hybrid

- Good, because logic and merges in Rust, and the user's git setup handles auth and LFS.
- Bad, because two ways to touch the repository (gix reads, git transport) must stay consistent.

### B. libgit2

- Good, because one library including push.
- Bad, because native C, OpenSSL/libssh2 linking, its own auth stack separate from the user's setup.

### C. System git for everything

- Good, because least code.
- Bad, because rebase conflicts leave the repository mid-rebase and markers in files; parsing output for everything.

## More Information

Research: the four-plugin source review of 2026-11-18 (Obsidian Git is MIT; desktop uses `simple-git`; no custom merge; askpass bridge). Related: the CLI-to-app socket ADR (`git:sync` through the running app), the secrets module (`features/secrets.rs`), the agent Changes card (per-chat commits). Open items: the GitHub OAuth App client id for device flow without `gh`; the exact `gix` version and feature set.
