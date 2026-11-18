use crate::ignore::{is_gitignore_path, WorkspaceIgnore};
use crate::state::{AppState, WorkspaceState};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const SELF_WRITE_TTL: Duration = Duration::from_secs(2);
pub(crate) const DEBOUNCE_MS: u64 = 300;

/// Watcher diagnostics: `debug` level, so they reach the log file only with `WRITER_LOG=debug`
/// (or the Logs setting) — the investigation path for "external change missed" reports.
macro_rules! wlog {
    ($($arg:tt)*) => {
        log::debug!(target: "watcher", $($arg)*);
    };
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeEvent {
    pub path: String,
    pub kind: String,
    pub workspace: Option<WorkspaceIdentity>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIdentity {
    pub root: String,
    pub epoch: u64,
}

/// True if `path` should be dropped before any further processing.
///
/// Only the *relative* path (inside the workspace root) is inspected — a
/// workspace at `~/.notes/` must keep firing events even though `.notes` is a
/// dotdir. Paths outside the root are kept; the recursive watch already
/// scopes things, and bailing out here would silently drop legitimate events
/// that happen to share a prefix with the canonical root via macOS aliasing.
fn should_ignore(path: &Path, workspace_root: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(workspace_root) else {
        return false;
    };
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy();
        if name == ".git" || name == "node_modules" || name == ".DS_Store" {
            return true;
        }
        // Allow .writer directory (workspace config) and .gitignore files —
        // both must be watchable: settings reload on the former, matcher
        // rebuild on the latter.
        if name == ".writer" || name == ".gitignore" {
            continue;
        }
        if name.starts_with('.') && name.len() > 1 {
            // `.agents/skills` and `.claude/skills` are the one dot-folder exception.
            if !crate::code_files::rel_is_visible(relative) {
                return true;
            }
        }
    }
    // Generated folders (`target`, `dist`, `__pycache__`...) would flood the feed.
    crate::code_files::rel_in_ignored_folder(relative)
}

/// Check the workspace ignore matcher, if any. Returns `false` when no
/// matcher is loaded yet so events are never silently dropped.
fn is_workspace_ignored(state: &WorkspaceState, path: &Path, is_dir: bool) -> bool {
    let guard = state.workspace_ignore.read();
    guard
        .as_ref()
        .map(|ignore| ignore.is_ignored(path, is_dir))
        .unwrap_or(false)
}

/// Check if a path is a config file that should trigger settings reload.
fn is_config_file(path: &Path) -> bool {
    // Workspace config: .writer/config
    if path.file_name().and_then(|n| n.to_str()) == Some("config") {
        if let Some(parent) = path.parent() {
            if parent.file_name().and_then(|n| n.to_str()) == Some(".writer") {
                return true;
            }
        }
    }
    false
}

/// True if `path` was written by Writer itself within the TTL window.
///
/// A single save fans out into multiple FSEvent records on macOS (Create,
/// Modify(Metadata), Modify(Data)); they all need to be suppressed so the
/// frontend doesn't reload the file from disk and clobber in-progress edits
/// keystrokes. The entry is *not* consumed on match — `record_write` cleans up
/// expired entries on its next call.
fn is_self_write(state: &WorkspaceState, path: &Path) -> bool {
    let writes = state.recent_writes.read();
    let hit = writes
        .get(path)
        .is_some_and(|written_at| written_at.elapsed() < SELF_WRITE_TTL);
    if hit {
        wlog!(
            "self-write suppressed: {} ({} tracked)",
            path.display(),
            writes.len()
        );
    }
    hit
}

pub fn record_write(state: &WorkspaceState, path: &Path) {
    let mut writes = state.recent_writes.write();
    writes.insert(path.to_path_buf(), Instant::now());

    // Clean up stale entries
    writes.retain(|_, t| t.elapsed() < SELF_WRITE_TTL);
    wlog!(
        "record_write: {} ({} tracked)",
        path.display(),
        writes.len()
    );
}

fn event_kind_str(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("created"),
        EventKind::Modify(_) => Some("modified"),
        EventKind::Remove(_) => Some("deleted"),
        _ => None,
    }
}

/// Sees the changed paths of every watched workspace: `(window label, vault root, paths, own)`.
/// `own` is the part of `paths` that Writer wrote itself a moment ago (the editor's saves, see
/// [`is_self_write`]).
pub type PathObserver = Box<dyn Fn(&str, &Path, Vec<PathBuf>, Vec<PathBuf>) + Send + Sync>;

static PATH_OBSERVERS: parking_lot::RwLock<Vec<PathObserver>> =
    parking_lot::RwLock::new(Vec::new());

/// Registers a consumer of the watcher's changed paths (the one source of file changes: no second
/// watcher). It gets each batch's paths BEFORE any ignore rule (the agent's config files are
/// hidden dot files the sidebar never lists), created, modified or removed, Writer's own writes
/// included (and named in `own`), and runs on the watcher thread: it must only filter and hand off, never block.
pub fn observe_paths(observer: PathObserver) {
    PATH_OBSERVERS.write().push(observer);
}

fn notify_observers(state: &WorkspaceState, label: &str, root: &Path, events: &[Event]) {
    let observers = PATH_OBSERVERS.read();
    if observers.is_empty() {
        return;
    }
    let paths: Vec<PathBuf> = events
        .iter()
        .filter(|e| event_kind_str(&e.kind).is_some())
        .flat_map(|e| e.paths.iter().cloned())
        .collect();
    if paths.is_empty() {
        return;
    }
    let own: Vec<PathBuf> = paths
        .iter()
        .filter(|p| is_self_write(state, p))
        .cloned()
        .collect();
    for o in observers.iter() {
        o(label, root, paths.clone(), own.clone());
    }
}

/// Start a file watcher targeted at a specific window. All emitted events
/// are routed via `emit_to(&window_label, ...)` so two windows hosting
/// different workspaces don't cross-talk on file events. The watcher
/// captures the window label plus the workspace epoch; when the epoch
/// moves on (workspace switch inside the same window) the debounced event
/// loop drops the batch.
pub fn start_watcher(
    app_handle: AppHandle,
    window_label: String,
    root: &Path,
    epoch: u64,
) -> Result<RecommendedWatcher, notify::Error> {
    let root_path = root.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();

    let mut watcher = RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        notify::Config::default().with_poll_interval(Duration::from_millis(DEBOUNCE_MS)),
    )?;

    watcher.watch(&root_path, RecursiveMode::Recursive)?;

    let captured_epoch = epoch;
    let watched_root = root_path.clone();

    // Spawn thread to process events
    let handle = app_handle.clone();
    let label = window_label.clone();
    std::thread::spawn(move || {
        // Simple debounce: collect events for DEBOUNCE_MS, then process
        let mut last_emit = Instant::now();
        let mut pending: Vec<Event> = Vec::new();

        loop {
            match rx.recv_timeout(Duration::from_millis(DEBOUNCE_MS)) {
                Ok(Ok(event)) => {
                    wlog!(
                        "recv: kind={:?} paths={:?}",
                        event.kind,
                        event
                            .paths
                            .iter()
                            .map(|p| p.display().to_string())
                            .collect::<Vec<_>>()
                    );
                    pending.push(event);
                }
                Ok(Err(err)) => {
                    wlog!("recv err: {err:?}");
                    continue;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }

            if pending.is_empty() || last_emit.elapsed() < Duration::from_millis(DEBOUNCE_MS) {
                continue;
            }

            // Look up this window's state. If the window has already been
            // closed (its WorkspaceState removed from the registry) the
            // watcher has nothing to drive; stop the event loop so the
            // thread exits cleanly.
            let Some(state) = handle.state::<AppState>().get(&label) else {
                break;
            };

            if state.workspace_snapshot().as_ref() != Some(&(watched_root.clone(), captured_epoch))
            {
                pending.clear();
                last_emit = Instant::now();
                continue;
            }

            notify_observers(&state, &label, &watched_root, &pending);

            let mut rebuild_ignore = false;
            // Paths the vault index must re-read. Collected before the
            // self-write check: Writer's own saves still change the index.
            let mut index_paths: HashSet<PathBuf> = HashSet::new();

            for event in pending.drain(..) {
                for path in &event.paths {
                    if should_ignore(path, &watched_root) {
                        wlog!("filter[should_ignore]: {}", path.display());
                        continue;
                    }

                    // `.gitignore` changes defer to a background rebuild.
                    if is_gitignore_path(path) {
                        wlog!("filter[gitignore-change]: {}", path.display());
                        rebuild_ignore = true;
                        continue;
                    }

                    // FSEvents reports the path as it was at event time; by
                    // the time we read it the file may already be gone, so
                    // `path.is_dir()` is unreliable. Trust the event kind
                    // first, fall back to the live stat. Computed up here
                    // because `is_workspace_ignored` needs an accurate
                    // is_dir to match dir-only gitignore rules (e.g. `dist/`)
                    // against deleted directories.
                    let is_folder_event = matches!(
                        event.kind,
                        EventKind::Remove(notify::event::RemoveKind::Folder)
                    ) || matches!(
                        event.kind,
                        EventKind::Create(notify::event::CreateKind::Folder)
                    );
                    let is_dir = is_folder_event || path.is_dir();

                    if is_workspace_ignored(&state, path, is_dir) {
                        wlog!("filter[workspace_ignore]: {}", path.display());
                        continue;
                    }

                    if index_feed_wanted(&event.kind, is_dir) {
                        index_paths.insert(path.clone());
                    }

                    if is_self_write(&state, path) {
                        continue;
                    }

                    let kind_str = match event_kind_str(&event.kind) {
                        Some(k) => k,
                        None => {
                            wlog!("filter[unmapped_kind]: {:?} {}", event.kind, path.display());
                            continue;
                        }
                    };

                    let payload = FileChangeEvent {
                        path: path.to_string_lossy().to_string(),
                        kind: kind_str.to_string(),
                        workspace: Some(WorkspaceIdentity {
                            root: watched_root.to_string_lossy().into_owned(),
                            epoch: captured_epoch,
                        }),
                    };

                    if is_dir {
                        wlog!(
                            "emit fs:directory-changed kind={kind_str} {}",
                            path.display()
                        );
                        let _ = handle.emit_to(label.clone(), "fs:directory-changed", &payload);
                    } else {
                        // `.writer/config` changes reload settings instead.
                        if is_config_file(path) {
                            wlog!("emit settings:changed {}", path.display());
                            let loader = state
                                .settings
                                .read()
                                .as_ref()
                                .map(|settings| settings.workspace_loader());
                            let layer = loader.map(|loader| loader.read(&watched_root));
                            let _ = state.with_workspace_snapshot(
                                &watched_root,
                                captured_epoch,
                                || {
                                    if let (Some(settings), Some(layer)) =
                                        (state.settings.write().as_mut(), layer)
                                    {
                                        settings.install_workspace_layer(layer);
                                    }
                                },
                            );
                            let _ = handle.emit_to(
                                label.clone(),
                                "settings:changed",
                                WorkspaceIdentity {
                                    root: watched_root.to_string_lossy().into_owned(),
                                    epoch: captured_epoch,
                                },
                            );
                            continue;
                        }

                        wlog!("emit fs:file-changed kind={kind_str} {}", path.display());
                        let _ = handle.emit_to(label.clone(), "fs:file-changed", &payload);
                    }

                    // Treat Create, Remove, and Rename (Modify(Name)) as
                    // directory-membership changes. Finder's "Move to Trash"
                    // and `mv file /elsewhere` arrive as Modify(Name(_)) on
                    // macOS — not Remove — so the previous code missed them
                    // entirely.
                    let is_membership_change = matches!(
                        event.kind,
                        EventKind::Create(_)
                            | EventKind::Remove(_)
                            | EventKind::Modify(notify::event::ModifyKind::Name(_))
                    );
                    if !is_membership_change {
                        continue;
                    }

                    // Refresh the parent directory's listing. Without this,
                    // non-`.md` file changes, folder deletes, and Finder
                    // moves never trigger a sidebar refresh.
                    if !is_dir {
                        if let Some(parent) = path.parent() {
                            wlog!("emit fs:directory-changed (parent) {}", parent.display());
                            let parent_payload = FileChangeEvent {
                                path: parent.to_string_lossy().to_string(),
                                kind: "modified".to_string(),
                                workspace: Some(WorkspaceIdentity {
                                    root: watched_root.to_string_lossy().into_owned(),
                                    epoch: captured_epoch,
                                }),
                            };
                            let _ = handle.emit_to(
                                label.clone(),
                                "fs:directory-changed",
                                &parent_payload,
                            );
                        }
                    }
                }
            }

            // One line per batch: what keeps an idle app busy shows up here (`WRITER_LOG=debug`).
            wlog!(
                "index feed: {} path(s){} first: {}",
                index_paths.len(),
                if rebuild_ignore { ", rescan" } else { "" },
                index_paths
                    .iter()
                    .take(5)
                    .map(|p| p
                        .strip_prefix(&watched_root)
                        .unwrap_or(p)
                        .display()
                        .to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            crate::commands::index::feed(
                &handle,
                &label,
                &watched_root,
                captured_epoch,
                index_paths.into_iter().collect(),
                rebuild_ignore,
            );

            if rebuild_ignore {
                spawn_ignore_rebuild(
                    handle.clone(),
                    label.clone(),
                    watched_root.clone(),
                    captured_epoch,
                );
            }

            last_emit = Instant::now();
        }
    });

    Ok(watcher)
}

/// Should this event reach the vault index? Every create/modify/remove of a
/// non-ignored path, but directories only on membership changes (a modified
/// directory entry fires for every child write and would re-walk the tree).
fn index_feed_wanted(kind: &EventKind, is_dir: bool) -> bool {
    if event_kind_str(kind).is_none() {
        return false;
    }
    !is_dir
        || matches!(
            kind,
            EventKind::Create(_)
                | EventKind::Remove(_)
                | EventKind::Modify(notify::event::ModifyKind::Name(_))
        )
}

/// Start a lightweight watcher for a single standalone file (compact mode,
/// no workspace). Watches the file's *parent directory* non-recursively:
/// watching the file inode directly would break on atomic temp+rename saves
/// — Writer's own `write_file_impl` and most editors replace the inode, and
/// the watch would die with the old one. Only events whose path matches the
/// watched file are forwarded; there is no index maintenance, no ignore
/// matching, and no directory-change fan-out.
pub fn start_file_watcher(
    app_handle: AppHandle,
    window_label: String,
    file: &Path,
    epoch: u64,
) -> Result<RecommendedWatcher, notify::Error> {
    let file_path = file.to_path_buf();
    let parent = file_path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| notify::Error::generic("standalone file has no parent directory"))?;
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();

    let mut watcher = RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        notify::Config::default().with_poll_interval(Duration::from_millis(DEBOUNCE_MS)),
    )?;

    watcher.watch(&parent, RecursiveMode::NonRecursive)?;
    wlog!(
        "file watcher started for {} (watching {})",
        file_path.display(),
        parent.display()
    );

    let handle = app_handle;
    let label = window_label;
    std::thread::spawn(move || {
        let mut last_emit = Instant::now();
        let mut pending: Vec<Event> = Vec::new();

        loop {
            match rx.recv_timeout(Duration::from_millis(DEBOUNCE_MS)) {
                Ok(Ok(event)) => pending.push(event),
                Ok(Err(err)) => {
                    wlog!("file watcher recv err: {err:?}");
                    continue;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }

            if pending.is_empty() || last_emit.elapsed() < Duration::from_millis(DEBOUNCE_MS) {
                continue;
            }

            let Some(state) = handle.state::<AppState>().get(&label) else {
                break;
            };

            // Drop the batch if the window has moved on to another file or
            // a workspace (epoch bump on every watch target switch).
            if state.workspace_epoch.load(Ordering::SeqCst) != epoch {
                pending.clear();
                last_emit = Instant::now();
                continue;
            }

            for event in pending.drain(..) {
                let Some(kind_str) = event_kind_str(&event.kind) else {
                    continue;
                };
                for path in &event.paths {
                    if *path != file_path {
                        continue;
                    }
                    if is_self_write(&state, path) {
                        continue;
                    }
                    wlog!(
                        "emit fs:file-changed (standalone) kind={kind_str} {}",
                        path.display()
                    );
                    let _ = handle.emit_to(
                        label.clone(),
                        "fs:file-changed",
                        &FileChangeEvent {
                            path: path.to_string_lossy().to_string(),
                            kind: kind_str.to_string(),
                            workspace: None,
                        },
                    );
                }
            }

            last_emit = Instant::now();
        }
    });

    Ok(watcher)
}

/// Rebuild the workspace gitignore matcher on a one-shot background thread,
/// then swap it in and nudge the sidebar to re-read. Keeps the watcher's
/// event loop free while the tree walk runs.
fn spawn_ignore_rebuild(
    handle: AppHandle,
    window_label: String,
    root: std::path::PathBuf,
    captured_epoch: u64,
) {
    std::thread::spawn(move || {
        let new_matcher = Arc::new(WorkspaceIgnore::load(&root));
        let Some(state) = handle.state::<AppState>().get(&window_label) else {
            return;
        };

        if state
            .with_workspace_snapshot(&root, captured_epoch, || {
                *state.workspace_ignore.write() = Some(new_matcher);
            })
            .is_none()
        {
            return;
        }
        let _ = handle.emit_to(
            window_label,
            "fs:directory-changed",
            FileChangeEvent {
                path: root.to_string_lossy().to_string(),
                kind: "modified".to_string(),
                workspace: Some(WorkspaceIdentity {
                    root: root.to_string_lossy().into_owned(),
                    epoch: captured_epoch,
                }),
            },
        );
    });
}

/// Drop a `RecommendedWatcher` on a detached thread. `notify`'s `Drop` impl
/// can briefly block on FSEvents unregistration (macOS) or inotify watch
/// removal (Linux); off-loading keeps the IPC thread responsive when the
/// user rapidly switches workspaces.
pub fn drop_watcher_off_thread(watcher: Option<RecommendedWatcher>) {
    let Some(watcher) = watcher else {
        return;
    };
    std::thread::spawn(move || drop(watcher));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const ROOT: &str = "/workspace";

    #[test]
    fn test_ignores_git_directory() {
        let root = Path::new(ROOT);
        assert!(should_ignore(Path::new("/workspace/.git/config"), root));
        assert!(should_ignore(
            Path::new("/workspace/.git/refs/heads/main"),
            root
        ));
    }

    #[test]
    fn test_ignores_hidden_files() {
        let root = Path::new(ROOT);
        assert!(should_ignore(Path::new("/workspace/.DS_Store"), root));
        assert!(should_ignore(Path::new("/workspace/.hidden/file.md"), root));
    }

    #[test]
    fn with_the_feature_off_skills_are_not_watched_and_generated_folders_are() {
        use crate::code_files::{with_policy_for_test, Policy};
        let root = Path::new(ROOT);
        let ignored = |p: &str| should_ignore(Path::new(&format!("{ROOT}/{p}")), root);
        with_policy_for_test(Policy::notes_only(), || {
            assert!(ignored(".agents/skills/x/run.py"));
            assert!(ignored(".claude/skills/x/SKILL.md"));
            assert!(!ignored("web/dist/a.js"));
            assert!(!ignored("web/target/a.rs"));
            // dot-folders and node_modules stay out whatever the feature says
            assert!(ignored(".hidden/a.md") && ignored("web/node_modules/a.js"));
        });
        with_policy_for_test(Policy::default(), || {
            assert!(!ignored(".agents/skills/x/run.py"));
            assert!(ignored("web/dist/a.js"));
        });
    }

    #[test]
    fn agent_skills_are_watched_and_generated_folders_are_not() {
        let root = Path::new(ROOT);
        assert!(!should_ignore(
            Path::new("/workspace/.agents/skills/x/run.py"),
            root
        ));
        assert!(!should_ignore(
            Path::new("/workspace/.claude/skills/x/SKILL.md"),
            root
        ));
        assert!(should_ignore(
            Path::new("/workspace/.claude/settings.json"),
            root
        ));
        assert!(should_ignore(
            Path::new("/workspace/.agents/skills/x/node_modules/a.js"),
            root
        ));
        assert!(should_ignore(Path::new("/workspace/app/target/a.rs"), root));
        assert!(!should_ignore(Path::new("/workspace/.writer/config"), root));
    }

    #[test]
    fn test_does_not_ignore_normal_files() {
        let root = Path::new(ROOT);
        assert!(!should_ignore(Path::new("/workspace/notes/hello.md"), root));
        assert!(!should_ignore(Path::new("/workspace/readme.md"), root));
    }

    #[test]
    fn dotdir_workspace_root_does_not_filter_its_own_paths() {
        // Regression: a workspace at `~/.notes/` must keep firing events even
        // though `.notes` is a dotdir.
        let root = Path::new("/Users/joel/.notes");
        assert!(!should_ignore(&root.join("foo.md"), root));
        assert!(!should_ignore(&root.join("docs/bar.md"), root));
        // Hidden subdirs inside the dotdir root are still filtered.
        assert!(should_ignore(&root.join(".cache/x"), root));
        assert!(should_ignore(&root.join(".git/HEAD"), root));
    }

    #[test]
    fn paths_outside_root_are_not_filtered_here() {
        // `should_ignore` only applies to paths inside the root; the recursive
        // watch and `is_workspace_ignored` handle anything else.
        let root = Path::new("/workspace");
        assert!(!should_ignore(Path::new("/elsewhere/.cache/file"), root));
    }

    #[test]
    fn test_self_write_detection() {
        let state = WorkspaceState::default();
        let path = PathBuf::from("/test/file.md");

        assert!(!is_self_write(&state, &path));
        record_write(&state, &path);

        // A single save produces multiple FSEvents (Create + Modify(Metadata)
        // + Modify(Data)); every match within the TTL window must be
        // suppressed, not just the first.
        assert!(is_self_write(&state, &path));
        assert!(is_self_write(&state, &path));
        assert!(is_self_write(&state, &path));
    }

    #[test]
    fn self_write_entry_is_not_consumed_on_match() {
        // Regression: an earlier implementation removed the entry on first
        // match, which dropped the second and third events from the same
        // save's fan-out and let the frontend reload the file from disk
        // mid-keystroke.
        let state = WorkspaceState::default();
        let path = PathBuf::from("/test/file.md");

        record_write(&state, &path);
        assert!(is_self_write(&state, &path));
        assert_eq!(
            state.recent_writes.read().len(),
            1,
            "entry must survive the lookup so subsequent FSEvent fan-out is also suppressed"
        );
        assert!(is_self_write(&state, &path));
        assert_eq!(state.recent_writes.read().len(), 1);
    }

    #[test]
    fn self_write_expires_after_ttl() {
        // The TTL window is what bounds suppression — past it, legitimate
        // external edits to the same path must be reflected in the editor.
        let state = WorkspaceState::default();
        let path = PathBuf::from("/test/file.md");

        // Insert a stale entry directly so the test doesn't have to sleep
        // through the real TTL.
        state.recent_writes.write().insert(
            path.clone(),
            Instant::now() - SELF_WRITE_TTL - Duration::from_millis(50),
        );

        assert!(!is_self_write(&state, &path));
    }

    #[test]
    fn workspace_identity_serialization_matches_the_shared_contract() {
        let expected: serde_json::Value = serde_json::from_str(include_str!(
            "../../shared/workspace-identity.contract.json"
        ))
        .unwrap();
        let actual = serde_json::to_value(WorkspaceIdentity {
            root: "/workspace".to_string(),
            epoch: 7,
        })
        .unwrap();

        assert_eq!(actual, expected);
    }
}
