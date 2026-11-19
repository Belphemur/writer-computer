//! Rename or move one vault file and keep every link to it working. The one
//! implementation behind `writer move` and the app's
//! sidebar rename (`commands/fs.rs::relocate_entry`); spec:
//! `SPECs/filename-links-and-rename-spec.md`, decision:
//! `docs/decisions/2026-11-16-links-resolve-by-file-name-and-rename-rewrites-links-through-one-rust-function.md`.
//!
//! [`plan`] computes the whole edit set first (no write); [`apply`] stages
//! every changed file next to its target, moves the file, then commits the
//! staged files, rolling back on an I/O error. Nothing here touches
//! `.obsidian` (confinement refuses it) and the text rewrite is byte-minimal
//! (`linkfix.rs`).

pub mod linkfix;
pub mod retitle;

use crate::index::resolve::PathIndex;
use crate::index::Index;
use crate::vault_ops::{self, VaultOpError};
use linkfix::{rewrite_base_text, rewrite_text, Move};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// One file whose text changes. `rel` is its path *before* the move.
#[derive(Debug, Clone)]
pub struct FileEdit {
    pub rel: String,
    pub before: String,
    pub after: String,
    pub links: usize,
}

#[derive(Debug, Clone)]
pub struct Plan {
    pub root: PathBuf,
    pub from: String,
    pub to: String,
    pub from_abs: PathBuf,
    pub to_abs: PathBuf,
    /// Only the letter case changes (two names for one file on a
    /// case-insensitive filesystem): done through a temporary name.
    pub case_only: bool,
    pub edits: Vec<FileEdit>,
    /// Links that point at the file but whose text could not be rewritten.
    pub skipped: usize,
    /// Files that could not be read as UTF-8 text and were left alone.
    pub unreadable: Vec<String>,
}

impl Plan {
    pub fn links(&self) -> usize {
        self.edits.iter().map(|e| e.links).sum()
    }
}

const RESERVED_WINDOWS: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// A file name (no folders) Writer is willing to create. Mirrors the
/// characters Obsidian refuses (`* " \ / < > : | ?`) plus the ones that break
/// wikilinks (`# ^ [ ]`), control characters, names the OS reserves, hidden
/// names (the index ignores them) and the protected folders.
pub fn validate_file_name(name: &str) -> Result<(), VaultOpError> {
    let bad = |why: &str| {
        Err(VaultOpError::Invalid(format!(
            "invalid file name {name:?}: {why}"
        )))
    };
    if name.trim().is_empty() {
        return bad("empty");
    }
    if name != name.trim() || name.ends_with('.') {
        return bad("no leading/trailing space or trailing dot");
    }
    if name.len() > 255 {
        return bad("longer than 255 bytes");
    }
    if let Some(c) = name
        .chars()
        .find(|c| c.is_control() || "*\"\\/<>:|?#^[]".contains(*c))
    {
        return bad(&format!("contains {c:?}"));
    }
    if name.starts_with('.') {
        return bad("hidden names are not indexed");
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
    if RESERVED_WINDOWS.contains(&stem.as_str()) {
        return bad("reserved name");
    }
    Ok(())
}

#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

fn name_of(path: &str) -> &str {
    path.rfind('/').map_or(path, |i| &path[i + 1..])
}

/// Confine `to` and keep the spelling the caller asked for when it only
/// differs in case from what `canonicalize` reports (case-insensitive fs).
fn confine_dest(root: &Path, to: &str) -> Result<(String, PathBuf), VaultOpError> {
    let c = vault_ops::confine(root, to)?;
    let wanted = to.trim().trim_start_matches('/');
    if c.rel != wanted && c.rel.eq_ignore_ascii_case(wanted) {
        let mut abs = c.abs.clone();
        abs.pop();
        abs.push(name_of(wanted));
        return Ok((wanted.to_string(), abs));
    }
    Ok((c.rel, c.abs))
}

/// Compute (without writing) what moving `from` to `to` (vault-relative or
/// absolute paths) changes. `update_links: false` plans the move alone.
pub fn plan(
    root: &Path,
    index: &Index,
    from: &str,
    to: &str,
    update_links: bool,
) -> Result<Plan, VaultOpError> {
    let src = vault_ops::confine(root, from)?;
    if !src.abs.is_file() {
        return Err(VaultOpError::NotFound(format!(
            "file not found: {}",
            src.rel
        )));
    }
    let (to_rel, to_abs) = confine_dest(root, to)?;
    validate_file_name(name_of(&to_rel))?;
    if to_rel == src.rel {
        return Err(VaultOpError::Invalid(
            "source and destination are the same".into(),
        ));
    }
    let case_only = to_rel.eq_ignore_ascii_case(&src.rel) && same_file(&src.abs, &to_abs);
    if to_abs.exists() && !case_only {
        return Err(VaultOpError::Invalid(format!("{to_rel} already exists")));
    }
    let mut plan = Plan {
        root: root.to_path_buf(),
        from: src.rel.clone(),
        to: to_rel.clone(),
        from_abs: src.abs.clone(),
        to_abs,
        case_only,
        edits: Vec::new(),
        skipped: 0,
        unreadable: Vec::new(),
    };
    // Code files are not link targets: renaming `run.py` rewrites no note.
    if !update_links || crate::code_files::is_code_path(std::path::Path::new(&src.rel)) {
        return Ok(plan);
    }

    let before = index
        .cached_paths()
        .map_err(|e| VaultOpError::Io(e.to_string()))?;
    let mut after: PathIndex = (*before).clone();
    after.remove(&src.rel);
    after.insert(to_rel.clone());
    let mv = Move {
        old: &src.rel,
        new: &to_rel,
    };
    // Candidates: notes the index says link here, the moved note itself (its
    // relative links follow it) and every `.base` (bases are not link-indexed).
    // Each is re-parsed and every link re-resolved, so a stale index row can
    // only cause a missed file, never a wrong edit.
    let mut sources: BTreeSet<String> = index
        .backlinks(&src.rel)
        .map_err(|e| VaultOpError::Io(e.to_string()))?
        .into_iter()
        .map(|b| b.source)
        .collect();
    if vault_ops::is_markdown_rel(&src.rel) {
        sources.insert(src.rel.clone());
    }
    sources.extend(before.paths().filter(|p| is_base(p)).cloned());
    for s in sources {
        let is_note = vault_ops::is_markdown_rel(&s);
        if !is_note && !is_base(&s) {
            continue;
        }
        let abs = vault_ops::confine(root, &s)?.abs;
        let text = match vault_ops::read_text(&abs) {
            Ok(t) => t,
            Err(_) => {
                plan.unreadable.push(s);
                continue;
            }
        };
        let s_after = if s == src.rel {
            to_rel.as_str()
        } else {
            s.as_str()
        };
        let rw = if is_note {
            rewrite_text(&text, &s, s_after, &mv, &before, &after)
        } else {
            rewrite_base_text(&text, &s, &mv, &before, &after)
        };
        plan.skipped += rw.skipped;
        if rw.changed > 0 {
            plan.edits.push(FileEdit {
                rel: s,
                before: text,
                after: rw.text,
                links: rw.changed,
            });
        }
    }
    Ok(plan)
}

fn is_base(rel: &str) -> bool {
    rel.to_ascii_lowercase().ends_with(".base")
}

/// What an I/O failure left behind (empty lists: the vault is as it was).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplyError {
    pub message: String,
    /// Files still carrying the rewritten links although the operation failed.
    pub changed: Vec<String>,
    /// True when the file itself is at the new path although the run failed.
    pub moved: bool,
}

impl std::fmt::Display for ApplyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)?;
        if self.changed.is_empty() && !self.moved {
            write!(f, "; nothing was changed")
        } else {
            write!(
                f,
                "; left in a partial state: file {}, links rewritten in [{}]",
                if self.moved { "moved" } else { "not moved" },
                self.changed.join(", ")
            )
        }
    }
}

struct Staged {
    rel: String,
    target: PathBuf,
    temp: PathBuf,
    before: String,
}

fn temp_beside(target: &Path) -> PathBuf {
    target
        .parent()
        .unwrap_or(Path::new("."))
        .join(format!(".~{}", uuid::Uuid::new_v4()))
}

fn rename_atomic(from: &Path, to: &Path, case_only: bool) -> std::io::Result<()> {
    if case_only {
        let tmp = temp_beside(from);
        std::fs::rename(from, &tmp)?;
        if let Err(e) = std::fs::rename(&tmp, to) {
            let _ = std::fs::rename(&tmp, from);
            return Err(e);
        }
        Ok(())
    } else {
        std::fs::rename(from, to)
    }
}

/// Apply a plan: verify nothing changed since planning, stage the new text
/// of every referrer, move the file, commit the staged files. On an I/O error
/// everything already done is undone; whatever could not be undone is listed
/// in the error.
pub fn apply(plan: &Plan) -> Result<(), ApplyError> {
    let fail = |message: String, changed: Vec<String>, moved: bool| ApplyError {
        message,
        changed,
        moved,
    };
    // 1. Verify: a referrer edited since planning would be overwritten.
    for e in &plan.edits {
        let abs = actual_abs(plan, &e.rel);
        match std::fs::read_to_string(&abs) {
            Ok(t) if t == e.before => {}
            Ok(_) => {
                return Err(fail(
                    format!("{} changed while planning; retry", e.rel),
                    vec![],
                    false,
                ))
            }
            Err(err) => return Err(fail(format!("cannot read {}: {err}", e.rel), vec![], false)),
        }
    }
    // 2. Stage the referrers (not the moved note: it is written after the move).
    let mut staged: Vec<Staged> = Vec::new();
    let cleanup = |staged: &[Staged]| {
        for s in staged {
            let _ = std::fs::remove_file(&s.temp);
        }
    };
    let mut self_edit: Option<&FileEdit> = None;
    for e in &plan.edits {
        if e.rel == plan.from {
            self_edit = Some(e);
            continue;
        }
        let target = actual_abs(plan, &e.rel);
        let temp = temp_beside(&target);
        if let Err(err) = std::fs::write(&temp, &e.after) {
            cleanup(&staged);
            let _ = std::fs::remove_file(&temp);
            return Err(fail(
                format!("cannot stage {}: {err}", e.rel),
                vec![],
                false,
            ));
        }
        if let Ok(meta) = std::fs::metadata(&target) {
            let _ = std::fs::set_permissions(&temp, meta.permissions());
        }
        staged.push(Staged {
            rel: e.rel.clone(),
            target,
            temp,
            before: e.before.clone(),
        });
    }
    // 3. Move the file (a retitle plan, `from == to`, only rewrites text).
    let moves = plan.from != plan.to;
    let mut created_dir: Option<PathBuf> = None;
    if let Some(parent) = plan.to_abs.parent().filter(|_| moves) {
        if !parent.exists() {
            if let Err(err) = std::fs::create_dir_all(parent) {
                cleanup(&staged);
                return Err(fail(
                    format!("cannot create {}: {err}", parent.display()),
                    vec![],
                    false,
                ));
            }
            created_dir = Some(parent.to_path_buf());
        }
    }
    if let Err(err) = moves
        .then(|| rename_atomic(&plan.from_abs, &plan.to_abs, plan.case_only))
        .unwrap_or(Ok(()))
    {
        cleanup(&staged);
        if let Some(d) = &created_dir {
            let _ = std::fs::remove_dir(d);
        }
        return Err(fail(
            format!("cannot move {} to {}: {err}", plan.from, plan.to),
            vec![],
            false,
        ));
    }
    // 4. Commit the staged files, then the moved note's own rewrite.
    let mut done: Vec<&Staged> = Vec::new();
    let mut error: Option<String> = None;
    for s in &staged {
        match std::fs::rename(&s.temp, &s.target) {
            Ok(()) => done.push(s),
            Err(err) => {
                error = Some(format!("cannot update links in {}: {err}", s.rel));
                break;
            }
        }
    }
    if error.is_none() {
        if let Some(e) = self_edit {
            if let Err(err) = vault_ops::write_text(&plan.to_abs, &e.after) {
                error = Some(format!("cannot update links in {}: {err}", plan.to));
            }
        }
    }
    let Some(message) = error else {
        // The per-path stores (icons, ignored words) of the moved file or folder follow it;
        // a failure there never fails the move.
        if moves {
            crate::vault_events::moved(&plan.root, &plan.from, &plan.to);
        }
        return Ok(());
    };
    // Roll back: restore committed referrers, drop the rest, move the file back.
    cleanup(&staged);
    let mut still_changed: Vec<String> = Vec::new();
    for s in done {
        if std::fs::write(&s.target, &s.before).is_err() {
            still_changed.push(s.rel.clone());
        }
    }
    let moved_back = !moves || rename_atomic(&plan.to_abs, &plan.from_abs, plan.case_only).is_ok();
    if moved_back {
        if let Some(d) = &created_dir {
            let _ = std::fs::remove_dir(d);
        }
    }
    Err(fail(message, still_changed, !moved_back))
}

/// Absolute path of a planned referrer (the moved note: before the move).
fn actual_abs(plan: &Plan, rel: &str) -> PathBuf {
    if rel == plan.from {
        plan.from_abs.clone()
    } else {
        plan.root.join(rel)
    }
}

#[cfg(test)]
mod tests;
