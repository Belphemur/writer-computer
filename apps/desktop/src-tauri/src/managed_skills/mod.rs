//! Writer-managed agent skills. Every workspace gets `writer-cli`,
//! `writer-search` and `writer-bases` in both `<vault>/.agents/skills/` and
//! `<vault>/.claude/skills/`, so Claude Code and other agents opened in the vault
//! know how to use the `writer` CLI. Spec: `SPECs/managed-vault-skills-spec.md`.
//!
//! Tauri-free (the app glue is `commands/skills.rs`, the CLI front end is
//! `cli/cmd_skills.rs`), so the same code runs in both.
//!
//! Update policy per `<root>/<name>` directory, decided by the markers in its
//! `SKILL.md` frontmatter (`writer-managed: true`, `writer-skills-version`,
//! `writer-content-hash`, `writer-files`):
//!
//! | installed                                   | action                             |
//! | ------------------------------------------- | ---------------------------------- |
//! | missing                                     | install                            |
//! | marked, older version                       | update                             |
//! | marked, same version, a file differs/missing| restore (the files are Writer's)   |
//! | marked, same version, identical             | nothing                            |
//! | marked, newer version                       | leave, report                      |
//! | no marker (the user's own skill)            | never touch, report                |
//! | marked, name no longer bundled              | remove what Writer wrote           |
//!
//! Nothing is written outside the vault (every path goes through
//! `vault_ops::confine`, which resolves symlinks), nothing into `.obsidian` or
//! `.git`, and only files Writer wrote are ever deleted.

mod bundle;
#[cfg(test)]
mod tests;

pub use bundle::{BundledFile, BundledSkill, BUNDLE_VERSION, SKILLS};

use crate::vault_ops::{self, VaultOpError};
use serde::Serialize;
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// Where each agent family looks for skills, relative to the vault root.
pub const SKILL_ROOTS: [&str; 2] = [".agents/skills", ".claude/skills"];

/// The app-wide setting (global scope, default true) that turns the sync off.
pub const SETTING_KEY: &str = "workspace.managed-agent-skills";

pub const KEY_MANAGED: &str = "writer-managed";
pub const KEY_VERSION: &str = "writer-skills-version";
pub const KEY_HASH: &str = "writer-content-hash";
pub const KEY_FILES: &str = "writer-files";

const SKILL_FILE: &str = "SKILL.md";

/// Serialises syncs inside one process (several windows can open the same
/// vault at once). Across processes the writes are atomic and deterministic,
/// so concurrent runs converge on the same bytes.
static SYNC_LOCK: Mutex<()> = Mutex::new(());
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Write what is needed.
    Apply,
    /// Report what would change, write nothing.
    Check,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Action {
    Installed,
    Updated,
    /// Same version, but a managed file was edited or missing.
    Restored,
    UpToDate,
    /// A managed skill that is no longer bundled was removed.
    Removed,
    /// Installed by a newer Writer; left untouched.
    SkippedNewer,
    /// A skill of the same name the user wrote (no marker); left untouched.
    SkippedUserOwned,
    Error,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Installed => "installed",
            Action::Updated => "updated",
            Action::Restored => "restored",
            Action::UpToDate => "up-to-date",
            Action::Removed => "removed",
            Action::SkippedNewer => "skipped-newer",
            Action::SkippedUserOwned => "skipped-user-owned",
            Action::Error => "error",
        }
    }

    /// Something the user may want to know about (not a routine outcome).
    pub fn is_problem(self) -> bool {
        matches!(
            self,
            Action::SkippedNewer | Action::SkippedUserOwned | Action::Error
        )
    }

    pub fn is_change(self) -> bool {
        matches!(
            self,
            Action::Installed | Action::Updated | Action::Restored | Action::Removed
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkillOutcome {
    /// Vault-relative skill directory, e.g. `.agents/skills/writer-cli`.
    pub dir: String,
    pub action: Action,
    /// Human-readable reason (versions, the refusal, the error).
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SyncReport {
    pub bundle_version: u32,
    /// `false` for [`Mode::Check`]: the actions are what would happen.
    pub applied: bool,
    pub outcomes: Vec<SkillOutcome>,
}

impl SyncReport {
    pub fn changed(&self) -> bool {
        self.outcomes.iter().any(|o| o.action.is_change())
    }

    pub fn problems(&self) -> impl Iterator<Item = &SkillOutcome> {
        self.outcomes.iter().filter(|o| o.action.is_problem())
    }

    /// Worth telling the UI about.
    pub fn notable(&self) -> bool {
        self.changed() || self.problems().next().is_some()
    }
}

// ---------------------------------------------------------------------------
// Rendering: bundled source -> the bytes installed in a vault
// ---------------------------------------------------------------------------

/// Hash of one skill's source files (path and content, in bundle order).
pub fn skill_hash(skill: &BundledSkill) -> String {
    let mut buf: Vec<u8> = Vec::new();
    for f in skill.files {
        buf.extend_from_slice(f.rel.as_bytes());
        buf.push(0);
        buf.extend_from_slice(&(f.content.len() as u64).to_le_bytes());
        buf.extend_from_slice(f.content.as_bytes());
    }
    crate::plugin_store::sha256_hex(&buf)
}

/// Hash over the whole bundle (every skill name and hash).
pub fn bundle_fingerprint() -> String {
    let mut buf = String::new();
    for s in SKILLS {
        buf.push_str(s.name);
        buf.push('\0');
        buf.push_str(&skill_hash(s));
        buf.push('\n');
    }
    crate::plugin_store::sha256_hex(buf.as_bytes())
}

/// Files of a skill other than `SKILL.md`, as listed in the marker.
fn extra_files(skill: &BundledSkill) -> Vec<&'static str> {
    skill
        .files
        .iter()
        .map(|f| f.rel)
        .filter(|r| *r != SKILL_FILE)
        .collect()
}

fn notice() -> String {
    format!(
        "<!-- Managed by Writer (skills bundle v{BUNDLE_VERSION}). Writer overwrites this file when it updates; \
edits are lost. To customise, copy this skill to a folder with another name and delete the `{KEY_MANAGED}` line. -->"
    )
}

/// The exact text installed for `file` of `skill`.
pub fn render(skill: &BundledSkill, file: &BundledFile) -> String {
    if file.rel != SKILL_FILE {
        return format!("{}\n\n{}", notice(), file.content);
    }
    let src = file.content;
    // Source `SKILL.md` always starts with a frontmatter block (tested).
    let close = src
        .strip_prefix("---\n")
        .and_then(|rest| rest.find("\n---\n").map(|i| i + 4))
        .expect("bundled SKILL.md must start with a frontmatter block");
    let (front, body) = src.split_at(close + 1); // front ends with "\n"
    let mut out = String::with_capacity(src.len() + 400);
    out.push_str(front);
    out.push_str(&format!("{KEY_MANAGED}: true\n"));
    out.push_str(&format!("{KEY_VERSION}: {BUNDLE_VERSION}\n"));
    out.push_str(&format!("{KEY_HASH}: {}\n", skill_hash(skill)));
    let extras = extra_files(skill);
    if !extras.is_empty() {
        out.push_str(&format!("{KEY_FILES}: \"{}\"\n", extras.join(",")));
    }
    // `body` starts with the closing fence "---\n".
    out.push_str("---\n");
    out.push_str(&notice());
    out.push('\n');
    out.push_str(&body[4..]);
    out
}

// ---------------------------------------------------------------------------
// Reading what is installed
// ---------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Marker {
    pub version: Option<u32>,
    pub hash: Option<String>,
    pub files: Vec<String>,
}

/// The managed marker of an installed `SKILL.md`, or `None` when the file has
/// no frontmatter or no `writer-managed: true` line.
pub fn parse_marker(text: &str) -> Option<Marker> {
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))?;
    let mut marker = Marker::default();
    let mut managed = false;
    for line in rest.lines() {
        if line.trim_end() == "---" {
            return managed.then_some(marker);
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let v = v.trim().trim_matches('"');
        match k.trim() {
            KEY_MANAGED => managed = v == "true",
            KEY_VERSION => marker.version = v.parse().ok(),
            KEY_HASH => marker.hash = Some(v.to_string()),
            KEY_FILES => {
                marker.files = v
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            }
            _ => {}
        }
    }
    None // no closing fence: not a frontmatter block
}

// ---------------------------------------------------------------------------
// Filesystem access, confined to the vault
// ---------------------------------------------------------------------------

struct Vault {
    root: PathBuf,
    mode: Mode,
}

fn io_err(e: std::io::Error) -> String {
    e.to_string()
}

impl Vault {
    fn confine(&self, rel: &str) -> Result<PathBuf, String> {
        vault_ops::confine(&self.root, rel)
            .map(|c| c.abs)
            .map_err(|e: VaultOpError| e.to_string())
    }

    /// `Ok(None)` when the file does not exist; non-UTF-8 content is `Err`.
    fn read(&self, abs: &Path) -> Result<Option<String>, std::io::Error> {
        match std::fs::read_to_string(abs) {
            Ok(t) => Ok(Some(t)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Atomic write: a unique temp file in the same directory, then rename.
    fn write(&self, abs: &Path, text: &str) -> Result<(), String> {
        if self.mode == Mode::Check {
            return Ok(());
        }
        let parent = abs
            .parent()
            .ok_or_else(|| format!("invalid path {}", abs.display()))?;
        std::fs::create_dir_all(parent).map_err(io_err)?;
        let tmp = parent.join(format!(
            ".writer-skill-{}-{}.tmp",
            std::process::id(),
            TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(text.as_bytes())?;
            f.sync_all()?;
            std::fs::rename(&tmp, abs)
        })();
        if let Err(e) = result {
            let _ = std::fs::remove_file(&tmp);
            return Err(io_err(e));
        }
        Ok(())
    }

    fn remove_file(&self, abs: &Path) -> Result<(), String> {
        if self.mode == Mode::Check {
            return Ok(());
        }
        match std::fs::remove_file(abs) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_err(e)),
        }
    }

    /// Best effort: only removes an empty directory.
    fn remove_empty_dir(&self, abs: &Path) {
        if self.mode == Mode::Apply {
            let _ = std::fs::remove_dir(abs);
        }
    }
}

/// A temp file of an interrupted atomic write.
fn is_temp_name(name: &str) -> bool {
    name.starts_with(".writer-skill-") && name.ends_with(".tmp")
}

/// Names of the entries in `dir`, or `None` when it is not a directory.
fn entry_names(dir: &Path) -> Option<Vec<String>> {
    let rd = std::fs::read_dir(dir).ok()?;
    Some(
        rd.filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
    )
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

fn outcome(dir: &str, action: Action, detail: impl Into<String>) -> SkillOutcome {
    SkillOutcome {
        dir: dir.to_string(),
        action,
        detail: detail.into(),
    }
}

/// Install, update or restore one bundled skill under `base` (a `SKILL_ROOTS` entry).
fn sync_skill(v: &Vault, base: &str, skill: &BundledSkill) -> SkillOutcome {
    let dir_rel = format!("{base}/{}", skill.name);
    let fail = |e: String| outcome(&dir_rel, Action::Error, e);
    let dir_abs = match v.confine(&dir_rel) {
        Ok(p) => p,
        Err(e) => return fail(format!("refused: {e}")),
    };
    let skill_md = dir_abs.join(SKILL_FILE);
    let installed = match v.read(&skill_md) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
            return outcome(
                &dir_rel,
                Action::SkippedUserOwned,
                "SKILL.md is not valid UTF-8 text",
            )
        }
        Err(e) => return fail(format!("cannot read SKILL.md: {e}")),
    };

    // What Writer would install, as (absolute path, text); SKILL.md last so an
    // interrupted run never leaves a marker over missing references.
    let mut wanted: Vec<(PathBuf, String)> = Vec::new();
    let mut order: Vec<&BundledFile> = skill.files.iter().filter(|f| f.rel != SKILL_FILE).collect();
    order.extend(skill.files.iter().filter(|f| f.rel == SKILL_FILE));
    for f in order {
        match v.confine(&format!("{dir_rel}/{}", f.rel)) {
            Ok(abs) => wanted.push((abs, render(skill, f))),
            Err(e) => return fail(format!("refused: {e}")),
        }
    }

    let (marker, fresh) =
        match installed.as_deref() {
            None => {
                // No SKILL.md: a fresh install, or a leftover of an interrupted
                // one (only entries Writer would create). Anything else in the
                // directory is the user's.
                let tops: BTreeSet<&str> = skill
                    .files
                    .iter()
                    .filter_map(|f| f.rel.split('/').next())
                    .collect();
                match entry_names(&dir_abs) {
                    Some(names)
                        if names
                            .iter()
                            .any(|n| !tops.contains(n.as_str()) && !is_temp_name(n)) =>
                    {
                        return outcome(
                            &dir_rel,
                            Action::SkippedUserOwned,
                            "the folder exists without a managed SKILL.md",
                        )
                    }
                    _ => (None, true),
                }
            }
            Some(text) => match parse_marker(text) {
                None => return outcome(
                    &dir_rel,
                    Action::SkippedUserOwned,
                    "a skill with this name exists and is not Writer-managed; it was not touched. \
Rename it, or delete it to let Writer install its own",
                ),
                Some(m) => (Some(m), false),
            },
        };

    let installed_version = marker.as_ref().map(|m| m.version.unwrap_or(0));
    if let Some(iv) = installed_version {
        if iv > BUNDLE_VERSION {
            log::info!(
                "managed skills: {dir_rel} was installed by a newer Writer (v{iv} > v{BUNDLE_VERSION}); left untouched"
            );
            return outcome(
                &dir_rel,
                Action::SkippedNewer,
                format!("installed version {iv} is newer than this Writer's {BUNDLE_VERSION}"),
            );
        }
    }

    let mut differing: Vec<&(PathBuf, String)> = Vec::new();
    for w in &wanted {
        match v.read(&w.0) {
            Ok(Some(t)) if t == w.1 => {}
            Ok(_) => differing.push(w),
            // Unreadable or not text: it is not what we wrote.
            Err(_) => differing.push(w),
        }
    }
    if differing.is_empty() && !fresh {
        // Files match; still drop files a previous version listed and this one does not.
        if let Some(m) = &marker {
            if let Err(e) = remove_stale(v, &dir_rel, &dir_abs, skill, m) {
                return fail(e);
            }
        }
        return outcome(&dir_rel, Action::UpToDate, "");
    }

    for (abs, text) in differing {
        if let Err(e) = v.write(abs, text) {
            return fail(format!("cannot write {}: {e}", abs.display()));
        }
    }
    if let Some(m) = &marker {
        if let Err(e) = remove_stale(v, &dir_rel, &dir_abs, skill, m) {
            return fail(e);
        }
    }
    match installed_version {
        None => outcome(
            &dir_rel,
            Action::Installed,
            format!("version {BUNDLE_VERSION}"),
        ),
        Some(iv) if iv < BUNDLE_VERSION => outcome(
            &dir_rel,
            Action::Updated,
            format!("version {iv} -> {BUNDLE_VERSION}"),
        ),
        Some(_) => outcome(
            &dir_rel,
            Action::Restored,
            "a managed file was edited or missing",
        ),
    }
}

/// Delete files the installed marker lists that this bundle no longer ships.
fn remove_stale(
    v: &Vault,
    dir_rel: &str,
    dir_abs: &Path,
    skill: &BundledSkill,
    marker: &Marker,
) -> Result<(), String> {
    let keep: BTreeSet<&str> = skill.files.iter().map(|f| f.rel).collect();
    for rel in &marker.files {
        if rel == SKILL_FILE || keep.contains(rel.as_str()) {
            continue;
        }
        let abs = v.confine(&format!("{dir_rel}/{rel}"))?;
        v.remove_file(&abs)?;
        if let Some(parent) = abs.parent() {
            if parent != dir_abs {
                v.remove_empty_dir(parent);
            }
        }
    }
    Ok(())
}

/// Remove managed skills under `base` that this bundle no longer ships.
fn remove_obsolete(v: &Vault, base: &str, out: &mut Vec<SkillOutcome>) {
    let Ok(base_abs) = v.confine(base) else {
        return; // refused paths are reported by `sync_skill`
    };
    let Ok(rd) = std::fs::read_dir(&base_abs) else {
        return;
    };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false)) // symlinks are not followed
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| !SKILLS.iter().any(|s| s.name == n))
        .collect();
    names.sort();
    for name in names {
        let dir_rel = format!("{base}/{name}");
        let Ok(dir_abs) = v.confine(&dir_rel) else {
            continue;
        };
        let Ok(Some(text)) = v.read(&dir_abs.join(SKILL_FILE)) else {
            continue;
        };
        let Some(marker) = parse_marker(&text) else {
            continue; // the user's skill
        };
        if marker.version.unwrap_or(0) > BUNDLE_VERSION {
            continue; // a newer Writer's skill
        }
        let mut result = Ok(());
        for rel in marker.files.iter().map(String::as_str).chain([SKILL_FILE]) {
            let step = v.confine(&format!("{dir_rel}/{rel}")).and_then(|abs| {
                v.remove_file(&abs)?;
                if let Some(p) = abs.parent() {
                    if p != dir_abs {
                        v.remove_empty_dir(p);
                    }
                }
                Ok(())
            });
            if let Err(e) = step {
                result = Err(e);
                break;
            }
        }
        v.remove_empty_dir(&dir_abs);
        out.push(match result {
            Ok(()) => outcome(
                &dir_rel,
                Action::Removed,
                "no longer part of Writer's bundle",
            ),
            Err(e) => outcome(&dir_rel, Action::Error, e),
        });
    }
}

/// Bring the managed skills of the vault at `root` up to date.
///
/// Errors are per skill, in the report; the function itself only fails when
/// `root` is not an openable directory.
pub fn sync(root: &Path, mode: Mode) -> Result<SyncReport, String> {
    let root = root
        .canonicalize()
        .map_err(|e| format!("cannot open vault {}: {e}", root.display()))?;
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let _guard = SYNC_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let v = Vault { root, mode };
    let mut outcomes = Vec::new();
    for base in SKILL_ROOTS {
        for skill in SKILLS {
            outcomes.push(sync_skill(&v, base, skill));
        }
        remove_obsolete(&v, base, &mut outcomes);
    }
    Ok(SyncReport {
        bundle_version: BUNDLE_VERSION,
        applied: mode == Mode::Apply,
        outcomes,
    })
}
