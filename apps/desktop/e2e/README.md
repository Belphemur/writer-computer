# E2E tests

End-to-end tests for the Writer desktop app, driven via WebdriverIO and the
[Choochmeque/tauri-webdriver](https://github.com/Choochmeque/tauri-webdriver)
plugin (the only viable WebDriver path for Tauri v2 on macOS as of April 2026 —
official `tauri-driver` does not support macOS, see
[tauri-apps/tauri#7068](https://github.com/tauri-apps/tauri/issues/7068)).

This setup is **experimental**. The plugin is early-stage; expect rough edges.

## One-time setup

Install the WebDriver intermediary CLI globally:

```sh
cargo install tauri-webdriver --locked
```

Install JS deps from the repo root:

```sh
vp install
```

## Running

From `apps/desktop/e2e/`:

```sh
pnpm run test:e2e
```

This builds the app with `--features e2e` (which embeds the WebDriver server)
and then runs the smoke spec. The first build is slow; incremental rebuilds
are fast.

> The e2e build uses an isolated bundle identifier (`com.writer-computer.e2e`)
> so it does NOT collide with `tauri-plugin-single-instance` from a Writer
> dev or release instance running in another worktree. You can leave your
> normal Writer running.

## What gets tested

`specs/smoke.spec.js` contains two specs:

1. **`mounts the React app`** — waits for the React top-level wrapper
   (`<div class="animate-fade-in">`, present in both the welcome and editor
   branches) to mount. Validates that the WKWebView loads and React renders.

2. **`creates a file and writes hello world via the Tauri IPC bridge`** —
   creates a fresh temp directory on the host, then drives the real Rust IPC
   commands (`create_file`, `write_file`) from inside the WKWebView via
   `window.__TAURI_INTERNALS__.invoke`, and asserts the bytes hit disk.
   Validates JS → IPC bridge → Rust command handler → filesystem end-to-end.
   The temp dir is removed on teardown so no host state leaks between runs.

The point is infrastructure validation, not feature coverage. Both specs are
independent of any restored workspace because the e2e build uses an isolated
bundle identifier (see below).

## Copilot + fake claude spec

`specs/copilot-fake-claude.spec.js` loads the UNMODIFIED obsidian-copilot 4.0.20 in a trusted
scratch vault and drives an Agent Mode turn against a fake `claude` CLI. Copilot is AGPL-3.0, so
it is never committed: `fixtures/copilot-fake-claude/setup.sh` downloads `main.js`,
`manifest.json` and `styles.css` from the official GitHub release into the gitignored
`e2e/.cache/copilot-4.0.20/` (first run needs network).

```sh
# build the e2e app first (see Build flavors), then from apps/desktop/e2e:
sh fixtures/copilot-fake-claude/run.sh        # NODE22_BIN=<node 22 bin dir> if your node is newer
```

`run.sh` builds the vault (fake at `<vault>/.bin/claude`, invocation log next to it), seeds ONLY
`recent_workspaces.json`, `plugins_trust.json` and `plugins_proc_consent.json` in the e2e data
dir (a native consent dialog cannot be driven), exports `WRITER_E2E_*` variables (including
`WRITER_E2E_EXTRA_PATH`, an e2e-feature-only PATH prefix for `plugin_which`), runs wdio, then
checks that no fake claude outlives the app. Without those variables the spec skips itself.

It asserts: Copilot enabled without errors (`window.__writerPluginErrors`, an in-page error
recorder), the host's `data.json` seed (settingsVersion 16, device profile pointing at the fake),
Copilot's stylesheet surviving the sanitizer, `copilot:*` palette commands, Agent Chat in the
right pane on the Claude backend, the load-time probes in the fake's log (`--version`,
`auth status --json`, the idle stream-json probe), a prompt answered with `FAKE-CLAUDE-REPLY`
and the session child's argv, that disabling Copilot stops the session process gracefully,
re-enable plus a live session, and (in `run.sh`) no orphan after the app quits. Not covered:
real `claude`, real LLM chat mode, permission cards, interrupt, SIGKILL escalation.

`specs/copilot-history-and-tabs.spec.js` (same fixture, `SPEC=copilot-history-and-tabs.spec.js`) restarts the app inside the spec (`browser.reloadSession()`) and asserts: Copilot's chat index is persisted and Recent chats list the chat after a restart (A), the chat opens as an editor tab when Copilot's open area is "Editor" (B), "Open chat note" opens the note in the main editor (C), and Copilot's active-note badge follows sidebar navigation (D). `setup.sh` also creates `beta.md` for it.

`specs/copilot-settings-tab.spec.js` reuses the same fixture (`SPEC=copilot-settings-tab.spec.js sh
fixtures/copilot-fake-claude/run.sh`): Settings > Community plugins > Options opens a "Copilot options"
tab that renders Copilot's real settings (tab labels, a non-cramped container), a second click focuses
it, closing it removes the plugin UI, and disabling Copilot leaves "Plugin not loaded". Screenshots go
to `WRITER_E2E_SHOTS` (default `e2e/.cache/shots`).

`specs/copilot-agents-config.spec.js` (`SPEC=copilot-agents-config.spec.js sh fixtures/copilot-fake-claude/run.sh`) is the agent-configuration check: Claude detected at the fake, every agent's **Configure** button opens a dialog that is actually on screen (position, bounds, hit test), Auto-detect / Apply (typed path) / Copy / Sign in for Claude, Auto-detect and a typed off-PATH path for the fake `codex-acp` (its `provenance.json` is read synchronously) and `opencode` (`--version` in `agents-invocations.log`), and `See plans` / `Open Copilot folder` reaching the system. `setup.sh` creates the fakes under `<vault>-agents/{path,typed}/bin (outside the vault, like a real install)` (`fake-agent.sh`; `path/bin` is on the login PATH only for this spec) and `run.sh` exports `WRITER_E2E_OPEN_LOG`: the e2e Rust build appends every `shell.openExternal` / `openPath` / `showItemInFolder` request there instead of opening a browser or Finder (release builds do not contain that code). A `signed-out` marker file next to the fake claude makes `claude auth status` report signed out. Copilot has no Browse/file-picker button, so there is no `WRITER_E2E_PICK_PATH`. The real `claude` on the machine is only touched by Auto-detect (the spec then re-saves the fake). Not covered: real logins, "Managed by Copilot" downloads (unsupported by design).

## Native agent pane + fake claude

`specs/agent-fake-claude.spec.js` drives Writer's own agent pane against `fixtures/agent-fake-claude/fake-claude.cjs`, a stand-in `claude` that replays the captured stream-json sessions in `src-tauri/src/agent/fixtures` (scenario per message with a `[fake:NAME]` keyword: `plain`, `thinking`, `tool-auto`, `permission-allow`, `permission-deny`, `interrupt`, `multi-turn`, `slow`, `crash`, `auth-error`; see the script header). `sh fixtures/agent-fake-claude/run.sh` (from `e2e/`, e2e app already built) builds the scratch vault, seeds the trust and `writer-agent` spawn consent files, puts the fake first on the e2e PATH and checks that no fake outlives the app. The fake's protocol is also checked without the app by `cargo test --test agent_fake_claude`, which reads its output through the production mapper.

## How it works

1. `pnpm run build:app` produces `Writer.app` with the `e2e` Cargo feature,
   which includes `tauri-plugin-webdriver` (an embedded HTTP WebDriver server).
2. `wdio.conf.js` (`onPrepare`) spawns the `tauri-webdriver` intermediary CLI
   on port 4444.
3. WebdriverIO connects to 4444; the intermediary launches `Writer.app` and
   proxies WebDriver commands to the embedded server.
4. The spec runs; afterwards `onComplete` kills the intermediary and the app
   quits.

## Build flavors

- `vp run desktop#dev` and `vp build` are unchanged — no WebDriver server.
- The e2e build invokes
  `cargo tauri build --features e2e --bundles app --config '{"identifier":"com.writer-computer.e2e","bundle":{"createUpdaterArtifacts":false}}'`.
  The overrides:
  - `--bundles app` skips DMG creation.
  - `createUpdaterArtifacts: false` skips updater artifact signing (which
    would otherwise demand `TAURI_SIGNING_PRIVATE_KEY`).
  - `identifier: "com.writer-computer.e2e"` gives the e2e build its own
    `tauri-plugin-single-instance` namespace and its own app data dir
    (`~/Library/Application Support/com.writer-computer.e2e/`). Without this,
    a Writer dev/release instance running in another worktree would intercept
    the launch and the WebDriver plugin would never start.
- **Never enable `--features e2e` for releases shipped to users** — it opens
  an HTTP server on localhost:4445.

## Troubleshooting

- **`ENOENT: tauri-webdriver`** — run `cargo install tauri-webdriver --locked`.
- **Port 4444/4445 in use** — a previous run did not clean up.
  `pkill -f tauri-webdriver` and retry.
- **App binary not found** — run `pnpm run build:app` first (or use
  `pnpm run test:e2e` which chains them).
- **Test hangs at `waitForDisplayed`** — the WKWebView likely did not load.
  Sanity-check that `vp run desktop#dev` still launches the app normally.
