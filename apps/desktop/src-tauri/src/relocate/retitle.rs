//! Set or clear a note's display title (the frontmatter `title` property, see
//! `SPECs/filename-links-and-rename-spec.md` "Display titles") and, optionally, update the links
//! that show the old title as their alias (`[[File|Old title]]`, `![[File|Old title]]`).
//!
//! It is a [`super::Plan`] whose `from` and `to` are the same file: the edit set (the property
//! patch of the note itself plus the alias rewrites in its referrers) is computed first and
//! committed by [`super::apply`], with the same verification, staging and rollback as a rename.
//! The file is never renamed and no link target changes.

use super::linkfix::rewrite_alias_text;
use super::{FileEdit, Plan};
use crate::index::patch;
use crate::index::Index;
use crate::vault_ops::{self, VaultOpError};
use serde_json::{json, Value as Json};
use std::collections::BTreeSet;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct Retitle {
    /// Edits to apply with [`super::apply`]; empty when the title does not change.
    pub plan: Plan,
    /// The override before (None: the note showed its file name) and after.
    pub old: Option<String>,
    pub new: Option<String>,
}

impl Retitle {
    /// Links (and notes containing them) whose alias text changes.
    pub fn link_counts(&self) -> (usize, usize) {
        let links = self.plan.links();
        let notes = self.plan.edits.iter().filter(|e| e.links > 0).count();
        (links, notes)
    }
}

/// The non-empty string `title` of a note's frontmatter.
pub fn read_title(text: &str) -> Option<String> {
    let props = patch::read_properties(text).ok()?;
    props
        .into_iter()
        .find(|p| p.name == "title")
        .and_then(|p| match p.value {
            Json::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
            _ => None,
        })
}

/// Normalise a requested title: trimmed, single line; blank means "clear".
pub fn normalize_title(new: Option<&str>) -> Result<Option<String>, VaultOpError> {
    let Some(n) = new.map(str::trim).filter(|n| !n.is_empty()) else {
        return Ok(None);
    };
    if n.contains(['\n', '\r']) {
        return Err(VaultOpError::Invalid(
            "a title must be a single line".into(),
        ));
    }
    Ok(Some(n.to_string()))
}

/// Compute (without writing) the edits that give `file` the display title `new` (`None` clears
/// it). `update_links: false` changes only the note's own frontmatter.
pub fn plan(
    root: &Path,
    index: &Index,
    file: &str,
    new: Option<&str>,
    update_links: bool,
) -> Result<Retitle, VaultOpError> {
    let src = vault_ops::confine_markdown(root, file)?;
    if !src.abs.is_file() {
        return Err(VaultOpError::NotFound(format!(
            "file not found: {}",
            src.rel
        )));
    }
    let new = normalize_title(new)?;
    let text = vault_ops::read_text(&src.abs)?;
    let old = read_title(&text);
    let mut plan = Plan {
        root: root.to_path_buf(),
        from: src.rel.clone(),
        to: src.rel.clone(),
        from_abs: src.abs.clone(),
        to_abs: src.abs.clone(),
        case_only: false,
        edits: Vec::new(),
        skipped: 0,
        unreadable: Vec::new(),
    };
    if old == new {
        return Ok(Retitle { plan, old, new });
    }
    let own_after = match &new {
        Some(n) => patch::set_property(&text, "title", &json!(n), Some(patch::ValueType::Text))?,
        None => patch::remove_property(&text, "title")?,
    };
    let paths = index
        .cached_paths()
        .map_err(|e| VaultOpError::Io(e.to_string()))?;
    let mut sources: BTreeSet<String> = BTreeSet::new();
    if update_links && old.is_some() {
        sources.extend(
            index
                .backlinks(&src.rel)
                .map_err(|e| VaultOpError::Io(e.to_string()))?
                .into_iter()
                .map(|b| b.source),
        );
    }
    sources.insert(src.rel.clone());
    for s in sources {
        if !vault_ops::is_markdown_rel(&s) {
            continue;
        }
        let is_self = s == src.rel;
        let before = if is_self {
            text.clone()
        } else {
            match vault_ops::read_text(&vault_ops::confine(root, &s)?.abs) {
                Ok(t) => t,
                Err(_) => {
                    plan.unreadable.push(s);
                    continue;
                }
            }
        };
        let base = if is_self {
            own_after.clone()
        } else {
            before.clone()
        };
        let (after, links) = match (&old, update_links) {
            (Some(o), true) => {
                let rw = rewrite_alias_text(&base, &s, &src.rel, o, new.as_deref(), &paths);
                (rw.text, rw.changed)
            }
            _ => (base, 0),
        };
        if after != before {
            plan.edits.push(FileEdit {
                rel: s,
                before,
                after,
                links,
            });
        }
    }
    Ok(Retitle { plan, old, new })
}

#[cfg(test)]
mod tests;
