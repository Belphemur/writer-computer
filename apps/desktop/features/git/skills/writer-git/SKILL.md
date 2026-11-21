---
name: writer-git
description: Read a vault's version history and save a version. Use when asked what changed in a note, who or what changed it, or to save the current state as a version.
---

# Version history

Writer saves versions of the vault with Git, locally. The user's edits are committed after a quiet minute, and each agent turn is its own commit. Do not run `git commit` yourself: Writer owns the commits.

## What changed

```sh
writer git:status
```

lists the files changed since the last version. `remote: none` is normal for a vault that is not synced; with a remote it also shows `ahead:` and `behind:` (versions not pushed, versions of the remote not taken in), `conflict:` lines (files the last sync could not settle: their version stays as it is on disk, never with conflict markers) and `held back` plugin settings (they look like they hold a token and are not synced).

```sh
writer git:log path=Notes/Plan.md
```

lists a file's versions, newest first, one per line: the short id, the date (UTC), `type(scope)` and the subject. The type says who: `user` (the person), `agent` (an agent turn, with `[agent claude <model>]`) or `chore` (Writer's own housekeeping). The scope says what: `edit`, `add`, `delete`, `move`, `restore`, `merge`. Add `format=json` for data, `limit=` for more or fewer.

Use it for "what changed in X last week" or "was this edit mine or an agent's". The log follows a file through renames and moves.

```sh
writer git:diff path=Notes/Plan.md rev=3f2a9c1
writer git:diff path=Notes/Plan.md rev=3f2a9c1 against=current
```

shows what a version changed: against the file's previous version (default), against the file now (`against=current`, what a restore would change) or against another version (`against=<id>`). Without `rev` it takes the latest version. Lines start with `+` or `-`; a version that only changed whitespace says "formatting only". Use it for "what did the agent change in this note" and "the version before the agent's edit".

```sh
writer git:show path=Notes/Plan.md rev=3f2a9c1
```

prints the file as it was in that version.

## Restore

```sh
writer git:restore path=Notes/Plan.md rev=3f2a9c1
```

writes that version back as a new change (a `user(restore)` version); history is kept and edits not saved yet are saved first. A deleted file comes back at its path, or beside it under a free name. Run it only when the user asks to go back to an earlier version.

## Save a version

```sh
writer git:commit
```

commits the pending changes now as a `user(...)` version. Run it only when the user asks to save a version; an agent turn is committed by Writer when it ends.

## Sync

```sh
writer git:sync
```

saves a version, fetches the remote, replays the local versions on top of it and pushes. With Writer open the app runs it; otherwise the same engine runs here, and a conflict is reported and left for the app. Without a remote it only saves a version. Run it only when the user asks to sync; Writer syncs by itself after each version and every few minutes.

If a command says version history is not set up, tell the user to choose it in Settings > Git.
