//! First-party features as built-in plugins (SPECs/builtin-plugins-spec.md, ADR
//! 2026-11-17 "build first-party features as built-in plugins").
//!
//! A feature is one folder, `apps/desktop/features/<id>/` (the id is kebab-case): `feature.json`
//! (the manifest: id, `enabledByDefault`, `rust.commands`, `rust.events`), `rust/` (the Rust
//! half), `web/` (the React half, collected by `src/lib/features`) and an optional
//! `settings.schema.json` fragment. Its Tauri commands live in their own plugin named after the
//! id, so they are called as `plugin:<id>|<command>` and are gated by the `<id>:allow-<command>`
//! permissions that `build.rs` generates from the manifest. A capability file
//! `src-tauri/capabilities/features/<id>.json` (picked up by tauri-build's default glob, no code)
//! grants `<id>:default` to the windows `main` and `w-*`, and nothing else.
//!
//! Adding a feature touches this file in two adjacent places: the `#[path]` `mod` line and the
//! entry in [`registry`] (`impl<R: Runtime> Feature<R> for WordCount`, see [`Feature`]):
//!
//! ```ignore
//! #[path = "../../../features/word-count/rust/mod.rs"]
//! mod word_count;
//! // in registry():  &word_count::WordCount,
//! ```
//!
//! Nothing else in Rust: not `lib.rs`, not `commands/mod.rs`, not `build.rs`. The contract test
//! fails when the folder, the manifest, the handlers, the capability file or the settings
//! fragment disagree.
//!
//! Rules every feature follows:
//! - Events are named `<id>:<name>`: Tauri accepts only alphanumerics, `-`, `/`, `:` and `_`
//!   (a `.` is rejected), and `src/lib/features/events.ts` enforces the same rule.
//! - A feature is started and stopped live ([`lifecycle`], ADR 2026-11-20): [`Feature::start`]
//!   receives a fresh [`scope::FeatureScope`] and everything the feature holds while it runs
//!   (threads, processes, timers, watcher observers, event listeners, its state) goes through
//!   that scope, so stopping it releases all of it; never `std::thread::spawn`, `Command::spawn`,
//!   `watcher::observe_paths` or `app.listen` in feature code (a source-scan test fails on it).
//!   Expensive state still builds on first use inside the scope's state.
//! - A command that panics inside its async body is caught by the async runtime, not by [`contain`]
//!   (which sees the synchronous part only); disk work goes through `commands::blocking`, which
//!   turns a panic of its closure into an error for the caller.
//! - Commands are `async` and do disk work through `commands::blocking` (the existing allowlist
//!   test scans this folder too).
//! - Failure containment (ADR 2026-11-17 "contain feature failures with unwinding panics", spec
//!   "Failure containment and recovery"): the release profile unwinds, and every boundary goes
//!   through [`guard`]: `start`, `stop`, the hooks, every command (the one wrapper is
//!   [`contain`], applied where the plugin is built, so a feature declares a plain
//!   [`Feature::invoke_handler`]) and every thread a feature starts (the scope's `spawn`). A panic is logged once (feature id and boundary,
//!   never the payload: the panic hook logs that, redacted), the feature is `failed` for the
//!   session, its commands answer `FeatureUnavailable`, its hooks are skipped, its scope is
//!   released and the webview gets `features:failed`. What cannot unwind (an Objective-C exception, a segfault) is recovered on
//!   the next launch from the crash markers in [`recovery`]; native code that stays live is
//!   declared through [`native`]. Features contain nothing themselves: no `catch_unwind` in
//!   feature code.
//! - Hooks ([`Feature::start`], `on_workspace_open`, `on_workspace_close`, `stop`, `on_exit`) are
//!   called by this module's runner only for started features (enabled, and `start` succeeded);
//!   a feature started after launch gets `on_workspace_open` for every open window, a stopped one
//!   gets nothing; a failing hook is logged, never propagated. Teardown hooks run in reverse
//!   order.
//! - Pure contributions ([`Feature::cli_commands`], [`Feature::ipc_commands`],
//!   [`Feature::skills`], [`Feature::index_ddl`], [`Feature::file_kinds`])
//!   are read from every registered feature whatever the toggle (the index and the CLI have no
//!   settings layer; a toggle must never rebuild the index). The tables that run them stay
//!   where they were: `cli::registry`, `managed_skills`, `index::schema`.
//! - `start` at launch runs while `install` holds the settings read lock: it must not write
//!   settings (a start after launch holds no lock).

use crate::cli::registry::CommandSpec;
use crate::config::Settings;
use crate::error::AppError;
use crate::index::kinds::FileKind;
use crate::ipc::IpcCommand;
use crate::managed_skills::BundledSkill;
use crate::state::AppState;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::Arc;
use tauri::ipc::Invoke;
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};

pub mod lazy;
mod lifecycle;
pub mod points;
pub mod recovery;
pub mod scope;
pub mod secrets;

#[allow(unused_imports)]
// the surface of the lifecycle for features and core; each is used somewhere
pub use lifecycle::{
    busy, exit, is_started, scope_of, settings_written, start_feature, started_ids, state_of,
    stop_feature, workspace_close, workspace_open, Busy, Running, STARTED_EVENT, STOPPED_EVENT,
};
use scope::FeatureScope;

#[cfg(test)]
mod containment_tests;
#[cfg(test)]
mod contract_tests;
#[cfg(test)]
mod escape_hatch_tests;
#[cfg(test)]
pub(crate) mod fixture;
#[cfg(test)]
mod ipc_tests;
#[cfg(test)]
mod lifecycle_tests;

#[path = "../../../features/agent/rust/mod.rs"]
mod agent;
#[path = "../../../features/bases/rust/mod.rs"]
pub(crate) mod bases;
#[path = "../../../features/code-files/rust/mod.rs"]
pub(crate) mod code_files;
#[path = "../../../features/dataview/rust/mod.rs"]
mod dataview;
#[path = "../../../features/excalidraw/rust/mod.rs"]
mod excalidraw;
#[path = "../../../features/git/rust/mod.rs"]
mod git;
#[path = "../../../features/graph/rust/mod.rs"]
mod graph;
#[path = "../../../features/icons/rust/mod.rs"]
pub(crate) mod icons;
#[path = "../../../features/lint/rust/mod.rs"]
mod lint;
#[path = "../../../features/obsidian-host/rust/mod.rs"]
pub(crate) mod obsidian_host;
#[path = "../../../features/pdf/rust/mod.rs"]
pub(crate) mod pdf;
#[path = "../../../features/spellcheck/rust/mod.rs"]
mod spellcheck;
#[path = "../../../features/tasks/rust/mod.rs"]
mod tasks;

/// The parts of `feature.json` Rust reads. `build.rs` reads the same file for the ACL, so the
/// manifest is the only place a command name is declared.
// `name`, `version` and `rust` are read by the contract tests and by the contributions below.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default = "default_true")]
    pub enabled_by_default: bool,
    #[serde(default)]
    pub rust: RustPart,
    #[serde(default)]
    pub contributes: Contributes,
    /// Hooks this feature owns (ADR 2026-11-20 "let features cooperate...").
    #[serde(default)]
    pub points: Vec<PointDecl>,
    /// Points of other features (or `core.*`) this feature adds behaviour to.
    #[serde(default)]
    pub extends: Vec<String>,
}

/// A point the feature owns: `id` is `<feature id>.<point>`, `kind` is `hook` (the only kind built).
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct PointDecl {
    pub id: String,
    pub kind: String,
    pub side: String,
}

/// The parts of `contributes` Rust reads (the rest is the web half's). The id lists name what the
/// web half registers; the contract test checks their shape and a TypeScript test ties them to
/// the `defineFeature` call.
#[allow(dead_code)]
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributes {
    /// Secrets the feature owns (spec "Feature settings and secrets").
    #[serde(default)]
    pub secrets: Vec<secrets::SecretDecl>,
    #[serde(default)]
    pub docks: Vec<String>,
    #[serde(default)]
    pub sidebar_panels: Vec<String>,
    #[serde(default)]
    pub sidebar_actions: Vec<String>,
    #[serde(default)]
    pub status_items: Vec<String>,
    #[serde(default)]
    pub overlays: Vec<String>,
    /// Menu surface (`editor-body`, `sidebar-file`, ...) to contributed item ids.
    #[serde(default)]
    pub menus: BTreeMap<String, Vec<String>>,
}

impl Contributes {
    /// Every id-list point as (point name, ids): one table for the checks that walk them all.
    pub fn id_lists(&self) -> Vec<(String, &Vec<String>)> {
        let mut lists = vec![
            ("docks".to_string(), &self.docks),
            ("sidebarPanels".to_string(), &self.sidebar_panels),
            ("sidebarActions".to_string(), &self.sidebar_actions),
            ("statusItems".to_string(), &self.status_items),
            ("overlays".to_string(), &self.overlays),
        ];
        lists.extend(
            self.menus
                .iter()
                .map(|(s, ids)| (format!("menus.{s}"), ids)),
        );
        lists
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RustPart {
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default)]
    pub events: Vec<String>,
    /// The `Feature` hooks the feature implements (`start`, `stop`, `onWorkspaceOpen`,
    /// `onWorkspaceClose`, `onExit`): documentation for the Features section, vocabulary checked by the contract test.
    #[serde(default)]
    pub hooks: Vec<String>,
    /// Commands the app registers itself (they are not a plugin's, so a plugin name or ACL would
    /// change their IPC names) that this feature's kill switch and failure state gate: [`gate`]
    /// answers `FeatureUnavailable` for them while the feature is off. Not part of `has_rust`.
    #[serde(default, rename = "gatedCommands")]
    pub gated_commands: Vec<String>,
    /// The ids of the file kinds the feature contributes ([`Feature::file_kinds`]): the contract
    /// test ties them to the code. Not part of `has_rust`.
    #[serde(default, rename = "fileKinds")]
    pub file_kinds: Vec<String>,
}

fn default_true() -> bool {
    true
}

impl Manifest {
    /// Does the feature have a Rust half? A feature without commands, events or hooks is
    /// TypeScript-only: no plugin, no ACL, nothing in [`registry`].
    #[cfg(test)]
    pub fn has_rust(&self) -> bool {
        !self.rust.commands.is_empty()
            || !self.rust.events.is_empty()
            || !self.rust.hooks.is_empty()
            || !self.rust.gated_commands.is_empty()
    }

    /// The settings key of this feature's kill switch.
    pub fn enabled_key(&self) -> String {
        format!("features.{}.enabled", self.id)
    }
}

/// The window a workspace hook runs for.
#[allow(dead_code)] // read by the first feature with a workspace hook (the agent pilot)
pub struct WindowCtx<'a> {
    pub label: &'a str,
    pub root: Option<&'a Path>,
}

/// A feature's commands, as the closure Tauri's `invoke_handler` takes.
pub type InvokeHandler<R> = Box<dyn Fn(Invoke<R>) -> bool + Send + Sync + 'static>;

/// One first-party feature. Generic over the runtime so the same registry runs under Tauri's mock
/// runtime in tests; implement it for every runtime (`impl<R: Runtime> Feature<R> for X`). Every
/// method but `manifest_source` has a no-op default, so a feature states only what it needs.
pub trait Feature<R: Runtime>: Send + Sync {
    /// `include_str!` of the feature's `feature.json` (the id, the kill-switch default, the
    /// commands and events).
    fn manifest_source(&self) -> &'static str;
    /// `include_str!` of the feature's `settings.schema.json` fragment, if it has settings.
    fn settings_source(&self) -> Option<&'static str> {
        None
    }

    /// The feature's commands as one invoke handler (`None` without commands). The runner builds
    /// the Tauri plugin named after the id around it and wraps it in [`contain`]: the feature
    /// never builds a plugin or guards a command itself.
    fn invoke_handler(&self) -> Option<InvokeHandler<R>> {
        None
    }

    /// The feature switches on: at launch, in Settings > Features, or "Turn back on". Build the
    /// state (`scope.manage`) and start whatever runs (`scope.spawn`, `process`, `timer`,
    /// `observe`, `listen`): the scope releases it all when the feature stops, so the feature
    /// keeps nothing in a static. An `Err` is logged and the feature is off for the session (no
    /// hook runs). At launch it runs while the settings read lock is held: never write settings.
    fn start(&self, _app: &AppHandle<R>, _scope: &FeatureScope) -> Result<(), String> {
        Ok(())
    }
    /// The feature switches off or fails over, before its scope is dropped: flush what must not
    /// be lost (a pending save). Not called for a feature that failed, nor at app exit (`on_exit`).
    fn stop(&self, _app: &AppHandle<R>) {}
    /// A window now has a workspace root (open, switch or restore), and for every such window
    /// when the feature is started after launch.
    #[allow(dead_code)] // no feature uses it yet
    fn on_workspace_open(&self, _app: &AppHandle<R>, _window: &WindowCtx<'_>) {}
    /// A window was destroyed or left its workspace (and, at a stop, every window): stop what it
    /// started for `label`.
    fn on_workspace_close(&self, _app: &AppHandle<R>, _label: &str) {}
    /// `RunEvent::Exit`.
    fn on_exit(&self, _app: &AppHandle<R>) {}

    /// `writer` CLI commands, appended to `cli::registry::COMMANDS`.
    fn cli_commands(&self) -> &'static [CommandSpec] {
        &[]
    }
    /// Commands the `writer` CLI may send to the running app over the local socket, added to
    /// the core allowlist `ipc::commands::CORE` while the feature runs (`ipc::Registry`). Pure
    /// data like `cli_commands`: each names this feature in `IpcCommand::feature`, so the server
    /// answers `feature_off` while its switch is off or it failed. A handler is plain async code
    /// over `ipc::Call`; vault confinement is `Call::confine_existing`, never a path check of
    /// its own.
    fn ipc_commands(&self) -> &'static [IpcCommand] {
        &[]
    }
    /// Managed agent skills, appended to `managed_skills::SKILLS` (changing one needs a
    /// `BUNDLE_VERSION` bump, a test says so).
    fn skills(&self) -> &'static [BundledSkill] {
        &[]
    }
    /// SQL appended to the vault index schema; part of the index schema version.
    fn index_ddl(&self) -> Option<&'static str> {
        None
    }
    /// The file kinds the feature adds to listing and search (`index::kinds`): the suffixes it
    /// owns, the gate that lists it and, optionally, the extractor that makes its files
    /// searchable by content. Pure data like `cli_commands`, read whatever the toggle: the
    /// kind's gate decides whether it is listed. Each id is named in `rust.fileKinds`.
    fn file_kinds(&self) -> &'static [FileKind] {
        &[]
    }

    fn manifest(&self) -> Result<Manifest, serde_json::Error> {
        serde_json::from_str(self.manifest_source())
    }
}

/// Every registered first-party feature, in startup order (teardown runs reversed). A
/// TypeScript-only feature is not listed: its manifest alone is enough.
pub fn registry<R: Runtime>() -> Vec<&'static dyn Feature<R>> {
    vec![
        &agent::Agent,
        &bases::Bases,
        &code_files::CodeFiles,
        &dataview::Dataview,
        &excalidraw::Excalidraw,
        &git::Git,
        &graph::Graph,
        &icons::Icons,
        &lint::Lint,
        &obsidian_host::ObsidianHost,
        &pdf::Pdf,
        &spellcheck::Spellcheck,
        &tasks::Tasks,
    ]
}

/// Is the feature switched on? `features.<id>.enabled` at the global scope (a vault's config can
/// not switch a feature of the app), the manifest default when the setting is absent.
pub fn is_enabled(settings: &Settings, manifest: &Manifest) -> bool {
    settings
        .get_global_or_default(&manifest.enabled_key())
        .and_then(|v| v.as_bool())
        .unwrap_or(manifest.enabled_by_default)
}

/// The features `install` sets up: enabled ones with a readable manifest. A setting for an id
/// that is not in `features` is never looked at, so a stale `features.gone.enabled` is ignored.
pub fn plan<R: Runtime>(
    features: Vec<&'static dyn Feature<R>>,
    settings: &Settings,
) -> Vec<&'static dyn Feature<R>> {
    features
        .into_iter()
        .filter(|f| match f.manifest() {
            Ok(m) => is_enabled(settings, &m),
            Err(e) => {
                log::error!("feature manifest is unreadable, feature skipped: {e}");
                false
            }
        })
        .collect()
}

// ---------- Failure containment ----------

/// Event sent to every window when a feature failed in Rust; payload [`FailedPayload`]. The web
/// host switches that feature's web half off for the session.
pub const FAILED_EVENT: &str = "features:failed";

#[derive(Debug, Clone, Serialize)]
pub struct FailedPayload {
    pub id: String,
    pub boundary: String,
}

/// A feature that failed this session: where and when (unix ms).
#[derive(Debug, Clone, Serialize)]
pub struct Failure {
    pub id: String,
    pub boundary: String,
    pub at: u64,
}

/// What the webview needs after startup: safe mode, the settings the last crash turned off
/// (the notice), this session's failures, which features are started and which are busy
/// (Settings > Features).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub safe_mode: bool,
    pub crash_disabled: Vec<recovery::Disable>,
    pub failures: Vec<Failure>,
    /// The features whose Rust half is up: the web half of one with a Rust half registers only
    /// once its id is here (and on `features:started`).
    pub started: Vec<String>,
    /// Started features that are doing work the user would lose by turning them off.
    pub busy: Vec<Busy>,
}

/// Where a guarded piece of code runs. The name is what the log, the event and the markers carry.
#[derive(Debug, Clone, Copy)]
pub enum Boundary {
    /// `Feature::start`.
    Setup,
    /// `Feature::stop`.
    Stop,
    WorkspaceOpen,
    WorkspaceClose,
    Exit,
    /// A command handler (the synchronous part: see the module docs).
    Command,
    /// A thread or timer started through [`spawn`].
    Thread(&'static str),
    /// Native code declared through [`native`], blamed on this setting when the process dies in it.
    Native(&'static str),
    /// A contribution to a point another feature owns (`points::extend`).
    Hook(&'static str),
}

impl Boundary {
    fn name(&self) -> String {
        match self {
            Boundary::Setup => "setup".into(),
            Boundary::Stop => "stop".into(),
            Boundary::WorkspaceOpen => "on_workspace_open".into(),
            Boundary::WorkspaceClose => "on_workspace_close".into(),
            Boundary::Exit => "on_exit".into(),
            Boundary::Command => "command".into(),
            Boundary::Thread(name) => format!("thread:{name}"),
            Boundary::Native(_) => "native".into(),
            Boundary::Hook(point) => format!("hook:{point}"),
        }
    }

    /// Code that may crash natively or abort gets a marker; commands and threads run too often
    /// for file IO and are covered by `catch_unwind` alone.
    fn marks_inside(&self) -> bool {
        !matches!(
            self,
            Boundary::Command | Boundary::Thread(_) | Boundary::Hook(_)
        )
    }

    fn setting(&self) -> Option<String> {
        match self {
            Boundary::Native(setting) => Some((*setting).to_string()),
            _ => None,
        }
    }
}

/// What startup read from the last run and decided; handed to [`install`].
pub struct Boot {
    files: Option<recovery::Files>,
    safe_mode: bool,
    crashed: Vec<recovery::Disable>,
}

impl Boot {
    /// No markers, no safe mode (tests, and the mock-runtime apps).
    pub fn none() -> Self {
        Self {
            files: None,
            safe_mode: false,
            crashed: Vec::new(),
        }
    }
}

/// Reads what the last run left (markers, startup counter), turns off the setting of a feature
/// the last run died in (through the one settings write path), counts this launch as not ready
/// until [`mark_ready`], and clears the stale markers. Call before [`install`].
pub fn boot(app_data_dir: &Path, settings: &mut Settings) -> Boot {
    let files = recovery::Files::new(app_data_dir);
    let found = files.read_all();
    let plan = recovery::recover(&found, std::process::id(), &|key| {
        settings
            .get_global_or_default(key)
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    });
    for d in &plan.disable {
        match settings.set_global(&d.setting, crate::config::ConfigValue::Bool(false)) {
            Ok(()) => log::warn!(
                "feature {} crashed the last run in {}; {} was turned off",
                d.id,
                d.boundary,
                d.setting
            ),
            Err(e) => log::error!("feature {}: could not turn {} off: {e}", d.id, d.setting),
        }
    }
    if plan.safe_mode {
        log::warn!(
            "{} launches in a row did not finish starting: safe mode (every feature off for this run)",
            found.failed_startups
        );
    }
    files.clear_found();
    files.write_failed_startups(found.failed_startups.saturating_add(1));
    Boot {
        files: Some(files),
        safe_mode: plan.safe_mode,
        crashed: plan.disable,
    }
}

/// Per-app containment state (managed): failed features, the marker stacks and the recovery report.
pub struct Containment {
    files: Option<recovery::Files>,
    pid: u32,
    safe_mode: bool,
    crashed: Vec<recovery::Disable>,
    failures: Mutex<BTreeMap<String, Failure>>,
    /// Leaks per feature after a stop (`lifecycle::STRIKE_LIMIT` fail it for the session).
    strikes: Mutex<BTreeMap<String, u32>>,
    /// Open `inside` markers, innermost last; the file holds the innermost.
    inside: Mutex<Vec<(u64, recovery::Marker)>>,
    active: Mutex<Vec<recovery::Active>>,
    next_token: std::sync::atomic::AtomicU64,
    ready: std::sync::atomic::AtomicBool,
}

impl Containment {
    fn new(boot: Boot) -> Self {
        Self {
            files: boot.files,
            pid: std::process::id(),
            safe_mode: boot.safe_mode,
            crashed: boot.crashed,
            failures: Mutex::new(BTreeMap::new()),
            strikes: Mutex::new(BTreeMap::new()),
            inside: Mutex::new(Vec::new()),
            active: Mutex::new(Vec::new()),
            next_token: std::sync::atomic::AtomicU64::new(0),
            ready: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn is_failed(&self, id: &str) -> bool {
        self.failures.lock().contains_key(id)
    }

    pub fn is_safe_mode(&self) -> bool {
        self.safe_mode
    }

    /// Counts a leak against the feature; returns its strikes so far.
    fn strike(&self, id: &str) -> u32 {
        let mut strikes = self.strikes.lock();
        let n = strikes.entry(id.to_string()).or_insert(0);
        *n += 1;
        *n
    }

    /// The user turned the feature back on: its failure and its strikes are forgotten.
    fn forget(&self, id: &str) {
        self.failures.lock().remove(id);
        self.strikes.lock().remove(id);
    }

    fn record(&self, id: &str, boundary: &str) {
        self.failures.lock().insert(
            id.to_string(),
            Failure {
                id: id.to_string(),
                boundary: boundary.to_string(),
                at: recovery::now_ms(),
            },
        );
    }

    fn enter(&self, id: &str, boundary: &Boundary) -> u64 {
        let token = self
            .next_token
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let marker = recovery::Marker {
            id: id.to_string(),
            boundary: boundary.name(),
            pid: self.pid,
            at: recovery::now_ms(),
            setting: boundary.setting(),
        };
        let mut stack = self.inside.lock();
        if let Some(files) = &self.files {
            files.write_inside(&marker);
        }
        stack.push((token, marker));
        token
    }

    fn leave(&self, token: u64) {
        let mut stack = self.inside.lock();
        stack.retain(|(t, _)| *t != token);
        if let Some(files) = &self.files {
            match stack.last() {
                Some((_, outer)) => files.write_inside(outer),
                None => files.clear_inside(),
            }
        }
    }

    fn set_active(&self, id: &str, setting: &str) {
        let mut list = self.active.lock();
        list.retain(|a| !(a.id == id && a.setting.as_deref() == Some(setting)));
        list.push(recovery::Active {
            id: id.to_string(),
            pid: self.pid,
            at: recovery::now_ms(),
            setting: Some(setting.to_string()),
        });
        if let Some(files) = &self.files {
            files.write_active(&list);
        }
    }

    /// A clean exit: nothing is live any more.
    fn clean_exit(&self) {
        self.active.lock().clear();
        if let Some(files) = &self.files {
            files.write_active(&[]);
            files.clear_inside();
        }
    }

    pub fn status(&self) -> Status {
        Status {
            safe_mode: self.safe_mode,
            crash_disabled: self.crashed.clone(),
            failures: self.failures.lock().values().cloned().collect(),
            started: Vec::new(),
            busy: Vec::new(),
        }
    }
}

fn containment<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::State<'_, Containment>> {
    app.try_state::<Containment>()
}

/// The failures and recovery report, the started and the busy features, for the webview.
pub fn status<R: Runtime>(app: &AppHandle<R>) -> Status {
    let mut status = containment(app).map_or_else(
        || Status {
            safe_mode: false,
            crash_disabled: Vec::new(),
            failures: Vec::new(),
            started: Vec::new(),
            busy: Vec::new(),
        },
        |c| c.status(),
    );
    status.started = started_ids(app);
    status.busy = busy(app);
    status
}

/// The first window finished loading: this launch got far enough, the startup counter resets.
/// Idempotent (it runs for every page load).
pub fn mark_ready<R: Runtime>(app: &AppHandle<R>) {
    let Some(c) = containment(app) else { return };
    if c.ready.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    if let Some(files) = &c.files {
        files.write_failed_startups(0);
    }
}

/// "Restart normally" out of safe mode: the counter resets, the caller restarts the app.
pub fn forget_failed_startups<R: Runtime>(app: &AppHandle<R>) {
    if let Some(files) = containment(app).and_then(|c| c.files.clone()) {
        files.write_failed_startups(0);
    }
}

/// Marks the feature failed for the session, logs it once (id and boundary only; the panic hook
/// already logged the redacted payload) and tells the webview.
fn fail<R: Runtime>(app: &AppHandle<R>, id: &str, boundary: &str, log: bool) {
    if let Some(c) = containment(app) {
        c.record(id, boundary);
    }
    if log {
        log::error!("feature {id} failed in {boundary} and is turned off for this session");
    }
    let payload = FailedPayload {
        id: id.to_string(),
        boundary: boundary.to_string(),
    };
    if let Err(e) = app.emit(FAILED_EVENT, payload) {
        log::warn!("feature {id}: could not announce its failure: {e}");
    }
    // a failed feature keeps no processes, threads or state
    lifecycle::stop_after_failure(app, id);
}

/// The one guard every feature boundary runs through: `f` under `catch_unwind`. A panic marks the
/// feature `failed`, is logged and announced, and comes back as an `Err`; the marker of a
/// boundary that may crash natively is written before `f` and removed after it.
pub fn guard<R: Runtime, T>(
    app: &AppHandle<R>,
    id: &str,
    boundary: Boundary,
    f: impl FnOnce() -> T,
) -> Result<T, String> {
    let state = containment(app);
    let token = state
        .as_ref()
        .filter(|_| boundary.marks_inside())
        .map(|c| c.enter(id, &boundary));
    let out = catch_unwind(AssertUnwindSafe(f));
    if let (Some(c), Some(token)) = (&state, token) {
        c.leave(token);
    }
    match out {
        Ok(v) => Ok(v),
        Err(_payload) => {
            let name = boundary.name();
            fail(app, id, &name, true);
            Err(format!("panic in {name}"))
        }
    }
}

/// Declares native code of feature `id` that stays live until a clean exit (an event monitor, a
/// native observer). `f` installs it under a marker; once it succeeds the feature is recorded in
/// `active-native.json`, so that a crash while the code is live turns `setting` off on the next
/// launch. No feature uses it today (the mouse monitor that did was removed, ADR 2026-11-17
/// "deliver mouse side buttons with DOM events only"); it is the API for the next native feature.
#[allow(dead_code)]
pub fn native<R: Runtime, T>(
    app: &AppHandle<R>,
    id: &str,
    setting: &'static str,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let installed = guard(app, id, Boundary::Native(setting), f)??;
    if let Some(c) = containment(app) {
        c.set_active(id, setting);
    }
    Ok(installed)
}

/// The one command-layer wrapper: a failed feature's commands answer `FeatureUnavailable`
/// instead of running, and a panic in the synchronous part of a handler fails the feature and
/// rejects the call (the resolver is cloned first, a panicking handler cannot answer).
pub fn contain<R: Runtime>(
    id: String,
    handler: InvokeHandler<R>,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        let app = invoke.message.webview().app_handle().clone();
        let unavailable = || AppError::FeatureUnavailable(id.clone());
        if containment(&app).is_some_and(|c| c.is_failed(&id)) {
            invoke.resolver.reject(unavailable());
            return true;
        }
        let resolver = invoke.resolver.clone();
        match guard(&app, &id, Boundary::Command, || handler(invoke)) {
            Ok(handled) => handled,
            Err(_) => {
                resolver.reject(unavailable());
                true
            }
        }
    }
}

/// Is the feature usable right now? Not in safe mode, not failed this session and its switch on.
/// The switch is read live from the global settings (every window shares them), so turning it on
/// or off applies at once; a feature with a plugin needs a restart instead, a gated one does not.
pub fn is_live<R: Runtime>(app: &AppHandle<R>, manifest: &Manifest) -> bool {
    if containment(app).is_some_and(|c| c.safe_mode || c.is_failed(&manifest.id)) {
        return false;
    }
    let Some(state) = app
        .try_state::<AppState>()
        .and_then(|s| s.get(crate::MAIN_WINDOW_LABEL))
    else {
        return manifest.enabled_by_default;
    };
    let settings = state.settings.read();
    settings
        .as_ref()
        .map_or(manifest.enabled_by_default, |s| is_enabled(s, manifest))
}

/// [`is_live`] for the registered feature `id` (a feature without a Rust half is not in the
/// registry, so it is never live here: only Rust code asks).
pub fn is_live_id<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    registry::<R>()
        .into_iter()
        .filter_map(|f| f.manifest().ok())
        .find(|m| m.id == id)
        .is_some_and(|m| is_live(app, &m))
}

/// Wraps the app's invoke handler for a feature whose commands stay registered by the app: a
/// command named in `manifest.rust.gated_commands` runs only while [`is_live`] and through
/// [`contain`] (a failed feature answers `FeatureUnavailable`, a panic fails the feature); every
/// other command goes straight to `handler`.
pub fn gate<R: Runtime>(
    manifest: Manifest,
    handler: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    let handler = Arc::new(handler);
    let inner = handler.clone();
    let contained = contain(manifest.id.clone(), Box::new(move |invoke| inner(invoke)));
    move |invoke| {
        if !manifest
            .rust
            .gated_commands
            .iter()
            .any(|c| c == invoke.message.command())
        {
            return handler(invoke);
        }
        let app = invoke.message.webview().app_handle().clone();
        if !is_live(&app, &manifest) {
            invoke
                .resolver
                .reject(AppError::FeatureUnavailable(manifest.id.clone()));
            return true;
        }
        contained(invoke)
    }
}

#[cfg(test)]
pub(crate) fn fail_for_test<R: Runtime>(app: &AppHandle<R>, id: &str) {
    fail(app, id, "test", false);
}

/// A feature's commands run only while the feature is started (its Rust half is up): otherwise
/// the call answers `FeatureUnavailable`, so a web half that registered early, or a stale
/// window, never calls into state that is not there.
fn started_only<R: Runtime>(id: String, handler: InvokeHandler<R>) -> InvokeHandler<R> {
    Box::new(move |invoke| {
        let app = invoke.message.webview().app_handle().clone();
        if !is_started(&app, &id) {
            invoke
                .resolver
                .reject(AppError::FeatureUnavailable(id.clone()));
            return true;
        }
        handler(invoke)
    })
}

/// The Tauri plugin of a feature's commands: named after the id, handler gated by "started" and
/// contained.
fn plugin_of<R: Runtime>(id: &str, handler: InvokeHandler<R>) -> tauri::plugin::TauriPlugin<R> {
    // `Builder::new` wants a `'static` name; a feature id lives for the process, a few bytes.
    let name: &'static str = Box::leak(id.to_string().into_boxed_str());
    tauri::plugin::Builder::new(name)
        .invoke_handler(contain(
            id.to_string(),
            started_only(id.to_string(), handler),
        ))
        .build()
}

fn id_of<R: Runtime>(f: &dyn Feature<R>) -> String {
    f.manifest().map(|m| m.id).unwrap_or_default()
}

/// Adds the plugin of every feature that has commands (started or not: a command of a feature
/// that is off answers `FeatureUnavailable`, and one switched on later needs no restart), then
/// starts the enabled ones through [`start_feature`], the path every later toggle takes too.
/// Called once from `setup`, after the settings layer exists (the webview already exists too, as
/// for the updater plugin). A feature whose `start` or plugin fails is logged and skipped; the
/// app and the other features keep starting. In safe mode (`boot`) no feature starts.
pub fn install<R: Runtime>(app: &AppHandle<R>, settings: &Settings, boot: Boot) {
    install_booted(app, registry::<R>(), settings, boot);
}

#[cfg(test)]
fn install_features<R: Runtime>(
    app: &AppHandle<R>,
    features: Vec<&'static dyn Feature<R>>,
    settings: &Settings,
) {
    install_booted(app, features, settings, Boot::none());
}

fn install_booted<R: Runtime>(
    app: &AppHandle<R>,
    features: Vec<&'static dyn Feature<R>>,
    settings: &Settings,
    boot: Boot,
) {
    let safe_mode = boot.safe_mode;
    app.manage(Containment::new(boot));
    app.manage(Running::new(features.clone()));
    for f in &features {
        let id = id_of(*f);
        let added = guard(app, &id, Boundary::Setup, || match f.invoke_handler() {
            Some(handler) => app
                .plugin(plugin_of(&id, handler))
                .map_err(|e| e.to_string()),
            None => Ok(()),
        })
        .and_then(|r| r);
        if let Err(e) = added {
            // a panic was announced by the guard; a plain error is announced here
            if !e.starts_with("panic in ") {
                fail(app, &id, "setup", false);
            }
            log::error!(
                "feature {id} could not add its commands and is disabled for this session: {e}"
            );
        }
    }
    if safe_mode {
        return;
    }
    for (id, error) in lifecycle::start_planned(app, plan(features, settings)) {
        log::error!("feature {id} failed to start and is disabled for this session: {error}");
    }
}

// Contributions: pure data. The registry is read for `Wry` only because a runtime must be
// named; none of these methods touch it.

/// Feature CLI commands, for `cli::registry`.
pub fn cli_commands() -> Vec<&'static CommandSpec> {
    cli_commands_of(&registry::<Wry>())
}

fn cli_commands_of<R: Runtime>(features: &[&'static dyn Feature<R>]) -> Vec<&'static CommandSpec> {
    features.iter().flat_map(|f| f.cli_commands()).collect()
}

/// File kinds of every registered feature, for `index::kinds`.
pub fn file_kinds() -> Vec<&'static FileKind> {
    file_kinds_of(&registry::<Wry>())
}

fn file_kinds_of<R: Runtime>(features: &[&'static dyn Feature<R>]) -> Vec<&'static FileKind> {
    features.iter().flat_map(|f| f.file_kinds()).collect()
}

/// The ids of the registered features `is_on` says are off: what a kind gated by a feature switch
/// reads (`code_files::Policy::features_off`). `is_on` is the caller's way to read the switch
/// (live settings in the app, [`cli_enabled`] in the CLI), like [`held_skills`].
pub fn switched_off(is_on: impl Fn(&Manifest) -> bool) -> std::collections::HashSet<String> {
    registry::<Wry>()
        .iter()
        .filter_map(|f| f.manifest().ok())
        .filter(|m| !is_on(m))
        .map(|m| m.id)
        .collect()
}

/// IPC commands of every registered feature, for the CLI client's per-command wait.
pub fn ipc_commands() -> Vec<&'static IpcCommand> {
    ipc_commands_of(&registry::<Wry>())
}

fn ipc_commands_of<R: Runtime>(features: &[&'static dyn Feature<R>]) -> Vec<&'static IpcCommand> {
    features.iter().flat_map(|f| f.ipc_commands()).collect()
}

/// The IPC commands of the features that are started: what the app's
/// socket accepts besides the core commands. A feature that is off, or failed to start, adds none.
pub fn running_ipc_commands<R: Runtime>(app: &AppHandle<R>) -> Vec<&'static IpcCommand> {
    app.try_state::<Running<R>>()
        .map(|running| ipc_commands_of(&running.features()))
        .unwrap_or_default()
}

/// A socket command of feature `id` panicked: the feature is failed for the session, like at any
/// other boundary.
pub fn fail_ipc_command<R: Runtime>(app: &AppHandle<R>, id: &str) {
    fail(app, id, "ipc", true);
}

/// Is the feature `id` switched on, for a process that has no settings layer (the `writer` CLI)?
/// Reads the global `config` file in `data_dir`, like [`is_enabled`] over [`Settings`]: the
/// setting, else the manifest default. An id that is not a registered feature counts as on
/// (the CLI never gates what is not a feature).
pub fn cli_enabled(data_dir: &Path, id: &str) -> bool {
    let manifests = registry::<Wry>()
        .into_iter()
        .filter_map(|f| f.manifest().ok());
    manifests.into_iter().find(|m| m.id == id).is_none_or(|m| {
        crate::config::read_global_bool(data_dir, &m.enabled_key()).unwrap_or(m.enabled_by_default)
    })
}

/// The bundled skills whose feature is switched off, by name: the sync neither installs nor
/// updates them (what is already installed stays as it is). `is_on` is the caller's way to read
/// the switch (live settings in the app, [`cli_enabled`] in the CLI).
pub fn held_skills(is_on: impl Fn(&Manifest) -> bool) -> Vec<&'static str> {
    held_skills_of(&registry::<Wry>(), is_on)
}

fn held_skills_of<R: Runtime>(
    features: &[&'static dyn Feature<R>],
    is_on: impl Fn(&Manifest) -> bool,
) -> Vec<&'static str> {
    features
        .iter()
        .filter(|f| f.manifest().is_ok_and(|m| !is_on(&m)))
        .flat_map(|f| f.skills())
        .map(|s| s.name)
        .collect()
}

/// [`held_skills`] for the running app: a feature that is off, failed or in safe mode holds its
/// skills ([`is_live`]).
pub fn held_skills_live<R: Runtime>(app: &AppHandle<R>) -> Vec<&'static str> {
    held_skills(|m| is_live(app, m))
}

/// Feature skills, for `managed_skills`.
pub fn skills() -> Vec<&'static BundledSkill> {
    skills_of(&registry::<Wry>())
}

fn skills_of<R: Runtime>(features: &[&'static dyn Feature<R>]) -> Vec<&'static BundledSkill> {
    features.iter().flat_map(|f| f.skills()).collect()
}

/// Settings fragments (`settings.schema.json` of each feature), for `config::settings_schema`,
/// which appends their entries to the core file. Every registered feature counts whatever its
/// toggle: a setting must keep its default and its place in the UI while the feature is off.
pub fn settings_fragments() -> Vec<&'static str> {
    settings_fragments_of(&registry::<Wry>())
}

fn settings_fragments_of<R: Runtime>(features: &[&'static dyn Feature<R>]) -> Vec<&'static str> {
    features
        .iter()
        .filter_map(|f| f.settings_source())
        .collect()
}

/// Feature DDL, for `index::schema`.
pub fn index_ddl() -> Vec<&'static str> {
    index_ddl_of(&registry::<Wry>())
}

fn index_ddl_of<R: Runtime>(features: &[&'static dyn Feature<R>]) -> Vec<&'static str> {
    features.iter().filter_map(|f| f.index_ddl()).collect()
}

/// Suffix of the index schema version: empty when no feature adds DDL (an app without such a
/// feature never rebuilds its indexes), else a hash of every DDL feature's id, manifest version
/// and DDL (a changed table or a bumped contract version rebuilds the cache). Registered
/// features count whatever their toggle, so switching one never rebuilds the index.
pub fn index_schema_suffix() -> String {
    index_schema_suffix_of(&registry::<Wry>())
}

fn index_schema_suffix_of<R: Runtime>(features: &[&'static dyn Feature<R>]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325; // FNV-1a: stable across builds and platforms
    let mut any = false;
    for f in features {
        let Some(ddl) = f.index_ddl() else { continue };
        any = true;
        let m = f
            .manifest()
            .expect("feature manifest parses (contract test)");
        for b in
            m.id.bytes()
                .chain([0])
                .chain(m.version.bytes())
                .chain([0])
                .chain(ddl.bytes())
        {
            hash ^= b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    if any {
        format!("+{hash:016x}")
    } else {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ConfigValue;
    use std::sync::Mutex;
    use tauri::test::mock_app;

    pub(super) fn settings_with(dir: &std::path::Path, values: &[(&str, bool)]) -> Settings {
        let mut s = Settings::new(dir.to_path_buf()).unwrap();
        for (k, v) in values {
            s.set_global(k, ConfigValue::Bool(*v)).unwrap();
        }
        s
    }

    #[derive(Clone, Copy)]
    enum Mode {
        Ok,
        Error,
        Panic,
    }

    /// A feature that records every hook into a log shared with the test.
    struct Probe {
        manifest: &'static str,
        log: &'static Mutex<Vec<String>>,
        mode: Mode,
        ddl: Option<&'static str>,
    }

    impl Probe {
        fn note(&self, what: &str) {
            let id = Feature::<tauri::test::MockRuntime>::manifest(self)
                .unwrap()
                .id;
            self.log.lock().unwrap().push(format!("{what}:{id}"));
        }
    }

    impl<R: Runtime> Feature<R> for Probe {
        fn manifest_source(&self) -> &'static str {
            self.manifest
        }
        fn start(&self, _app: &AppHandle<R>, _scope: &FeatureScope) -> Result<(), String> {
            self.note("setup");
            match self.mode {
                Mode::Ok => Ok(()),
                Mode::Error => Err("forced setup error".into()),
                Mode::Panic => panic!("forced setup panic"),
            }
        }
        fn on_workspace_open(&self, _app: &AppHandle<R>, w: &WindowCtx<'_>) {
            self.note(&format!("open({})", w.label));
        }
        fn on_workspace_close(&self, _app: &AppHandle<R>, label: &str) {
            self.note(&format!("close({label})"));
        }
        fn on_exit(&self, _app: &AppHandle<R>) {
            self.note("exit");
        }
        fn index_ddl(&self) -> Option<&'static str> {
            self.ddl
        }
    }

    const A: &str = r#"{"id":"probe-a","name":"A","version":"1.0.0"}"#;
    const B: &str = r#"{"id":"probe-b","name":"B","version":"1.0.0"}"#;

    fn entries(log: &Mutex<Vec<String>>) -> Vec<String> {
        log.lock().unwrap().clone()
    }

    #[test]
    fn the_registry_lists_the_features_and_every_entry_has_a_valid_manifest() {
        let ids: Vec<String> = registry::<Wry>()
            .iter()
            .map(|f| f.manifest().expect("manifest parses").id)
            .collect();
        assert_eq!(
            ids,
            [
                "agent",
                "bases",
                "code-files",
                "dataview",
                "excalidraw",
                "git",
                "graph",
                "icons",
                "lint",
                "obsidian-host",
                "pdf",
                "spellcheck",
                "tasks"
            ]
        );
    }

    #[test]
    fn fragments_are_read_from_every_registered_feature_whatever_its_toggle() {
        let all = settings_fragments();
        assert!(all.iter().any(|f| f.contains("\"agent.binary-path\"")));
        // the core defaults include the agent's, so a disabled feature keeps its settings
        assert!(crate::config::default_settings().contains_key("agent.pane-width"));
        assert_eq!(settings_fragments_of(&fixture::registry::<Wry>()).len(), 1);
    }

    #[test]
    fn install_registers_enabled_features_only() {
        let dir = tempfile::tempdir().unwrap();
        let on = settings_with(dir.path(), &[]);
        assert_eq!(
            plan(fixture::registry::<Wry>(), &on).len(),
            1,
            "default is on"
        );

        let dir = tempfile::tempdir().unwrap();
        let off = settings_with(dir.path(), &[("features.fixture-hello.enabled", false)]);
        assert!(plan(fixture::registry::<Wry>(), &off).is_empty());
    }

    #[test]
    fn a_setting_for_an_unknown_feature_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let s = settings_with(
            dir.path(),
            &[
                ("features.ghost.enabled", false),
                ("features.fixture-hello.enabled", true),
            ],
        );
        assert_eq!(plan(fixture::registry::<Wry>(), &s).len(), 1);
    }

    #[test]
    fn a_stale_line_of_a_removed_feature_is_harmless() {
        // `features.mouse-buttons.enabled = false` stays in configs written before that feature was
        // removed: an unknown key, never read, kept on disk, and the features still plan.
        let dir = tempfile::tempdir().unwrap();
        let mut s = settings_with(dir.path(), &[("features.mouse-buttons.enabled", false)]);
        assert!(!crate::config::default_settings().contains_key("features.mouse-buttons.enabled"));
        let reloaded = Settings::new(dir.path().to_path_buf()).unwrap();
        assert_eq!(
            plan(registry::<Wry>(), &reloaded).len(),
            13,
            "the agent, bases, code-files, dataview, excalidraw, git, graph, icons, lint, obsidian-host, pdf, spellcheck and tasks still start"
        );
        // an unrelated write keeps the line instead of tripping over it
        s.set_global(
            "features.agent.enabled",
            crate::config::ConfigValue::Bool(true),
        )
        .unwrap();
        let text = std::fs::read_to_string(dir.path().join("config")).unwrap();
        assert!(text.contains("features.mouse-buttons.enabled"), "{text}");
    }

    #[test]
    fn a_broken_manifest_skips_the_feature_instead_of_aborting() {
        static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
        static BROKEN: Probe = Probe {
            manifest: "{ not json",
            log: &LOG,
            mode: Mode::Ok,
            ddl: None,
        };
        let dir = tempfile::tempdir().unwrap();
        let s = settings_with(dir.path(), &[]);
        let features: Vec<&'static dyn Feature<Wry>> = vec![&BROKEN];
        assert!(plan(features, &s).is_empty());
    }

    #[test]
    fn a_disabled_feature_is_never_set_up_and_gets_no_hooks() {
        static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
        static P: Probe = Probe {
            manifest: A,
            log: &LOG,
            mode: Mode::Ok,
            ddl: None,
        };
        let dir = tempfile::tempdir().unwrap();
        let s = settings_with(dir.path(), &[("features.probe-a.enabled", false)]);
        let app = mock_app();
        install_features(app.handle(), vec![&P], &s);
        workspace_open(app.handle(), "main", Path::new("/vault"));
        workspace_close(app.handle(), "main");
        exit(app.handle());
        assert!(entries(&LOG).is_empty(), "{:?}", entries(&LOG));
    }

    #[test]
    fn hooks_run_in_order_and_teardown_in_reverse() {
        static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
        static PA: Probe = Probe {
            manifest: A,
            log: &LOG,
            mode: Mode::Ok,
            ddl: None,
        };
        static PB: Probe = Probe {
            manifest: B,
            log: &LOG,
            mode: Mode::Ok,
            ddl: None,
        };
        let dir = tempfile::tempdir().unwrap();
        let s = settings_with(dir.path(), &[]);
        let app = mock_app();
        install_features(app.handle(), vec![&PA, &PB], &s);
        workspace_open(app.handle(), "w-1", Path::new("/vault"));
        workspace_close(app.handle(), "w-1");
        exit(app.handle());
        assert_eq!(
            entries(&LOG),
            [
                "setup:probe-a",
                "setup:probe-b",
                "open(w-1):probe-a",
                "open(w-1):probe-b",
                "close(w-1):probe-b",
                "close(w-1):probe-a",
                "exit:probe-b",
                "exit:probe-a",
            ]
        );
    }

    #[test]
    fn a_failing_or_panicking_setup_is_isolated_and_the_app_still_starts() {
        static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
        static BAD: Probe = Probe {
            manifest: A,
            log: &LOG,
            mode: Mode::Error,
            ddl: None,
        };
        static WORSE: Probe = Probe {
            manifest: B,
            log: &LOG,
            mode: Mode::Panic,
            ddl: None,
        };
        const C: &str = r#"{"id":"probe-c","name":"C"}"#;
        static GOOD: Probe = Probe {
            manifest: C,
            log: &LOG,
            mode: Mode::Ok,
            ddl: None,
        };
        let dir = tempfile::tempdir().unwrap();
        let s = settings_with(dir.path(), &[]);
        let app = mock_app();
        install_features(app.handle(), vec![&BAD, &WORSE, &GOOD], &s);
        assert_eq!(
            started_ids(app.handle()),
            ["probe-c"],
            "only the healthy feature runs"
        );
        let failed: Vec<String> = status(app.handle())
            .failures
            .iter()
            .map(|f| f.id.clone())
            .collect();
        assert_eq!(failed, ["probe-a", "probe-b"]);

        // the failed features get no hooks
        LOG.lock().unwrap().clear();
        workspace_open(app.handle(), "main", Path::new("/vault"));
        assert!(
            entries(&LOG).contains(&"open(main):probe-c".to_string())
                && !entries(&LOG).iter().any(|e| e == "open(main):probe-a"),
            "{:?}",
            entries(&LOG)
        );
    }

    #[test]
    fn contributions_are_collected_from_features() {
        static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
        static PLAIN: Probe = Probe {
            manifest: A,
            log: &LOG,
            mode: Mode::Ok,
            ddl: None,
        };
        static WITH_DDL: Probe = Probe {
            manifest: B,
            log: &LOG,
            mode: Mode::Ok,
            ddl: Some("CREATE TABLE feature_b(id INTEGER);"),
        };
        static WITH_DDL_V2: Probe = Probe {
            manifest: r#"{"id":"probe-b","name":"B","version":"2.0.0"}"#,
            log: &LOG,
            mode: Mode::Ok,
            ddl: Some("CREATE TABLE feature_b(id INTEGER);"),
        };
        let plain: Vec<&'static dyn Feature<Wry>> = vec![&PLAIN];
        assert!(cli_commands_of(&plain).is_empty());
        assert!(skills_of(&plain).is_empty());
        assert!(index_ddl_of(&plain).is_empty());
        assert_eq!(
            index_schema_suffix_of(&plain),
            "",
            "no DDL: the core schema version is unchanged"
        );

        let with: Vec<&'static dyn Feature<Wry>> = vec![&PLAIN, &WITH_DDL];
        assert_eq!(index_ddl_of(&with), ["CREATE TABLE feature_b(id INTEGER);"]);
        let suffix = index_schema_suffix_of(&with);
        assert!(suffix.starts_with('+') && suffix.len() == 17, "{suffix}");
        assert_eq!(suffix, index_schema_suffix_of(&with), "stable");
        let v2: Vec<&'static dyn Feature<Wry>> = vec![&WITH_DDL_V2];
        assert_ne!(
            suffix,
            index_schema_suffix_of(&v2),
            "manifest version counts"
        );
    }

    #[test]
    fn the_registered_features_add_exactly_their_contributions_to_the_core_tables() {
        let names: Vec<_> = cli_commands().iter().map(|c| c.name).collect();
        assert_eq!(
            names,
            [
                "project:archive",
                "project:unarchive",
                "bases",
                "base:views",
                "base:create",
                "base:query",
                "dql",
                "excalidraw:create",
                "excalidraw:add",
                "excalidraw:update",
                "excalidraw:read",
                "excalidraw:lint",
                "excalidraw:export",
                "excalidraw:preview",
                "git:status",
                "git:log",
                "git:diff",
                "git:show",
                "git:restore",
                "git:sync",
                "git:commit",
                "icon:set",
                "icon:get",
                "icon:remove",
                "lint",
                "lint:fix",
                "check",
                "task:add",
                "task:done",
                "task:edit"
            ]
        );
        assert!(cli_commands().iter().all(|c| c.feature
            == Some(if c.name.starts_with("project:") {
                "agent"
            } else if c.name.starts_with("excalidraw:") {
                "excalidraw"
            } else if c.name.starts_with("git:") {
                "git"
            } else if c.name.starts_with("icon:") {
                "icons"
            } else if c.name.starts_with("task:") {
                "tasks"
            } else if c.name == "dql" {
                "dataview"
            } else if c.name == "lint" || c.name == "lint:fix" {
                "lint"
            } else if c.name == "check" {
                "spellcheck"
            } else {
                "bases"
            })));
        let skills: Vec<_> = skills().iter().map(|s| s.name).collect();
        assert_eq!(
            skills,
            [
                "writer-bases",
                "writer-excalidraw",
                "writer-diagram",
                "writer-git",
                "writer-lint"
            ]
        );
        assert!(index_ddl().is_empty());
        assert_eq!(index_schema_suffix(), "");
        assert!(crate::index::schema_version()
            .chars()
            .all(|c| c.is_ascii_digit()));
        assert_eq!(
            crate::cli::registry::commands().count(),
            crate::cli::registry::COMMANDS.len() + 30
        );
        assert_eq!(
            crate::managed_skills::all_skills().count(),
            crate::managed_skills::SKILLS.len() + 5
        );
    }

    #[test]
    fn a_feature_that_is_off_holds_exactly_its_skills_and_the_cli_reads_the_switch_from_the_file() {
        let off = |m: &Manifest| m.id != "bases";
        assert_eq!(held_skills(off), ["writer-bases"]);
        assert!(held_skills(|_| true).is_empty());

        let dir = tempfile::tempdir().unwrap();
        assert!(
            cli_enabled(dir.path(), "bases"),
            "no config: the manifest default"
        );
        std::fs::write(
            dir.path().join("config"),
            "features.bases.enabled = false\n",
        )
        .unwrap();
        assert!(!cli_enabled(dir.path(), "bases"));
        std::fs::write(dir.path().join("config"), "features.bases.enabled = true\n").unwrap();
        assert!(cli_enabled(dir.path(), "bases"));
        assert!(
            cli_enabled(dir.path(), "not-a-feature"),
            "only features are gated"
        );
    }
}
