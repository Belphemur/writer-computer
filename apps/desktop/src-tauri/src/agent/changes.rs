//! What the agent changed during a turn: the data behind the "Changes" card. Tauri-free.
//! Spec: `SPECs/native-agent-spec.md` "Turn changes".
//!
//! Source of truth. The CLI edits the vault itself, so Writer snapshots, never reproduces: when a
//! mutating tool call's input is complete (`tool-call-input`, or its permission request when that
//! comes first), and therefore before the tool ran, [`ChangeStore::capture`] stores the file's
//! text as it is on disk (the pre-image). At `turn-finished`, [`ChangeStore::finish`] reads the
//! files again (the end image) and diffs the two, so several edits of one file, a denied edit
//! and an edit that Bash later touched are all accounted for correctly for the files that were
//! snapshotted. The end image also is what Undo checks the file against, so Undo never overwrites
//! a newer edit.
//!
//! Tracked with a diff: the paths of `Edit`, `MultiEdit`, `Write` and `NotebookEdit` calls (a file
//! created by `Write` has an absent pre-image).
//!
//! Tracked without a diff. (1) Shell commands: while a `Bash` call of the chat is in flight
//! ([`command_windows`](super::command_windows): its window and the trade-offs), the vault files
//! the file watcher reports as changed are recorded as "changed by a command"
//! ([`ChangeStore::record_command_changes`]): listed, attributed to the role whose command ran,
//! never with a diff or Undo (there is no pre-image). Only what Writer shows is listed
//! (`code_files::rel_is_visible` and `is_listed_path`: no hidden folders, no ignored folders, no
//! unlisted file types; never the memory folders) and a file that an edit call already
//! snapshotted in the turn keeps that record. (2) The timing gap: when the pre-image read lost the
//! race against the tool ([`edit_inverse`](super::edit_inverse)), an `Edit`/`MultiEdit` whose
//! inverse is exact gets the reconstructed pre-image (a normal record), any other raced call is
//! "before unknown": listed, no diff, no Undo. Detection needs the file to have been modified
//! within [`RACE_WINDOW`] of the capture, so an old file never looks raced.
//! Undo exists only for a trusted pre-image: read from disk before the tool ran, or reconstructed.
//!
//! Limits. Memory only: snapshots are never written to disk, never into the vault and never
//! logged. A file over [`MAX_FILE_BYTES`], a binary one or one that no longer fits in
//! [`MAX_TOTAL_BYTES`] keeps only a fingerprint: it is listed but has no diff and no Undo. When
//! the total is exceeded the oldest turn is dropped first. Paths are confined to the vault root
//! (`vault_ops::confine`: no `..`, no symlink out, no `.git`/`.obsidian`). The agent's memory
//! folders (`memory::is_memory_rel`) are never tracked: not in the card, not undoable.
//!
//! The session. The same capture also keeps, per chat, the first pre-image of every path as that
//! chat's session baseline (ADR 2026-11-18 "Show a chat's changed notes in a compact row ..."):
//! [`ChangeStore::session_summary`] and [`ChangeStore::session_detail`] diff the baselines against
//! the files as they are now, so the row above the composer and the "Session changes" tab read
//! the one store the turn card reads. Same rules and the same exclusions; the baselines are
//! memory only and have their own budget of [`MAX_TOTAL_BYTES`] (a baseline that does not fit
//! keeps a fingerprint: listed, no diff). They live until Writer exits.

use super::command_windows::CommandWindows;
use super::edit_inverse::{settle, Settled};
use super::events::*;
use super::line_diff::{counts, diff_lines, split_lines, Edit};
use super::memory;
use super::sub_tracker::Author;
use crate::vault_ops;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
/// A diff longer than this is cut (`truncated`).
pub const MAX_DIFF_ROWS: usize = 20_000;
/// Longer lines are cut for display.
pub const MAX_ROW_CHARS: usize = 2_000;
/// Over this many lines on both sides together the file is listed without a diff.
const MAX_DIFF_LINES: usize = 200_000;

/// Tools that edit a file, with the input keys that hold its path. Twin of the `edit` kind in
/// `features/agent/web/lib/tool-kinds.ts` (the TS side only renders; this side must know the paths).
const EDIT_TOOLS: [&str; 4] = ["Edit", "MultiEdit", "Write", "NotebookEdit"];
const PATH_KEYS: [&str; 3] = ["file_path", "notebook_path", "path"];
const SHELL_TOOL: &str = "Bash";
/// A file modified this recently when its pre-image was read may already hold the tool's edit.
pub const RACE_WINDOW: Duration = Duration::from_secs(5);

/// Whether `tool` edits a file (its end is when the session's counts change).
pub fn is_edit_tool(tool: &str) -> bool {
    EDIT_TOOLS.contains(&tool)
}

/// Whether `tool` is a shell command (its window is when watcher changes are blamed on it).
pub fn is_shell_tool(tool: &str) -> bool {
    tool == SHELL_TOOL
}

/// Why a file has no usable "before" although it was changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unknown {
    /// Seen by the watcher during a shell command.
    Command,
    /// An edit call that the pre-image read raced.
    Race,
}

/// One side of a file: its text, or only a fingerprint when the text cannot be kept.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Snap {
    /// `None`: the file does not exist.
    Text(Option<String>),
    /// Size and modification time; `None`: the file does not exist.
    Opaque(Option<(u64, Option<SystemTime>)>),
    /// A pre-image that does not exist for sure: the file is listed, never diffed or undone.
    /// Only ever a `pre` side.
    Unknown(Unknown),
}

impl Snap {
    fn origin(&self) -> ChangeOrigin {
        match self {
            Snap::Unknown(Unknown::Command) => ChangeOrigin::Command,
            Snap::Unknown(Unknown::Race) => ChangeOrigin::BeforeUnknown,
            _ => ChangeOrigin::Edit,
        }
    }
    fn bytes(&self) -> usize {
        match self {
            Snap::Text(Some(s)) => s.len(),
            _ => 0,
        }
    }
    fn exists(&self) -> bool {
        !matches!(self, Snap::Text(None) | Snap::Opaque(None))
    }
}

/// Modified within [`RACE_WINDOW`] before now: the only files a tool can have just written.
fn modified_recently(abs: &Path) -> bool {
    std::fs::metadata(abs)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age <= RACE_WINDOW)
}

/// The pre-image of `tool`'s call on `abs`, from the text read just now.
fn settled_pre(tool: &str, input: &Value, abs: &Path, snap: Snap) -> Snap {
    let Snap::Text(Some(text)) = &snap else {
        return snap;
    };
    if !modified_recently(abs) {
        return snap;
    }
    match settle(tool, input, text) {
        Settled::AsCaptured => snap,
        Settled::Reconstructed(before) => Snap::Text(Some(before)),
        Settled::Unknown => Snap::Unknown(Unknown::Race),
    }
}

/// Reads `abs` as it is now. `keep_text` false (the budget is spent) keeps only the fingerprint.
fn read_snap(abs: &Path, keep_text: bool) -> Snap {
    let meta = match std::fs::metadata(abs) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Snap::Text(None),
        Err(_) => return Snap::Opaque(Some((0, None))),
    };
    let print = (meta.len(), meta.modified().ok());
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES || !keep_text {
        return Snap::Opaque(Some(print));
    }
    match std::fs::read(abs) {
        Ok(bytes) if !bytes.contains(&0) => match String::from_utf8(bytes) {
            Ok(text) => Snap::Text(Some(text)),
            Err(_) => Snap::Opaque(Some(print)),
        },
        Ok(_) => Snap::Opaque(Some(print)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Snap::Text(None),
        Err(_) => Snap::Opaque(Some(print)),
    }
}

struct FileRec {
    /// The sub-agent role that made the first edit of this file in the turn (`None`: the main agent).
    by: Option<Author>,
    rel: String,
    abs: PathBuf,
    pre: Snap,
    end: Snap,
    reverted: AtomicBool,
}

impl FileRec {
    fn new(by: Option<Author>, rel: &str, abs: &Path, pre: Snap) -> Self {
        Self {
            by,
            rel: rel.to_string(),
            abs: abs.to_path_buf(),
            pre,
            end: Snap::Opaque(None),
            reverted: AtomicBool::new(false),
        }
    }

    /// Compare the disk to the end image the way it was taken.
    fn keeps_text(&self) -> bool {
        !matches!(self.end, Snap::Opaque(_))
    }
}

struct OpenTurn {
    id: String,
    root: PathBuf,
    files: Vec<FileRec>,
    bash: bool,
    bytes: usize,
}

/// A finished turn, immutable except for the `reverted` flags.
pub struct TurnRec {
    chat_id: String,
    id: String,
    root: PathBuf,
    files: Vec<FileRec>,
    bash: bool,
    bytes: usize,
}

/// What a closed turn needs to be finished (moved out of the store under its lock, so the file
/// reads happen outside it and before a queued message can start the next turn).
pub struct ClosedTurn {
    chat_id: String,
    turn: OpenTurn,
}

/// A chat's first-touch version of one path.
struct SessionFile {
    by: Option<Author>,
    rel: String,
    abs: PathBuf,
    base: Snap,
}

struct Session {
    root: PathBuf,
    /// In first-touch order.
    files: Vec<SessionFile>,
}

struct Inner {
    finished: VecDeque<Arc<TurnRec>>,
    open: HashMap<String, OpenTurn>,
    sessions: HashMap<String, Session>,
    /// Bytes of the session baselines (a budget apart from `used`: a long chat must not starve
    /// the turn card's pre-images).
    session_used: usize,
    /// Bytes of every kept snapshot, open and finished.
    used: usize,
    counter: u64,
    windows: CommandWindows,
}

impl Inner {
    /// Adds `f` to its chat's session baselines unless the chat has the path already (the
    /// first-touch version wins). Returns whether it was added.
    fn track_in_session(
        &mut self,
        chat_id: &str,
        root: &Path,
        f: &FileRec,
        max_total: usize,
    ) -> bool {
        let session = self
            .sessions
            .entry(chat_id.to_string())
            .or_insert_with(|| Session {
                root: root.to_path_buf(),
                files: Vec::new(),
            });
        if session.files.iter().any(|s| s.abs == f.abs) {
            return false;
        }
        let base = if matches!(f.pre, Snap::Unknown(_))
            || self.session_used + f.pre.bytes() <= max_total
        {
            f.pre.clone()
        } else {
            read_snap(&f.abs, false)
        };
        self.session_used += base.bytes();
        session.files.push(SessionFile {
            by: f.by.clone(),
            rel: f.rel.clone(),
            abs: f.abs.clone(),
            base,
        });
        true
    }

    fn next_turn_id(&mut self) -> String {
        self.counter += 1;
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("t{:x}{:x}", ms, self.counter)
    }
}

pub struct ChangeStore {
    inner: Mutex<Inner>,
    max_total: usize,
    /// Serialises reverts so two clicks never interleave.
    revert_lock: Mutex<()>,
}

impl Default for ChangeStore {
    fn default() -> Self {
        Self::with_cap(MAX_TOTAL_BYTES)
    }
}

/// One row of the card: a file, or a rename (two records).
struct Entry {
    main: usize,
    /// The old side of a rename.
    from: Option<usize>,
    status: ChangeStatus,
}

/// Classifies the records of a turn: unchanged ones drop out, an identical deleted + added text
/// pair becomes one rename.
fn plan(files: &[FileRec]) -> Vec<Entry> {
    let mut entries: Vec<Entry> = Vec::new();
    for (i, f) in files.iter().enumerate() {
        let status = match (f.pre.exists(), f.end.exists()) {
            // no usable "before": listed whenever the file is there or gone now
            _ if matches!(f.pre, Snap::Unknown(_)) => {
                if f.end.exists() {
                    ChangeStatus::Modified
                } else {
                    ChangeStatus::Deleted
                }
            }
            (false, false) => continue,
            (false, true) => ChangeStatus::Added,
            (true, false) => ChangeStatus::Deleted,
            (true, true) if f.pre == f.end => continue,
            (true, true) => ChangeStatus::Modified,
        };
        entries.push(Entry {
            main: i,
            from: None,
            status,
        });
    }
    let deleted: Vec<usize> = entries
        .iter()
        .filter(|e| e.status == ChangeStatus::Deleted)
        .map(|e| e.main)
        .collect();
    let mut taken: Vec<usize> = Vec::new();
    for e in entries
        .iter_mut()
        .filter(|e| e.status == ChangeStatus::Added)
    {
        let Snap::Text(Some(new)) = &files[e.main].end else {
            continue;
        };
        let twin = deleted.iter().copied().find(|d| {
            !taken.contains(d)
                && matches!(&files[*d].pre, Snap::Text(Some(old)) if old == new && !new.is_empty())
        });
        if let Some(d) = twin {
            taken.push(d);
            e.from = Some(d);
            e.status = ChangeStatus::Renamed;
        }
    }
    entries.retain(|e| !taken.contains(&e.main));
    entries
}

fn diff_of(pre: &Snap, end: &Snap) -> Option<(Vec<Edit>, Vec<String>, Vec<String>)> {
    let old = match pre {
        Snap::Text(t) => t.as_deref().unwrap_or(""),
        Snap::Opaque(_) | Snap::Unknown(_) => return None,
    };
    let new = match end {
        Snap::Text(t) => t.as_deref().unwrap_or(""),
        Snap::Opaque(_) | Snap::Unknown(_) => return None,
    };
    let (la, lb) = (split_lines(old), split_lines(new));
    if la.len() + lb.len() > MAX_DIFF_LINES {
        return None;
    }
    let edits = diff_lines(&la, &lb);
    Some((
        edits,
        la.iter().map(|s| s.to_string()).collect(),
        lb.iter().map(|s| s.to_string()).collect(),
    ))
}

fn cut_row(line: &str) -> String {
    let line = line.strip_suffix('\r').unwrap_or(line);
    if line.chars().count() > MAX_ROW_CHARS {
        let mut s: String = line.chars().take(MAX_ROW_CHARS).collect();
        s.push('…');
        s
    } else {
        line.to_string()
    }
}

fn summary_of(files: &[FileRec], e: &Entry) -> FileChangeSummary {
    let f = &files[e.main];
    let (added, removed, no_diff) = match e.status {
        ChangeStatus::Renamed => (0, 0, false),
        _ => match diff_of(&f.pre, &f.end) {
            Some((edits, ..)) => {
                let (a, d) = counts(&edits);
                (a, d, false)
            }
            None => (0, 0, true),
        },
    };
    FileChangeSummary {
        path: f.rel.clone(),
        status: e.status,
        added,
        removed,
        old_path: e.from.map(|i| files[i].rel.clone()),
        no_diff,
        origin: f.pre.origin(),
        by: f.by.as_ref().map(|a| a.label.clone()),
        by_call: f.by.as_ref().map(|a| a.call_id.clone()),
    }
}

fn rows_of(pre: &Snap, end: &Snap) -> (Vec<DiffRow>, bool) {
    let Some((edits, la, lb)) = diff_of(pre, end) else {
        return (Vec::new(), false);
    };
    let mut rows = Vec::with_capacity(edits.len().min(MAX_DIFF_ROWS));
    for e in &edits {
        if rows.len() >= MAX_DIFF_ROWS {
            return (rows, true);
        }
        rows.push(match *e {
            Edit::Equal(i, j) => DiffRow {
                kind: DiffRowKind::Context,
                old_line: Some(i as u32 + 1),
                new_line: Some(j as u32 + 1),
                text: cut_row(&lb[j]),
            },
            Edit::Del(i) => DiffRow {
                kind: DiffRowKind::Del,
                old_line: Some(i as u32 + 1),
                new_line: None,
                text: cut_row(&la[i]),
            },
            Edit::Add(j) => DiffRow {
                kind: DiffRowKind::Add,
                old_line: None,
                new_line: Some(j as u32 + 1),
                text: cut_row(&lb[j]),
            },
        });
    }
    (rows, false)
}

/// The diff rows of an entry (none for a rename, whose content is equal).
fn rows_for(files: &[FileRec], e: &Entry) -> (Vec<DiffRow>, bool) {
    match e.status {
        ChangeStatus::Renamed => (Vec::new(), false),
        _ => rows_of(&files[e.main].pre, &files[e.main].end),
    }
}

/// Whether `f` could be reverted if the disk still matched the end image.
fn restorable(f: &FileRec) -> bool {
    matches!(f.pre, Snap::Text(_)) && !matches!(f.end, Snap::Opaque(None))
}

fn undo_state(files: &[FileRec], e: &Entry) -> UndoState {
    let recs: Vec<&FileRec> = std::iter::once(e.main)
        .chain(e.from)
        .map(|i| &files[i])
        .collect();
    if recs.iter().all(|f| f.reverted.load(Ordering::SeqCst)) {
        return UndoState::Reverted;
    }
    if !recs.iter().all(|f| restorable(f)) {
        return UndoState::Unavailable;
    }
    // each record is checked against the end image, a deleted one against "still absent"
    if recs
        .iter()
        .all(|f| f.reverted.load(Ordering::SeqCst) || read_snap(&f.abs, f.keeps_text()) == f.end)
    {
        UndoState::Available
    } else {
        UndoState::ChangedSince
    }
}

/// A watcher path that may be listed as "changed by a command": inside the vault, a file Writer
/// shows (see the module doc), not the agent's memory.
fn trackable_change(root: &Path, path: &Path) -> Option<vault_ops::Confined> {
    let c = vault_ops::confine(root, &path.to_string_lossy()).ok()?;
    let rel = Path::new(&c.rel);
    let shown = !memory::is_memory_rel(&c.rel)
        && crate::code_files::rel_is_visible(rel)
        && crate::code_files::is_listed_path(rel);
    (shown && !c.abs.is_dir()).then_some(c)
}

impl ChangeStore {
    pub fn with_cap(max_total: usize) -> Self {
        Self {
            inner: Mutex::new(Inner {
                finished: VecDeque::new(),
                open: HashMap::new(),
                sessions: HashMap::new(),
                session_used: 0,
                used: 0,
                counter: 0,
                windows: CommandWindows::default(),
            }),
            max_total,
            revert_lock: Mutex::new(()),
        }
    }

    /// Records the pre-image of the files a tool call is about to change (or notes that a shell
    /// command ran). Call it as soon as the call's input is complete. Idempotent per file and
    /// turn: the first snapshot wins, so a permission request after the input changes nothing.
    pub fn capture(&self, chat_id: &str, root: &Path, cwd: &Path, tool: &str, input: &Value) {
        self.capture_by(chat_id, root, cwd, tool, input, None);
    }

    /// [`ChangeStore::capture`] for a call made by a sub-agent: `by` is its role label and run, kept on
    /// the file's record (the first snapshot wins, so the first author does too).
    pub fn capture_by(
        &self,
        chat_id: &str,
        root: &Path,
        cwd: &Path,
        tool: &str,
        input: &Value,
        by: Option<&Author>,
    ) {
        let shell = tool == SHELL_TOOL;
        if !shell && !EDIT_TOOLS.contains(&tool) {
            return;
        }
        let Ok(root) = root.canonicalize() else {
            return;
        };
        let mut targets: Vec<vault_ops::Confined> = Vec::new();
        if !shell {
            let Some(rec) = input.as_object() else { return };
            for key in PATH_KEYS {
                let Some(p) = rec.get(key).and_then(Value::as_str) else {
                    continue;
                };
                let joined = if Path::new(p).is_absolute() {
                    p.to_string()
                } else {
                    cwd.join(p).to_string_lossy().into_owned()
                };
                // outside the vault, through a link out, `..`, a protected folder: not tracked;
                // nor is the agent's own memory (`memory.rs`): saving a fact is not a note edit
                if let Ok(c) = vault_ops::confine(&root, &joined) {
                    if !memory::is_memory_rel(&c.rel) {
                        targets.push(c);
                    }
                }
                break;
            }
        }
        let fresh: Vec<&vault_ops::Confined> = {
            let g = self.inner.lock();
            let known = g.open.get(chat_id);
            targets
                .iter()
                .filter(|c| !known.is_some_and(|t| t.files.iter().any(|f| f.abs == c.abs)))
                .collect()
        };
        // reading happens outside the lock; a read that lost the race against the tool is
        // settled here (reconstructed, or "before unknown")
        let snaps: Vec<(&vault_ops::Confined, Snap)> = fresh
            .into_iter()
            .map(|c| {
                let snap = read_snap(&c.abs, true);
                (c, settled_pre(tool, input, &c.abs, snap))
            })
            .collect();
        let mut g = self.inner.lock();
        // a pre-image that no longer fits (after dropping the oldest turns) keeps a fingerprint
        let mut kept: Vec<FileRec> = Vec::new();
        let mut add_bytes = 0usize;
        for (c, mut snap) in snaps {
            if kept.iter().any(|f| f.abs == c.abs) {
                continue;
            }
            while g.used + add_bytes + snap.bytes() > self.max_total {
                let Some(old) = g.finished.pop_front() else {
                    break;
                };
                g.used = g.used.saturating_sub(old.bytes);
            }
            if g.used + add_bytes + snap.bytes() > self.max_total {
                snap = read_snap(&c.abs, false);
            }
            add_bytes += snap.bytes();
            kept.push(FileRec::new(by.cloned(), &c.rel, &c.abs, snap));
        }
        if !shell && kept.is_empty() {
            return;
        }
        for f in &kept {
            g.track_in_session(chat_id, &root, f, self.max_total);
        }
        let stamp = g.next_turn_id();
        let open = g
            .open
            .entry(chat_id.to_string())
            .or_insert_with(|| OpenTurn {
                id: stamp,
                root: root.clone(),
                files: Vec::new(),
                bash: false,
                bytes: 0,
            });
        open.bash |= shell;
        open.files.extend(kept);
        open.bytes += add_bytes;
        g.used += add_bytes;
    }

    /// A `Bash` call of the chat started (its `tool-call-started`): from now its window explains
    /// the changes the watcher reports. `by` is the sub-agent that made the call. No file IO.
    pub fn command_started(&self, chat_id: &str, call_id: &str, by: Option<&Author>, at: Instant) {
        self.inner
            .lock()
            .windows
            .start(chat_id, call_id, by.cloned(), at);
    }

    /// The call got its `tool_result` (any tool id may be passed; only `Bash` calls have a window).
    pub fn command_finished(&self, chat_id: &str, call_id: &str, at: Instant) {
        self.inner.lock().windows.finish(chat_id, call_id, at);
    }

    /// The chat's process or turn ended: no command of it runs any more.
    pub fn commands_ended(&self, chat_id: &str, at: Instant) {
        self.inner.lock().windows.end_chat(chat_id, at);
    }

    /// Vault files the watcher reported as changed at `at` (Writer's own writes already removed
    /// by the caller). While a command window of the chat explains `at` they are recorded as
    /// "changed by a command" in the open turn and the session, except the ones the turn already
    /// tracks. Returns whether the chat's session may have changed (publish it). Reads metadata
    /// only (never file text), so call it off the watcher thread.
    pub fn record_command_changes(
        &self,
        chat_id: &str,
        root: &Path,
        paths: &[PathBuf],
        at: Instant,
    ) -> bool {
        let Ok(root) = root.canonicalize() else {
            return false;
        };
        let Some(by) = self.inner.lock().windows.explaining(chat_id, at) else {
            return false;
        };
        let found: Vec<vault_ops::Confined> = paths
            .iter()
            .filter_map(|p| trackable_change(&root, p))
            .collect();
        if found.is_empty() {
            return false;
        }
        let mut g = self.inner.lock();
        for c in &found {
            let rec = |by: &Option<Author>| {
                FileRec::new(by.clone(), &c.rel, &c.abs, Snap::Unknown(Unknown::Command))
            };
            g.track_in_session(chat_id, &root, &rec(&by), self.max_total);
            if let Some(turn) = g.open.get_mut(chat_id) {
                if !turn.files.iter().any(|f| f.abs == c.abs) {
                    turn.files.push(rec(&by));
                }
            }
        }
        true
    }

    /// Takes the chat's open turn out of the store, if any file was snapshotted or a shell ran.
    /// Cheap (no file IO): call it under the runner's lock, then [`ChangeStore::finish`] outside.
    pub fn close_turn(&self, chat_id: &str) -> Option<ClosedTurn> {
        let turn = self.inner.lock().open.remove(chat_id)?;
        Some(ClosedTurn {
            chat_id: chat_id.to_string(),
            turn,
        })
    }

    /// Reads the end images, keeps the turn for `detail`/`revert` and returns the compact
    /// summary, or `None` when no vault file changed (a turn with only a shell command, or a
    /// denied edit, shows no card).
    pub fn finish(&self, closed: ClosedTurn) -> Option<TurnChangesSummary> {
        let ClosedTurn { chat_id, mut turn } = closed;
        let mut end_bytes = 0usize;
        {
            let g = self.inner.lock();
            // what is still free after this turn's own pre-images
            let free = self.max_total.saturating_sub(g.used);
            drop(g);
            let mut budget = free;
            for f in &mut turn.files {
                // an unchanged-looking file needs no text: compare cheaply first
                f.end = read_snap(&f.abs, true);
                let size = f.end.bytes();
                if size > budget {
                    f.end = read_snap(&f.abs, false);
                } else {
                    budget -= size;
                    end_bytes += size;
                }
            }
        }
        let entries = plan(&turn.files);
        let summaries: Vec<FileChangeSummary> =
            entries.iter().map(|e| summary_of(&turn.files, e)).collect();
        let total = turn.bytes + end_bytes;
        let rec = Arc::new(TurnRec {
            chat_id,
            id: turn.id.clone(),
            root: turn.root,
            files: turn.files,
            bash: turn.bash,
            bytes: total,
        });
        let mut g = self.inner.lock();
        // the pre-images were counted while open; the end images are new
        g.used += end_bytes;
        if summaries.is_empty() {
            g.used = g.used.saturating_sub(total);
            return None;
        }
        g.finished.push_back(Arc::clone(&rec));
        while g.used > self.max_total && g.finished.len() > 1 {
            let old = g.finished.pop_front().expect("len > 1");
            g.used = g.used.saturating_sub(old.bytes);
        }
        Some(TurnChangesSummary {
            turn_id: rec.id.clone(),
            files: summaries,
            bash: rec.bash,
        })
    }

    fn find(&self, chat_id: &str, turn_id: &str, root: &Path) -> Option<Arc<TurnRec>> {
        let root = root.canonicalize().ok()?;
        self.inner
            .lock()
            .finished
            .iter()
            .find(|t| t.chat_id == chat_id && t.id == turn_id && t.root == root)
            .cloned()
    }

    /// The diffs of a finished turn, or `None` when the snapshot is gone (app restart, evicted).
    pub fn detail(&self, chat_id: &str, turn_id: &str, root: &Path) -> Option<TurnChanges> {
        let t = self.find(chat_id, turn_id, root)?;
        let files = plan(&t.files)
            .iter()
            .map(|e| {
                let (rows, truncated) = rows_for(&t.files, e);
                FileChange {
                    summary: summary_of(&t.files, e),
                    rows,
                    truncated,
                    undo: undo_state(&t.files, e),
                }
            })
            .collect();
        Some(TurnChanges {
            turn_id: t.id.clone(),
            files,
            bash: t.bash,
        })
    }

    /// The chat's first-touch versions against the files now, as records the turn code reads
    /// (`pre` = baseline, `end` = disk). Files are read outside the lock. `None`: this chat has
    /// no session in this vault.
    fn session_recs(&self, chat_id: &str, root: &Path) -> Option<Vec<FileRec>> {
        let root = root.canonicalize().ok()?;
        let items: Vec<(Option<Author>, String, PathBuf, Snap)> = {
            let g = self.inner.lock();
            let s = g.sessions.get(chat_id).filter(|s| s.root == root)?;
            s.files
                .iter()
                .map(|f| (f.by.clone(), f.rel.clone(), f.abs.clone(), f.base.clone()))
                .collect()
        };
        Some(
            items
                .into_iter()
                .map(|(by, rel, abs, pre)| FileRec {
                    by,
                    rel,
                    end: read_snap(&abs, true),
                    abs,
                    pre,
                    reverted: AtomicBool::new(false),
                })
                .collect(),
        )
    }

    /// Every note this chat changed, compact (the row above the composer). `None` when the chat
    /// has touched no file. A note edited back to its first version drops out.
    pub fn session_summary(&self, chat_id: &str, root: &Path) -> Option<SessionChangesSummary> {
        let recs = self.session_recs(chat_id, root)?;
        let files = plan(&recs).iter().map(|e| summary_of(&recs, e)).collect();
        Some(SessionChangesSummary { files })
    }

    /// The session's diffs (the "Session changes" tab), each note against its first-touch version.
    pub fn session_detail(&self, chat_id: &str, root: &Path) -> Option<SessionChanges> {
        let recs = self.session_recs(chat_id, root)?;
        let files = plan(&recs)
            .iter()
            .map(|e| {
                let (rows, truncated) = rows_for(&recs, e);
                SessionFileChange {
                    summary: summary_of(&recs, e),
                    rows,
                    truncated,
                }
            })
            .collect();
        Some(SessionChanges { files })
    }

    /// Restores the pre-turn content of `paths` (a rename restores both sides). Per path: refused
    /// when the file changed since the turn ended, when there is no pre-image, or when it is not a
    /// path of this turn. `None` when the snapshot is gone.
    pub fn revert(
        &self,
        chat_id: &str,
        turn_id: &str,
        root: &Path,
        paths: &[String],
    ) -> Option<Vec<RevertOutcome>> {
        let t = self.find(chat_id, turn_id, root)?;
        let _one_at_a_time = self.revert_lock.lock();
        let entries = plan(&t.files);
        Some(
            paths
                .iter()
                .map(|p| {
                    let outcome = |result, message: Option<&str>| RevertOutcome {
                        path: p.clone(),
                        result,
                        message: message.map(String::from),
                    };
                    let Some(e) = entries.iter().find(|e| &t.files[e.main].rel == p) else {
                        return outcome(
                            RevertResult::Unavailable,
                            Some("not changed in this turn"),
                        );
                    };
                    match undo_state(&t.files, e) {
                        UndoState::Reverted => return outcome(RevertResult::Reverted, None),
                        UndoState::Unavailable => {
                            return outcome(
                                RevertResult::Unavailable,
                                Some("no copy from before the turn"),
                            )
                        }
                        UndoState::ChangedSince => {
                            return outcome(RevertResult::ChangedSince, Some("file changed since"))
                        }
                        UndoState::Available => {}
                    }
                    for i in std::iter::once(e.main).chain(e.from) {
                        if let Err(msg) = restore(&t.root, &t.files[i]) {
                            return outcome(RevertResult::Failed, Some(&msg));
                        }
                    }
                    outcome(RevertResult::Reverted, None)
                })
                .collect(),
        )
    }
}

/// Writes the pre-image back (atomic write, parent folders recreated) or removes the file the
/// turn created. The path is confined again at the moment of writing.
fn restore(root: &Path, f: &FileRec) -> Result<(), String> {
    let c = vault_ops::confine(root, &f.abs.to_string_lossy()).map_err(|e| e.to_string())?;
    if c.abs != f.abs {
        return Err("the path now resolves elsewhere".into());
    }
    match &f.pre {
        Snap::Text(Some(text)) => {
            if let Some(parent) = c.abs.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            // not recorded as a self-write: the watcher reports it like any external edit, so an
            // open tab reloads
            vault_ops::write_text(&c.abs, text).map_err(|e| e.to_string())?;
        }
        Snap::Text(None) => match std::fs::remove_file(&c.abs) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        },
        Snap::Opaque(_) | Snap::Unknown(_) => return Err("no copy from before the turn".into()),
    }
    f.reverted.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
#[path = "changes_tests.rs"]
mod tests;
