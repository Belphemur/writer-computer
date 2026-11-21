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

lists the files changed since the last version. `remote: none` is normal: nothing is synced.

```sh
writer git:log path=Notes/Plan.md
```

lists a file's versions, newest first, one per line: the short id, the date (UTC), `type(scope)` and the subject. The type says who: `user` (the person), `agent` (an agent turn, with `[agent claude <model>]`) or `chore` (Writer's own housekeeping). The scope says what: `edit`, `add`, `delete`, `move`, `restore`, `merge`. Add `format=json` for data, `limit=` for more or fewer.

Use it for "what changed in X last week" or "was this edit mine or an agent's".

## Save a version

```sh
writer git:commit
```

commits the pending changes now as a `user(...)` version. Run it only when the user asks to save a version; an agent turn is committed by Writer when it ends.

If a command says version history is not set up, tell the user to choose it in Settings > Git.
