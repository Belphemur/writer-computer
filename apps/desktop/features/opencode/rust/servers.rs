//! The OpenCode servers of the app: one [`OpencodeServer`] per window and vault, made when the
//! first OpenCode chat of that window starts (or when Settings asks for the model list) and
//! stopped when the window closes, the vault changes or the feature goes off. Nothing starts
//! with the feature: with no chat and no settings page there is no process (spec
//! `SPECs/opencode-backend-spec.md` section 5, "Start").
//!
//! The one owner of the Tauri-facing facts the pure server needs: where the program is (the
//! user's own path, else the usual search), the app data folder (config file, the empty config
//! home of the fallback, shell wrapper), the environment (the login shell's `PATH` with the `writer` launcher folder
//! first, and the user's `SHELL`, which the server hands to its wrapper). Everything it starts
//! lives in the feature's scope: the runtime threads and the child through the scope's
//! `Spawner`, the state itself through `scope.manage`.

use super::client::{Client, Io, SHORT};
use super::config::{self, ConfigInput};
use super::opencode_api as api;
use super::server::{
    Launcher, OpencodeServer, ProcessLauncher, ServerSettings, Stored, CONFIG_HOME_NAME,
    SHELL_WRAPPER_NAME,
};
use crate::agent::binary::{self, Program};
use crate::agent::pending_delete::PendingDeletes;
use crate::agent::{cli_launcher, env};
use crate::features::scope::Spawner;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// The program every window runs.
pub const PROGRAM: Program = Program {
    name: "opencode",
    // where the installer script of OpenCode puts its binary
    extra_dirs: &[".opencode/bin"],
};
/// The event the web half listens to: the server's list of models changed.
pub const MODELS_EVENT: &str = "opencode:models-updated";
/// The setting with the user's own path to it.
pub const BINARY_SETTING: &str = "agent.opencode.binary-path";

pub(super) type Env = Arc<dyn Fn(Option<&Path>) -> Vec<(String, String)> + Send + Sync>;

struct Entry {
    root: PathBuf,
    program: PathBuf,
    server: Arc<OpencodeServer>,
}

/// The servers of the started feature, by window label.
pub struct Servers<R: Runtime> {
    app: AppHandle<R>,
    spawner: Spawner,
    /// The app data folder: Writer's config, empty config home and shell wrapper live below it,
    /// the `writer` launcher next to them. `None` when the app has none (no server can start).
    app_data: Option<PathBuf>,
    launcher: Arc<dyn Launcher>,
    /// The environment of a server, given the folder of the `writer` launcher.
    env: Env,
    entries: Mutex<HashMap<String, Entry>>,
    stopped: AtomicBool,
    /// The names of the providers each window's server listed, so one that is switched off (and no
    /// longer listed) keeps its tab under the name it had.
    provider_names: Arc<Mutex<HashMap<String, std::collections::BTreeMap<String, String>>>>,
    /// The sessions owed a delete (see `pending.rs`); `None` with no app data folder.
    pending: Option<Arc<PendingDeletes>>,
}

/// The vault's stable name (config file, pending deletes): `agent::pending_delete::vault_id`.
pub use crate::agent::pending_delete::vault_id;

impl<R: Runtime> Servers<R> {
    pub fn new(app: AppHandle<R>, spawner: Spawner) -> Self {
        let app_data = app.path().app_data_dir().ok();
        let launcher = Arc::new(ProcessLauncher {
            spawner: spawner.clone(),
        });
        // the login shell's PATH with the launcher's folder first, and the user's own SHELL (the
        // server hands it to its wrapper): `agent::env`, the same environment a Claude chat gets
        let env: Env = Arc::new(env::current);
        Self::with(app, spawner, launcher, app_data, env)
    }

    /// The servers with the launcher and the data folder given (tests bring a fake OpenCode and a
    /// temporary folder).
    pub(super) fn with(
        app: AppHandle<R>,
        spawner: Spawner,
        launcher: Arc<dyn Launcher>,
        app_data: Option<PathBuf>,
        env: Env,
    ) -> Self {
        Self {
            app,
            spawner,
            launcher,
            env,
            entries: Mutex::new(HashMap::new()),
            provider_names: Arc::default(),
            stopped: AtomicBool::new(false),
            pending: app_data
                .as_ref()
                .map(|d| Arc::new(PendingDeletes::new(d.join(super::driver::ID)))),
            app_data,
        }
    }

    pub fn spawner(&self) -> &Spawner {
        &self.spawner
    }

    /// A global setting of the window as a string (`None` when unset or blank).
    pub fn setting(&self, label: &str, key: &str) -> Option<String> {
        crate::config::global_nonblank(&self.app, label, key)
    }

    /// The app, for the one reader of the list settings ([`crate::config::global_list`]).
    pub fn app(&self) -> &AppHandle<R> {
        &self.app
    }

    /// The program: the user's own path, else the usual search. Blocking (login shell).
    pub fn find(&self, label: &str) -> Option<PathBuf> {
        binary::find_program(&PROGRAM, self.setting(label, BINARY_SETTING).as_deref())
    }

    /// How many servers run.
    pub fn count(&self) -> usize {
        self.entries.lock().len()
    }

    /// The sessions executing a turn, over every window.
    pub fn running_turns(&self) -> usize {
        self.entries
            .lock()
            .values()
            .map(|e| e.server.running_turns())
            .sum()
    }

    /// Whether the window has a server (started or not yet: it starts with its first chat).
    #[cfg(test)]
    pub fn has(&self, label: &str) -> bool {
        self.entries.lock().contains_key(label)
    }

    /// The server of window `label` and vault `root`: the one it has, or a new one (the old one
    /// stops first when the vault or the program changed). Nothing is started yet: that is
    /// `ensure_started`'s, on the first chat. Blocking (program search).
    pub fn server(&self, label: &str, root: &Path) -> Result<Arc<OpencodeServer>, String> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err("OpenCode is switched off".into());
        }
        // not found: the bare name, so the start says "not found" the way every other start does
        let program = self
            .find(label)
            .unwrap_or_else(|| PathBuf::from(PROGRAM.name));
        let mut entries = self.entries.lock();
        if let Some(e) = entries.get(label) {
            if e.root == root && e.program == program {
                return Ok(Arc::clone(&e.server));
            }
        }
        let old = entries.remove(label);
        let server = self.make(label, &program, root)?;
        entries.insert(
            label.to_string(),
            Entry {
                root: root.to_path_buf(),
                program,
                server: Arc::clone(&server),
            },
        );
        drop(entries);
        // stopped off the lock and off this thread: a process that is slow to end must not hold
        // the next chat, or the UI
        if let Some(old) = old {
            self.retire(old.server);
        }
        Ok(server)
    }

    /// Stops `server` on a thread of the feature (the process can take seconds to end: SIGTERM,
    /// then the kill). With no thread to be had (the feature is stopping) it is stopped here.
    fn retire(&self, server: Arc<OpencodeServer>) {
        let other = Arc::clone(&server);
        if self
            .spawner
            .spawn("opencode-stop", move |_| other.shutdown())
            .is_err()
        {
            server.shutdown();
        }
    }

    fn make(
        &self,
        label: &str,
        program: &Path,
        root: &Path,
    ) -> Result<Arc<OpencodeServer>, String> {
        let app_data = self
            .app_data
            .clone()
            .ok_or("Writer has no data folder to keep OpenCode's files in")?;
        let home = app_data.join("opencode");
        let settings = ServerSettings {
            program: program.to_path_buf(),
            root: root.to_path_buf(),
            config_file: home.join(format!("{}.json", vault_id(root))),
            config_home: home.join(CONFIG_HOME_NAME),
            shell_wrapper: home.join(SHELL_WRAPPER_NAME),
            app_data: app_data.clone(),
        };
        let io = Io::start(&self.spawner)?;
        let owed = self.pending.clone();
        let vault = vault_id(root);
        // the folder with the `writer` launcher goes first on the server's PATH, so the agent's
        // shell finds the `writer` command the managed skills name
        let launcher = cli_launcher::shared_dir(&app_data);
        let inherit = Arc::clone(&self.env);
        let server = OpencodeServer::new(
            io,
            Arc::clone(&self.launcher),
            settings,
            Box::new(move || inherit(launcher.as_deref())),
        );
        // the user's switches, read at every write of the config (a switch applies at the next one)
        let (app, label) = (self.app.clone(), label.to_string());
        server.on_switches(Arc::new(move || Stored {
            mcp_on: crate::config::global_list(&app, &label, config::MCP_SWITCHES.setting),
            providers_off: crate::config::global_list(&app, &label, config::PROVIDERS_OFF_SETTING),
        }));
        // the settings page reads the models again when the server says they changed
        let app = self.app.clone();
        server.on_models_changed(Box::new(move || {
            let _ = app.emit(MODELS_EVENT, ());
        }));
        // what this vault is owed from before (the sessions of chats deleted while no server ran)
        server.on_up(Box::new(move |client| {
            let Some(owed) = owed.clone() else { return };
            let ids = owed.take(&vault);
            if ids.is_empty() {
                return;
            }
            let (client, vault) = (client.clone(), vault.clone());
            let io = Arc::clone(client.io());
            io.spawn(async move {
                for id in ids {
                    if !delete_session(&client, &id).await {
                        owed.add(&vault, &id);
                    }
                }
            });
        }));
        Ok(server)
    }

    /// A deleted chat's session: deleted now when this window's server for `root` is up, else
    /// kept (ids only, in the app data folder) and deleted the next time a server of the vault
    /// starts. Nothing is started for it. Blocking.
    pub fn forget(&self, label: &str, root: &Path, session: &str) {
        let up = self
            .entries
            .lock()
            .get(label)
            .filter(|e| e.root == root)
            .map(|e| Arc::clone(&e.server))
            .filter(|s| s.connection().is_some());
        let done = up.is_some_and(|server| {
            let conn = server.connection();
            let (Some(conn), id) = (conn, session.to_string()) else {
                return false;
            };
            let client = conn.client.clone();
            server
                .io()
                .call(async move { delete_session(&client, &id).await }, SHORT)
                .unwrap_or(false)
        });
        log::debug!(target: "opencode", "opencode: a deleted chat's session was removed (ok: {done})");
        if !done {
            self.record(root, session);
        }
    }

    /// Keeps `session` to be deleted the next time a server of the vault starts.
    pub fn record(&self, root: &Path, session: &str) {
        if let Some(p) = &self.pending {
            p.add(&vault_id(root), session);
        }
    }

    #[cfg(test)]
    pub(super) fn owed(&self, root: &Path) -> Vec<String> {
        self.pending
            .as_ref()
            .map(|p| p.peek(&vault_id(root)))
            .unwrap_or_default()
    }

    /// The server of the window, running: Writer's own configuration is written first (a
    /// server that is up keeps the richer one a chat made), then it starts. Blocking. For what
    /// needs a server without a chat (the model list, the saved rules, a title of a closed chat).
    pub fn ensure_up(&self, label: &str, root: &Path) -> Result<Arc<OpencodeServer>, String> {
        let server = self.server(label, root)?;
        if server.connection().is_none() {
            let text = config::render(&ConfigInput {
                table: super::adapter::table(),
                roles: None,
                mcp: None,
                found: &config::discover(root),
            });
            server.apply_config(&text).map_err(|e| e.to_string())?;
            server.ensure_started().map_err(|e| e.to_string())?;
        }
        Ok(server)
    }

    /// Whether the window's server loaded the user's config; `None` while it has no server up.
    pub fn global_config(&self, label: &str) -> Option<super::server::GlobalConfig> {
        self.entries.lock().get(label)?.server.global_config()
    }

    /// The provider tabs of the window's server: its providers and the ones switched off.
    /// Starts it. Blocking.
    pub fn providers(
        &self,
        label: &str,
        root: &Path,
    ) -> Result<Vec<super::models::ProviderRow>, String> {
        let server = self.ensure_up(label, root)?;
        let client = server.connection().ok_or("OpenCode is not running")?.client;
        let off = crate::config::global_list(&self.app, label, config::PROVIDERS_OFF_SETTING);
        let asked = off.clone();
        let (names, key) = (Arc::clone(&self.provider_names), label.to_string());
        server
            .io()
            .call(
                async move {
                    // the first answer after a start can be empty (the providers settle a moment later)
                    let mut rows = Vec::new();
                    for attempt in 0..8 {
                        if attempt > 0 {
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        }
                        let reply = client.get(&api::PROVIDERS, &[]).await?;
                        rows = super::models::provider_rows(
                            &reply,
                            &asked,
                            names.lock().entry(key.clone()).or_default(),
                        );
                        if rows.iter().any(|r| !r.off) {
                            break;
                        }
                    }
                    Ok::<_, super::client::ApiError>(rows)
                },
                std::time::Duration::from_secs(12),
            )
            .ok_or("OpenCode did not answer")?
            .map_err(|_| "OpenCode could not list its providers".to_string())
    }

    /// A switch changed: the window's configuration is rendered again and the server reads it when
    /// no turn runs. Nothing is started for it (a server that is not up renders it at its start).
    /// Blocking.
    pub fn reapply(&self, label: &str) -> Result<(), String> {
        let server = self
            .entries
            .lock()
            .get(label)
            .map(|e| Arc::clone(&e.server));
        match server {
            Some(s) => s.reapply().map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    /// The window closed or left its vault: its server and every chat on it go. Returns at once;
    /// the server stops on a thread of its own.
    pub fn shutdown_window(&self, label: &str) {
        let old = self.entries.lock().remove(label);
        if let Some(e) = old {
            self.retire(e.server);
        }
    }

    /// The feature stops or the app exits: no process remains. Later asks are refused. Waits for
    /// every process (the scope's stop and the app's exit need it done, and no thread of the
    /// scope can be started any more).
    pub fn shutdown_all(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let all: Vec<Entry> = self.entries.lock().drain().map(|(_, e)| e).collect();
        for e in all {
            e.server.shutdown();
        }
    }
}

/// Deletes one session; one that is already gone counts as deleted.
pub(super) async fn delete_session(client: &Client, id: &str) -> bool {
    match client
        .request(&api::SESSION_DELETE, &[("sessionID", id)], &[], None, SHORT)
        .await
    {
        Ok(_) => true,
        Err(e) => e.is_not_found(),
    }
}
