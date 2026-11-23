//! Auto-updater state machine, native menu wiring, and release-check plumbing.
//!
//! v1 deliberately keeps the entire user-facing surface in the native app menu
//! and native dialogs — no React components.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::menu::MenuItem;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri::{AppHandle, Manager, WebviewWindow, Wry};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogBuilder, MessageDialogButtons, MessageDialogKind,
};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Pick a window to anchor native dialogs to. Without a parent, `rfd` falls
/// back to `CFUserNotificationDisplayAlert` on macOS, which shows a generic
/// system icon instead of our app icon. Passing any visible window forces the
/// `NSAlert` path, which displays the running app's icon.
fn dialog_parent(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_visible().unwrap_or(false))
        .or_else(|| app.webview_windows().into_values().next())
}

fn with_parent<R: tauri::Runtime>(
    mut builder: MessageDialogBuilder<R>,
    parent: Option<&WebviewWindow<R>>,
) -> MessageDialogBuilder<R> {
    if let Some(parent) = parent {
        builder = builder.parent(parent);
    }
    builder
}

/// Where the releases (and so the downloads for a package install) live; the updater endpoint in
/// `tauri.conf.json` is under it, and both name the repository of `shared/release.json` (a test
/// pins that).
const RELEASES_URL: &str = "https://github.com/Belphemur/writer-computer/releases";

/// How an update reaches this install.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallKind {
    /// macOS app bundle or Linux AppImage: the updater downloads, replaces and restarts.
    SelfUpdate,
    /// `.deb`/`.rpm`: the package manager owns the files, so we only point at the download.
    Package,
}

/// An AppImage is the only Linux install the updater can replace. The bundle type is the one the
/// updater plugin reads (`tauri::utils::platform::bundle_type`, stamped into the binary by the
/// bundler); any other Linux run is a package (or a build from source) and must not self-update.
fn install_kind(bundle: Option<BundleType>, linux: bool) -> InstallKind {
    if linux && bundle != Some(BundleType::AppImage) {
        InstallKind::Package
    } else {
        InstallKind::SelfUpdate
    }
}

fn release_page(version: &str) -> String {
    format!("{RELEASES_URL}/tag/v{version}")
}

const DAILY_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
const DISMISSED_VERSION_FILE: &str = "updater-dismissed-version.json";

/// State machine for the updater lifecycle.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum UpdaterState {
    Idle,
    Checking,
    UpToDate,
    Available { version: String },
    Downloading,
    ReadyToInstall { version: String },
    Error { message: String },
}

/// Menu item handles the state machine rebuilds on each transition.
pub struct UpdaterMenuItems {
    pub check: MenuItem<Wry>,
}

/// Application-managed state that owns the updater lifecycle.
pub struct UpdaterManager {
    state: Mutex<UpdaterState>,
    menu_items: UpdaterMenuItems,
    pending_update: Mutex<Option<Update>>,
    dismissed: DismissedVersion,
}

#[derive(Serialize, Deserialize)]
struct DismissedVersionFile {
    dismissed: Option<String>,
}

/// The version the user said "Later" to, kept on disk so automatic checks stay quiet about it.
struct DismissedVersion {
    path: PathBuf,
}

impl DismissedVersion {
    fn read(&self) -> Option<String> {
        let data = std::fs::read_to_string(&self.path).ok()?;
        let parsed: DismissedVersionFile = serde_json::from_str(&data).ok()?;
        parsed.dismissed
    }

    fn write(&self, version: Option<&str>) {
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file = DismissedVersionFile {
            dismissed: version.map(|s| s.to_string()),
        };
        if let Ok(json) = serde_json::to_string(&file) {
            let _ = std::fs::write(&self.path, json);
        }
    }
}

/// What both update dialogs (install and download) do with the answer: accepting runs `accept`;
/// "Later" remembers the version and runs `clear` (drop the pending update, back to idle).
fn settle(
    accepted: bool,
    version: &str,
    dismissed: &DismissedVersion,
    accept: impl FnOnce(),
    clear: impl FnOnce(),
) {
    if accepted {
        accept();
    } else {
        dismissed.write(Some(version));
        clear();
    }
}

impl UpdaterManager {
    pub fn new(menu_items: UpdaterMenuItems, app_data_dir: PathBuf) -> Self {
        let manager = Self {
            state: Mutex::new(UpdaterState::Idle),
            menu_items,
            pending_update: Mutex::new(None),
            dismissed: DismissedVersion {
                path: app_data_dir.join(DISMISSED_VERSION_FILE),
            },
        };
        manager.refresh_menu(&UpdaterState::Idle);
        manager
    }

    fn set_state(&self, new: UpdaterState) {
        self.refresh_menu(&new);
        *self.state.lock() = new;
    }

    /// Atomically transition from a non-busy state to `Checking`. Returns
    /// `false` if the updater was already mid-check or mid-download, so
    /// callers can bail without racing another task.
    fn try_begin_check(&self) -> bool {
        {
            let mut state = self.state.lock();
            if matches!(&*state, UpdaterState::Checking | UpdaterState::Downloading) {
                return false;
            }
            *state = UpdaterState::Checking;
        }
        self.refresh_menu(&UpdaterState::Checking);
        true
    }

    fn refresh_menu(&self, state: &UpdaterState) {
        let (check_text, check_enabled) = match state {
            UpdaterState::Checking => ("Checking for Updates…".to_string(), false),
            UpdaterState::Downloading => ("Downloading Update…".to_string(), false),
            _ => ("Check for Updates…".to_string(), true),
        };

        let _ = self.menu_items.check.set_text(check_text);
        let _ = self.menu_items.check.set_enabled(check_enabled);
    }

    /// Drop the pending update and go back to idle: the user answered, or it was handled.
    fn reset(&self) {
        *self.pending_update.lock() = None;
        self.set_state(UpdaterState::Idle);
    }
}

fn manager(app: &AppHandle) -> tauri::State<'_, UpdaterManager> {
    app.state::<UpdaterManager>()
}

/// Trigger a check for updates. `manual = true` surfaces "up to date" and error
/// dialogs; automatic checks stay quiet when there's nothing to do.
pub fn start_check(app: AppHandle, manual: bool) {
    if !manager(&app).try_begin_check() {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let check_result = match app.updater() {
            Ok(updater) => updater.check().await,
            Err(err) => Err(err),
        };

        match check_result {
            Ok(Some(update)) => {
                let version = update.version.clone();
                let notes = update.body.clone();

                if !manual {
                    let dismissed = manager(&app).dismissed.read();
                    if dismissed.as_deref() == Some(version.as_str()) {
                        manager(&app).set_state(UpdaterState::UpToDate);
                        return;
                    }
                }

                {
                    let mgr = manager(&app);
                    *mgr.pending_update.lock() = Some(update);
                    mgr.set_state(UpdaterState::Available {
                        version: version.clone(),
                    });
                }

                prompt_install(app.clone(), version, notes);
            }
            Ok(None) => {
                manager(&app).set_state(UpdaterState::UpToDate);
                if manual {
                    let current = app.package_info().version.to_string();
                    let parent = dialog_parent(&app);
                    with_parent(
                        app.dialog()
                            .message(format!(
                                "You're up to date. Writer {} is the latest version.",
                                current
                            ))
                            .kind(MessageDialogKind::Info)
                            .title("Writer"),
                        parent.as_ref(),
                    )
                    .show(|_| {});
                }
            }
            Err(err) => {
                let message = err.to_string();
                manager(&app).set_state(UpdaterState::Error {
                    message: message.clone(),
                });
                if manual {
                    let parent = dialog_parent(&app);
                    with_parent(
                        app.dialog()
                            .message(format!("Could not check for updates.\n\n{}", message))
                            .kind(MessageDialogKind::Error)
                            .title("Writer"),
                        parent.as_ref(),
                    )
                    .show(|_| {});
                }
            }
        }
    });
}

/// The "Update Available" dialog of both install kinds: `accept_label` runs `accept`, "Later"
/// remembers the version and clears the pending update (`settle`).
fn prompt_update(
    app: AppHandle,
    version: String,
    body: String,
    accept_label: &str,
    accept: impl FnOnce(&AppHandle) + Send + 'static,
) {
    let parent = dialog_parent(&app);
    let app_for_cb = app.clone();
    with_parent(
        app.dialog()
            .message(body)
            .kind(MessageDialogKind::Info)
            .title("Update Available")
            .buttons(MessageDialogButtons::OkCancelCustom(
                accept_label.to_string(),
                "Later".to_string(),
            )),
        parent.as_ref(),
    )
    .show(move |accepted| {
        let mgr = manager(&app_for_cb);
        settle(
            accepted,
            &version,
            &mgr.dismissed,
            || accept(&app_for_cb),
            || mgr.reset(),
        );
    });
}

/// A package install cannot be updated in place: say so and offer the release page.
fn prompt_download(app: AppHandle, version: String) {
    use tauri_plugin_opener::OpenerExt;
    let url = release_page(&version);
    let body = format!(
        "Writer {version} is available.\n\nDownload the new package and install it with your package manager."
    );
    prompt_update(app, version, body, "Download", move |app| {
        if let Err(err) = app.opener().open_url(&url, None::<&str>) {
            log::warn!("could not open the release page: {err}");
        }
        manager(app).reset();
    });
}

fn prompt_install(app: AppHandle, version: String, notes: Option<String>) {
    if install_kind(bundle_type(), cfg!(target_os = "linux")) == InstallKind::Package {
        return prompt_download(app, version);
    }
    let body = match notes.as_deref() {
        Some(notes) if !notes.trim().is_empty() => {
            format!("Writer {} is available.\n\n{}", version, notes.trim())
        }
        _ => format!("Writer {} is available.", version),
    };
    prompt_update(app, version, body, "Install and Restart", |app| {
        start_install(app.clone());
    });
}

/// Download + install the pending update, then relaunch the app.
pub fn start_install(app: AppHandle) {
    let pending = manager(&app).pending_update.lock().take();

    let Some(update) = pending else {
        return;
    };

    manager(&app).set_state(UpdaterState::Downloading);

    tauri::async_runtime::spawn(async move {
        let version = update.version.clone();
        let result = update
            .download_and_install(|_chunk, _total| {}, || {})
            .await;

        match result {
            Ok(_) => {
                manager(&app).set_state(UpdaterState::ReadyToInstall {
                    version: version.clone(),
                });
                // Clear any previously dismissed version once an install completes.
                manager(&app).dismissed.write(None);
                app.restart();
            }
            Err(err) => {
                let message = err.to_string();
                manager(&app).set_state(UpdaterState::Error {
                    message: message.clone(),
                });
                let parent = dialog_parent(&app);
                with_parent(
                    app.dialog()
                        .message(format!("Update failed.\n\n{}", message))
                        .kind(MessageDialogKind::Error)
                        .title("Writer"),
                    parent.as_ref(),
                )
                .show(|_| {});
            }
        }
    });
}

/// Spawn the background task that runs a check once per day while the app is
/// open. The initial at-launch check is triggered separately from `setup`.
pub fn spawn_daily_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(DAILY_CHECK_INTERVAL);
        // The first tick fires immediately — skip it because `setup` already
        // schedules the launch check.
        interval.tick().await;
        loop {
            interval.tick().await;
            start_check(app.clone(), false);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_appimage_self_updates_on_linux() {
        use InstallKind::{Package, SelfUpdate};
        assert_eq!(install_kind(Some(BundleType::AppImage), true), SelfUpdate);
        for pkg in [Some(BundleType::Deb), Some(BundleType::Rpm), None] {
            assert_eq!(install_kind(pkg, true), Package);
        }
        // macOS bundles (and anything off Linux) update in place
        assert_eq!(install_kind(Some(BundleType::App), false), SelfUpdate);
        assert_eq!(install_kind(None, false), SelfUpdate);
    }

    fn dismissed_in(dir: &tempfile::TempDir) -> DismissedVersion {
        DismissedVersion {
            path: dir.path().join("sub").join(DISMISSED_VERSION_FILE),
        }
    }

    #[test]
    fn later_is_remembered_and_clears_the_pending_update() {
        let dir = tempfile::tempdir().unwrap();
        let dismissed = dismissed_in(&dir);
        let (mut accepted, mut cleared) = (false, false);
        settle(
            false,
            "0.9.1",
            &dismissed,
            || accepted = true,
            || cleared = true,
        );
        assert!(!accepted && cleared);
        assert_eq!(dismissed.read().as_deref(), Some("0.9.1"));
    }

    #[test]
    fn accepting_runs_the_action_and_remembers_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let dismissed = dismissed_in(&dir);
        let (mut accepted, mut cleared) = (false, false);
        settle(
            true,
            "0.9.1",
            &dismissed,
            || accepted = true,
            || cleared = true,
        );
        assert!(accepted && !cleared);
        assert_eq!(dismissed.read(), None);
        // a later answer replaces the version; clearing it (after an install) removes it
        dismissed.write(Some("0.9.2"));
        assert_eq!(dismissed.read().as_deref(), Some("0.9.2"));
        dismissed.write(None);
        assert_eq!(dismissed.read(), None);
    }

    #[test]
    fn download_link_is_the_tagged_release_page() {
        assert_eq!(
            release_page("0.9.1"),
            "https://github.com/Belphemur/writer-computer/releases/tag/v0.9.1"
        );
    }

    #[test]
    fn updater_endpoint_and_releases_url_name_the_shared_repository() {
        let shared: serde_json::Value =
            serde_json::from_str(include_str!("../../shared/release.json")).unwrap();
        let repo = shared["repo"].as_str().unwrap();
        assert_eq!(RELEASES_URL, format!("https://github.com/{repo}/releases"));
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let endpoint = conf["plugins"]["updater"]["endpoints"][0].as_str().unwrap();
        assert!(endpoint.starts_with(RELEASES_URL), "{endpoint}");
    }
}
