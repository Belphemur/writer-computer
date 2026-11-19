//! Task writes on vault files: path confinement and the one atomic write are `vault_ops`'s; the
//! text changes are `edit`'s. Shared by the Tauri commands and the `writer` CLI.

use super::date::Day;
use super::edit::{self, EditError, Edited, FieldValue, StatusChange};
use super::grammar::Field;
use super::settings::TaskSettings;
use crate::vault_ops::{self, VaultOpError};
use std::path::Path;

/// What a write did, for the caller's answer and for refreshing views.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// Vault-relative path of the file written.
    pub path: String,
    /// 1-based lines now holding the task (none: it was removed).
    pub lines: Vec<u32>,
}

impl From<EditError> for VaultOpError {
    fn from(e: EditError) -> Self {
        VaultOpError::Invalid(e.to_string())
    }
}

fn change(path: String, e: &Edited) -> Change {
    Change {
        path,
        lines: e.lines.iter().map(|l| *l as u32).collect(),
    }
}

/// Read a note, apply `f`, and write it back when the text changed.
fn edit_file(
    root: &Path,
    rel: &str,
    f: impl FnOnce(&str) -> Result<Edited, EditError>,
) -> Result<Change, VaultOpError> {
    let c = vault_ops::confine_markdown(root, rel)?;
    let old = vault_ops::read_text(&c.abs)?;
    let e = f(&old)?;
    if e.text != old {
        vault_ops::write_text(&c.abs, &e.text)?;
    }
    Ok(change(c.rel, &e))
}

pub fn change_status(
    root: &Path,
    rel: &str,
    line: usize,
    expect: Option<&str>,
    change: StatusChange,
    s: &TaskSettings,
    today: Day,
) -> Result<Change, VaultOpError> {
    edit_file(root, rel, |t| {
        edit::change_status(t, line, expect, change, s, today)
    })
}

pub fn toggle(
    root: &Path,
    rel: &str,
    line: usize,
    expect: Option<&str>,
    s: &TaskSettings,
    today: Day,
) -> Result<Change, VaultOpError> {
    change_status(root, rel, line, expect, StatusChange::Toggle, s, today)
}

/// Rewrite the one task line with `f(line, line_no)`, however many edits it makes.
pub fn edit_line(
    root: &Path,
    rel: &str,
    line: usize,
    expect: Option<&str>,
    f: impl FnOnce(&str, usize) -> Result<String, EditError>,
) -> Result<Change, VaultOpError> {
    edit_file(root, rel, |t| {
        edit::edit_text_line(t, line, expect, |l| Ok(vec![f(l, line)?]))
    })
}

pub fn set_field(
    root: &Path,
    rel: &str,
    line: usize,
    expect: Option<&str>,
    field: Field,
    value: &FieldValue,
    s: &TaskSettings,
) -> Result<Change, VaultOpError> {
    edit_file(root, rel, |t| {
        edit::set_field(t, line, expect, field, value, s)
    })
}

/// Append a task to `rel` (the inbox by default), creating the note and its folders on first use.
pub fn add(
    root: &Path,
    rel: &str,
    text: &str,
    fields: &[(Field, String)],
    s: &TaskSettings,
) -> Result<Change, VaultOpError> {
    let line = edit::new_task(text, fields, s)?;
    let c = vault_ops::confine_markdown(root, rel)?;
    if let Some(dir) = c.abs.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let old = match vault_ops::read_text(&c.abs) {
        Ok(t) => t,
        Err(VaultOpError::NotFound(_)) => String::new(),
        Err(e) => return Err(e),
    };
    let e = edit::append_task(&old, &line);
    vault_ops::write_text(&c.abs, &e.text)?;
    Ok(change(c.rel, &e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn d(s: &str) -> Day {
        Day::parse(s).unwrap()
    }

    #[test]
    fn writes_one_line_and_refuses_what_it_must() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("a.md"), "x\n- [ ] one 📅 2024-03-15\ny\n").unwrap();
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        let s = TaskSettings::default();
        let c = toggle(&root, "a.md", 2, Some("one"), &s, d("2024-03-15")).unwrap();
        assert_eq!((c.path.as_str(), c.lines.as_slice()), ("a.md", &[2][..]));
        assert_eq!(
            std::fs::read_to_string(root.join("a.md")).unwrap(),
            "x\n- [x] one 📅 2024-03-15 ✅ 2024-03-15\ny\n"
        );
        // never `.obsidian`, never outside, never a non-note
        assert!(add(&root, ".obsidian/t.md", "x", &[], &s).is_err());
        assert!(add(&root, "../out.md", "x", &[], &s).is_err());
        assert!(add(&root, "t.txt", "x", &[], &s).is_err());
        assert!(toggle(&root, "a.md", 1, None, &s, d("2024-03-15")).is_err());
    }

    #[test]
    fn add_creates_the_inbox_on_first_use_and_appends_after() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let s = TaskSettings::default();
        let c = add(&root, "Inbox/Tasks.md", "first", &[], &s).unwrap();
        assert_eq!(c.lines, [1]);
        let c = add(
            &root,
            "Inbox/Tasks.md",
            "second",
            &[(Field::Due, "2024-05-01".into())],
            &s,
        )
        .unwrap();
        assert_eq!(c.lines, [2]);
        assert_eq!(
            std::fs::read_to_string(root.join("Inbox/Tasks.md")).unwrap(),
            "- [ ] first\n- [ ] second 📅 2024-05-01\n"
        );
    }
}
