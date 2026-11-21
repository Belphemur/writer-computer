# Git sync

Status: **phase 1 implemented** (2026-11-20): local version history only, no remote and no network: setup by default when a vault opens (below; "Local history only" and "Use existing repository" stay as the choices of Settings > Git), the History tab with diffs and Restore (`git:diff`, `git:show`, `git:restore`; the shared text diff `src-tauri/src/text_diff/`), the managed ignore block, the cadence, `type(scope): subject` commit messages with trailers, agent-turn commits through the agent's points, the status item, the panel, Settings > Git (short layout, no remote controls), `writer git:status`, `git:log`, `git:commit` and the `writer-git` skill. Everything else below (remote, sync, merge, merge view, LFS) is designed and **not built**. Decision: [ADR 2026-11-18 sync vaults with a built-in Git feature](../docs/decisions/2026-11-18-sync-vaults-with-a-built-in-git-feature-rust-merge-and-system-git-transport.md) (accepted, phase 1 in code).

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
node_modules/
.DS_Store
Thumbs.db
# writer:end
```

**Never in the middle of an operation.** Writer commits nothing, sets nothing up and restores nothing while the repository has `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge/`, `rebase-apply/` or `BISECT_LOG`, or a detached HEAD (`git::operation`, checked in `auto_setup`, the runtime's `active()` and `Repo::commit` itself, so every path refuses: user, agent, restore, close flush). The status says "Paused: merge in progress" (or rebase, detached HEAD) quietly and the history resumes by itself when the markers go.

**What it leaves out.** A file over 100 MB (the `git.lfs-threshold-mb` default; a constant until LFS exists) is not versioned: the panel lists "Not versioned: too large (n)" with the names on click. A folder with its own `.git` (a nested repository) and any `node_modules` are never walked into. `.obsidian/plugins/*/data.json` stays synced.

**Reading cost.** A version is looked up by its id in that commit alone, falling back to a bounded walk only for an abbreviated id; per-file lists are cached per HEAD; the Deleted list hides protected and device-local paths and shows the 200 newest with "Show more". Restore writes the open tab's unsaved edits first (the normal save), restores, then reloads the tab through the watcher's reload.

Shared Writer config (`.writer/property-types.json`, `.writer/graph.json`, `.writer/icons.json`) and plugins' code and settings in `.obsidian/` are synced.

## When off, and how it cooperates

Git is an optional built-in feature (ADR 2026-11-20 "let features cooperate through owned points, optional services and rare requires"). With `features.git.enabled` off, or on in a vault that is not set up, everything works exactly as before: the agent keeps its in-memory Changes card, diffs and Undo (`agent/changes.rs`, `agent/line_diff.rs`) as the only path, lint, the editor's save path, window close and the CLI are untouched, and no timer runs. Git adds to the agent, never replaces anything of it.

- The agent **owns** two hook points (contract in `agent/api.rs`, registry `features/points.rs`): `agent.turn-started` (the vault root and chat id; emitted from a blocking thread before an idle chat's message is delivered) and `agent.turn-finished` (chat id, title, backend, models, files changed with kind add/edit/delete/move; once per turn, also for a turn with no change and when the process died under it). The agent never knows git exists; with no contributor `emit` returns at once.
- Git **extends** both from its `setup` (`feature.json` `extends`, with an `offNotes` line each for Settings > Features: "Your pending edits won't be saved before an agent turn", "Agent turns won't be saved in history"). The registration is skipped while git or the agent is off, a panic in git's handler fails git only, and git works alone: with the agent off it is the history of the user's edits.
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
- A fetched change to a note that is open in an editor is applied only after the same idle time as lint's fixes (5 s without typing): merged into the editor as one transaction (one undo step, `userEvent: "git.sync"`, caret and selection mapped), never a reload under the user's hands. Closed files are written at once. A true overlap opens the merge view instead.

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

The state before a sync is recorded in `.writer/git/sync-state.json` (device-local). An interrupted sync (crash, quit) resumes from it on the next start or rolls back to the recorded head; the working tree is never left half-replayed.

## Merge

Per file, base / mine / theirs, in `git/merge.rs`:

- **Markdown**:
  - **Front matter**: merged per property. A property changed on one side takes that side. Added on both with the same value merges cleanly; changed on both to different values is a conflict on that property only. Key order follows mine, then theirs' new keys. Formatting stays byte-minimal through the frontmatter patcher (`index/patch.rs`).
  - **Body**: diff3 line merge over the shared line-diff core (`text_diff/lines.rs`, moved from `agent/line_diff.rs`, not copied). Non-overlapping edits, including adjacent lines, merge cleanly.
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
- **LFS**: threshold, and `git-lfs` missing.
- **History** (built, `git/tests.rs`, `features/git/tests/git-history.test.tsx`, `tests/text-diff-view.test.tsx`): list grouping (days, bursts of 15 min per author), labels (device, agent badge and chat title), renames followed, deleted files listed and restored; diff of a version against its parent, against current and between two; rendered diff with properties rows and Source toggle, "Formatting only"; restore as a new commit; the agent Changes card and History tab render through the one diff component; `git:log`/`git:diff`/`git:show` read and `git:restore` write over MCP.
- **Scheduler**: debounce, interval, on close, paused while a merge view is open.
- **No remote**: local-only setup from a plain folder, commits on the cadence, no fetch or push attempted, status Local (not Offline or Error), history and restore work, adding a remote later pushes the existing history, removing it returns to Local.
- **CLI**: headless and through the socket.
- **Agent**: the chat commit message.

## Not in scope

Branches other than the current one, pull requests, submodule editing, a Writer-hosted sync service, encrypting the repository, mobile.
