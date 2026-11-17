//! Skills on disk for the agent pane's `/` menu (spec `SPECs/native-agent-spec.md` section 3.2).
//!
//! Tauri-free. Reads ONLY `<name>/SKILL.md` inside `.claude/skills` and `.agents/skills` of
//! three places: the active project folder, the vault root (dot folders the index, the watcher
//! and the sidebar never show) and, read-only, the user's home (`~/.claude/skills`,
//! `~/.agents/skills`: the user asked to see their global skills). Nothing else under the home is
//! opened (no settings, no credentials, no transcripts), only name and description are taken from
//! a skill's frontmatter, and plugin-provided skills are never read (the CLI reports those in
//! `system/init`).
//!
//! Confinement: the project path goes through `vault_ops::confine`; for the vault's folders every
//! skills folder, skill folder and `SKILL.md` is canonicalised and must stay inside the
//! (canonical) vault root, so a symlink out of the vault is skipped. In the home the two skills
//! folders are the allowlist: their entries may be symlinks (people link skills in), but a
//! `SKILL.md` must resolve to a regular file. The scan is bounded (entries per folder, total
//! skills, bytes read per file, description length).

use crate::vault_ops::{self, VaultOpError};
use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use yaml_rust2::{Yaml, YamlLoader};

/// Folders read, relative to the vault root and to the project folder, in priority order: when a
/// name exists in several, the first wins (project before vault, `.claude` before `.agents`).
pub const SKILL_DIRS: [&str; 2] = [".claude/skills", ".agents/skills"];
pub const MAX_ENTRIES_PER_DIR: usize = 200;
pub const MAX_SKILLS: usize = 300;
pub const MAX_SKILL_FILE_BYTES: u64 = 64 * 1024;
pub const MAX_DESCRIPTION_CHARS: usize = 300;
const MAX_NAME_CHARS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DiskSkill {
    pub name: String,
    /// One line, at most 300 characters; empty when the skill has none.
    pub description: String,
    /// `project` (the active project's folder), `vault` (the vault root) or `global` (the home).
    pub scope: &'static str,
    /// Vault-relative path of the `SKILL.md`; the absolute path for a `global` skill.
    pub path: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SkillsError {
    #[error("{0}")]
    Invalid(String),
}

impl From<VaultOpError> for SkillsError {
    fn from(e: VaultOpError) -> Self {
        SkillsError::Invalid(e.to_string())
    }
}

/// A skill name is a folder name the CLI could use as `/name`: ASCII letters, digits, `.`, `_`,
/// `-`, not starting with `.` or `-`.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_NAME_CHARS
        && !name.starts_with(['.', '-'])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn one_line(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > MAX_DESCRIPTION_CHARS {
        let cut: String = flat.chars().take(MAX_DESCRIPTION_CHARS - 1).collect();
        format!("{}…", cut.trim_end())
    } else {
        flat
    }
}

/// `name` and `description` from a `SKILL.md`'s YAML frontmatter. Missing or broken frontmatter
/// gives `(None, None)`; scalars of any YAML style (plain, quoted, `>`, `|`) are flattened to one
/// line.
pub fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let text = text.replace("\r\n", "\n");
    let Some(rest) = text.strip_prefix("---\n") else {
        return (None, None);
    };
    let end = rest
        .find("\n---\n")
        .or_else(|| rest.strip_suffix("\n---").map(|r| r.len()));
    let Some(end) = end else {
        return (None, None);
    };
    let Ok(docs) = YamlLoader::load_from_str(&rest[..end]) else {
        return (None, None);
    };
    let Some(map) = docs.first().and_then(Yaml::as_hash) else {
        return (None, None);
    };
    let get = |key: &str| -> Option<String> {
        match map.get(&Yaml::String(key.into()))? {
            Yaml::String(s) => Some(s.clone()),
            Yaml::Integer(i) => Some(i.to_string()),
            Yaml::Real(r) => Some(r.clone()),
            Yaml::Boolean(b) => Some(b.to_string()),
            _ => None,
        }
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    };
    (get("name"), get("description").map(|d| one_line(&d)))
}

fn read_capped(path: &Path) -> Option<String> {
    let mut buf = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(MAX_SKILL_FILE_BYTES)
        .read_to_end(&mut buf)
        .ok()?;
    // A cut can land inside a UTF-8 sequence; the frontmatter is at the top and unaffected.
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Canonical form of `p`, which must stay inside `limit` when one is given.
fn resolve(limit: Option<&Path>, p: &Path) -> Option<PathBuf> {
    let c = p.canonicalize().ok()?;
    match limit {
        Some(root) => c.starts_with(root).then_some(c),
        None => Some(c),
    }
}

fn rel(root: &Path, abs: &Path) -> Option<String> {
    let r = abs.strip_prefix(root).ok()?;
    let parts: Option<Vec<&str>> = r.components().map(|c| c.as_os_str().to_str()).collect();
    Some(parts?.join("/"))
}

/// Reads the skills of `<base>/.claude/skills` and `<base>/.agents/skills`. `limit` is the vault
/// root for vault and project folders (everything must stay inside it) and `None` for the home.
fn scan_dir(limit: Option<&Path>, base: &Path, scope: &'static str, out: &mut Vec<DiskSkill>) {
    for sub in SKILL_DIRS {
        let Some(dir) = resolve(limit, &base.join(sub)).filter(|d| d.is_dir()) else {
            continue;
        };
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut names: Vec<_> = entries
            .filter_map(Result::ok)
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        names.sort();
        for dir_name in names.into_iter().take(MAX_ENTRIES_PER_DIR) {
            if out.len() >= MAX_SKILLS {
                return;
            }
            if !valid_name(&dir_name) {
                continue;
            }
            // The skill folder and its SKILL.md may be symlinks (inside the vault, for vault folders).
            let Some(skill_dir) = resolve(limit, &dir.join(&dir_name)).filter(|d| d.is_dir())
            else {
                continue;
            };
            // `is_file` on the canonical path: a regular file, not a folder, socket or pipe.
            let Some(file) = resolve(limit, &skill_dir.join("SKILL.md")).filter(|f| f.is_file())
            else {
                continue;
            };
            let Some(text) = read_capped(&file) else {
                continue;
            };
            let (name, description) = parse_frontmatter(&text);
            let name = name.filter(|n| valid_name(n)).unwrap_or(dir_name);
            let path = match limit {
                Some(root) => match rel(root, &file) {
                    Some(p) => p,
                    None => continue,
                },
                None => file.to_string_lossy().into_owned(),
            };
            out.push(DiskSkill {
                name,
                description: description.unwrap_or_default(),
                scope,
                path,
            });
        }
    }
}

/// Skills visible to a chat whose cwd is `project_path` (vault-relative) or the vault root, plus
/// the user's global ones when `home` is given, de-duplicated by name (project over vault over
/// global, `.claude` over `.agents`), sorted by name. `root` must be canonical.
pub fn list_skills(
    root: &Path,
    project_path: Option<&str>,
    home: Option<&Path>,
) -> Result<Vec<DiskSkill>, SkillsError> {
    let mut found = Vec::new();
    if let Some(p) = project_path.map(str::trim).filter(|p| !p.is_empty()) {
        let confined = vault_ops::confine(root, p)?;
        if confined.abs.is_dir() {
            scan_dir(Some(root), &confined.abs, "project", &mut found);
        }
    }
    scan_dir(Some(root), root, "vault", &mut found);
    if let Some(home) = home {
        scan_dir(None, home, "global", &mut found);
    }
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<DiskSkill> = found
        .into_iter()
        .filter(|s| seen.insert(s.name.to_lowercase()))
        .collect();
    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let root = t.path().canonicalize().unwrap();
        (t, root)
    }

    fn skill(root: &Path, base: &str, name: &str, fm: &str) {
        let d = root.join(base).join(name);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("SKILL.md"), format!("---\n{fm}\n---\n\nbody\n")).unwrap();
    }

    #[test]
    fn frontmatter_name_and_description_in_every_yaml_style() {
        assert_eq!(
            parse_frontmatter("---\nname: a-b\ndescription: Does a thing.\n---\nx"),
            (Some("a-b".into()), Some("Does a thing.".into()))
        );
        assert_eq!(
            parse_frontmatter(
                "---\nname: \"q\"\ndescription: >\n  first line\n  second line\n---\n"
            ),
            (Some("q".into()), Some("first line second line".into()))
        );
        assert_eq!(
            parse_frontmatter("---\r\nname: crlf\r\ndescription: 'It''s fine'\r\n---\r\nbody"),
            (Some("crlf".into()), Some("It's fine".into()))
        );
        assert_eq!(parse_frontmatter("no frontmatter"), (None, None));
        assert_eq!(
            parse_frontmatter("---\nname: [unclosed\n---\n"),
            (None, None)
        );
        assert_eq!(parse_frontmatter("---\nname: x\n"), (None, None));
        let long = format!("---\ndescription: {}\n---\n", "w ".repeat(400));
        let d = parse_frontmatter(&long).1.unwrap();
        assert!(d.chars().count() <= MAX_DESCRIPTION_CHARS && d.ends_with('…'));
    }

    #[test]
    fn names_are_cli_safe() {
        for ok in ["writer-cli", "a", "v1.2", "snake_case"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in ["", ".hidden", "-x", "a b", "a/b", "é", &"x".repeat(65)] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn lists_both_dot_folders_of_the_vault_and_the_project() {
        let (_t, root) = vault();
        skill(
            &root,
            ".claude/skills",
            "writer-cli",
            "name: writer-cli\ndescription: CLI help",
        );
        skill(
            &root,
            ".agents/skills",
            "writer-search",
            "name: writer-search\ndescription: Search",
        );
        skill(
            &root,
            "Projects/Demo/.claude/skills",
            "local",
            "name: local\ndescription: Project only",
        );
        skill(
            &root,
            "Other/.claude/skills",
            "elsewhere",
            "name: elsewhere",
        );
        let got = list_skills(&root, Some("Projects/Demo"), None).unwrap();
        let names: Vec<_> = got.iter().map(|s| (s.name.as_str(), s.scope)).collect();
        assert_eq!(
            names,
            vec![
                ("local", "project"),
                ("writer-cli", "vault"),
                ("writer-search", "vault")
            ]
        );
        assert_eq!(got[0].path, "Projects/Demo/.claude/skills/local/SKILL.md");
        assert_eq!(got[1].description, "CLI help");
        // Without a project only the vault's skills show.
        let vault_only = list_skills(&root, None, None).unwrap();
        assert_eq!(vault_only.len(), 2);
    }

    #[test]
    fn project_beats_vault_and_claude_beats_agents_for_the_same_name() {
        let (_t, root) = vault();
        skill(
            &root,
            ".claude/skills",
            "dup",
            "name: dup\ndescription: vault claude",
        );
        skill(
            &root,
            ".agents/skills",
            "dup",
            "name: dup\ndescription: vault agents",
        );
        skill(
            &root,
            "P/.agents/skills",
            "dup",
            "name: dup\ndescription: project agents",
        );
        let got = list_skills(&root, Some("P"), None).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].description, "project agents");
        let v = list_skills(&root, None, None).unwrap();
        assert_eq!(v[0].description, "vault claude");
    }

    #[test]
    fn folder_name_is_used_when_frontmatter_has_no_valid_name() {
        let (_t, root) = vault();
        skill(
            &root,
            ".claude/skills",
            "from-dir",
            "description: no name key",
        );
        skill(
            &root,
            ".claude/skills",
            "also-dir",
            "name: not valid!\ndescription: bad name",
        );
        let got = list_skills(&root, None, None).unwrap();
        assert_eq!(
            got.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["also-dir", "from-dir"]
        );
    }

    #[test]
    fn skips_folders_without_skill_md_and_invalid_folder_names() {
        let (_t, root) = vault();
        fs::create_dir_all(root.join(".claude/skills/empty")).unwrap();
        fs::create_dir_all(root.join(".claude/skills/.hidden")).unwrap();
        fs::write(root.join(".claude/skills/loose.md"), "x").unwrap();
        skill(&root, ".claude/skills", ".dot", "name: dot");
        assert!(list_skills(&root, None, None).unwrap().is_empty());
    }

    #[test]
    fn rejects_project_paths_that_leave_the_vault() {
        let (_t, root) = vault();
        assert!(list_skills(&root, Some("../outside"), None).is_err());
        assert!(list_skills(&root, Some("/etc"), None).is_err());
        assert!(list_skills(&root, Some(".git"), None).is_err());
        // A missing project folder is not an error: it just has no skills.
        assert!(list_skills(&root, Some("Nope"), None).unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_out_of_the_vault_are_not_followed() {
        use std::os::unix::fs::symlink;
        let (_t, root) = vault();
        let outside = tempfile::tempdir().unwrap();
        let out = outside.path().canonicalize().unwrap();
        // a whole skills folder, a skill folder and a SKILL.md pointing outside
        skill(&out, "skills", "evil", "name: evil\ndescription: outside");
        fs::create_dir_all(root.join("A/.claude")).unwrap();
        symlink(out.join("skills"), root.join("A/.claude/skills")).unwrap();
        fs::create_dir_all(root.join(".claude/skills")).unwrap();
        symlink(
            out.join("skills/evil"),
            root.join(".claude/skills/linked-dir"),
        )
        .unwrap();
        let d = root.join(".claude/skills/file-link");
        fs::create_dir_all(&d).unwrap();
        symlink(out.join("skills/evil/SKILL.md"), d.join("SKILL.md")).unwrap();
        assert!(list_skills(&root, Some("A"), None).unwrap().is_empty());
        // a project folder that is itself a symlink out is refused by confinement
        symlink(&out, root.join("Linked")).unwrap();
        assert!(list_skills(&root, Some("Linked"), None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_inside_the_vault_work() {
        use std::os::unix::fs::symlink;
        let (_t, root) = vault();
        skill(
            &root,
            "LLM-Agents/skills",
            "shared",
            "name: shared\ndescription: Linked in",
        );
        fs::create_dir_all(root.join(".claude/skills")).unwrap();
        symlink(
            root.join("LLM-Agents/skills/shared"),
            root.join(".claude/skills/shared"),
        )
        .unwrap();
        let got = list_skills(&root, None, None).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].path, "LLM-Agents/skills/shared/SKILL.md");
    }

    fn home_with(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().canonicalize().unwrap();
        for (rel, text) in files {
            let p = home.join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }
        (t, home)
    }

    #[test]
    fn global_skills_come_from_exactly_the_two_home_folders_and_rank_last() {
        let (_t, root) = vault();
        let (_h, home) = home_with(&[
            (
                ".claude/skills/g-claude/SKILL.md",
                "---\nname: g-claude\ndescription: Global one\n---\n",
            ),
            (
                ".agents/skills/g-agents/SKILL.md",
                "---\nname: g-agents\n---\n",
            ),
            (
                ".claude/skills/clash/SKILL.md",
                "---\nname: clash\ndescription: global clash\n---\n",
            ),
            // never opened or listed: settings, credentials, transcripts, other folders
            (".claude/settings.json", "{\"secret\":1}"),
            (".claude/.credentials.json", "{\"token\":\"x\"}"),
            (".claude/projects/p/SKILL.md", "---\nname: nope\n---\n"),
            (
                ".claude/plugins/x/skills/y/SKILL.md",
                "---\nname: plugin-skill\n---\n",
            ),
            (".other/skills/z/SKILL.md", "---\nname: other\n---\n"),
            (".claude/skills/not-a-skill.txt", "x"),
        ]);
        skill(
            &root,
            ".claude/skills",
            "clash",
            "name: clash\ndescription: vault clash",
        );
        let got = list_skills(&root, None, Some(&home)).unwrap();
        let names: Vec<_> = got.iter().map(|s| (s.name.as_str(), s.scope)).collect();
        assert_eq!(
            names,
            vec![
                ("clash", "vault"),
                ("g-agents", "global"),
                ("g-claude", "global")
            ]
        );
        let g = got.iter().find(|s| s.name == "g-claude").unwrap();
        assert_eq!(g.description, "Global one");
        assert!(
            g.path.starts_with(home.to_str().unwrap()) && g.path.ends_with("g-claude/SKILL.md")
        );
        // no home, no global skills
        assert_eq!(list_skills(&root, None, None).unwrap().len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn global_symlinked_skills_resolve_but_skill_md_must_be_a_regular_file() {
        use std::os::unix::fs::symlink;
        let (_t, root) = vault();
        let (_h, home) = home_with(&[]);
        let store = tempfile::tempdir().unwrap();
        let store = store.path().canonicalize().unwrap();
        skill(
            &store,
            "shared",
            "linked",
            "name: linked\ndescription: Elsewhere on disk",
        );
        fs::create_dir_all(home.join(".claude/skills")).unwrap();
        symlink(
            store.join("shared/linked"),
            home.join(".claude/skills/linked"),
        )
        .unwrap();
        // SKILL.md that is a directory, and one that is a symlink to a directory
        fs::create_dir_all(home.join(".claude/skills/dirmd/SKILL.md")).unwrap();
        fs::create_dir_all(home.join(".claude/skills/linkdir")).unwrap();
        symlink(&store, home.join(".claude/skills/linkdir/SKILL.md")).unwrap();
        // a dangling link is skipped, not an error
        symlink(store.join("missing"), home.join(".claude/skills/dangling")).unwrap();
        let got = list_skills(&root, None, Some(&home)).unwrap();
        assert_eq!(
            got.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["linked"]
        );
    }

    #[test]
    fn bounds_the_scan() {
        let (_t, root) = vault();
        for i in 0..(MAX_SKILLS + 20) {
            skill(
                &root,
                ".claude/skills",
                &format!("s{i:04}"),
                "description: x",
            );
        }
        assert!(list_skills(&root, None, None).unwrap().len() <= MAX_SKILLS);
        // a huge SKILL.md is read only up to the cap and still parses its frontmatter
        let d = root.join(".agents/skills/big");
        fs::create_dir_all(&d).unwrap();
        let body = "y".repeat(2_000_000);
        fs::write(
            d.join("SKILL.md"),
            format!("---\nname: big\ndescription: ok\n---\n{body}"),
        )
        .unwrap();
        let text = read_capped(&d.join("SKILL.md")).unwrap();
        assert!(text.len() as u64 <= MAX_SKILL_FILE_BYTES);
        assert_eq!(parse_frontmatter(&text).0.as_deref(), Some("big"));
    }
}
