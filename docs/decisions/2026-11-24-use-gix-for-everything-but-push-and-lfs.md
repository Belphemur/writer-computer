---
status: accepted
date: 2026-11-24
decision-makers: Writer maintainers, the user
---

# Use gix for every git call except push and LFS

## Context and Problem Statement

[ADR 2026-11-18](2026-11-18-sync-vaults-with-a-built-in-git-feature-rust-merge-and-system-git-transport.md) put reading and writing the repository on `gix` and everything that touches the network, the config, identity and signing on the system `git`. The user asked (2026-11-24) to do as much as possible with gix and the rest with git. Checked on docs.rs and in gitoxide's crate status: gix 0.91 has no push and no LFS (push is on gitoxide's 1.0 roadmap). It has fetch, remote and config editing, identity resolution and commit signing. gix 0.91 has already landed (7bb6c030); `jiff` 1.x, which it pulls in, is accepted.

Which calls move to gix, which stay on `git`, and how do we keep the behaviour users rely on (their config, credentials, SSH, signers)?

## Decision Drivers

- Fewer child processes and no output parsing; works with no `git` installed for what gix can do.
- The user's git setup keeps working: config, `insteadOf`, helpers, SSH agent, signing programs.
- A failed step never loses a change; signing and network calls stay bounded and cancelable.
- Credentials never in argv, logs or events; one `Kind` table and one sanitizer for errors.
- DRY: one source for config reads, one write path for `.git/config`.

## Considered Options

- A. Keep `git` for transport, config, identity and signing (today).
- B. gix for everything gix can do; `git` for push and LFS only (chosen).
- C. Write our own push and LFS transfer in Rust.

## Decision Outcome

Chosen option: **B**, because it removes most child processes while the two things gix cannot do keep their proven path.

Sub-choices:

- **TLS**: gix feature `blocking-http-transport-reqwest`, on Writer's reqwest with rustls and the `ring` provider. Not `-rust-tls` (it pulls aws-lc-rs), not curl or OpenSSL. One `crate::tls::ensure_provider()` replaces the four copies of the provider install (`plugin_http.rs`, `telemetry.rs`, `plugin_store.rs`, `attachments.rs`).
- **Signing**: gix resolves the options; Writer runs the signer itself through `Exec` (scope, timeout, kill on feature off, logging), not `Commit::sign`.
- **Clone**: `init` + remote + Writer's own sync, not gix's checkout (it runs filter drivers and writes outside Writer's confinement).

gix features: `sha1`, `status`, `blocking-http-transport-reqwest`, `progress-tree` (optional, for clone). Not `worktree-mutation`.

### Inventory

| Call today                                                                                 | Replacement                                                                                                         |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `git remote get-url origin`                                                                | `find_remote("origin")` and `url(Fetch)` (applies `insteadOf`), then `transport::sanitize`                          |
| `git remote add` / `set-url`                                                               | new `git/config_write.rs`: load `.git/config` without includes, edit, write through a lock file and rename          |
| `git config --local k v` (branch tracking, `commit.gpgsign`)                               | `config_write::set_local`, same path                                                                                |
| `git remote remove origin`                                                                 | `config_write::remove_remote`: section, `branch.*` keys pointing at origin, `refs/remotes/origin/*` in one ref edit |
| `check_reachable` (`ls-remote`)                                                            | deleted, it is dead code                                                                                            |
| `git fetch --no-tags --no-write-fetch-head origin +refs/heads/<b>:refs/remotes/origin/<b>` | `git/net.rs::fetch_branch`                                                                                          |
| `git config --get commit.gpgsign` and signing keys                                         | `config_snapshot()` reads (never `commit_signing_options` here, it runs `defaultKeyCommand`)                        |
| `git commit-tree -S`                                                                       | build the commit, resolve options with gix, run the signer through `Exec`, `write_object`                           |
| `git cat-file commit` (same identities)                                                    | deleted; name and email checked for `<`, `>`, newline                                                               |
| `git var GIT_AUTHOR_IDENT` / `GIT_COMMITTER_IDENT`                                         | `Repo::identities_via_gix`; `git/system.rs` deleted                                                                 |
| `git push`, `git lfs install`, `lfs fetch`, `lfs push`                                     | stay on `git`                                                                                                       |
| `git --version` (is git installed)                                                         | stays                                                                                                               |

### Fidelity rules

- **Config**: gix reads system, global, XDG, repo, `include` and `includeIf`. When a real git is found (never the macOS `/usr/bin/git` stub) set `Permissions.config.git_binary` so its installation config applies (Apple's `credential.helper=osxkeychain`); it runs `git config -lz --show-origin` once per process. Keep the `includeIf` symlink retry. Open with `bail_if_untrusted(true)` (`safe.directory`). `.git/config` is loaded without includes for writing and never touches the global config.
- **HTTP options**: from `repo.transport_options(url, Some("origin"))`. gix's reqwest backend applies only headers and redirects, so Writer maps `http.proxy`, `no_proxy`, `http.sslCAInfo`, `http.sslVerify`, the user agent and the timeout through `configure_client`.
- **Credentials** (refines point 3 of the 2026-11-18 ADR): with a Writer credential (token, `gh`, `fj`), answer in process through `Connection::with_credentials`, using the existing `credential::answer`; `store` and `erase` do nothing; no helper child, the user's helpers are not asked. Without one, run the user's helpers from `credential_helpers(url)` through `Exec` (scope, timeout, `GCM_INTERACTIVE=never`); fallback is gix's cascade with prompts disabled. Never prompt.
- **SSH**: gix spawns `ssh` with the app's environment, so `SSH_AUTH_SOCK`, `~/.ssh/config` and an `IdentityAgent` (1Password) apply. `core.sshCommand` and `GIT_SSH_COMMAND` are handled by gix. It is killed on drop.
- **Fetch**: single branch, `Tags::None`, refspec replaced in memory, no `FETCH_HEAD`, no prune. `sync.rs` relies only on `refs/remotes/origin/<b>` and `BranchMissing` (`is_missing_required_mapping`). gix does no `gc --auto`, so after a fetch count packs and above 50 run `git maintenance run --auto` through `Exec` if git exists, else log a warning.
- **Signing argv**, byte for byte as gix-object builds it. OpenPGP and X.509: `<program> [args] --status-fd=2 -bsau <key>`, the commit without `gpgsig` on stdin, armored signature on stdout, stderr must contain `[GNUPG:] SIG_CREATED `. SSH: `<program> [args] -Y sign -n git -f <keyfile> [-U] <payload-tmpfile>`, signature read from `<tmpfile>.sig`; a literal key goes to a 0600 temp file with `-U`. `\r\n` folded. The header is `gpgsig` (`gpgsig-sha256` for sha256) after the committer, replacing any existing one. Writer reads no key material. A parity test makes the object id equal to `Commit::sign`'s.
- **Identity**: gix env overrides, `EMAIL`, `author.*`, `committer.*`, `user.*`. No answer means no guess (`useConfigOnly`). The test `identity_matches_git_var` stays.
- **Timeouts and cancel**: a `net::Ctx { exec, interrupt, budget }`; a watchdog polls the scope token and the `Exec` deadline every 100 ms and sets the interrupt; reqwest gets the timeout. `FETCH_TIMEOUT` (120 s) and the close deadline are unchanged. Log one line on target `git` ("gix fetch ok in N ms" or "gix fetch failed: <redacted>"), never the URL.
- **Errors**: `transport::classify` splits into `classify_text` (today's needle table, used for git output) and `classify_gix` (io error kinds, HTTP 401/403 Auth, 404 NotFound, connect and timeout Offline, else the text). One `Kind` table, one sanitizer. A missing `git-upload-pack` is `Kind::NoGit`.

### The seam

No trait. `transport::Transport` stays the facade with the same public methods, so `sync.rs`, `signin.rs` and `commands.rs` do not change. Files: `transport.rs` (facade, `Kind`, `classify*`, `sanitize`), `exec.rs` (moved out unchanged), `net.rs` (new), `config_write.rs` (new), `signing.rs`, `clone.rs` (new, ADR 2026-11-24 start a workspace from a git repository), `src/tls.rs` (new), `system.rs` deleted.

### Child processes outside Writer's `Exec`

gix starts these itself: `ssh`; `git-upload-pack` (for `file://` and path remotes); the fallback credential helpers; `gpg.ssh.defaultKeyCommand` (only if `commit_signing_options` is called, which we avoid). The escape-hatch scan is textual and does not see them; this ADR is where they are recorded. The watchdog and drop kill them.

### Unsupported

`http.sslCert` and `http.sslKey` (client certificates), `http.cookieFile`, `http.version`, and the macOS system proxy. A remote that needs one of these cannot sync; the error says so.

### With no git installed

Works: local history, identity, signing, fetch and replay over HTTPS and SSH, clone over HTTPS and SSH, Writer credentials. Needs git: push, LFS, `file://` and path remotes, the user's osxkeychain helper. Words: push "Install git to push"; LFS "Install git to sync large files"; folder remote "Install git to use a folder remote"; status "Pending n" (`NoGit` is treated like `LocalNetwork`, a notice); Settings > Git remote row "Fetch only: install git to push"; pointers "Large files not downloaded (n)".

### Consequences

- Good, because fetch, clone, config, identity and signing work with no `git` binary, with fewer children and no output parsing.
- Good, because one config source (gix) for identity, signing and HTTP options.
- Bad, because two transports remain until gix ships push.
- Bad, because some `http.*` keys are unsupported (above) and Writer maps others by hand.
- Bad, because gix's own children sit outside `Exec`'s scope.
- Bad, because no `gc --auto` (mitigated by the pack count).
- Neutral, because MSRV is 1.95 and `jiff` 1.x sits beside 0.2 in the lock.

### Risks and mitigations

| Risk                                  | Mitigation                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| `config_write` corrupts `.git/config` | no-includes load, lock then rename, re-read with git in tests, never the global config |
| `remove_remote` leaves leftovers      | mirror git: branch keys and `refs/remotes/origin/*`                                    |
| Signer outside scope, argv drift      | signer through `Exec`; byte parity test; `git verify-commit`                           |
| Hung ssh or helper                    | watchdog; ssh killed on drop; helpers through `Exec`                                   |
| reqwest ignores `http.*`              | `configure_client` mapping with tests                                                  |
| No osxkeychain helper                 | `git_binary` when a real git exists                                                    |
| Reduced-trust repository              | `bail_if_untrusted(true)`                                                              |
| No ring provider                      | `tls::ensure_provider()` everywhere, a TLS test                                        |
| Name or email with `<`, `>`, newline  | validate before `write_object`                                                         |
| Missing branch vs empty remote        | `is_missing_required_mapping`, tested both ways                                        |

## Implementation Plan

- **Affected paths**: `apps/desktop/src-tauri/src/git/` (`transport.rs`, `net.rs`, `config_write.rs`, `exec.rs`, `signing.rs`, `repo.rs`, `clone.rs`, tests), `src/tls.rs` and its four call sites, `features/git/rust/` (`sync.rs`, `runtime.rs`, the NoGit notice), `Cargo.toml` (gix features only; no new crate outside the gix tree), `SPECs/git-sync-spec.md`.
- **Dependencies**: gix feature `blocking-http-transport-reqwest` (and `progress-tree`). Confirm with `cargo tree -e features -i gix`: expected new crates are gix-credentials, gix-prompt, gix-negotiate; no third-party crate.
- **Patterns to follow**: `Exec` for every child; `credential::answer`; the one `Kind` table; the re-exec test pattern (`git/tests.rs` `engine_identity`) generalised to `git/test_child.rs::in_child(test_name, env, args)`.
- **Patterns to avoid**: `Commit::sign` in production; gix checkout for clone; prompting; logging a URL; a second `.git/config` write path; calling `commit_signing_options` where `defaultKeyCommand` could run unasked.
- **Migration steps** (lanes; {1, 2} first, then 3, then 4):
  1. **Lane 1, local calls**: `config_write.rs`, remote methods in `transport.rs`, delete `check_reachable`, `config_local` and `system.rs`, identities through gix, `test_child.rs`.
  2. **Lane 2, signing**: `signing.rs` rewrite (mode, key checks, `sign_commit`), `repo.rs` commit and `write_commit`, `signing_tests.rs`; rewrite the spec's Signing paragraph. Parallel with Lane 1; afterwards `signing.rs::set_local` moves onto `config_write`.
  3. **Lane 3, fetch**: gix feature, `tls.rs` and call sites, `net.rs`, `Exec` move, fetch and the `classify` split, NoGit notice, `net_tests.rs`. Measure the release binary before and after (gate: at most +3 MB, record it here).
  4. **Lane 4, clone engine**: see ADR 2026-11-24 start a workspace from a git repository. Needs Lanes 1 and 3.

### Verification

- [ ] Fetch parity against `git fetch` with the same arguments: refs equal, no `FETCH_HEAD`, no tags; a missing branch and an empty remote give `BranchMissing`; `insteadOf` applies; a `file://` remote without git gives `NoGit`.
- [ ] HTTP tests (a local server in front of `git http-backend`; skipped without git): Basic auth answered in process with no helper child; a token for another host gives Auth; the fallback helper is used and `credential.helper=` clears it; `http.proxy` is honoured; a stall gives Timeout; scope cancel gives Cancelled.
- [ ] A TLS test with a test-only certificate: https works and `http.sslCAInfo` is honoured.
- [ ] Config parity: after each `config_write` operation `git config --local --list` shows the expected keys and git still parses the file.
- [ ] Signing: fake signer; a throwaway `ssh-keygen` key with `gpg.format=ssh` passes `git verify-commit` and gix `verify_signature`; byte parity with `Commit::sign`; a failing signer makes no commit; a replay re-signs.
- [ ] `identity_matches_git_var` passes.
- [ ] Tests use a temp HOME and XDG dir, `GIT_CONFIG_NOSYSTEM=1`, and only `file://` or `http://127.0.0.1`.
- [ ] Release binary delta is at most +3 MB; `cargo tree -e features -i gix` shows no third-party crate.
- [ ] No `git config`, `git remote`, `git fetch`, `git commit-tree` or `git var` call remains in production code.

## Pros and Cons of the Options

### A. Keep git

- Good, because nothing changes and every user setting applies for free.
- Bad, because a `git` binary is needed for everything, output is parsed, and identity and signing each spawn processes.

### B. gix for what it can do

- Good, because see Consequences; the user asked for it.
- Bad, because fidelity work above and a second transport.

### C. Our own push and LFS

- Good, because one transport.
- Bad, because push and LFS bugs lose or corrupt data; gix will ship push, which would replace our code.

## More Information

Partly supersedes point 2 (Transport) and the "network calls through gix" pattern to avoid of [ADR 2026-11-18](2026-11-18-sync-vaults-with-a-built-in-git-feature-rust-merge-and-system-git-transport.md). Supersedes its 2026-11-20 identity note (git as the source of truth, gix only as fallback) and its 2026-11-23 signing notes ("git signs", "Writer runs no signer itself"): gix resolves identity and signing options, Writer runs the signer. Refines point 3 (Credentials) and point 10 (LFS stays on git). Spec: [`SPECs/git-sync-spec.md`](../../SPECs/git-sync-spec.md). Next: [start a workspace from a git repository](2026-11-24-start-a-workspace-from-a-git-repository.md).

**Revisit when** gix ships push or LFS: move them over and delete the system-git transport.
