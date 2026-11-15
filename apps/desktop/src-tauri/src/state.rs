use crate::config::Settings;
use crate::error::AppError;
use crate::ignore::WorkspaceIgnore;
use crate::index::names::NameCache;
use crate::open_target::PendingOpenPayload;
use notify::RecommendedWatcher;
use parking_lot::{Mutex, RwLock};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// Per-window workspace state. Every open window has exactly one
/// `WorkspaceState`, keyed by the window's Tauri label inside [`AppState`].
/// All workspace-bound runtime data — the loaded file index, the file
/// watcher, the gitignore matcher, the per-window settings layer — lives
/// here so multiple windows can host different workspaces simultaneously
/// without clobbering each other.
pub struct WorkspaceState {
    pub workspace_root: RwLock<Option<PathBuf>>,
    /// Mirror of the SQLite index's listed rows (notes and `.base` files):
    /// quick open, recents and the sidebar's "folder holds notes" check all
    /// read it. The `files` table stays the source of truth; see
    /// `index/names.rs`.
    pub names: NameCache,
    pub watcher_handle: RwLock<Option<RecommendedWatcher>>,
    /// Tracks recently written paths to avoid echo from file watcher.
    /// Maps path -> time of write. Entries older than 2s are stale.
    pub recent_writes: RwLock<HashMap<PathBuf, Instant>>,
    /// Gitignore matcher for the current workspace. Rebuilt when any
    /// `.gitignore` file changes. `None` until the first workspace is opened.
    pub workspace_ignore: RwLock<Option<Arc<WorkspaceIgnore>>>,
    /// Monotonic counter incremented on every workspace switch inside this
    /// window. Background tasks capture it at launch and re-check before
    /// writing; stale results are dropped. Watcher closures capture it too
    /// so events queued against a prior workspace never mutate the new
    /// workspace's state.
    pub workspace_epoch: AtomicU64,
    /// Cancellation flag threaded through the active index walker. On
    /// workspace switch the outgoing flag is flipped to `true` so the old
    /// walker exits within a directory boundary instead of running to
    /// completion; a fresh flag is installed for the new workspace.
    pub cancel_index: RwLock<Arc<AtomicBool>>,
    /// Per-window settings: global layer is loaded from the app data dir
    /// (shared by all windows) but the workspace layer reflects *this*
    /// window's workspace. Two windows with different workspaces therefore
    /// carry different merged settings without clobbering each other.
    pub settings: RwLock<Option<Settings>>,
    /// Open target set before this window's `get_startup_state` has read the
    /// startup slot. Usually seeded during window creation (CLI args or
    /// `open_new_workspace_window`); macOS `RunEvent::Opened` can also seed
    /// the hidden main window before React asks for startup state.
    pub startup_open: Mutex<Option<PendingOpenPayload>>,
    /// Flips to `true` once `get_startup_state` has attempted to read
    /// `startup_open`. After this point, open events must use `pending_open`
    /// because the startup slot will not be read again.
    pub startup_open_taken: AtomicBool,
    /// Runtime-only queue for drag-drop / dock-drop events after the startup
    /// slot has been read. Drained by the frontend once startup hydration
    /// completes. Never read by `get_startup_state`.
    pub pending_open: Mutex<VecDeque<PendingOpenPayload>>,
    /// The single file hosted by this window when it runs in standalone
    /// compact mode (no workspace root). Used to dedupe repeat opens of the
    /// same file onto the existing window and as the target of the
    /// single-file watcher.
    pub standalone_file: RwLock<Option<PathBuf>>,
}

pub type WorkspaceRuntimeDrop = (
    Option<RecommendedWatcher>,
    HashMap<PathBuf, Instant>,
    Option<Arc<WorkspaceIgnore>>,
);

impl Default for WorkspaceState {
    fn default() -> Self {
        Self {
            workspace_root: RwLock::new(None),
            names: NameCache::default(),
            watcher_handle: RwLock::new(None),
            recent_writes: RwLock::new(HashMap::new()),
            workspace_ignore: RwLock::new(None),
            workspace_epoch: AtomicU64::new(0),
            cancel_index: RwLock::new(Arc::new(AtomicBool::new(false))),
            settings: RwLock::new(None),
            startup_open: Mutex::new(None),
            startup_open_taken: AtomicBool::new(false),
            pending_open: Mutex::new(VecDeque::new()),
            standalone_file: RwLock::new(None),
        }
    }
}

impl WorkspaceState {
    fn reset_workspace_runtime(&self) -> WorkspaceRuntimeDrop {
        self.cancel_index.read().store(true, Ordering::SeqCst);
        *self.standalone_file.write() = None;
        self.names.reset();
        let recent_writes = std::mem::take(&mut *self.recent_writes.write());
        let ignore = self.workspace_ignore.write().take();
        if let Some(settings) = self.settings.write().as_mut() {
            settings.clear_workspace();
        }
        (self.watcher_handle.write().take(), recent_writes, ignore)
    }

    /// Transition to a workspace under the same root write guard used by
    /// close. This is the single reset funnel for all workspace-owned runtime
    /// state, so open and close cannot drift into different cleanup rules.
    pub fn transition_to_workspace(
        &self,
        root: PathBuf,
    ) -> (u64, Arc<AtomicBool>, WorkspaceRuntimeDrop) {
        let workspace_loader = self
            .settings
            .read()
            .as_ref()
            .map(|settings| settings.workspace_loader());
        let workspace_settings = workspace_loader.map(|loader| loader.read(&root));
        let mut root_guard = self.workspace_root.write();
        let old_watcher = self.reset_workspace_runtime();
        let epoch = self.workspace_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        *root_guard = Some(root.clone());

        let cancel = Arc::new(AtomicBool::new(false));
        *self.cancel_index.write() = Arc::clone(&cancel);
        *self.workspace_ignore.write() = Some(Arc::new(WorkspaceIgnore::bootstrap()));
        if let (Some(settings), Some(layer)) = (self.settings.write().as_mut(), workspace_settings)
        {
            settings.install_workspace_layer(layer);
        }

        (epoch, cancel, old_watcher)
    }

    /// Atomically publish a workspace root together with its new epoch.
    /// Readers that need both values must use [`Self::workspace_snapshot`]
    /// so they cannot observe a new epoch paired with the outgoing root.
    #[cfg(test)]
    pub fn replace_workspace_root(&self, root: PathBuf) -> u64 {
        let mut root_guard = self.workspace_root.write();
        let epoch = self.workspace_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        *root_guard = Some(root);
        epoch
    }

    pub fn workspace_snapshot(&self) -> Option<(PathBuf, u64)> {
        let root_guard = self.workspace_root.read();
        let epoch = self.workspace_epoch.load(Ordering::SeqCst);
        root_guard.clone().map(|root| (root, epoch))
    }

    /// Run one immediate workspace-bound side effect only while a captured
    /// root/epoch pair is still current. The root read guard remains held for
    /// the callback, preventing a workspace switch from being published
    /// between final validation and the side effect itself.
    pub fn with_workspace_snapshot<T>(
        &self,
        captured_root: &Path,
        captured_epoch: u64,
        f: impl FnOnce() -> T,
    ) -> Option<T> {
        let root_guard = self.workspace_root.read();
        let epoch = self.workspace_epoch.load(Ordering::SeqCst);
        if root_guard.as_deref() != Some(captured_root) || epoch != captured_epoch {
            return None;
        }
        Some(f())
    }

    /// Atomically invalidate and clear the currently hosted workspace. The
    /// root write guard stays held while workspace-owned state is reset so a
    /// concurrent open cannot publish its new root before cleanup finishes.
    pub fn clear_workspace_if_current(
        &self,
        expected_root: &Path,
    ) -> Result<WorkspaceRuntimeDrop, ()> {
        let mut root_guard = self.workspace_root.write();
        if root_guard.as_deref() != Some(expected_root) {
            return Err(());
        }

        self.workspace_epoch.fetch_add(1, Ordering::SeqCst);
        *root_guard = None;
        Ok(self.reset_workspace_runtime())
    }

    pub fn set_startup_open(&self, payload: PendingOpenPayload) {
        debug_assert!(
            !self.startup_open_taken.load(Ordering::Acquire),
            "startup_open was set after get_startup_state consumed it"
        );
        *self.startup_open.lock() = Some(payload);
    }

    pub fn try_set_startup_open(
        &self,
        payload: PendingOpenPayload,
    ) -> Result<(), PendingOpenPayload> {
        let mut startup_open = self.startup_open.lock();
        if self.startup_open_taken.load(Ordering::Acquire) || startup_open.is_some() {
            return Err(payload);
        }
        *startup_open = Some(payload);
        Ok(())
    }

    pub fn take_startup_open(&self) -> Option<PendingOpenPayload> {
        let mut startup_open = self.startup_open.lock();
        let payload = startup_open.take();
        self.startup_open_taken.store(true, Ordering::Release);
        payload
    }

    pub fn push_pending_open(&self, payload: PendingOpenPayload) {
        let mut pending = self.pending_open.lock();
        if pending.back() == Some(&payload) {
            return;
        }
        pending.push_back(payload);
    }

    pub fn pop_pending_open(&self) -> Option<PendingOpenPayload> {
        self.pending_open.lock().pop_front()
    }

    /// Bring a just-saved file's mtime forward in the name mirror so recents
    /// order is right before the watcher feed re-reads the row.
    pub fn update_index_modified_at(&self, path: &Path, modified_at: u64) {
        self.names.touch(path, modified_at);
    }

    pub fn has_pending_workspace(&self, path: &Path) -> bool {
        let matches = |payload: &PendingOpenPayload| {
            payload
                .workspace
                .as_deref()
                .is_some_and(|workspace| Path::new(workspace) == path)
        };
        if self.startup_open.lock().as_ref().is_some_and(matches) {
            return true;
        }
        self.pending_open.lock().iter().any(matches)
    }

    pub fn has_pending_file(&self, path: &Path) -> bool {
        let matches = |payload: &PendingOpenPayload| {
            payload.workspace.is_none()
                && payload
                    .file
                    .as_deref()
                    .is_some_and(|file| Path::new(file) == path)
        };
        if self.startup_open.lock().as_ref().is_some_and(matches) {
            return true;
        }
        self.pending_open.lock().iter().any(matches)
    }

    /// Check that `path` is one this window may touch and return its resolved
    /// form. Allowed: anything under the workspace root, or the single file
    /// a standalone window hosts (or is about to host). Symlinks and `..`
    /// are resolved before the comparison so they cannot escape the root.
    /// Fails explicitly with `InvalidPath` otherwise.
    pub fn authorize_path(&self, path: &Path) -> Result<PathBuf, AppError> {
        let resolved = resolve_for_access(path)?;
        if let Some(root) = self.workspace_root.read().as_deref() {
            let root = root
                .canonicalize()
                .map_err(|e| AppError::Io(e.to_string()))?;
            if resolved.starts_with(&root) {
                return Ok(resolved);
            }
        }
        let hosted = self
            .standalone_file
            .read()
            .as_deref()
            .and_then(|file| file.canonicalize().ok());
        if hosted.as_deref() == Some(resolved.as_path()) || self.has_pending_file(path) {
            return Ok(resolved);
        }
        Err(AppError::InvalidPath(format!(
            "{} is outside this window's workspace",
            path.display()
        )))
    }

    /// Like [`Self::authorize_path`], plus what a standalone (single-file)
    /// window needs for read-only existence probes and saving pasted images:
    /// the hosted file's sibling entries and its `<stem>-assets` folder.
    /// Workspace windows get exactly `authorize_path`.
    pub fn authorize_probe(&self, path: &Path) -> Result<PathBuf, AppError> {
        let err = self.authorize_path(path).err();
        let Some(err) = err else {
            return self.authorize_path(path);
        };
        if self.workspace_root.read().is_some() {
            return Err(err);
        }
        let hosted = self
            .standalone_file
            .read()
            .as_deref()
            .and_then(|f| f.canonicalize().ok());
        let (Some(hosted), Ok(resolved)) = (hosted, resolve_for_access(path)) else {
            return Err(err);
        };
        let dir = hosted.parent().map(Path::to_path_buf);
        let assets = hosted
            .file_stem()
            .zip(dir.as_ref())
            .map(|(stem, dir)| dir.join(format!("{}-assets", stem.to_string_lossy())));
        let sibling = resolved.parent() == dir.as_deref();
        let in_assets = assets.as_ref().is_some_and(|a| resolved.starts_with(a));
        if sibling || in_assets {
            Ok(resolved)
        } else {
            Err(err)
        }
    }
}

/// Canonicalize `path`, tolerating a final component that does not exist yet
/// (new files, rename targets): the parent is canonicalized and the name
/// re-attached. A missing parent, or a final component of `..`, is rejected.
fn resolve_for_access(path: &Path) -> Result<PathBuf, AppError> {
    if let Ok(resolved) = path.canonicalize() {
        return Ok(resolved);
    }
    let name = path
        .file_name()
        .ok_or_else(|| AppError::InvalidPath(path.display().to_string()))?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::InvalidPath(path.display().to_string()))?;
    let parent = parent
        .canonicalize()
        .map_err(|_| AppError::NotFound(path.display().to_string()))?;
    Ok(parent.join(name))
}

/// Process-wide registry of per-window `WorkspaceState`, keyed by Tauri
/// window label. The main window uses the label `"main"`; secondary
/// windows get uuid-based labels assigned by
/// `commands::workspace::open_workspace_in_new_window`.
pub struct AppState {
    windows: RwLock<HashMap<String, Arc<WorkspaceState>>>,
    /// Serializes initialization, migrations, and read-modify-write mutations
    /// of the global config shared by every window. Lock order is this mutex
    /// first, then an individual window's `settings` lock.
    pub global_settings_file_lock: Mutex<()>,
    /// Serializes read-modify-write on the shared `sessions.json` file so
    /// two windows can't clobber each other's tab state under the 500 ms
    /// debounce. Held only for the load→save span.
    pub sessions_file_lock: Mutex<()>,
    /// Serializes read-modify-write on the shared `recent_files.json` file
    /// so concurrent recents updates from multiple windows don't drop each
    /// other's entries. Held only for the load→save span.
    pub recent_files_lock: Mutex<()>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            windows: RwLock::new(HashMap::new()),
            global_settings_file_lock: Mutex::new(()),
            sessions_file_lock: Mutex::new(()),
            recent_files_lock: Mutex::new(()),
        }
    }

    /// Return the window's state, creating a fresh `WorkspaceState` if this
    /// label is unknown. Called by every Tauri command at the top of its
    /// body after deriving the window label from the invoking webview.
    pub fn get_or_create(&self, label: &str) -> Arc<WorkspaceState> {
        {
            let map = self.windows.read();
            if let Some(state) = map.get(label) {
                return state.clone();
            }
        }
        let mut map = self.windows.write();
        map.entry(label.to_string())
            .or_insert_with(|| Arc::new(WorkspaceState::default()))
            .clone()
    }

    pub fn get(&self, label: &str) -> Option<Arc<WorkspaceState>> {
        self.windows.read().get(label).cloned()
    }

    /// Remove and return a window's state. Called from the window-close
    /// event handler so the watcher's `Drop` runs (stopping FSEvents /
    /// inotify subscriptions) and the index memory is reclaimed.
    pub fn remove(&self, label: &str) -> Option<Arc<WorkspaceState>> {
        self.windows.write().remove(label)
    }

    /// Find an existing window already hosting or opening `path`. Used to
    /// focus rather than duplicate when the user opens a workspace that's
    /// already open in another window. Pending opens are included so two
    /// quick requests for the same workspace do not race before the new
    /// window hydrates and publishes `workspace_root`.
    pub fn find_by_workspace(&self, path: &Path) -> Option<String> {
        let map = self.windows.read();
        for (label, state) in map.iter() {
            let guard = state.workspace_root.read();
            if let Some(root) = guard.as_deref() {
                if root == path {
                    return Some(label.clone());
                }
            }
            drop(guard);

            if state.has_pending_workspace(path) {
                return Some(label.clone());
            }
        }
        None
    }

    /// Find an existing standalone window already hosting (or about to
    /// host) `path`. Mirrors `find_by_workspace` so repeat opens of the
    /// same file focus the existing compact window instead of duplicating.
    pub fn find_by_standalone_file(&self, path: &Path) -> Option<String> {
        let map = self.windows.read();
        for (label, state) in map.iter() {
            let guard = state.standalone_file.read();
            if guard.as_deref() == Some(path) {
                return Some(label.clone());
            }
            drop(guard);

            if state.has_pending_file(path) {
                return Some(label.clone());
            }
        }
        None
    }

    /// Snapshot of all known window labels. Used by startup code to emit
    /// broadcast-style events without hard-coding labels.
    pub fn labels(&self) -> Vec<String> {
        self.windows.read().keys().cloned().collect()
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window_with_root(root: &Path) -> Arc<WorkspaceState> {
        let app_state = AppState::new();
        let window = app_state.get_or_create("w");
        *window.workspace_root.write() = Some(root.canonicalize().unwrap());
        window
    }

    #[test]
    fn authorize_path_allows_files_inside_workspace() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        let window = window_with_root(dir.path());
        assert!(window.authorize_path(&dir.path().join("a.md")).is_ok());
        // Not-yet-existing file (create / rename target) in an existing dir.
        assert!(window.authorize_path(&dir.path().join("new.md")).is_ok());
    }

    #[test]
    fn authorize_path_rejects_outside_dotdot_and_symlink_escape() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.md"), "x").unwrap();
        let window = window_with_root(dir.path());

        assert!(matches!(
            window.authorize_path(&outside.path().join("secret.md")),
            Err(AppError::InvalidPath(_))
        ));
        let dotdot = dir
            .path()
            .join("..")
            .join(outside.path().file_name().unwrap())
            .join("secret.md");
        assert!(window.authorize_path(&dotdot).is_err());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
            assert!(window
                .authorize_path(&dir.path().join("link").join("secret.md"))
                .is_err());
        }
    }

    #[test]
    fn authorize_path_without_workspace_allows_only_the_standalone_file() {
        let dir = tempfile::tempdir().unwrap();
        let hosted = dir.path().join("hosted.md");
        let other = dir.path().join("other.md");
        std::fs::write(&hosted, "x").unwrap();
        std::fs::write(&other, "x").unwrap();
        let app_state = AppState::new();
        let window = app_state.get_or_create("s");
        assert!(window.authorize_path(&hosted).is_err());
        *window.standalone_file.write() = Some(hosted.clone());
        assert!(window.authorize_path(&hosted).is_ok());
        assert!(window.authorize_path(&other).is_err());
    }

    #[test]
    fn authorize_probe_extends_standalone_to_siblings_and_assets_only() {
        let dir = tempfile::tempdir().unwrap();
        let hosted = dir.path().join("hosted.md");
        std::fs::write(&hosted, "x").unwrap();
        std::fs::write(dir.path().join("sibling.md"), "x").unwrap();
        std::fs::create_dir_all(dir.path().join("sub/deeper")).unwrap();
        std::fs::create_dir(dir.path().join("hosted-assets")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let app_state = AppState::new();
        let window = app_state.get_or_create("s");
        assert!(window.authorize_probe(&hosted).is_err(), "not hosted yet");
        *window.standalone_file.write() = Some(hosted.clone());
        assert!(window.authorize_probe(&hosted).is_ok());
        assert!(window
            .authorize_probe(&dir.path().join("sibling.md"))
            .is_ok());
        assert!(window
            .authorize_probe(&dir.path().join("hosted-assets/new.png"))
            .is_ok());
        assert!(window
            .authorize_probe(&dir.path().join("sub/deeper"))
            .is_err());
        assert!(window
            .authorize_probe(&outside.path().join("x.md"))
            .is_err());
        let dotdot = dir.path().join("hosted-assets/../../escape.md");
        assert!(window.authorize_probe(&dotdot).is_err());
    }

    #[test]
    fn authorize_probe_is_strict_in_a_workspace_window() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("a.md"), "x").unwrap();
        let window = window_with_root(dir.path());
        *window.standalone_file.write() = Some(outside.path().join("a.md"));
        assert!(window
            .authorize_probe(&outside.path().join("b.md"))
            .is_err());
        assert!(window.authorize_probe(&dir.path().join("n.md")).is_ok());
    }

    #[test]
    fn find_by_workspace_matches_startup_open() {
        let app_state = AppState::new();
        let window_state = app_state.get_or_create("startup-window");
        window_state.set_startup_open(PendingOpenPayload {
            workspace: Some("/tmp/workspace".to_string()),
            file: None,
        });

        assert_eq!(
            app_state.find_by_workspace(Path::new("/tmp/workspace")),
            Some("startup-window".to_string())
        );
    }

    #[test]
    fn find_by_workspace_matches_pending_open() {
        let app_state = AppState::new();
        let window_state = app_state.get_or_create("pending-window");
        window_state.push_pending_open(PendingOpenPayload {
            workspace: Some("/tmp/workspace".to_string()),
            file: None,
        });

        assert_eq!(
            app_state.find_by_workspace(Path::new("/tmp/workspace")),
            Some("pending-window".to_string())
        );
    }

    #[test]
    fn find_by_standalone_file_matches_hosted_and_pending_files() {
        let app_state = AppState::new();
        let hosting = app_state.get_or_create("hosting-window");
        *hosting.standalone_file.write() = Some(PathBuf::from("/tmp/hosted.md"));

        let pending = app_state.get_or_create("pending-window");
        pending.set_startup_open(PendingOpenPayload {
            workspace: None,
            file: Some("/tmp/pending.md".to_string()),
        });

        assert_eq!(
            app_state.find_by_standalone_file(Path::new("/tmp/hosted.md")),
            Some("hosting-window".to_string())
        );
        assert_eq!(
            app_state.find_by_standalone_file(Path::new("/tmp/pending.md")),
            Some("pending-window".to_string())
        );
        assert_eq!(
            app_state.find_by_standalone_file(Path::new("/tmp/other.md")),
            None
        );
    }

    #[test]
    fn workspace_plus_file_payload_does_not_match_standalone_lookup() {
        // A file opened *into a workspace window* must not be claimed by the
        // standalone dedupe — only file-only payloads host standalone files.
        let app_state = AppState::new();
        let state = app_state.get_or_create("workspace-window");
        state.push_pending_open(PendingOpenPayload {
            workspace: Some("/tmp/workspace".to_string()),
            file: Some("/tmp/workspace/a.md".to_string()),
        });

        assert_eq!(
            app_state.find_by_standalone_file(Path::new("/tmp/workspace/a.md")),
            None
        );
    }

    #[test]
    fn pending_open_preserves_distinct_payloads_in_order() {
        let window_state = WorkspaceState::default();
        let first = PendingOpenPayload {
            workspace: Some("/tmp/workspace-a".to_string()),
            file: Some("/tmp/workspace-a/a.md".to_string()),
        };
        let second = PendingOpenPayload {
            workspace: Some("/tmp/workspace-b".to_string()),
            file: Some("/tmp/workspace-b/b.md".to_string()),
        };

        window_state.push_pending_open(first.clone());
        window_state.push_pending_open(second.clone());

        assert_eq!(window_state.pop_pending_open(), Some(first));
        assert_eq!(window_state.pop_pending_open(), Some(second));
        assert_eq!(window_state.pop_pending_open(), None);
    }

    #[test]
    fn pending_open_dedupes_repeated_tail_payload() {
        let window_state = WorkspaceState::default();
        let payload = PendingOpenPayload {
            workspace: Some("/tmp/workspace".to_string()),
            file: Some("/tmp/workspace/a.md".to_string()),
        };

        window_state.push_pending_open(payload.clone());
        window_state.push_pending_open(payload.clone());

        assert_eq!(window_state.pop_pending_open(), Some(payload));
        assert_eq!(window_state.pop_pending_open(), None);
    }

    #[test]
    fn startup_open_cannot_be_seeded_after_take() {
        let window_state = WorkspaceState::default();
        assert_eq!(window_state.take_startup_open(), None);

        let payload = PendingOpenPayload {
            workspace: Some("/tmp/workspace".to_string()),
            file: None,
        };

        assert_eq!(
            window_state.try_set_startup_open(payload.clone()),
            Err(payload)
        );
    }

    #[test]
    fn startup_open_try_seed_preserves_existing_payload() {
        let window_state = WorkspaceState::default();
        let first = PendingOpenPayload {
            workspace: Some("/tmp/workspace-a".to_string()),
            file: None,
        };
        let second = PendingOpenPayload {
            workspace: Some("/tmp/workspace-b".to_string()),
            file: None,
        };

        window_state.set_startup_open(first.clone());

        assert_eq!(
            window_state.try_set_startup_open(second.clone()),
            Err(second)
        );
        assert_eq!(window_state.take_startup_open(), Some(first));
    }

    #[test]
    fn guarded_workspace_snapshot_rejects_stale_callbacks_and_holds_read_guard() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let state = WorkspaceState::default();
        let first_root = first.path().canonicalize().unwrap();
        let first_epoch = state.replace_workspace_root(first_root.clone());

        let ran = std::cell::Cell::new(false);
        let result = state.with_workspace_snapshot(&first_root, first_epoch, || {
            ran.set(true);
            assert!(state.workspace_root.try_write().is_none());
            42
        });
        assert_eq!(result, Some(42));
        assert!(ran.get());

        state.replace_workspace_root(second.path().canonicalize().unwrap());
        ran.set(false);
        assert_eq!(
            state.with_workspace_snapshot(&first_root, first_epoch, || ran.set(true)),
            None
        );
        assert!(!ran.get());

        state.replace_workspace_root(first_root.clone());
        assert_eq!(
            state.with_workspace_snapshot(&first_root, first_epoch, || ran.set(true)),
            None
        );
        assert!(!ran.get());
    }

    #[test]
    fn close_workspace_invalidates_the_snapshot_and_rejects_stale_roots() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_root = first.path().canonicalize().unwrap();
        let second_root = second.path().canonicalize().unwrap();
        let state = WorkspaceState::default();
        let (first_epoch, _, _) = state.transition_to_workspace(first_root.clone());
        let generation = state.names.reset();
        state.names.bind(
            generation,
            first_root.clone(),
            first_root.join("index.sqlite3"),
        );
        state
            .recent_writes
            .write()
            .insert(first_root.join("old.md"), Instant::now());

        state.clear_workspace_if_current(&first_root).unwrap();
        assert!(state.workspace_snapshot().is_none());
        assert!(!state.names.is_bound());
        assert!(state.recent_writes.read().is_empty());
        assert!(state.workspace_ignore.read().is_none());
        assert!(state
            .with_workspace_snapshot(&first_root, first_epoch, || ())
            .is_none());

        state.transition_to_workspace(second_root.clone());
        assert!(state.workspace_ignore.read().is_some());
        assert!(state.clear_workspace_if_current(&first_root).is_err());
        assert_eq!(
            state.workspace_snapshot().map(|(root, _)| root),
            Some(second_root)
        );
    }
}
