---
status: accepted
date: 2026-11-17
decision-makers: Writer maintainers
---

# Contain feature failures with unwinding panics and recover from native crashes on the next launch

## Context and Problem Statement

Writer now runs first-party code as built-in features (`tables`, `mouse-buttons`, and next the `agent`; see the [built-in features ADR](2026-11-17-build-first-party-features-as-built-in-plugins-with-one-manifest-one-rust-trait-and-one-registry-line.md)). The requirement is that no feature, whatever it does, can take Writer down or leave it in a state the user cannot recover from. Today:

- The release profile in `apps/desktop/src-tauri/Cargo.toml` sets `panic = "abort"` (inherited from upstream's initial commit). Any Rust panic in a feature, in a command, a hook or a thread, kills the app. The features ADR records this and limits release isolation to `Result` errors; its `catch_unwind` guards only work in dev and test.
- A native crash (an Objective-C exception unwinding through `extern "C"`, a segfault in AppKit) cannot be caught in-process under any panic setting. The native mouse monitor aborted the app twice this way ([mouse side buttons ADR](2026-11-17-deliver-mouse-side-buttons-with-a-native-nsevent-monitor.md), spec `SPECs/mouse-side-buttons-spec.md` "Crash").
- In the webview, the TS feature host already wraps `activate` in `try/catch`, but a throwing React contribution or editor extension can still break a whole pane.

## Decision Drivers

- A failing feature must cost that feature only, never the app or the user's unsaved work.
- Whatever cannot be contained in-process must be recovered automatically on the next launch, without the user editing files.
- One guard and one marker mechanism, used by every boundary (DRY), not per-feature handling.
- No new dependency; no note content, paths or secrets in logs ([local logs ADR](2026-11-16-always-write-local-error-logs.md)).
- Small runtime cost: no extra IO on hot paths (per keystroke or per IPC call).

## Considered Options

- A. `panic = "unwind"` in release, `catch_unwind` at every feature boundary, plus next-launch crash markers and a safe mode.
- B. Keep `panic = "abort"`; `Result`-only isolation in-process, and next-launch crash markers and safe mode for every panic and native crash.
- C. Run risky native features in a separate helper process, so even native crashes cannot take the app down.

## Decision Outcome

Chosen option: **A**. It is the only option that keeps the app running through a Rust panic in a feature, and the markers cover what no in-process option can catch. C is rejected for now (helper binary, IPC, lifecycle and signing for one native feature); it stays the escape route if a native feature keeps crashing.

1. **Panic mode**: the release profile uses `panic = "unwind"` (dev and test already do). This supersedes the features ADR's "panic = abort" consequence; the rest of that ADR stands.
2. **One Rust guard**: `features::guard(id, boundary, f)` runs `f` under `std::panic::catch_unwind` (with `AssertUnwindSafe`), turns a panic into an error, logs it once at `error` level with the feature id and boundary name only, marks the feature `failed` for the session, and emits `features:failed { id, boundary }` to the webview. Every feature boundary goes through it: `setup`, `on_workspace_open`, `on_workspace_close`, `on_exit`, every feature command (one wrapper at the command layer, not in each command), and every thread or timer a feature spawns (`features::spawn(id, name, f)`). A failed feature's commands return a typed `FeatureUnavailable` error instead of running. Core code (non-feature) keeps its current error handling.
3. **Crash markers** for what cannot unwind: before a feature runs code that may crash natively or abort (its `setup`, hooks, and calls it declares risky through `features::native(id, f)`), Writer writes the marker `features/inside.json` (`{ "id", "boundary", "pid", "at" }`) in the app data dir, atomically, and removes it after. Startup reads it before features install: a leftover marker from another process means the last run died inside that feature, so Writer sets `features.<id>.enabled = false`, logs it, and shows a notice ("Mouse buttons was turned off after a crash. Turn it back on in Settings > Features."). Long-running native code (the mouse monitor) keeps its marker only around install and uninstall, and records a separate `features/active-native.json` list so a crash while it is live is attributed to it.
4. **Safe mode**: Writer counts startups that did not reach "ready" (a `startup.json` counter reset when the first window finishes loading). Two failed startups in a row start Writer in safe mode: every feature off for that run (core editing, files, settings stay), a banner explains it and offers "Restart normally". Safe mode never rewrites the user's settings; it is a per-run override.
5. **Webview containment**: every UI contribution (pane, dock item, page kind, settings block, menu items) renders inside a per-feature error boundary that shows a small "This feature failed" placeholder with a "Turn off" action; commands, keybindings and menu actions run under the host's `try/catch`; editor extensions are wrapped so an exception in a view plugin or decoration is caught and the extension is dropped for that editor. Three failures of one feature within a session switch it off for the session and show a notice. `features:failed` from Rust does the same for the feature's web half.
6. **Re-enable path**: Settings > Features shows a failed or crash-disabled feature with its last failure (boundary, time) and a "Turn back on" toggle; turning it back on clears the session failure state (web half at once, Rust half after restart, as today).

### Consequences

- Good: a Rust panic in any feature boundary is logged and costs that feature only; the app keeps running in release.
- Good: a native crash in a feature costs one launch at most: the next launch turns that feature off and says so; repeated startup crashes fall back to safe mode, so the app is always recoverable without editing files.
- Good: one guard, one spawn helper, one marker file, one error boundary component; adding a feature adds no isolation code.
- Bad: unwinding adds landing pads and unwind tables; the release binary grows (measured and recorded in this ADR when implemented) and some LTO inlining is lost.
- Bad: `catch_unwind` does not make state consistent: a feature that panicked mid-update may leave its own state half-written; that is why the feature is disabled for the session, not resumed.
- Bad: a panic in core code or in a dependency's own thread outside a feature boundary still ends the process as an unhandled thread panic would; the markers and safe mode are the recovery there.
- Neutral: Writer diverges from upstream's `panic = "abort"`; a future upstream merge must keep `unwind`.

### Non-goals

- Running first-party features in a sandbox or a separate process (option C), for now.
- Changing community plugin isolation: the [trust ADR](2026-11-13-trust-vaults-before-running-plugins-no-in-page-sandbox.md) still governs Obsidian plugins.
- Uploading crashes anywhere (no telemetry change); everything stays in the local log.
- Catching native crashes in-process.

## Implementation Plan

- **Affected paths**:
  - `apps/desktop/src-tauri/Cargo.toml`: `[profile.release] panic = "unwind"`.
  - `apps/desktop/src-tauri/src/features/mod.rs`: `guard`, `spawn`, `native`, failure state per feature, `FeatureUnavailable` error, the `features:failed` event; the runner calls hooks only through `guard`. Marker and startup-counter IO in a new Tauri-free `features/recovery.rs` (atomic write, read, clear; pure decision function `recover(marker, counter, settings) -> Plan`).
  - `apps/desktop/src-tauri/src/lib.rs`: read recovery state before `features::install`; mark "ready" when the first window finishes loading; safe-mode override passed to `install`.
  - `apps/desktop/src-tauri/src/error.rs`: the `FeatureUnavailable` variant.
  - `apps/desktop/features/mouse-buttons/rust/`: monitor install and uninstall through `features::native`, its thread through `features::spawn`.
  - `apps/desktop/src/lib/features/`: error boundary component, wrapping of commands, keybindings, menus and editor extensions, failure counter, listener for `features:failed`, notice and safe-mode banner.
  - Settings > Features section: failure display and re-enable toggle.
  - `SPECs/builtin-plugins-spec.md`: a "Failure containment and recovery" section; `docs/decisions/README.md` index; the features ADR gains a dated note pointing here.
- **Patterns to follow**: every boundary through the one guard (no per-feature `catch_unwind`); recovery logic pure and Tauri-free, IO at the edges; log feature id and boundary only; settings writes through the one settings write path; safe mode as a per-run override, never a settings rewrite.
- **Patterns to avoid**: `catch_unwind` scattered in feature code; logging panic payloads that may contain note text or paths verbatim (log the payload through the existing redaction, capped); IO in hot paths (markers only around setup, hooks and declared native calls, never per IPC call); resuming a feature after it panicked in the same session.
- **Tests**:
  - Rust: a test-only fixture feature that panics in `setup`, in each hook, in a command and in a spawned thread; each case leaves the app (mock runtime) running, the feature `failed`, other features untouched, one error log line, and `features:failed` emitted; a failed feature's command returns `FeatureUnavailable`.
  - Rust, pure `recover`: stale marker from another pid disables that feature; own-pid or absent marker does nothing; two failed startups give safe mode; a successful startup resets the counter; a corrupt marker file is ignored with a warning.
  - A release-profile check that `catch_unwind` catches (a `#[test]` run in CI with `--release`, which now unwinds).
  - TS: a contribution that throws renders the placeholder and the rest of the pane works; a throwing command, keybinding, menu item and editor extension are contained; three failures switch the feature off; `features:failed` switches the web half off.
- **Measure**: release binary size before and after the profile change, recorded under "More Information".

### Verification

- [ ] `[profile.release]` has `panic = "unwind"` and `cargo test --release` passes, including the guard tests.
- [ ] A forced panic in a feature's setup, hooks, command and thread leaves the app running with only that feature off (mock-runtime tests).
- [ ] A stale marker disables its feature on the next launch and the notice appears (pure test plus one e2e or manual check in a real window).
- [ ] Two failed startups in a row start in safe mode; "Restart normally" leaves safe mode.
- [ ] A throwing web contribution is contained by its error boundary; three failures switch the feature off for the session.
- [ ] No log line contains note text, a vault path or a secret (log assertions in the tests).
- [ ] Release binary size before and after is recorded here.

## Pros and Cons of the Options

### A. Unwind and guard, plus markers and safe mode

- Good, because Rust panics are survived live, and native crashes are recovered next launch.
- Bad, because of binary size and the upstream divergence.

### B. Keep abort, markers and safe mode only

- Good, because nothing changes in the build and the binary stays smallest.
- Bad, because every Rust panic in a feature still kills the app and loses whatever the user had not saved; recovery only happens after the crash.

### C. Separate helper process for risky native features

- Good, because even native crashes cannot take the app down.
- Bad, because it needs a second binary, IPC, process lifecycle, code signing and notarisation of the helper, for one feature today; and it does nothing for Rust panics in in-process features.

## More Information

Spec: [`SPECs/builtin-plugins-spec.md`](../../SPECs/builtin-plugins-spec.md) (section to add: "Failure containment and recovery"). Partly supersedes the "panic = abort" consequence of the [built-in features ADR](2026-11-17-build-first-party-features-as-built-in-plugins-with-one-manifest-one-rust-trait-and-one-registry-line.md). Related: [mouse side buttons](2026-11-17-deliver-mouse-side-buttons-with-a-native-nsevent-monitor.md), [always write local error logs](2026-11-16-always-write-local-error-logs.md). Revisit if a native feature crashes repeatedly in the field (then consider option C for it), or if the binary size growth exceeds 15%.

2026-11-17, implementation note. Release binary (`cargo build --release` in `apps/desktop/src-tauri`, `target/release/desktop`, not `tauri build`): **12,070,864 bytes before** (`panic = "abort"`, clean tree at `59172ab`) and **15,955,104 bytes after** (`panic = "unwind"` plus the containment code, the removal of the mouse monitor and its `block2` dependency, and the recovery commands): **+3,884,240 bytes, +32%**. That is above the 15% revisit threshold named above; the split between unwind tables, lost LTO inlining and the new code was not measured separately (one build each), so the revisit is open. The pilot `mouse-buttons` feature and its native monitor were removed the same day ([ADR](2026-11-17-remove-the-mouse-buttons-feature-and-its-native-monitor.md)); `features::native` and the crash markers stay as generic machinery, tested with fixture features, with no feature using them today. A panic inside an `async` command body is caught by the async runtime, not by the one command wrapper (`features::contain`, which sees the synchronous part); the spec "Failure containment and recovery" lists this and the other limits.
