# Git sync

Status: **phases 1 to 5 implemented** (2026-11-20; phase 1 is described here, the others in their own paragraphs below): local version history only, no remote and no network: setup by default when a vault opens (below; "Local history only" and "Use existing repository" stay as the choices of Settings > Git), the History tab with diffs and Restore (`git:diff`, `git:show`, `git:restore`; the shared text diff `src-tauri/src/text_diff/`), the managed ignore block, the cadence, `type(scope): subject` commit messages with trailers, agent-turn commits through the agent's points, the status item, the panel, Settings > Git (short layout, no remote controls), `writer git:status`, `git:log`, `git:commit` and the `writer-git` skill. LFS (phase 5) is built, see LFS. Decision: [ADR 2026-11-18 sync vaults with a built-in Git feature](../docs/decisions/2026-11-18-sync-vaults-with-a-built-in-git-feature-rust-merge-and-system-git-transport.md) (accepted, phase 1 in code).

Phase 3 (sync with a remote) **implemented** (2026-11-20), in code and tested, not seen in a real window or against a real remote. Built as specified in Sync, Merge, Credentials, Cadence and Status and panel, with these deviations:

- **Replay** (`git/sync.rs`): each unpushed commit is re-made on a virtual tree built from the remote head, per file (base: the commit's parent, mine: the commit, theirs: the accumulating tree); message, author and committer are kept, a commit that becomes empty is dropped. A file that overlaps or is held back is skipped for the rest of the replay: its version stays on disk and `.writer/git/conflicts.json` blocks commits of it. Atomic through `.writer/git/sync-state.json` `{old_head, new_head, skip}`: record, move HEAD (compare-and-set), then the working tree and index; recovery resumes at new head or discards at old head.
- **Renames** are followed in the replay since phase 4 (see there).
- **Token hold-back** happens when the commit is made and in the replay, not as a push-time filter: a held plugin's `data.json` never enters a commit that could be pushed ("Sync anyway" and "Never sync this plugin" record the decision).
- **Overlap with unsaved typing** in an open note: the user's text stays (autosave writes it locally), the note shows the "Changed on another device" bar and the merge view (phase 4) settles it.
- **No device-flow sign-in**: "Sign in with GitHub" runs `gh repo create <vault name> --private`; without `gh`, "Install GitHub CLI" opens its page. No OAuth client id is invented.
- **Credential source** (`token` or `gh`) is device-local state, not a setting; the helper is Writer's own binary (`writer git-credential`), registered as the only helper for Writer's calls and bound to the token's host (see Credentials), and answers only `get` over https.
- The one bounded runner is `src-tauri/src/process_run.rs` (a scope `Spawner`, timeout, stdin text, output cap, killed on stop): git's `Exec` and the agent's `claude` probes and title call run through it; child `PATH` comes from `plugin_env::search_dirs`, `git` and `gh` are found with `plugin_env::which`.

Phase 4 (conflicts and the merge view) **implemented** (2026-11-20), in code and tested, not seen in a real window. Built as specified in Merge, Merge view and Status and panel, with these notes:

- **Settling** (`git/resolve.rs`, Tauri-free, shared with the CLI): `open` lays out the file as settled text and overlaps over the recorded base, the other side's HEAD version and the user's buffer; `save` composes the result (front matter with the chosen side per conflicting property, then the Result column's text), writes it through the app's one atomic write after telling the editors (`git:applying`), forgets the conflict and commits it as `user(merge)` on top of HEAD, which completes what the replay left out; the next sync pushes it. `take` settles a whole side (`writer git:resolve path=… take=mine|theirs|both`; a binary's `both` keeps the conflict copy). Cancel is the absence of any call: the file stays conflicted and sync stays paused for it, the note on disk keeps mine, never markers. The feature is busy (`busy_guard`) and holds the repository's write lock while a resolution writes.
- **The record** (`.writer/git/conflicts.json`) now also holds the base blob id and, after a rename, `theirs_path` (where the other side's version is; `path` is always where mine is on disk). A file already in conflict is never overwritten by a later sync's worktree update.
- **Renames in the replay** (`git/renames.rs`, `git/sync.rs`): a commit's deleted and added files pair as a rename by Writer's `Writer-Move-From/To` trailers, then by the same blob, then by at least half shared lines of one extension; the other side's renames since the merge base are found the same way. A rename here with an edit there lands as the edited file at the new name; an edit here with a rename there follows the rename (the edit lands at the new name, no duplicate); renamed on both sides to one name merges the edits; to different names, or edited on both sides with a rename on one, is a conflict whose record names both paths and the merge view offers the name to keep. Only the replay follows renames: a pull that only updates the worktree (an open note edited while the other device renamed it) still keeps the edit and brings the renamed file beside it.
- **The merge view** (`features/git/web/components/merge-page.tsx`, page kind `git-merge`, core): Mine, Result and Theirs. Result is a CodeMirror editor on the app's own stack (`@codemirror/state`, `view`, `commands`; `@codemirror/merge` is not a dependency and none was added): a state field tracks every overlap through edits, a block of Take mine, Take theirs and Take both sits above it, the overlap starts as mine's lines and counts as decided once a button is used or the user types in it; Save waits until every overlap and property is decided. Mine and Theirs are read-only editors marking the same overlaps; the page is one scroller (the columns grow with their text, so overlaps are not row-aligned across columns). Front matter conflicts are rows with both values and a choice; a rename conflict adds a choice of name.
- **Ways in**: the panel's Conflicts rows (link activation: middle click and Cmd/Ctrl-click open it in the background), "Resolve conflicts" in the palette (the open note's, else the first; binaries go to the panel), and the note bar. The new core slot `note-bar` renders the git feature's one-line bar "Changed on another device — Resolve" over an open conflicted note; it never opens the view by itself and never touches the buffer, so autosave keeps writing the user's text locally (a conflicted file is never committed). Binary conflicts list the `name (conflict <device> <date>).ext` copy with Keep mine, Keep theirs and Keep both. The status reads `Conflict n` with binaries counted.
- **Mine** in the view is the editor's buffer when the note has unsaved typing, else the file. If the base object was collected the view is two-way (every difference overlaps).

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
- `gix` (MIT/Apache-2.0, approved by the user 2026-11-20), exact version pinned when work starts, minimal features, no network features.

## Setup (Settings > Git)

**Set up by default** (the user, 2026-11-20: "By default setup the git repo"). With the feature on, a vault that opens and has no setup recorded is set up by the first pass of the cadence thread, once per open:

- the vault root is already a repository: used as it is ("Use existing repository"), the managed `.gitignore` block is written, **no extra commit** until there are changes (the block is a pending change);
- a folder above the vault is a repository (a docs folder in a code repo): **not set up automatically**, never a silent commit into a parent repository. The status item reads "History off" and a click, like Settings > Git, shows the setup choices ("Local history only" makes a repository of its own in the vault; "Use existing repository" needs the vault root itself to be one);
- otherwise "Local history only": `git init` through gix, the ignore block, and the first commit `chore(setup): start version history`;
- no git identity: the repository and the block are made but no commit; the existing "Set your git name and email" state follows, and the first commit after the user sets one is the `chore(setup)` commit (an empty repository's first commit is always that one);
- **Stop version history** (Settings > Git, per vault) removes Writer's setup record (`.writer/git/state.json` `stopped`, device-local: the vault stops counting as set up, no automatic commit, no setup on the next open) and never touches `.git` or the history. The vault then shows the setup choices; choosing one clears the record.

The setup record is that device-local state plus the managed block (`git::is_set_up`): a vault is set up when it is a repository holding the block and has not been stopped.

A remote is optional (the user, 2026-11-19). Without one, Git is local version history: automatic commits, history, diff and restore, the merge view for conflicts the user makes locally; nothing is fetched or pushed. A remote can be added, changed or removed later from the same page.

0. **Local history only**: Writer runs `git init` if the vault is not a repo, writes the ignore block and makes the first commit. No remote, no sign-in, no network.
1. **Use existing repository**: the vault is already a repo; its remote and branch are used as they are, and a repo with no remote is the local-only mode.
2. **Add a remote**: paste an SSH or HTTPS URL; Writer runs `git init` if needed, writes the ignore block, makes the first commit, and pushes.
3. **Sign in with GitHub**: with `gh` installed and signed in, `gh repo create <vault name> --private` creates and links the repo. Without `gh`, the GitHub device flow (needs a registered GitHub OAuth App client id: open item).

If the vault has Obsidian Git settings (`.obsidian/plugins/obsidian-git/data.json`), its intervals and commit message prefill Writer's settings once (read-only).

## Credentials

- SSH: the user's ssh-agent and keys, untouched.
- HTTPS: Writer's binary in credential-helper mode, `writer git-credential` (the git credential protocol on stdin/stdout), registered per command as git's **only** helper: `-c credential.helper= -c credential.helper=!writer …` (the empty value clears the user's helpers for that call, so git's `store` after a success never hands Writer's token to them, e.g. to `store` or the macOS keychain helper). It answers from the secret `features.git.token` (declared in `feature.json` `contributes.secrets`, stored by `features/secrets.rs` in the one Keychain item) or, when the user picked "GitHub CLI", from `gh auth token` read at that moment (never copied, GitHub hosts only).
- The token is **bound to the host it was saved for**: choosing the token source records the host of the vault's `https` remote (`token_host` in `.writer/git/state.json`, not a secret) and the helper gets it as `--host`; it answers no other host, and nothing when no host was recorded (save the token again after linking another remote).
- Writer registers its helper only when it has a credential for the vault (a saved token, or the GitHub CLI source); otherwise git runs with the user's own helpers untouched (fix 2026-11-21).
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
node_modules/
.DS_Store
Thumbs.db
# writer:end
```

**Never in the middle of an operation.** Writer commits nothing, sets nothing up and restores nothing while the repository has `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge/`, `rebase-apply/` or `BISECT_LOG`, or a detached HEAD (`git::operation`, checked in `auto_setup`, the runtime's `active()` and `Repo::commit` itself, so every path refuses: user, agent, restore, close flush). The status says "Paused: merge in progress" (or rebase, detached HEAD) quietly and the history resumes by itself when the markers go.

**What it leaves out.** A file over `git.lfs-threshold-mb` (100 MB by default) is not versioned while LFS is off (or `git-lfs` is missing): the panel lists "Not versioned: too large (n)" with the names on click. With LFS on it is versioned through LFS instead (see LFS). A file already in LFS is never skipped. A folder with its own `.git` (a nested repository) and any `node_modules` are never walked into. `.obsidian/plugins/*/data.json` stays synced.

**Reading cost.** A version is looked up by its id in that commit alone, falling back to a bounded walk only for an abbreviated id; per-file lists are cached per HEAD; the Deleted list hides protected and device-local paths and shows the 200 newest with "Show more". Restore writes the open tab's unsaved edits first (the normal save), restores, then reloads the tab through the watcher's reload.

Shared Writer config (`.writer/property-types.json`, `.writer/graph.json`, `.writer/icons.json`) and plugins' code and settings in `.obsidian/` are synced.

## When off, and how it cooperates

Git is an optional built-in feature (ADR 2026-11-20 "let features cooperate through owned points, optional services and rare requires"). With `features.git.enabled` off, or on in a vault that is not set up, everything works exactly as before: the agent keeps its in-memory Changes card, diffs and Undo (`agent/changes.rs`, `agent/line_diff.rs`) as the only path, lint, the editor's save path, window close and the CLI are untouched, and no timer runs. Git adds to the agent, never replaces anything of it.

- The agent **owns** two hook points and one provider point, `agent.turn-baseline` (see "With the agent"), (contract in `agent/api.rs`, registry `features/points.rs`): `agent.turn-started` (the vault root and chat id; emitted from a blocking thread before an idle chat's message is delivered) and `agent.turn-finished` (chat id, title, backend, models, files changed with kind add/edit/delete/move; once per turn, also for a turn with no change and when the process died under it). The agent never knows git exists; with no contributor `emit` returns at once.
- Git **extends** the hooks and **provides** the baseline from its `start` (`feature.json` `extends`, with an `offNotes` line each for Settings > Features: "Your pending edits won't be saved before an agent turn", "Agent turns won't be saved in history"). The registration is skipped while git or the agent is off, a panic in git's handler fails git only, and git works alone: with the agent off it is the history of the user's edits.
- Git observes writes through `watcher::observe_paths` (no second watcher); paths the managed ignore block names (`.obsidian/workspace*.json`, `.writer/index/`, ...) never reset the quiet timer.
- Off: the Rust half is not set up until the next start (no state, no extension, no ticker), its CLI commands answer "turned off", the skill is not installed, the web half (page, status item, panel, commands) goes at once. All runtime resources belong to one struct (`runtime::Vaults`) with one `shutdown()`.
- A vault that is not set up (no repository or no managed block) gets no commit, no timer action and no error from any hook.

### Plugin settings and secrets (the user, 2026-11-20)

Plugin settings (`.obsidian/plugins/<id>/data.json`) are synced, but before every push Writer scans each changed `data.json` for token-like values: keys named like `token`, `key`, `apiKey`, `secret`, `password`, `auth`, `bearer` (case-insensitive, nested) with a non-empty string value, and long high-entropy strings (40+ chars of base64/hex alphabet). A file that matches is held back from the push (kept committed locally only if it was before; otherwise left out of the commit) and the panel says "Plugin <name>'s settings look like they contain a token — not synced", with **Sync anyway** (this file, until its token values change) and **Never sync this plugin** (adds the file to the managed ignore block). The scan runs locally, logs only the plugin id, never the value.

## Cadence

Designed with the user on 2026-11-20, after the lint lesson (fixes on every autosave rewrote the line being typed): Git never acts while the user types, and one idle constant is shared with lint.

**Commits (the user's edits)**

- A commit runs after `git.commit-after` of quiet: no file in the vault written for that long, by anyone (the editor's autosave, a lint fix, an external app). Lint's safe fixes land 5 s after typing stops, so they are always in the same commit as the edit, never their own.
- Also: on window close, before an agent turn starts (so the turn's commit holds only the agent's files), and on "Commit now".
- No user commit runs while an agent turn is running in the vault. When the turn ends, the agent's commit goes first, then the quiet timer resumes for the rest.
- A file with an open merge view is never committed until it is saved. Writes by the app are seen through the watcher's self-write detection.

**Commit messages** (designed with the user 2026-11-20): the format of conventional commits, not their spec. The type says who, the scope says what happened, so `git log` alone shows the difference between the user's and an agent's commits.

```
user(edit): Meeting notes, Plan (+2)
user(add): Ideas
user(delete): Old draft
user(move): Plan → Archive/Plan
user(restore): Plan to 2026-11-19 14:03
user(merge): Plan
agent(edit): Rewrite the interview guide
chore(setup): start version history
```

- Types: `user` (the user's edits, restores and merge-view resolutions), `agent` (one agent turn), `chore` (Writer's own housekeeping: `setup` for the first commit, `ignore` when the managed `.gitignore` block changes).
- Scopes: `edit`, `add`, `delete`, `move` (a rename is a move), `restore`, `merge`, `setup`, `ignore`. A commit whose files all share one kind takes it; a commit mixing kinds is `edit`.
- Subject for `user`: the changed notes by title (file name without `.md`, other files with their extension), at most two named, then `(+n)`; a move names `from → to`. For `agent`: the chat title.
- Trailers: `Writer-Device: <device name>` on every commit; `Writer-Chat: <chat id>`, `Writer-Agent: <backend>` (`claude`, `opencode`) and `Writer-Model: <model id>` on agent commits. The model is the one the turn's main agent reported (its last `message.model`, e.g. `claude-opus-5-5`); a sub-agent that ran on another model adds one more `Writer-Model:` line per distinct model. `Writer-Turn: <turn id>` names the agent turn, so the Changes card finds its commit by chat id and turn id with no time window (two turns of one chat seconds apart resolve to their own commits). History shows it by its display name (Opus 5.5, Haiku 5.5). Backend and model are trailers, never the scope. When the backend reports no model, the trailer is left out (never guessed).
- **Identity**: the author and committer are exactly what `git commit` resolves, and the installed `git` is the source of truth: Writer runs `git var GIT_AUTHOR_IDENT` and `GIT_COMMITTER_IDENT` in the vault (`git/system.rs`; the `PATH` adds Homebrew and the standard dirs, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, a 5 s timeout; only the name and email are read) and commits with the answer. So the environment (`GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL`, `EMAIL`), the repository's `.git/config`, `include` and `includeIf` (a work identity for some folders), the global `~/.gitconfig`, `$XDG_CONFIG_HOME/git/config` and the system config all apply as git applies them, symlinked paths included. The call is made with `user.useConfigOnly=true`, so git never answers with a name guessed from the system user and the host name. Only without a `git` binary does gix resolve the same sources, trying the resolved repository path first and the given one second (git matches `gitdir:` against the resolved path), which agrees with git through a symlink. The answer is checked at setup and at every commit, and remembered per vault for the status poll (`git::IdentityCache`, owned by the feature's state), refreshed when Settings > Git opens and when a commit fails. Nothing is invented: no "Writer" fallback, no email made from user data. When no identity resolves, Writer does not commit: the status item reads Error, the panel and Settings > Git say "Set your git name and email" with `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, and the setup stops before it writes into the vault. Tests compare the engine with `git var` in a temp repository with a temp `HOME` and XDG dir, an `includeIf "gitdir:..."`, environment overrides, and a repository reached through a symlink (both for the git path and the gix fallback); they skip without `git`.
- Lint fixes never get their own commit: they fall in the quiet window of the edit they follow.
- A replayed commit (sync) keeps its message and trailers.
- The template `git.commit-message` (Advanced) only shapes the subject, default `{{notes}}`; placeholders `{{notes}}`, `{{date}}`, `{{hostname}}`, `{{numFiles}}`, `{{files}}`. Writer always adds the `type(scope): ` prefix and the trailers. History labels and badges rows from the type, scope and trailers.

**Sync (with a remote)**

- Fetch, replay and push about 10 s after each commit, every `git.sync-interval`, on vault open and on window close (short timeout), and on "Sync now".
- A fetched change to a note that is open in an editor is applied only after the same idle time as lint's fixes (5 s without typing): merged into the editor as one transaction (one undo step, `userEvent: "git.sync"`, caret and selection mapped), never a reload under the user's hands. Closed files are written at once. A true overlap leaves the file as the user has it and shows the "Changed on another device — Resolve" bar over the note; the merge view opens only when the user asks.

| Setting                | Default     | Choices / meaning                                                  |
| ---------------------- | ----------- | ------------------------------------------------------------------ |
| `git.commit-after`     | 1 min       | 30 s, 1 min, 5 min, Manual (only "Commit now", close, agent turns) |
| `git.sync-interval`    | 5 min       | 1, 5, 15 min, Manual (not shown without a remote)                  |
| `git.agent-commits`    | on          | each agent turn its own commit; off: agent edits join yours        |
| `git.commit-message`   | `{{notes}}` | Advanced; subject template, see Commit messages                    |
| `git.lfs`              | off         | Advanced; see LFS                                                  |
| `git.lfs-threshold-mb` | 100         | Advanced; see LFS                                                  |

Obsidian Git settings, when present, prefill `git.commit-after` and `git.sync-interval` once (read-only); its commit message is not imported (Writer's prefixes would be lost).

### Settings page

Short, the rest folded:

```
Git                          ● Synced 2 min ago
Remote     github.com/me/vault   [Change]
           [Sync now]  [Pause]
Save versions   [After 1 min quiet ▾]
Sync            [Every 5 min ▾]
Agent turns     [✓] Own version per turn
▸ Advanced
   Commit message     {{notes}}
   Large files (LFS)  [ ] over [100] MB
   Ignored            [Edit .gitignore block]
```

Without a remote the Remote row reads "None" with "Add a remote", and "Sync" is hidden. Before setup the page shows the four setup choices (below) instead.

## Sync

With no remote, sync is step 1 only: commits on the cadence, never a fetch or push, never a network error.

1. Commit pending changes.
2. `git fetch` the tracking branch.
3. If the remote has commits the local branch lacks, replay the unpushed local commits in order on top of the remote head: for each commit, merge each changed file with base = that commit's parent, mine = the commit's version, theirs = the current rebuilt tree; write new commits with the same message, author and date.
4. `git push`. If rejected because the remote moved, go back to 2 (at most 3 rounds, then "Sync failed: remote keeps changing").

The state before a sync is recorded in `.writer/git/sync-state.json` (device-local, written atomically like every file of `.writer/git/`). An interrupted sync (crash, quit) resumes from it or rolls back to the recorded head; the working tree is never left half-replayed. Recovery runs under the repository's write lock **before every commit** (user, agent, setup, the close flush; `git::commit_user` and friends run it themselves) and when the vault opens; `Repo::commit` refuses while the record exists, so the files the interrupted sync had not written yet are never committed back at their old version. The record is cleared as soon as the working tree and the index follow the new head, before the push, so a failed push leaves nothing to recover. The replay's conflicts are recorded before the branch moves (a crash after the move still finds them).

**Confinement** (fix 2026-11-21). A remote tree is not trusted. Every working-tree write and removal of a sync and of the merge view goes through `vault_ops::confine_with` with `sync::PROTECTED`: `.git` in any spelling (case variants on APFS, the HFS+ ignorable code points, trailing dots, `git~1`) at any depth, the device-local `.writer/git/` (a remote `plugin-scan.json` must never pre-approve a token) and any path through a symlink (git never writes beyond a link either) are refused; `.obsidian` syncs. Refused paths are never written, are listed in the panel ("Not written: … (protected path)", dismissed with the other notices) and printed by `writer git:sync`. Writes are the app's one atomic write (`vault_ops::write_bytes`) plus git's file mode.

**The last push guard.** Before any push the unpushed commits are scanned: one that adds a held-back plugin `data.json` stops the push (also when the replay had nothing to rebuild on, e.g. an empty remote); the replay scans a merged result too.

**Status is read-only.** `git_status` never writes: a conflict the user settled outside the merge view is left out of the status and forgotten by the next commit or sync, under the write lock (`conflicts::forget_settled`).

**Open notes.** `git:applying` comes twice with one payload (`{ paths, done }`): before the writes (the editors hold every save of those notes, `lib/save.ts` `holdSaves`) and after them (the written notes are applied at the typing idle, the others released). A watcher event during a save in flight is never dropped behind it. When the buffer overlaps the synced change, the conflict is recorded in Rust (`git_conflict_record`: base = the text last saved, the buffer written as the user's version, under the write lock) so the note bar shows and no automatic commit takes the user's text over the other device's.

**Close and exit.** The sync at close runs on a feature scope thread with one deadline for all its calls and rounds (6 s); the closing side waits for it that long plus a short grace, never running network git itself. The cadence starts its syncs on scope threads too, so the ticker never waits on the network.

## Merge

Per file, base / mine / theirs, in `git/merge.rs`:

- **Markdown**:
  - **Front matter**: merged per property. A property changed on one side takes that side. Added on both with the same value merges cleanly; changed on both to different values is a conflict on that property only. Key order follows mine, then theirs' new keys. Formatting stays byte-minimal through the frontmatter patcher (`index/patch.rs`).
  - **Body**: diff3 line merge over the shared line-diff core (`text_diff/lines.rs`, moved from `agent/line_diff.rs`, not copied). Non-overlapping edits, including adjacent lines, merge cleanly.
- **Other text** (`.base`, `.canvas`, `.excalidraw`, `.json`, code): line merge. JSON files whose three versions parse merge per top-level key first.
- **Binary**: no merge. The remote version stays at the path; mine is kept beside it as `name (conflict <device> <YYYY-MM-DD HHmm>).ext` (this device's name; a counter, `… HHmm 2).ext`, when that name is taken) and listed in the panel.
- **Delete vs edit**: the edit wins and the file is restored; the panel says so.
- **Rename**: within one commit, Writer's move trailers, then the same blob, then text of one extension sharing at least 3 distinctive lines (not blank, not front matter, not repeated in the file) and half of them, as a unique pair. Over the other device's range of commits only its recorded moves (chained) and exact blobs count: two notes made from one template are never one file. Edits follow the renamed file; an edit that follows a rename the other side also edited is a conflict (both paths recorded), never a silent merge.

A true overlap pauses the sync for that file only. Other files complete; the file is marked conflicted.

## Merge view

A page kind `git-merge` with three columns, Mine, Result and Theirs:

- Each conflicting hunk offers "Take mine", "Take theirs" and "Take both" (mine then theirs).
- The Result column is editable.
- Front matter conflicts show per property with the two values.
- "Save" writes the result through the one write path, completes the replay and resumes sync. The note's buffer is saved before the view opens and again before Save; if the file changed on disk since the view opened, those edits are merged into the result (base: the text the view opened on), and when they overlap Save writes nothing and says "The note changed; reopen".
- `writer git:resolve` goes through the running app when it has the vault open (its editors are told, its write lock held), headless otherwise.
- "Cancel" keeps the file conflicted, and sync stays paused for it.

The note on disk keeps mine until Save; it never contains conflict markers.

## LFS

Off by default (hosting can cost money). When on and `git-lfs` is installed, files above the threshold are tracked through a managed block in `.gitattributes` (the same markers). When `git-lfs` is missing, the setting is disabled with "Install git-lfs to use this".

### Built (2026-11-20, phase 5)

In code and tested against a fake `git-lfs` and, where it is installed, the real one (the real-tool test skips without it); not run against a real remote or in a real window.

- **Settings** `git.lfs` (off) and `git.lfs-threshold-mb` (100) are one row in Advanced ("Large files (LFS) [ ] over [100] MB", `features/git/web/components/lfs-row.tsx`); the switch is disabled with "Install git-lfs to use this" when `git-lfs` is not found. `git-lfs` is found like `git` is: the user's login shell (`plugin_env::which`), cached for a minute (`Vaults::lfs_available`, refreshed when the page opens). What applies is `git::Lfs { enabled: on && installed, threshold }`, passed to the engine by the caller (the app's runtime from the settings, the CLI from the settings file); the engine never reads settings.
- **One pattern rule: per file.** A file that crosses the threshold gets its own line in the managed block of `.gitattributes`: its exact path, anchored with `/`, glob characters escaped, quoted when it holds a space (`"/my clip.mov" filter=lfs diff=lfs merge=lfs -text`). A per-extension rule would pull every small file of that extension into LFS and make "above the threshold" false. A file once in LFS stays (its line stays while the file exists); lines of files that are gone are dropped when the block is next written, in the commit that adds the next file. Written in the same commit as the pointer, sorted, idempotent, the user's own lines untouched (`git/lfs.rs` over the generalised splice `ignore::replace_block`, one code for both blocks). Two devices that each change the block merge by the union of its lines (the block stands for itself as one line while the rest of the file is merged as text, so a line either side added outside the block is kept and a true overlap outside it is a normal conflict). Only the block change is committed on top of the version in the commit (HEAD's, or the user's own edit when it is part of the commit): other unsaved edits of `.gitattributes` stay pending; a line stays while its file exists or its pointer is still in HEAD.
- **Pointers are written in-process, not through `git lfs clean`.** The format is three fixed lines and the store is `.git/lfs/objects/<aa>/<bb>/<oid>`: a commit streams the file through sha-256 (the `sha2` the app has) into the store (written under a temp name, renamed), then commits the pointer blob with the index entry carrying the real file's stat. This keeps recording a version independent of `git-lfs` (and of a child per file in the commit path) and needs no scope; `git-lfs` is used only to move objects. Rule for a file, in order: a file on disk that is itself a pointer (never downloaded) is committed as it is; one whose HEAD version is a pointer stays in LFS whatever the setting says (a moved file takes its source's version, and a delete plus an add of the same content is paired into a move _before_ the size limit is asked, comparing sizes first and hashing only a same-size candidate); one that any `.gitattributes` rule covers (the user's own `*.psd filter=lfs`, read through gix's attribute stack, or Writer's block) is a pointer whatever its size, so git's own clean filter agrees, and is never "Not versioned"; any other file is a pointer when LFS is enabled and it is above the threshold, and gets its line in the block. The object store is `<common git dir>/lfs` (a linked worktree uses the main repository's), written under a temp name in `lfs/tmp` and renamed; an object already there is not copied again.
- **`git lfs install --local`** runs once per vault (skipped when the repository's config already has `[filter "lfs"]`) before the first commit and sync with LFS on: filters and hooks in the repository's own config for the user's own git; nothing global.
- **gix never runs the LFS filter.** gix's status would start the repository's `filter.lfs` driver (`git-lfs filter-process`) itself, a child outside the feature's scope; files whose index entry is a pointer are excluded from gix's status (`:(top,literal,exclude)` pathspecs, chosen by the `filter` attribute, only looked for when some `.gitattributes` or `info/attributes` names `filter=lfs`) and compared by Writer against their pointer (size and time first, a hash only when they moved). Status, commit, merge and restore never start `git-lfs` except through `Exec`.
- **Sync.** Before the working tree follows a fetch, the large files it adds or changes whose object is missing are downloaded (`git lfs fetch origin <remote branch>`, through `Exec` and the same credential helper) so the files written are real; with `git-lfs` missing the pointers are written as they are. Files are then written from pointers as streams (compared by pointer, copied from the store through a temp file under `lfs/tmp`, the target confined to the vault, announced to the editors), never held in memory. One best-effort catch-up after every sync downloads what is still a pointer on disk; a failure is logged and the files are listed in the report (`lfs_missing`, `writer git:sync` prints them), it never stops the sync or the push. Before a push the local store's objects go first (`git lfs push origin <branch>`); with a local store and no `git-lfs` the push stops with "Install git-lfs to sync large files" rather than send pointers without their objects. LFS content moves whenever `git-lfs` is installed, whatever the setting says. Every `git lfs` call pins the server to the remote's own (`-c lfs.url` and `lfs.pushurl`, derived from an HTTPS remote the way git-lfs derives it), so a `.lfsconfig` in the vault cannot send the credentials elsewhere; SSH and `file://` remotes pin nothing. `git-lfs`'s folder (found once per runner, login shell included) is on every child's `PATH`, so git's own `pre-push` hook finds it. **The repository lock is let go for the transfers** (they only append to the object store, and can take minutes): the sync re-reads the repository afterwards and runs the round again when a commit landed meanwhile; a pre-turn commit waits for the next pass only while a sync holds the lock for a replay or write. A transfer error is one line, "Large file transfer failed" (or the same Auth / Offline lines as git's), with the sanitized output under Details; the status is Syncing during transfers, the transfer timeout is 30 minutes (close-time sync keeps its short cap).
- **Merge.** An LFS pointer is binary for the merge: two versions of a large file keep both (the remote's at the path, mine beside it), like any binary.
- **History, diff, restore.** A large file has no line counts and diffs as its two sizes (from the pointers, whether or not the object is on this device: no object is read for a list or a diff). Restore of an LFS file copies the object from the store as a stream and commits a new pointer; it refuses ("This large file is not downloaded here") rather than write a pointer over the file, and refuses ("Turn on large files (LFS) to restore this file") a file that would then be left out as too large, instead of reporting "no new version". The history text view (`git:show`) reads the object.
- **Turning LFS off later** adds nothing new (a new large file is "Not versioned: too large"), leaves existing LFS files, `.gitattributes` and history as they are, and keeps committing edits to a file already in LFS as pointers. The panel shows "Large files (LFS): n" (files whose HEAD version is a pointer and named by the managed block).
- **CLI.** `writer git:status` prints `lfs: on|off, n files in LFS` and `not versioned (too large): <path>` lines; json has `lfs: { enabled, installed, files }` and `tooLarge`. `git:commit`, `git:sync` and `git:restore` use the settings file's values. The `writer-git` skill (bundle v27) describes large files.
- **Limits.** A user's own LFS rules are honoured when committing (pointers, never "Not versioned") but their files are not counted in the panel (it counts the managed block's files). A restore of a text large file shown with `git:show` reads it whole. LFS locks and `.lfsconfig` are not read by Writer (git-lfs reads `.lfsconfig` itself, with the server pinned as above). The credential helper's host binding to the origin host for LFS requests is part of the credential-helper fixes (worktree `git-fixes-34`) and is to be checked after they land.

## History

Designed with the user on 2026-11-20.

### Built (2026-11-20)

The engine reads through gix in `git/repo.rs` (`file_versions` follows a file through renames: the `Writer-Move-From:` / `Writer-Move-To:` trailer pair (percent-encoded paths, so arrows and double spaces in names survive) Writer puts on commits that move files first, git's rename detection otherwise; `deleted_files`, `blob`, `resolve`), `git/history.rs` builds on them (`versions` with line counts, `diff` against parent, current or another version, `restore`), the commands are `plugin:git|git_history`, `git_deleted`, `git_version_diff`, `git_version_text`, `git_restore`, `git_stop`. The web half is the page kind `git-history` (core, `feature: "git"`, view in the slot `page-view:git-history`), `features/git/web/components/history-page.tsx` and `version-detail.tsx`, the pure grouping in `web/lib/history.ts`, and core's one diff component `src/components/diff/` (`TextDiffView`: rendered note, property rows, Source toggle, Formatting only; the agent's Changes card renders through it too, with git off). Cooperation: git `provides` `git.history` (a service: open a file's history) and `uses` `agent.chats` (a service the agent now provides: "Open chat" on an agent version, hidden while the agent is off). The Changes card's "View in history" goes through the same service (the agent `uses` `git.history`): `commitForTurn({chatId, turnId, finishedAt})` finds the turn's commit by the `Writer-Chat` and `Writer-Turn` trailers and answers `{rev, settled}` (`settled`: found, or git committed past the turn without one, so the card drops its `onCommit` listener and asks no more), `onCommit` tells the card to ask again, `openHistory(path, {rev})` opens the tab; with git off or the vault not set up the card shows no link. A deleted file's row in the Versions panel has Show history in its right-click menu.

Writer's own moves: a `user(move)` commit records `Writer-Move`, so a file that was moved and edited keeps its history; `relocate` itself stays unaware of git, so a move-with-edit that Writer's relocate did not commit as one move relies on git's similarity detection.

### Where

- One **History tab** per file: page kind `git-history`, a normal tab (back/forward, split, middle-click).
- Opened by "Show history" from the tab menu, the file tree menu (files and deleted entries) and the palette, and from an agent Changes card (below).
- Left: the version list. Right: the selected version.
- Header of the selected version: date, time, device or agent badge, message, then actions: **Restore**, **Copy**, **Open** (the version read-only in a tab), **Open chat** (agent versions).

### List

- Grouped by day ("Today", "Yesterday", then dates).
- A burst folds into one entry: consecutive versions from the same author (device or chat) less than 15 min apart, "14:02–14:32 · 6 saves", expandable. Nothing is hidden, only folded.
- Each entry is labelled with who changed it: the device name for automatic commits, an agent badge and the chat title for agent turns, the message for manual commits. Each also shows its +/- line counts.
- History follows renames and moves (Writer records them through `relocate`; for others, git's rename detection on the commit). Older entries show the old name.
- **Deleted notes**: the panel has a "Deleted" section listing files removed from the vault. Each opens its History tab, and the last version can be restored.

### Diff

- Selecting a version shows **what changed in that version**: that version against the file's previous version. "Compare with current" switches to that version against the file now (what Restore would change). Shift-click a second entry to compare any two.
- **Notes** are shown rendered, like the editor (headings, lists, links, embeds as their labels), with insertions underlined in the success colour and deletions struck in the danger colour. Word-level within a paragraph, unchanged blocks folded.
- **Front matter** changes show as property rows above the body (name, old → new, added, removed).
- A **Source** toggle switches to the raw line diff. A version whose only change is formatting (whitespace, line breaks) says "Formatting only" and offers the toggle.
- Other text files (`.base`, `.canvas`, `.excalidraw`, JSON, code) always show the line diff. Images show before and after side by side; other binaries show their sizes.
- **One diff component** serves the History tab and the agent's Changes card: a rendered-with-marks view over the shared text diff (`src-tauri/src/text_diff/`: `lines.rs` the Myers core moved from `agent/line_diff.rs`, `words.rs`, `note.rs`; the lint engine uses the same core), with the Source toggle. The card's current line view becomes its Source mode.

### Restore

- "Restore" writes that version back as a new change through the one write path, committed as "Restore <file> to <date time>". History is never rewritten.
- For a deleted file, the file is recreated at its last path (or a free name beside it).

### With the agent

- Each agent turn that changed files is its own commit, `agent(<kind>): <chat title>` with the trailers `Writer-Chat:` and `Writer-Agent:` (see Cadence), so history shows it with an agent badge. The user's pending edits are committed just before the turn starts. A file the user also edited during the turn goes into the agent's commit when the agent touched it; otherwise into the user's next commit.
- The Changes card gets "View in history" (opens the History tab on that commit). The history entry gets "Open chat".
- The card's Undo stays as today (in-memory, this session).
- **Shell-command changes get a diff.** Git contributes to the agent's provider point `agent.turn-baseline` (contract in `agent/api.rs`; ADR 2026-11-23): "this file as it was when the turn started". At `agent.turn-started`, after the user's pending edits are committed, git notes per chat (memory only) the HEAD commit and the paths still not in it (`git/baseline.rs`: skipped large files, ignored or held-back files, a turn of another chat running). It answers for a path only when it can vouch: a note exists, the path is not in the not-committed set, not under `node_modules` or a nested repository, and its text in that commit is a UTF-8 text of at most 2 MiB (an LFS file only when its pointer says it fits and the object is local) -> `Text`; or the commit has no such path and git does not ignore it -> `Absent`. Anything else: no answer, and the file stays "listed without a diff". Nothing is noted when the commit before the turn could not run (no identity, a merge, rebase or detached HEAD, a sync holding the repository, history stopped, a vault inside a parent repository). The note is dropped at the chat's next turn, when the vault closes and when git stops (the extension is retracted with the feature's scope). Reads go through `git/repo.rs` on the thread that records the change, never the watcher's or the main thread. A user edit made during the turn is part of the diff, as for files the agent edits (no user commit runs during a turn).
- The agent reads history through `writer git:log path=…`, `writer git:diff path=… [rev=…] [against=parent|current]` and `writer git:show path=… rev=…`. They are MCP read tools, and the managed skill says when to use them ("what changed in X last week", "the version before the agent's edit"). Restoring goes through `writer git:restore path=… rev=…`, a write tool.

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
- `writer git:log path=…`, `writer git:diff path=… [rev=…] [against=parent|current]`, `writer git:show path=… rev=…` (reads) and `writer git:restore path=… rev=…` (writes); see History.
- The managed `writer-cli` skill documents them.
- An agent chat's changes are committed as their own commit when the turn ends, `agent(<kind>): <chat title>` (the Changes card already knows the files).

## Privacy and logging

Log operation names, durations and outcomes only. Never tokens, remote URLs with credentials, file contents or file paths.

## Tests

- **Merge**: property-level front matter, clean adjacent edits, true overlap, delete vs edit, binary keep-both, JSON per key, rename plus edit.
- **Replay**: order and authorship kept, a conflict pauses one file, resume and rollback from the recorded state, remote moved during push.
- **Transport** against a local bare remote: missing git, timeout, auth failure surfaced, PATH fix.
- **Credential helper**: answers from the secret, the `gh` path, never logs.
- **Ignore block**: keeps user lines and is idempotent.
- **LFS** (built, `git/lfs.rs` unit tests, `git/lfs_tests.rs`, `features/git/tests/git-feature.test.tsx`): pointer format and store, the managed `.gitattributes` block (idempotent, user lines kept, patterns agree with `git check-attr`), threshold from the setting, a file over it committed as a pointer with its object stored, off skips as before, push sends objects first and a second clone gets the real content, a file arriving later is written real, two devices adding a large file each, no `git-lfs` stops the push, a sanitized LFS error line, install once, turning off leaves existing files, history sizes and Restore, no LFS child in status or commit, no LFS work when nothing is large.
- **History** (built, `git/tests.rs`, `features/git/tests/git-history.test.tsx`, `tests/text-diff-view.test.tsx`): list grouping (days, bursts of 15 min per author), labels (device, agent badge and chat title), renames followed, deleted files listed and restored; diff of a version against its parent, against current and between two; rendered diff with properties rows and Source toggle, "Formatting only"; restore as a new commit; the agent Changes card and History tab render through the one diff component; `git:log`/`git:diff`/`git:show` read and `git:restore` write over MCP.
- **Scheduler**: debounce, interval, on close, paused while a merge view is open.
- **No remote**: local-only setup from a plain folder, commits on the cadence, no fetch or push attempted, status Local (not Offline or Error), history and restore work, adding a remote later pushes the existing history, removing it returns to Local.
- **CLI**: headless and through the socket.
- **Agent**: the chat commit message.

## Not in scope

Branches other than the current one, pull requests, submodule editing, a Writer-hosted sync service, encrypting the repository, mobile.
