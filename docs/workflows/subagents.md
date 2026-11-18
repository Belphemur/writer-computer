# Sub-agents: how work is delegated

How a lead session (the one the user talks to) splits work across sub-agents in this repo. The character every agent works with is in [`docs/soul.md`](../soul.md).

## Who is who

| Role                  | What it is                                                                  | Does                                                                                                                                                                                                               | Never does                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **Lead**              | The session the user talks to (Opus). The orchestrator.                     | Talks with the user, defines the UX and the decision, writes or updates the spec and the ADR, briefs sub-agents, reviews their reports, runs the final validation, commits, pushes, builds and relaunches the app. | Long implementation work it could delegate; reading big file dumps it only needs a conclusion from.                              |
| **`writer-engineer`** | The implementation sub-agent, `.claude/agents/writer-engineer.md` (Sonnet). | One task end to end: code, tests, spec and CHANGELOG lines, validation, a short report.                                                                                                                            | Git writes (commit, push, stash, reset, rebase), `tauri build`, new dependencies without an explicit go, scope beyond the brief. |
| **Explore**           | A read-only search sub-agent.                                               | Sweeps many files to locate code and returns the conclusion.                                                                                                                                                       | Edits, reviews.                                                                                                                  |
| **Reviewer**          | A fresh sub-agent per persona in [`agent-review.md`](./agent-review.md).    | Reviews a diff with context it did not write.                                                                                                                                                                      | Reviewing its own work.                                                                                                          |

A sub-agent is a separate model run with its own context. It knows only its brief and what it reads; the lead sees only its final report.

## When to delegate

- Delegate implementation that spans several files, needs its own test run, or can run while the lead keeps talking with the user.
- Do it inline when it is a handful of edits whose place is already known (a one-line fix, a doc edit, a commit).
- Never delegate a decision that is the user's: define the UX with the user first (questions with a recommended option), record it (spec, ADR via the `adr-skill`), then delegate the build.

## Before briefing: decide, then write it down

1. Agree the behaviour with the user. For a decision with real alternatives, write the ADR (`docs/decisions/`, the `adr-skill`) and get the user's confirmation before it is accepted.
2. Commit the ADR (or spec) first, so the sub-agent reads the decision from the repo instead of from a paraphrase.

## The brief

A sub-agent has no memory of the conversation, so the brief carries everything:

- **Where to work**: the main checkout, or a named worktree when another agent is editing overlapping files. Say which files or areas another agent owns and must not be touched.
- **The goal and the user's words**, quoted when they matter ("labels only on hover").
- **The source of truth to read**: the ADR, the spec section, related ADRs. "Read it fully: it is the spec."
- **Rules that always apply**: `.agents/skills/engineering-philosophy/SKILL.md` (DRY > SOLID > KISS), `.agents/skills/writer-feature/SKILL.md` for features, `SPECs/link-activation-spec.md` for anything clickable, import aliases, privacy (no note contents or paths in logs), terse UI text, no commit/push/build, no new dependency without the user's go.
- **What is known and ruled out**, so it does not redo the lead's investigation; and suspected causes to check for a bug, without asserting them.
- **Tests expected** and the validation commands, plus the list of known flaky tests.
- **The report**: files, design choices (which principle won where), deviations, what only a real window can verify, open questions.

## Running several at once

- Independent lanes run in parallel. Overlapping lanes either share one agent (send it the follow-up) or get separate worktrees (`git worktree add -b <lane> .claude/worktrees/<lane> <base>`).
- Follow-ups from the user mid-task go to the running agent (`SendMessage`), not to a second agent on the same files.
- A sub-agent never repeats work another one owns.

## After the report

1. Read the report critically: deviations, duplicated code, scope creep, a claim not backed by a test. Fix or send it back.
2. Run the validation on the combined tree (`vp check`, `vp test run`, `cargo test`, `cargo fmt --check`), rebasing a worktree lane onto the branch first.
3. One signed, conventional commit per finished task (`git commit -S`), ending with the `Co-Authored-By` line; push to `origin` only.
4. Build and relaunch the app only when the user allows it (they may be using it).
5. Tell the user, in plain words: what changed, what was tested, what only the real app can show, and any open question.

## Tests and the real CLI

Agent-pane tests use the fake `claude` and the goldens. The real `claude` CLI may be run only inside a temporary directory, to record real stream shapes as sanitized fixtures; never in the user's vault, and never reading `~/.claude`.
