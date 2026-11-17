# Built-in plugins: Step 0 spike report

Date: 2026-11-17. Status: spike complete. Prototype is throwaway and lives only in this worktree (`apps/desktop/src-tauri/src/features/spike_hello/`, `src/lib/spike-features/`). Spec: [`builtin-plugins-spec.md`](./builtin-plugins-spec.md). ADR: `docs/decisions/2026-11-17-build-first-party-features-as-built-in-plugins-...md`.

## Verdict

| #   | Question                                                  | Verdict                                  |
| --- | --------------------------------------------------------- | ---------------------------------------- |
| 1   | Inlined Tauri plugin per feature (routing, ACL)           | **GO**                                   |
| 2   | Capability pattern, file-touch count                      | **GO** (with a 25-line `build.rs` merge) |
| 3   | `app.plugin()` in `setup`, lazy init, disabled = rejected | **GO** (restart-scoped kill switch)      |
| 4   | Frontend contract, event names                            | **GO** (two naming rules to fix in spec) |
| 5   | Evidence                                                  | below                                    |

Overall: **GO** for Step 1 as planned. The central `invoke_handler!` fallback is not needed. Four spec corrections come out of it (section "Spec corrections").

## Versions (Cargo.lock, unchanged by the spike)

```
tauri v2.11.2   tauri-build v2.6.2   tauri-utils v2.9.2   tauri-runtime v2.11.2
```

(The spec cites tauri 2.12.5 / tauri-build 2.7.4 source; those are in the registry but the lockfile resolves 2.11.2 / 2.6.2. Behaviour verified here is on the locked versions.) `Cargo.lock` is not modified.

Cargo.toml edits, spike only (both reported as requested):

- `[build-dependencies] serde_json = "1"` (ADR-approved, already a normal dependency, no new crate).
- `[dev-dependencies] tauri = { version = "2", features = ["test"] }`. NOT literally in the ADR. `test` is an empty cargo feature of the already-locked tauri (`test = []` in tauri 2.11.2's Cargo.toml), no crate is added, lockfile unchanged. It is needed for `tauri::test::mock_builder`. Needs the user's nod before it leaves the spike.
- No tauri-specta/specta added.

## Q1. Inlined plugin: GO

How it works (verified in `tauri-build-2.6.2/src/acl.rs` and by test):

- `Attributes::new().plugin(name, InlinedPlugin::new().commands(&[..]).default_permission(DefaultPermissionRule::AllowAllCommands))` autogenerates `allow-<cmd>` / `deny-<cmd>` (command name kebab-cased: `word_count_for_text` -> `allow-word-count-for-text`) plus a `default` set containing all allows. Capabilities then reference `"<id>:default"` (or single `"<id>:allow-<cmd>"`).
- `tauri::plugin::Builder::new("<id>")` + `.invoke_handler(generate_handler![..])` gives routing `plugin:<id>|<cmd>`. Name must equal the id used in `build.rs`.
- Plugin commands are ALWAYS ACL-checked (`tauri-2.11.2/src/webview/mod.rs` ~L1822), independent of whether the app defines an app manifest. App commands (`invoke("read_file")`) stay ungated because the app has no `AppManifest`; the test `unprefixed_app_commands_still_work...` shows adding inlined plugins leaves them untouched.
- `core:default` is irrelevant to plugin commands: it only covers core plugins (event, window, path, ...). Without `<id>:default` in some capability the call is rejected (proved by removing `capability.json`: 3 of 7 tests failed with `spike-hello.status not allowed. Permissions associated with this command: spike-hello:allow-status, spike-hello:default`). `default.json` keeps `core:default` unchanged and needs no edit.
- Rejections proved with real build-time ACL (`crate::context()` = the real `generate_context!`), mock runtime:
  - remote origin `https://evil.example` -> `spike-hello.ping not allowed on window "main" ... URL: https://evil.example/ ... allowed on: [windows: "main", "w-*", URL: local]`
  - window `intruder` (not `main`/`w-*`) -> `... not allowed on window "intruder" ...`
  - command not in the manifest -> `spike-hello.nope not allowed. Command not found`
  - window `w-1234` (glob) is allowed.
- Async command with `State<'_, T>` + `AppHandle<R>` generic over runtime works; `Channel` args not tested (agent streaming uses events today, so not on the critical path; still open for Step 4).

Findings that change the spec sketch:

1. `generate_context!()` can only be expanded once per crate (`error: symbol _EMBED_INFO_PLIST is already defined`). The spike adds `pub(crate) fn context<R: Runtime>() -> tauri::Context<R> { tauri::generate_context!() }` in `lib.rs`, used by `run()` and by tests. One-time infra change.
2. The spec's `Feature::tauri_plugin(&self) -> Option<TauriPlugin<Wry>>` and `&'static dyn Feature` list cannot run under `MockRuntime`. Use a registry generic over the runtime: `fn registry<R: Runtime>() -> Vec<FeatureDef<R>>`, `FeatureDef { id, plugin: fn() -> TauriPlugin<R> }`. This keeps the "one `mod` line + one list entry" property and makes every feature's IPC testable without a GUI.

## Q2. Capabilities and file-touch counts: GO

Facts (`tauri-build-2.6.2/src/acl.rs` L424, `tauri-utils-2.9.2/src/acl/build.rs` `parse_capabilities`):

- Default: `./capabilities/**/*`, every `.json/.toml` found is a capability; duplicate `identifier` is a build error. So a per-feature file dropped anywhere under `capabilities/` (e.g. `capabilities/features/<id>.json`) is auto-included with zero edits. Simplest option.
- `Attributes::capabilities_path_pattern` takes exactly ONE `&'static str` glob, so a pattern cannot cover both `capabilities/*.json` and `src/features/*/capability.json` (the `glob` crate has no braces). Setting it replaces the default and would drop `default.json`.
- Spike solution (implemented, works): `build.rs` copies `capabilities/*.json` and each `src/features/<id>/capability.json` (as `feature-<id>.json`) into `OUT_DIR/capabilities-merged/` and sets the pattern to that dir. The generated `gen/schemas/capabilities.json` contained both `default` and `feature-spike-hello`. `rerun-if-changed` on `src/features`, `capabilities` and each manifest/capability makes edits rebuild (observed: removing the file changed behaviour on the next `cargo test`).
- The same `build.rs` loop reads `feature.json` (`id`, `rust.commands`) so the command list lives once, in the manifest (DRY). A contract test must still check manifest commands == `#[tauri::command]` fns (not written in the spike; listed in Step 3/4).
- Caveats: the merged pattern is an absolute `OUT_DIR` path used as a glob (a `[` or `*` in the checkout path would break it; escape if it matters); a manifest command missing from the handler list is NOT a compile error (it is "not found" at runtime), a handler command missing from the manifest is "not allowed" at runtime. Both are caught only by the contract test.

New feature, files touched (one Rust command, one capability):

| Approach                              | Files edited/created                                                                                                                       | Shared files edited                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Today / central `invoke_handler![..]` | `lib.rs` (mod, `manage`, handler lines), `commands/mod.rs`, `commands/<x>.rs`. No ACL file for app commands.                               | 2 (`lib.rs`, `commands/mod.rs`) + 1 new |
| Inlined plugin (spike)                | NEW: `features/<id>/mod.rs`, `feature.json`, `capability.json`, `tests.rs`. EDIT: `features/mod.rs` (2 lines: `pub mod` + registry entry). | 1 (`features/mod.rs`, 2 adjacent lines) |
| Inlined plugin, default glob variant  | same, but `capability.json` lives at `capabilities/features/<id>.json` and no `build.rs` merge is needed                                   | 1 (+1 file outside the folder)          |

One-time infra (already in the spike): `build.rs`, `lib.rs` (`context()` + one `features::install` call in `setup`), `features/mod.rs`. After that, `build.rs`, `lib.rs`, `capabilities/default.json`, `Cargo.toml` are never touched by a feature.

## Q3. Setup-time add, lazy activation, disabled features: GO

- Tauri order (`tauri-2.11.2/src/app.rs` `setup()` ~L2513): config windows are built first, THEN the `Builder::setup` closure runs. The test asserts `get_webview_window("main").is_some()` inside `setup` before `features::install`. So `app.handle().plugin(p)` after the webview exists is the normal case (the repo already does this for the updater).
- `AppHandle::plugin` runs `Plugin::setup` synchronously: `app.manage(HelloState::default())` inside `plugin.setup` is visible immediately (`status` returns right after install). The route `plugin:spike-hello|ping` works on the first call, ACL included (ACL is resolved from the compile-time context, independent of when the plugin is added).
- Lazy init: `HelloState { heavy: tokio::sync::OnceCell<Heavy> }`. After setup `status` = `{heavy_built:false, pings:0}`; after two pings the `Heavy` was built exactly once (`heavy_build` equal in both replies) and `status.heavy_built == true`. `tokio` already has the `sync` feature. Rule for features: `setup` creates only an empty struct; build heavy state in the first command or in `on_workspace_open`.
- Disabled features: ACL is a compile-time list, enablement is a runtime flag. They compose as: permissions and capabilities always exist (cheap, static), but a disabled feature is never passed to `app.plugin()`. Result with the flag off: no managed state (`try_state` is `None`) and the invoke is rejected with `plugin spike-hello not found` (ACL passes, routing fails). So "compile-time list vs runtime flag": use both, ACL = compile-time superset, registration = runtime gate. Disabling at runtime without restart is not possible (a Tauri plugin cannot be removed once added, only never added); the spec already says restart needed for Rust parts. Env gate in the spike: `WRITER_DISABLE_FEATURES=a,b`; the real runner would read `features.<id>.enabled` settings.
- Not proved: plugin `js_init_script` for webviews already created (not needed, no init scripts planned); `on_event` hooks; window-destroy hooks (these are `Feature` trait concerns for Step 3, not Tauri plugin ones).

## Q4. Frontend contract: GO

Code: `apps/desktop/src/lib/spike-features/ipc.ts` and `spike-hello.ts` (appendix). `vp check` passes on the new files (including two `@ts-expect-error` lines proving an unknown command and wrong args are type errors); `vp test run tests/spike-features-ipc.test.ts` passes 4 tests via `mockIPC`: `featureInvoke` sends exactly `plugin:spike-hello|ping` with `{name}`, a command not in the manifest's `rust.commands` rejects, and the manifest's command list equals the typed map keys.

- Typing: JSON imports widen to `string[]`, so the command union cannot be derived from `feature.json` at the type level without `as const` or generated types. The spike types commands with a hand `Commands` interface per feature and guards at runtime and in the contract test with the manifest list. tauri-specta (later) replaces the hand interface with generated types.
- Event name rules (verified in `tauri-2.11.2/src/event/event_name.rs`): characters must be Unicode alphanumeric or `-`, `/`, `:`, `_`. A dot is rejected (`IllegalEventName`, tested: `app.emit("spike-hello.pinged")` is `Err`). `agent://event` is valid (letters, `:`, `/`). So the spec's manifest example `word-count:changed` is fine, but any `<id>.<name>` convention (as used for command ids like `word-count.toggle`) must NOT be used for events.
- `ctx.events.listen(name)` -> `listen("<id>:<name>")` works and is validated with the same regex client-side.
- tauri-specta caveat (read from `tauri-specta-2.0.0-rc.29/src/name.rs`, not compiled): with `Builder::plugin_name("spike-hello")` commands become `plugin:spike-hello|cmd` (matches our routing) but events become `plugin:spike-hello:<EVENT NAME>` (`:` is legal, so valid), and `E::NAME` defaults to the event type name in the configured casing. Events must be unique per registry (`panic!("Another event with name ... is already registered")`). So when specta lands, the one event convention must be `plugin:<id>:<name>` (or drop `plugin_name` and keep `<id>:<name>` via explicit event names); decide once and make `ctx.events` and the manifest `rust.events` agree. Do not mix.

## Spec corrections

1. Registry is generic over the runtime (`FeatureDef<R>`), not `TauriPlugin<Wry>`.
2. `generate_context!` once per crate: add `crate::context()` in Step 3.
3. Capability: spec 5.3 option (a) "capabilities_path_pattern includes several folders" is impossible (one glob); use the `build.rs` merge (done) or the `capabilities/features/` default glob.
4. Events: never `.` in event names; fix the namespacing rule ahead of tauri-specta (above). Also `docs` wording: event names in `feature.json` `rust.events` are `<id>:<name>`.
5. Manifest `rust.commands` is a build input: a stale manifest silently produces "not allowed"/"not found" at runtime, so the contract test is mandatory, not optional.

## Risks

- Release profile `panic = "abort"`: error isolation by `catch_unwind` is dev-only (already in spec).
- Build-script manifests mean adding a command without touching `feature.json` fails only at runtime. Mitigation: contract test extending the `sync_commands_are_allowlisted` scanner.
- `serde_json` build-dep plus `Box::leak` in `build.rs` is fine (build script only), but it makes `build.rs` non-trivial; keep it tiny and tested.
- `tauri` `test` dev-feature: needs explicit approval (above).
- Plugin names appear in ACL schemas and permissions: ids become a public-ish contract (`spike-hello:allow-ping`); rename cost is a capability edit.
- Mock-runtime tests need `run_iteration` (deprecated, busy-loop warning; `#![allow(deprecated)]` in the test file) to execute `setup`. Acceptable for tests.
- Unverified: `Channel` arguments through plugin commands; behaviour on Windows/Linux (only macOS run); a plugin whose `setup` returns `Err` (should abort `app.plugin` and be isolated by the runner).

## Recommended Step 1

Proceed with the ADR order, no fallback needed:

1. TS core (`src/lib/features/`: types, `defineFeature`, registry via `import.meta.glob`, lifecycle with `OwnedRegistry`, contract test) plus the keybinding registry replacing the `if` chain in `use-keyboard-shortcuts.ts` (conflict test). Promote `featureInvoke`/`featureEvents` from this spike into `src/lib/features/ipc.ts` with the event regex and the namespacing rule fixed.
2. In parallel, land the Rust infra as its own small commit (it is already proven): `crate::context()`, `features/mod.rs` generic registry + `install`, the `build.rs` manifest/capability merge, and the contract test. Ask for the go on the `tauri` `test` dev-feature in the same step.
3. Pilot `tables` (editor-only) for the TS contribution points and lazy activation. Pilot Rust: `mouse-buttons` (Step 3).

Delete before merging anything: `features/spike_hello/`, `src/lib/spike-features/`, `tests/spike-features-ipc.test.ts`, and the `node_modules` symlinks created in this worktree (root and `apps/desktop`, pointing to the main checkout's installs, only used to run `vp`).

## Commands run and output

```
cargo test features:: -- --nocapture --test-threads=1
test features::spike_hello::tests::command_without_permission_is_rejected ... unknown command rejection: "spike-hello.nope not allowed. Command not found"
test features::spike_hello::tests::disabled_feature_registers_no_commands ... disabled feature rejection: "plugin spike-hello not found"
test features::spike_hello::tests::event_names_follow_tauri_rules ... ok
test features::spike_hello::tests::plugin_added_in_setup_routes_and_acl_allows_main ... ok
test features::spike_hello::tests::remote_origin_is_rejected_by_acl ... remote origin rejection: "spike-hello.ping not allowed on window \"main\", webview \"main\", URL: https://evil.example/  allowed on: [windows: \"main\", \"w-*\", URL: local]  referenced by: capability: feature-spike-hello, permission: allow-ping"
test features::spike_hello::tests::unprefixed_app_commands_still_work_and_core_default_is_not_needed_for_plugin ... ok
test features::spike_hello::tests::window_outside_capability_is_rejected_by_acl ... unauthorized window rejection: "spike-hello.ping not allowed on window \"intruder\", webview \"intruder\", URL: local  allowed on: [windows: \"main\", \"w-*\", URL: local]  referenced by: capability: feature-spike-hello, permission: allow-ping"
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 168 filtered out; finished in 0.01s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 175 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.17s

tauri v2.11.2
[build-dependencies]

tauri-build v2.6.2

tauri-runtime v2.11.2

tauri-utils v2.9.2

tauri-utils v2.9.2
```

`cargo test` full suite: 175 passed (includes `commands::tests::sync_commands_are_allowlisted`), `cargo fmt --check` clean, `cargo clippy --all-targets` no warnings in the new files. `vp check` on the three new TS files: pass.

## Appendix: prototype code

### apps/desktop/src-tauri/build.rs

```
use std::path::{Path, PathBuf};
use std::{env, fs};

/// SPIKE: one manifest per feature (`src/features/<id>/feature.json`) drives the
/// per-feature inlined Tauri plugin ACL and a colocated `capability.json`.
fn main() {
    // `telemetry.rs` reads these with `option_env!`. Cargo tracks that through
    // dep-info for the crate itself; declaring them here as well makes the
    // dependency explicit and covers the build script's own outputs.
    println!("cargo::rerun-if-env-changed=WRITER_POSTHOG_KEY");
    println!("cargo::rerun-if-env-changed=WRITER_POSTHOG_HOST");

    let features_dir = Path::new("src/features");
    println!("cargo::rerun-if-changed=src/features");
    println!("cargo::rerun-if-changed=capabilities");

    // Merged capability dir: `capabilities/*.json` (app-wide) plus every
    // feature's `capability.json`, copied as `feature-<id>.json`. tauri-build accepts
    // exactly ONE glob, so merging is how a feature keeps its capability in its own folder.
    let merged = PathBuf::from(env::var("OUT_DIR").unwrap()).join("capabilities-merged");
    let _ = fs::remove_dir_all(&merged);
    fs::create_dir_all(&merged).unwrap();
    for entry in fs::read_dir("capabilities").unwrap().flatten() {
        let p = entry.path();
        if p.extension().is_some_and(|e| e == "json") {
            fs::copy(&p, merged.join(p.file_name().unwrap())).unwrap();
        }
    }

    let mut attrs = tauri_build::Attributes::new();
    for entry in fs::read_dir(features_dir).unwrap().flatten() {
        let dir = entry.path();
        let manifest_path = dir.join("feature.json");
        let Ok(raw) = fs::read_to_string(&manifest_path) else {
            continue;
        };
        println!("cargo::rerun-if-changed={}", manifest_path.display());
        let m: serde_json::Value = serde_json::from_str(&raw).expect("feature.json is not JSON");
        let id: &'static str = Box::leak(m["id"].as_str().expect("feature.json id").into());
        let commands: Vec<&'static str> = m["rust"]["commands"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|c| &*Box::leak(c.as_str().unwrap().to_owned().into_boxed_str()))
                    .collect()
            })
            .unwrap_or_default();
        let commands: &'static [&'static str] = Box::leak(commands.into_boxed_slice());
        attrs = attrs.plugin(
            id,
            tauri_build::InlinedPlugin::new()
                .commands(commands)
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        );
        let cap = dir.join("capability.json");
        if cap.exists() {
            println!("cargo::rerun-if-changed={}", cap.display());
            fs::copy(&cap, merged.join(format!("feature-{id}.json"))).unwrap();
        }
    }
    let pattern: &'static str = Box::leak(format!("{}/*", merged.display()).into_boxed_str());
    attrs = attrs.capabilities_path_pattern(pattern);

    tauri_build::try_build(attrs).unwrap();
}
```

### apps/desktop/src-tauri/src/features/mod.rs

```
//! SPIKE (ADR Step 0): the one Rust registration file for first-party features.
//! Adding a feature = its folder + the `mod` line + the `vec!` entry below.

use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Runtime};

pub mod spike_hello;

/// One entry per feature. Generic over the runtime (not `TauriPlugin<Wry>` as in the
/// spec sketch) so the same registry runs under `tauri::test::MockRuntime`.
pub struct FeatureDef<R: Runtime> {
    pub id: &'static str,
    pub plugin: fn() -> TauriPlugin<R>,
}

pub fn registry<R: Runtime>() -> Vec<FeatureDef<R>> {
    vec![spike_hello::def()]
}

/// Kill switch for the whole spike: `WRITER_DISABLE_FEATURES=a,b`.
pub fn enabled_from_env(id: &str) -> bool {
    !std::env::var("WRITER_DISABLE_FEATURES")
        .unwrap_or_default()
        .split(',')
        .any(|d| d.trim() == id)
}

/// Adds the plugin of every enabled feature. Safe to call from `setup` (after the
/// webview exists): `AppHandle::plugin` initializes the plugin synchronously.
/// A disabled feature is never added, so its commands answer "not found".
pub fn install<R: Runtime>(
    app: &AppHandle<R>,
    is_enabled: impl Fn(&str) -> bool,
) -> tauri::Result<()> {
    for def in registry::<R>() {
        if is_enabled(def.id) {
            app.plugin((def.plugin)())?;
        }
    }
    Ok(())
}
```

### apps/desktop/src-tauri/src/features/spike_hello/mod.rs

```
//! SPIKE feature: one async command, one event, managed state, lazy heavy init.
//! Not a shipped feature.

use serde::Serialize;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::sync::OnceCell;

use super::FeatureDef;

pub const ID: &str = "spike-hello";
pub const EVENT_PINGED: &str = "spike-hello:pinged";

/// Cheap to create in `setup`; the expensive part is built on the first call.
#[derive(Default)]
pub struct HelloState {
    heavy: OnceCell<Heavy>,
    pings: AtomicUsize,
}

pub struct Heavy {
    pub build_id: usize,
}

static HEAVY_BUILDS: AtomicUsize = AtomicUsize::new(0);

#[derive(Serialize, Clone)]
pub struct PingReply {
    pub message: String,
    pub heavy_build: usize,
    pub pings: usize,
}

#[derive(Serialize)]
pub struct Status {
    pub heavy_built: bool,
    pub pings: usize,
}

#[tauri::command]
async fn ping<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, HelloState>,
    name: String,
) -> Result<PingReply, String> {
    let heavy = state
        .heavy
        .get_or_init(|| async {
            Heavy {
                build_id: HEAVY_BUILDS.fetch_add(1, Ordering::SeqCst) + 1,
            }
        })
        .await;
    let pings = state.pings.fetch_add(1, Ordering::SeqCst) + 1;
    let reply = PingReply {
        message: format!("hello {name}"),
        heavy_build: heavy.build_id,
        pings,
    };
    app.emit(EVENT_PINGED, reply.clone())
        .map_err(|e| e.to_string())?;
    Ok(reply)
}

#[tauri::command]
async fn status(state: State<'_, HelloState>) -> Result<Status, String> {
    Ok(Status {
        heavy_built: state.heavy.initialized(),
        pings: state.pings.load(Ordering::SeqCst),
    })
}

pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new(ID)
        .invoke_handler(tauri::generate_handler![ping, status])
        .setup(|app, _api| {
            app.manage(HelloState::default());
            Ok(())
        })
        .build()
}

pub fn def<R: Runtime>() -> FeatureDef<R> {
    FeatureDef {
        id: ID,
        plugin: plugin::<R>,
    }
}

#[cfg(test)]
mod tests;
```

### apps/desktop/src-tauri/src/features/spike_hello/feature.json

```
{
  "id": "spike-hello",
  "name": "Spike hello",
  "version": "0.0.0",
  "description": "Throwaway Step 0 spike. Not a shipped feature.",
  "activation": ["onCommand:spike-hello.ping"],
  "rust": {
    "commands": ["ping", "status"],
    "events": ["spike-hello:pinged"]
  }
}
```

### apps/desktop/src-tauri/src/features/spike_hello/capability.json

```
{
  "identifier": "feature-spike-hello",
  "description": "Grants the spike-hello plugin commands to every Writer window.",
  "windows": ["main", "w-*"],
  "permissions": ["spike-hello:default"]
}
```

### apps/desktop/src-tauri/src/features/spike_hello/tests.rs

```
#![allow(deprecated)] // run_iteration: the only way to run `setup` under the mock runtime
use super::*;
use crate::features;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};
use tauri::webview::InvokeRequest;
use tauri::{Listener, WebviewWindow, WebviewWindowBuilder};

const LOCAL: &str = if cfg!(any(windows, target_os = "android")) {
    "http://tauri.localhost"
} else {
    "tauri://localhost"
};

fn request(cmd: &str, url: &str, body: Value) -> InvokeRequest {
    InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: url.parse().unwrap(),
        body: InvokeBody::Json(body),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    }
}

/// Real `generate_context!` (so the REAL build-time ACL and capabilities apply), mock
/// runtime. The plugin is added from `setup`, i.e. after the config window "main" exists.
fn app(enabled: fn(&str) -> bool) -> (tauri::App<MockRuntime>, Arc<Mutex<Option<bool>>>) {
    let main_existed_at_setup = Arc::new(Mutex::new(None));
    let flag = main_existed_at_setup.clone();
    let mut app = mock_builder()
        .setup(move |app| {
            *flag.lock().unwrap() = Some(app.get_webview_window("main").is_some());
            features::install(app.handle(), enabled)?;
            Ok(())
        })
        .build(crate::context())
        .unwrap();
    // Tauri creates config windows and runs `setup` on the first iteration, in that order.
    app.run_iteration(|_, _| {});
    (app, main_existed_at_setup)
}

fn main_window(app: &tauri::App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    app.get_webview_window("main").expect("config window main")
}

#[test]
fn plugin_added_in_setup_routes_and_acl_allows_main() {
    let (app, existed) = app(|_| true);
    assert_eq!(
        *existed.lock().unwrap(),
        Some(true),
        "webview existed before plugin add"
    );
    let w = main_window(&app);

    let pinged = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = pinged.clone();
    app.listen(EVENT_PINGED, move |e| {
        sink.lock().unwrap().push(e.payload().to_string())
    });

    // lazy: managed state exists (setup ran) but heavy state is not built yet
    let st = get_ipc_response(&w, request("plugin:spike-hello|status", LOCAL, json!({}))).unwrap();
    let st: Value = st.deserialize().unwrap();
    assert_eq!(st, json!({ "heavy_built": false, "pings": 0 }));

    let r1: Value = get_ipc_response(
        &w,
        request("plugin:spike-hello|ping", LOCAL, json!({ "name": "a" })),
    )
    .unwrap()
    .deserialize()
    .unwrap();
    let r2: Value = get_ipc_response(
        &w,
        request("plugin:spike-hello|ping", LOCAL, json!({ "name": "b" })),
    )
    .unwrap()
    .deserialize()
    .unwrap();
    assert_eq!(r1["message"], "hello a");
    assert_eq!(r1["heavy_build"], r2["heavy_build"], "heavy init ran once");
    assert_eq!(r2["pings"], 2);

    let st: Value = get_ipc_response(&w, request("plugin:spike-hello|status", LOCAL, json!({})))
        .unwrap()
        .deserialize()
        .unwrap();
    assert_eq!(st["heavy_built"], true);
    // event emitted per ping (listener runs synchronously on emit)
    assert_eq!(pinged.lock().unwrap().len(), 2);
}

#[test]
fn remote_origin_is_rejected_by_acl() {
    let (app, _) = app(|_| true);
    let w = main_window(&app);
    let err = get_ipc_response(
        &w,
        request(
            "plugin:spike-hello|ping",
            "https://evil.example",
            json!({ "name": "x" }),
        ),
    )
    .unwrap_err();
    eprintln!("remote origin rejection: {err}");
    assert!(err.to_string().contains("not allowed"), "{err}");
}

#[test]
fn window_outside_capability_is_rejected_by_acl() {
    let (app, _) = app(|_| true);
    let w = WebviewWindowBuilder::new(&app, "intruder", Default::default())
        .build()
        .unwrap();
    let err = get_ipc_response(
        &w,
        request("plugin:spike-hello|ping", LOCAL, json!({ "name": "x" })),
    )
    .unwrap_err();
    eprintln!("unauthorized window rejection: {err}");
    assert!(err.to_string().contains("not allowed"), "{err}");

    // `w-*` glob windows (secondary workspace windows) are allowed
    let w2 = WebviewWindowBuilder::new(&app, "w-1234", Default::default())
        .build()
        .unwrap();
    get_ipc_response(&w2, request("plugin:spike-hello|status", LOCAL, json!({}))).unwrap();
}

#[test]
fn command_without_permission_is_rejected() {
    // `deny`-by-absence: a command that is not in the manifest has no permission at all.
    let (app, _) = app(|_| true);
    let w = main_window(&app);
    let err =
        get_ipc_response(&w, request("plugin:spike-hello|nope", LOCAL, json!({}))).unwrap_err();
    eprintln!("unknown command rejection: {err}");
    assert!(err.to_string().contains("not allowed"), "{err}");
}

#[test]
fn disabled_feature_registers_no_commands() {
    let (app, _) = app(|id| id != ID);
    let w = main_window(&app);
    assert!(
        app.try_state::<HelloState>().is_none(),
        "no state for a disabled feature"
    );
    let err = get_ipc_response(
        &w,
        request("plugin:spike-hello|ping", LOCAL, json!({ "name": "x" })),
    )
    .unwrap_err();
    eprintln!("disabled feature rejection: {err}");
    // ACL (compile-time) passes; routing (runtime) refuses
    assert!(err.to_string().contains("not found"), "{err}");
}

#[test]
fn unprefixed_app_commands_still_work_and_core_default_is_not_needed_for_plugin() {
    // Pre-existing app commands are not ACL-gated (no AppManifest), so adding an inlined
    // plugin must not change them.
    #[tauri::command]
    fn app_cmd() -> &'static str {
        "ok"
    }
    let mut app = mock_builder()
        .invoke_handler(tauri::generate_handler![app_cmd])
        .build(crate::context())
        .unwrap();
    app.run_iteration(|_, _| {});
    let w = main_window(&app);
    let r: Value = get_ipc_response(&w, request("app_cmd", LOCAL, json!({})))
        .unwrap()
        .deserialize()
        .unwrap();
    assert_eq!(r, "ok");
}

#[test]
fn event_names_follow_tauri_rules() {
    let ok = |s: &str| s.chars().all(|c| c.is_alphanumeric() || "-/:_".contains(c));
    assert!(ok(EVENT_PINGED));
    assert!(ok("agent://event"));
    assert!(!ok("spike-hello.pinged"), "dot is illegal");
    assert!(!ok("spike hello"));
    // and Tauri itself agrees: an illegal name makes emit fail
    let (app, _) = app(|_| true);
    assert!(app.emit("spike-hello.pinged", 1).is_err());
    assert!(app.emit("agent://event", 1).is_ok());
}
```

### lib.rs changes

```rust
pub mod features; // module list
pub(crate) fn context<R: tauri::Runtime>() -> tauri::Context<R> { tauri::generate_context!() }
.build(context()) // was tauri::generate_context!()
features::install(app.handle(), features::enabled_from_env)?; // in setup, before the updater plugin
```

### apps/desktop/src/lib/spike-features/ipc.ts

```ts
// SPIKE (ADR Step 0, question 4): typed per-feature IPC + namespaced events.
// Throwaway; the real home is `src/lib/features/ipc.ts`.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Tauri's own rule (tauri `event_name.rs`): alphanumerics, `-`, `/`, `:`, `_`. A dot is rejected. */
const EVENT_NAME = /^[\p{L}\p{N}\-/:_]+$/u;
const FEATURE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export interface CommandSpec {
  args: object | undefined;
  result: unknown;
}
export type CommandMap<C> = { [K in keyof C]: CommandSpec };

/** `invoke("plugin:<id>|<cmd>", args)`; the command map gives args and result types per feature. */
export function featureInvoke<C extends CommandMap<C>>(id: string, commands?: readonly string[]) {
  if (!FEATURE_ID.test(id)) throw new Error(`invalid feature id: ${id}`);
  return <K extends keyof C & string>(
    cmd: K,
    ...args: C[K]["args"] extends undefined ? [] : [args: C[K]["args"]]
  ): Promise<C[K]["result"]> => {
    // Optional runtime guard fed by the manifest's `rust.commands` (a contract test also checks it).
    if (commands && !commands.includes(cmd)) {
      return Promise.reject(new Error(`feature ${id} declares no command ${cmd}`));
    }
    return invoke(`plugin:${id}|${cmd}`, args[0] as Record<string, unknown> | undefined);
  };
}

/** `ctx.events` for one feature: names are auto-namespaced `<id>:<name>`. */
export function featureEvents<E extends object>(id: string) {
  return {
    name: <K extends keyof E & string>(name: K) => {
      const full = `${id}:${name}`;
      if (!EVENT_NAME.test(full)) throw new Error(`illegal Tauri event name: ${full}`);
      return full;
    },
    listen<K extends keyof E & string>(name: K, fn: (payload: E[K]) => void): Promise<UnlistenFn> {
      const full = `${id}:${name}`;
      if (!EVENT_NAME.test(full))
        return Promise.reject(new Error(`illegal Tauri event name: ${full}`));
      return listen<E[K]>(full, (e) => fn(e.payload));
    },
  };
}
```

### apps/desktop/src/lib/spike-features/spike-hello.ts

```ts
// SPIKE: what a feature's `web/ipc.ts` looks like with the contract above.
import manifest from "../../../src-tauri/src/features/spike_hello/feature.json";
import { featureEvents, featureInvoke } from "./ipc";

interface SpikeHelloCommands {
  ping: { args: { name: string }; result: { message: string; heavy_build: number; pings: number } };
  status: { args: undefined; result: { heavy_built: boolean; pings: number } };
}
interface SpikeHelloEvents {
  pinged: { message: string; heavy_build: number; pings: number };
}

export const spikeHello = featureInvoke<SpikeHelloCommands>("spike-hello", manifest.rust.commands);
export const spikeHelloEvents = featureEvents<SpikeHelloEvents>("spike-hello");

export const ping = (name: string) => spikeHello("ping", { name });
export const status = () => spikeHello("status");
// @ts-expect-error unknown command is a type error
export const bad = () => spikeHello("nope");
// @ts-expect-error wrong args are a type error
export const bad2 = () => spikeHello("ping", { nam: "x" });
```

### apps/desktop/tests/spike-features-ipc.test.ts

```ts
// @vitest-environment jsdom
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vite-plus/test";
import manifest from "../src-tauri/src/features/spike_hello/feature.json";
import { featureEvents } from "../src/lib/spike-features/ipc";
import { ping, spikeHello, spikeHelloEvents, status } from "../src/lib/spike-features/spike-hello";

afterEach(() => clearMocks());

describe("featureInvoke", () => {
  it("routes to plugin:<id>|<cmd> with args", async () => {
    const seen: Array<[string, unknown]> = [];
    mockIPC((cmd, args) => {
      seen.push([cmd, args]);
      return { message: "hello a", heavy_build: 1, pings: 1 };
    });
    await ping("a");
    await status();
    expect(seen[0]).toEqual(["plugin:spike-hello|ping", { name: "a" }]);
    expect(seen[1][0]).toBe("plugin:spike-hello|status");
  });

  it("rejects commands the manifest does not declare", async () => {
    await expect((spikeHello as (c: string) => Promise<unknown>)("nope")).rejects.toThrow(
      /declares no command/,
    );
  });

  it("manifest commands equal the typed map keys", () => {
    expect([...manifest.rust.commands].sort()).toEqual(["ping", "status"]);
  });
});

describe("featureEvents", () => {
  it("namespaces and validates names with Tauri's rules", () => {
    expect(spikeHelloEvents.name("pinged")).toBe("spike-hello:pinged");
    expect(manifest.rust.events).toContain(spikeHelloEvents.name("pinged"));
    const dotted = featureEvents<{ "a.b": number }>("spike-hello");
    expect(() => dotted.name("a.b")).toThrow(/illegal/);
    // legacy agent name is valid for Tauri
    expect(/^[\p{L}\p{N}\-/:_]+$/u.test("agent://event")).toBe(true);
  });
});
```
