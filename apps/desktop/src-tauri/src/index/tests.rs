//! Integration tests over a synthetic fixture vault built in a temp dir.
//! No real user data is used anywhere.

use super::*;
use std::collections::BTreeMap;
use std::fs;
use std::time::{Duration, SystemTime};
use tempfile::TempDir;

pub(super) struct Fixture {
    pub(super) vault: TempDir,
    pub(super) data: TempDir,
}

pub(super) fn write(root: &Path, rel: &str, content: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

fn write_bytes(root: &Path, rel: &str, content: &[u8]) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

/// Non-ignored files in the fixture (computed by the builder below).
const FIXTURE_FILES: usize = 43;
/// Markdown notes (everything except `pic.png`, `spec.pdf`, `data.base`).
const FIXTURE_MD: usize = 40;

pub(super) fn build_fixture() -> Fixture {
    let vault = TempDir::new().unwrap();
    let r = vault.path();
    write(
        r,
        "Home.md",
        "# Home\nSee [[Projects/Alpha]], [[Beta]], [[missing note]] and [[ノート]].\n#Home\n",
    );
    write(
        r,
        "Projects/Alpha.md",
        "---\nstatus: active\ndue: 2024-03-01\npriority: 2\ndone: false\ntags: [project, work/alpha]\nrelated:\n  - \"[[Beta]]\"\n  - \"[[People/Ann Lee]]\"\nowner: \"[[People/Ann Lee|Ann]]\"\n---\n# Alpha\nLinks to [[Beta]] and ![[img/pic.png]] and [spec](../docs/spec.pdf).\n",
    );
    write(r, "Projects/Beta.md", "---\ntags: project, work/beta\nstatus: done\ndue: \"2024-03-05\"\n---\nBeta body #Mixed/Case\n");
    write(
        r,
        "Archive/Beta.md",
        "---\nstatus: archived\n---\nOld beta.\n",
    );
    write(r, "People/Ann Lee.md", "---\naliases:\n  - Annie\n  - A. Lee\ncreation date: 2024-01-05\nseen: 2024-01-05T10:30:00\nseen_tz: 2024-01-05T10:30:00+02:00\n---\nPerson.\n");
    write(
        r,
        "Notes/dup.md",
        "dup in notes, links to [[dup]] and [[Other/dup]]\n",
    );
    write(r, "Other/dup.md", "dup in other\n");
    write(r, "Meta/nulls.md", "---\nempty:\nnothing: ~\nobj:\n  a: 1\n  b:\n    - x\n    - y\nflag: true\nzero: 0\nneg: -2.5\ntext: 007\n---\nnulls\n");
    write(r, "Meta/broken.md", "---\nkey: [oops\nother: : :\n---\n# Broken Title\nBroken body with [[Home]] and #brokentag\n");
    write_bytes(r, "Meta/crlf.md", b"---\r\ntitle: Windows\r\ntags:\r\n  - win\r\n---\r\n# CRLF\r\n- [ ] first\r\n- [x] second\r\n");
    write_bytes(
        r,
        "Meta/bom.md",
        b"\xef\xbb\xbf---\ntitle: Bom\n---\nBody with BOM [[Home]]\n",
    );
    write(
        r,
        "日本語/ノート.md",
        "---\nstatus: 進行中\n---\n# ノート\n[[Home]]\n",
    );
    write(r, "café/résumé.md", "résumé body #café\n");
    write(
        r,
        "Meta/tasks.md",
        "# Tasks\n- [ ] open task\n- [x] done task\n- [/] partial\n```\n- [ ] not a task\n#notatag\n[[nolink]]\n```\nInline `#code` and `[[nolink2]]`.\n",
    );
    write(
        r,
        "Meta/md-links.md",
        "[a](Projects/Alpha.md) [b](Projects/Beta.md#Sec) [web](https://example.com/x.md)\n",
    );
    write(r, "Meta/embeds.md", "![[Projects/Alpha]]\n![[data.base]]\n");
    // Attachments and other files.
    write_bytes(r, "img/pic.png", &[0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    write_bytes(r, "docs/spec.pdf", b"%PDF-1.4 fake");
    write(r, "data.base", "views:\n  - type: table\n    name: Table\n");
    // Filler notes: a chain with frontmatter, tags and links.
    for i in 0..24 {
        let next = (i + 1) % 24;
        write(
            r,
            &format!("Bulk/n{i:02}.md"),
            &format!(
                "---\nindex: {i}\ntags: [bulk, bulk/g{}]\n---\n# Note {i}\nNext: [[n{next:02}]] #bulk\n",
                i % 3
            ),
        );
    }
    // Ignored content: must never get a row.
    write(r, ".obsidian/app.json", "{}");
    write(r, ".obsidian/notes-in-config.md", "# hidden\n");
    write(r, ".hidden.md", "hidden\n");
    write(r, "node_modules/pkg/readme.md", "# dep\n");
    write(r, ".gitignore", "build/\n");
    write(r, "build/out.md", "# built\n");
    Fixture {
        vault,
        data: TempDir::new().unwrap(),
    }
}

pub(super) fn open(fx: &Fixture) -> Index {
    Index::open_for_cli(fx.vault.path(), Some(fx.data.path())).unwrap()
}

fn file_paths(index: &Index) -> Vec<String> {
    index
        .query_files(&FileFilter::default())
        .unwrap()
        .rows
        .into_iter()
        .map(|r| r.path)
        .collect()
}

/// (relative path, size, mtime) of every entry under `root`, hidden included.
fn snapshot(root: &Path) -> BTreeMap<String, (u64, u128)> {
    let mut out = BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for e in fs::read_dir(&dir).unwrap() {
            let e = e.unwrap();
            let md = e.metadata().unwrap();
            let rel = e
                .path()
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let m = md
                .modified()
                .unwrap()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            out.insert(rel, (if md.is_dir() { 0 } else { md.len() }, m));
            if md.is_dir() {
                stack.push(e.path());
            }
        }
    }
    out
}

fn bump_mtime(path: &Path) {
    let f = fs::OpenOptions::new().write(true).open(path).unwrap();
    f.set_modified(SystemTime::now() + Duration::from_secs(60))
        .unwrap();
}

/// The scan walks folders under one policy snapshot (`walk_builder_with`): with the feature
/// `code-files` off the skills folders are not walked and the ignored-folder list is not applied.
/// (The index worker thread reads the process-wide policy, so this goes through the builder.)
#[test]
fn the_walker_follows_the_code_files_policy_for_folders() {
    use crate::code_files::Policy;
    let vault = TempDir::new().unwrap();
    let r = vault.path();
    for f in [
        "a.md",
        "run.py",
        "dist/a.js",
        ".agents/skills/x/run.sh",
        ".obsidian/app.json",
    ] {
        write(r, f, "x");
    }
    let walked = |p: Policy| {
        let mut v: Vec<String> = build::walk_builder_with(r, p)
            .build()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
            .map(|e| {
                e.path()
                    .strip_prefix(r)
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        v.sort();
        v
    };
    assert_eq!(
        walked(Policy::default()),
        [".agents/skills/x/run.sh", "a.md", "run.py"].map(String::from)
    );
    assert_eq!(
        walked(Policy::notes_only()),
        ["a.md", "dist/a.js", "run.py"].map(String::from)
    );
}

#[test]
fn cold_build_counts_and_ignore_rules() {
    let fx = build_fixture();
    let index = open(&fx);
    let paths = file_paths(&index);
    assert_eq!(paths.len(), FIXTURE_FILES, "{paths:?}");
    for bad in [
        ".obsidian",
        ".hidden",
        "node_modules",
        "build/",
        ".gitignore",
    ] {
        assert!(
            !paths.iter().any(|p| p.contains(bad)),
            "{bad} leaked: {paths:?}"
        );
    }
    let st = index.status().unwrap();
    assert_eq!(st.state, IndexState::Ready);
    assert_eq!(st.files as usize, FIXTURE_FILES);
    assert_eq!(st.markdown_files as usize, FIXTURE_MD);
    // Attachments have a row but no parsed content.
    let pic = index.get_file("img/pic.png").unwrap().unwrap();
    assert_eq!(
        (pic.ext.as_str(), pic.folder.as_str(), pic.words),
        ("png", "img", None)
    );
    let meta = index
        .get_metadata(&MetaSelector::Paths(vec![
            "img/pic.png".into(),
            "nope.md".into(),
        ]))
        .unwrap();
    assert_eq!(meta.missing, vec!["nope.md"]);
    assert!(meta.notes[0].frontmatter.is_none());
    // DB lives outside the vault.
    assert!(index.db_path().starts_with(fx.data.path()));
    assert!(!index.db_path().starts_with(index.root()));
}

#[test]
fn nothing_is_written_into_the_vault() {
    let fx = build_fixture();
    let before = snapshot(fx.vault.path());
    {
        let index = open(&fx);
        index.refresh_blocking().unwrap();
        let abs = index.root().join("Home.md");
        index.index_paths_blocking(vec![abs]).unwrap();
        index.backlinks("Home.md").unwrap();
    }
    assert_eq!(snapshot(fx.vault.path()), before);
    assert!(!fx.vault.path().join(".writer").exists());
}

#[test]
fn properties_are_typed() {
    let fx = build_fixture();
    let index = open(&fx);
    let props = index.properties().unwrap();
    let get = |k: &str| {
        props
            .iter()
            .find(|p| p.key == k)
            .unwrap_or_else(|| panic!("{k}"))
    };
    assert_eq!(get("status").types.get("text"), Some(&4)); // Alpha, Beta, Archive, ノート
    assert_eq!(get("due").types.get("date"), Some(&1));
    assert_eq!(get("due").types.get("text"), Some(&1)); // quoted date stays text
    assert_eq!(get("priority").types.get("number"), Some(&1));
    assert_eq!(get("done").types.get("bool"), Some(&1));
    assert_eq!(get("creation date").types.get("date"), Some(&1)); // space in the name
    assert_eq!(get("seen").types.get("datetime"), Some(&1));
    assert_eq!(get("empty").types.get("null"), Some(&1));
    assert_eq!(get("nothing").types.get("null"), Some(&1));
    assert_eq!(get("obj").types.get("object"), Some(&1));
    assert_eq!(get("related").types.get("list"), Some(&1));
    assert_eq!(get("owner").types.get("link"), Some(&1));
    assert_eq!(get("text").types.get("text"), Some(&1)); // 007 stays text
    assert_eq!(get("neg").types.get("number"), Some(&1));

    let meta = index
        .get_metadata(&MetaSelector::Paths(vec!["Meta/nulls.md".into()]))
        .unwrap();
    let fm = meta.notes[0].frontmatter.as_ref().unwrap();
    assert_eq!(fm["obj"]["b"][1], "y");
    assert_eq!(fm["empty"], serde_json::Value::Null);

    // Typed shadow columns and list items.
    let (num, date, dt_off, items): (f64, i64, i64, i64) = index
        .read(|c| {
            let num = c.query_row("SELECT v_num FROM props p JOIN files f ON f.id=p.file_id WHERE f.path='Projects/Alpha.md' AND key='priority'", [], |r| r.get(0))?;
            let date = c.query_row("SELECT v_date FROM props p JOIN files f ON f.id=p.file_id WHERE f.path='Projects/Alpha.md' AND key='due'", [], |r| r.get(0))?;
            let off = c.query_row("SELECT v_date FROM props p JOIN files f ON f.id=p.file_id WHERE key='seen_tz'", [], |r| r.get(0))?;
            let items = c.query_row("SELECT COUNT(*) FROM prop_items i JOIN files f ON f.id=i.file_id WHERE f.path='Projects/Alpha.md' AND i.link_target IS NOT NULL", [], |r| r.get(0))?;
            Ok((num, date, off, items))
        })
        .unwrap();
    assert_eq!(num, 2.0);
    assert_eq!(date, 1_709_251_200_000); // 2024-03-01T00:00:00Z
    assert_eq!(dt_off, 1_704_443_400_000); // 10:30 at +02:00 = 08:30Z
    assert_eq!(items, 2);
}

#[test]
fn tags_are_normalised_nested_and_skip_code() {
    let fx = build_fixture();
    let index = open(&fx);
    let tags: BTreeMap<_, _> = index
        .tags()
        .unwrap()
        .into_iter()
        .map(|t| (t.tag, t.count))
        .collect();
    assert_eq!(tags.get("home"), Some(&1)); // #Home lowercased
    assert_eq!(tags.get("mixed"), Some(&1)); // ancestor of #Mixed/Case
    assert_eq!(tags.get("mixed/case"), Some(&1));
    assert_eq!(tags.get("work"), Some(&2)); // Alpha (list) and Beta (comma string)
    assert_eq!(tags.get("work/alpha"), Some(&1));
    assert_eq!(tags.get("work/beta"), Some(&1));
    assert_eq!(tags.get("project"), Some(&2));
    assert_eq!(tags.get("bulk"), Some(&24));
    assert_eq!(tags.get("bulk/g0"), Some(&8));
    assert_eq!(tags.get("café"), Some(&1));
    assert!(!tags.contains_key("notatag") && !tags.contains_key("code"));
    assert_eq!(tags.get("win"), Some(&1)); // CRLF frontmatter list
    assert_eq!(tags.get("brokentag"), Some(&1)); // body of the broken-frontmatter note
    let files = index.tag_files("#Work").unwrap();
    assert_eq!(files, vec!["Projects/Alpha.md", "Projects/Beta.md"]);
    let f = index
        .query_files(&FileFilter {
            tag: Some("work/alpha".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(f.total, 1);
    assert!(index.tag_files("123").is_err());
}

#[test]
fn links_resolve_with_obsidian_rules() {
    let fx = build_fixture();
    let index = open(&fx);
    let link = |from: &str, raw: &str| {
        index
            .links(from)
            .unwrap()
            .into_iter()
            .find(|l| l.raw == raw)
            .unwrap_or_else(|| panic!("{from} -> {raw}"))
    };
    // Duplicate basename: nearest folder wins, root source falls to shortest path.
    assert_eq!(
        link("Projects/Alpha.md", "Beta").target.as_deref(),
        Some("Projects/Beta.md")
    );
    assert_eq!(
        link("Home.md", "Beta").target.as_deref(),
        Some("Archive/Beta.md")
    );
    assert_eq!(
        link("Notes/dup.md", "dup").target.as_deref(),
        Some("Notes/dup.md")
    );
    assert_eq!(
        link("Notes/dup.md", "Other/dup").target.as_deref(),
        Some("Other/dup.md")
    );
    assert_eq!(
        link("Home.md", "Projects/Alpha").target.as_deref(),
        Some("Projects/Alpha.md")
    );
    assert_eq!(
        link("Home.md", "ノート").target.as_deref(),
        Some("日本語/ノート.md")
    );
    assert_eq!(link("Home.md", "missing note").target, None);
    // Embed of an attachment and a markdown link to a pdf, relative.
    let embed = link("Projects/Alpha.md", "img/pic.png");
    assert_eq!(
        (embed.kind.as_str(), embed.target.as_deref()),
        ("embed", Some("img/pic.png"))
    );
    assert_eq!(
        link("Projects/Alpha.md", "../docs/spec.pdf")
            .target
            .as_deref(),
        Some("docs/spec.pdf")
    );
    assert_eq!(
        link("Meta/embeds.md", "data.base").target.as_deref(),
        Some("data.base")
    );
    // Markdown links; external URLs are not links.
    let md = index.links("Meta/md-links.md").unwrap();
    assert_eq!(md.len(), 2);
    assert_eq!(md[1].subpath.as_deref(), Some("Sec"));
    assert_eq!(md[1].target.as_deref(), Some("Projects/Beta.md"));
    // Frontmatter links.
    let fm: Vec<_> = index
        .links("Projects/Alpha.md")
        .unwrap()
        .into_iter()
        .filter(|l| l.in_fm)
        .collect();
    assert_eq!(fm.len(), 3);
    assert!(fm.iter().all(|l| l.target.is_some()));
    let owner = fm
        .iter()
        .find(|l| l.display.as_deref() == Some("Ann"))
        .unwrap();
    assert_eq!(owner.target.as_deref(), Some("People/Ann Lee.md"));
    // Code is not scanned.
    assert!(index.links("Meta/tasks.md").unwrap().is_empty());
    // Backlinks exclude self-links; list sources.
    let back: Vec<_> = index
        .backlinks("Projects/Beta.md")
        .unwrap()
        .into_iter()
        .map(|b| b.source)
        .collect();
    assert!(back.contains(&"Projects/Alpha.md".to_string()));
    assert!(back.contains(&"Meta/md-links.md".to_string()));
    let home_back: Vec<_> = index
        .backlinks("Home.md")
        .unwrap()
        .into_iter()
        .map(|b| b.source)
        .collect();
    assert!(home_back.contains(&"Meta/bom.md".to_string()));
    assert!(home_back.contains(&"Meta/broken.md".to_string()));
    assert_eq!(
        index.resolve_link("", "ann lee").unwrap().as_deref(),
        Some("People/Ann Lee.md")
    );
    // Unresolved listing.
    let unresolved = index.unresolved().unwrap();
    let missing = unresolved
        .iter()
        .find(|u| u.target == "missing note")
        .unwrap();
    assert_eq!(
        (missing.count, missing.sources.as_slice()),
        (1, &["Home.md".to_string()][..])
    );
    assert!(!unresolved.iter().any(|u| u.target.starts_with("nolink")));
}

#[test]
fn broken_crlf_bom_and_unicode_notes_still_index() {
    let fx = build_fixture();
    let index = open(&fx);
    let m = index
        .get_metadata(&MetaSelector::Paths(vec![
            "Meta/broken.md".into(),
            "Meta/crlf.md".into(),
            "Meta/bom.md".into(),
            "日本語/ノート.md".into(),
        ]))
        .unwrap();
    let broken = &m.notes[0];
    assert!(
        broken.fm_error.as_deref().unwrap().contains("YAML"),
        "{:?}",
        broken.fm_error
    );
    assert!(broken.frontmatter.is_none());
    assert_eq!(broken.headings[0].text, "Broken Title");
    assert_eq!(broken.headings[0].line, 5);
    assert_eq!(broken.links.len(), 1);
    let crlf = &m.notes[1];
    assert_eq!(crlf.frontmatter.as_ref().unwrap()["title"], "Windows");
    assert_eq!(crlf.headings[0].line, 6);
    assert_eq!(m.notes[2].frontmatter.as_ref().unwrap()["title"], "Bom");
    assert_eq!(m.notes[3].frontmatter.as_ref().unwrap()["status"], "進行中");
    let tasks = index
        .tasks(&TaskFilter {
            path: Some("Meta/crlf.md".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(
        tasks
            .iter()
            .map(|t| (t.line, t.status.as_str(), t.text.as_str()))
            .collect::<Vec<_>>(),
        vec![(7, " ", "first"), (8, "x", "second")]
    );
    let all = index.tasks(&TaskFilter::default()).unwrap();
    assert_eq!(all.len(), 2 + 3);
    let done = index
        .tasks(&TaskFilter {
            done: Some(true),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(done.len(), 2);
    let partial = index
        .tasks(&TaskFilter {
            status: Some("/".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(partial[0].text, "partial");
    let f = index.get_file("Meta/crlf.md").unwrap().unwrap();
    assert!(f.words.unwrap() >= 4 && f.chars.unwrap() > 10);
}

#[test]
fn query_api_surface() {
    let fx = build_fixture();
    let index = open(&fx);
    // Filters, order, paging.
    let page = index
        .query_files(&FileFilter {
            folder: Some("Bulk/".into()),
            order: FileOrder::Name,
            limit: Some(5),
            ..Default::default()
        })
        .unwrap();
    assert_eq!((page.total, page.rows.len()), (24, 5));
    assert_eq!(page.rows[0].name, "n00.md");
    let pngs = index
        .query_files(&FileFilter {
            ext: Some(".PNG".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(pngs.total, 1);
    let props = index
        .query_files(&FileFilter {
            has_property: Some("creation date".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(props.rows[0].path, "People/Ann Lee.md");
    let direct = index
        .query_files(&FileFilter {
            folder: Some("Projects".into()),
            direct_only: true,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(direct.total, 2);
    let named = index
        .query_files(&FileFilter {
            name_contains: Some("n0_".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(named.total, 0); // `_` is literal, not a wildcard
                                // Orphans / deadends: notes nothing links to, notes that link nowhere.
    let orphans = index.orphans().unwrap();
    assert!(orphans.contains(&"Meta/tasks.md".to_string()));
    assert!(!orphans.contains(&"Home.md".to_string()));
    assert!(!orphans.contains(&"Projects/Alpha.md".to_string()));
    let dead = index.deadends().unwrap();
    assert!(dead.contains(&"Meta/tasks.md".to_string()));
    assert!(dead.contains(&"Projects/Beta.md".to_string()));
    assert!(!dead.contains(&"Home.md".to_string()));
    // Folders with recursive sizes.
    let folders = index.list_folders(None).unwrap();
    let projects = folders.iter().find(|f| f.path == "Projects").unwrap();
    assert_eq!((projects.files, projects.total_files), (2, 2));
    assert!(projects.size > 0);
    assert!(folders.iter().any(|f| f.path == "日本語"));
    assert!(!folders.iter().any(|f| f.path.starts_with('.')));
    let sub = index.list_folders(Some("Bulk")).unwrap();
    assert_eq!(sub.len(), 1);
    let s = index.vault_summary().unwrap();
    assert_eq!(
        (s.files as usize, s.folders),
        (FIXTURE_FILES, folders.len() as i64)
    );
    // Bulk metadata hydration.
    let all = index.get_metadata(&MetaSelector::All).unwrap();
    assert_eq!(all.notes.len(), FIXTURE_MD);
    assert!(all.notes.iter().all(|n| !n.path.ends_with(".png")));
}

/// Open without refreshing, so the test can read the scan stats itself.
fn open_raw(fx: &Fixture) -> Index {
    Index::open(OpenParams {
        root: fx.vault.path().to_path_buf(),
        app_data_dir: fx.data.path().to_path_buf(),
        cancel: Arc::new(AtomicBool::new(false)),
        on_change: None,
    })
    .unwrap()
}

#[test]
fn warm_open_reparses_only_changes() {
    let fx = build_fixture();
    let root = fx.vault.path().canonicalize().unwrap();
    let cold = open_raw(&fx);
    let cold_stats = cold.refresh_blocking().unwrap();
    assert_eq!(cold_stats.reparsed, FIXTURE_MD);
    assert_eq!(cold_stats.added, FIXTURE_FILES);
    drop(cold);

    // Nothing changed: nothing is read or parsed.
    let index = open_raw(&fx);
    assert_eq!(index.status().unwrap().state, IndexState::Ready); // queryable before the refresh
    let stats = index.refresh_blocking().unwrap();
    assert_eq!(stats.reparsed, 0);
    assert_eq!(
        (stats.added, stats.changed, stats.touched, stats.deleted),
        (0, 0, 0, 0)
    );
    assert_eq!(stats.unchanged, FIXTURE_FILES);
    drop(index);

    // One edit (different size), one new note, one delete, one touch-only.
    write(
        &root,
        "Home.md",
        "# Home edited with a longer body\n[[Beta]]\n",
    );
    write(&root, "New.md", "# New\n[[Home]]\n");
    fs::remove_file(root.join("Other/dup.md")).unwrap();
    bump_mtime(&root.join("Projects/Beta.md"));
    let index = open_raw(&fx);
    let stats = index.refresh_blocking().unwrap();
    assert_eq!(stats.reparsed, 2, "{stats:?}"); // Home.md edited + New.md added
    assert_eq!(
        (stats.added, stats.changed, stats.touched, stats.deleted),
        (1, 1, 1, 1)
    );
    assert_eq!(stats.unchanged, FIXTURE_FILES - 3);
    assert!(index.get_file("Other/dup.md").unwrap().is_none());
    assert!(index.get_file("New.md").unwrap().is_some());
    let home = index.links("Home.md").unwrap();
    assert_eq!(home.len(), 1);
    assert_eq!(home[0].target.as_deref(), Some("Archive/Beta.md"));
    // The touched file kept its parsed rows.
    let beta = index
        .get_metadata(&MetaSelector::Paths(vec!["Projects/Beta.md".into()]))
        .unwrap();
    assert_eq!(
        beta.notes[0].frontmatter.as_ref().unwrap()["status"],
        "done"
    );
}

#[test]
fn deletes_are_detected_on_warm_open() {
    let fx = build_fixture();
    let root = fx.vault.path().canonicalize().unwrap();
    drop(open(&fx));
    fs::remove_file(root.join("Other/dup.md")).unwrap();
    let _ = root;
    let index = open_raw(&fx);
    let stats = index.refresh_blocking().unwrap();
    assert_eq!((stats.deleted, stats.reparsed), (1, 0));
    // Notes/dup.md linked to Other/dup: now unresolved; the bare `dup` link still resolves.
    let l = index.links("Notes/dup.md").unwrap();
    assert_eq!(
        l.iter().find(|x| x.raw == "Other/dup").unwrap().target,
        None
    );
    assert_eq!(
        l.iter().find(|x| x.raw == "dup").unwrap().target.as_deref(),
        Some("Notes/dup.md")
    );
}

#[test]
fn incremental_updates_and_link_reresolution() {
    let fx = build_fixture();
    let index = open(&fx);
    let root = index.root().to_path_buf();
    // Edit: properties, tags and headings are replaced.
    write(
        &root,
        "Projects/Beta.md",
        "---\nstatus: reopened\ntags: [fresh]\n---\n## New heading\n",
    );
    let changed = index
        .index_paths_blocking(vec![root.join("Projects/Beta.md")])
        .unwrap();
    assert_eq!(changed, vec!["Projects/Beta.md"]);
    let m = index
        .get_metadata(&MetaSelector::Paths(vec!["Projects/Beta.md".into()]))
        .unwrap();
    assert_eq!(
        m.notes[0].frontmatter.as_ref().unwrap()["status"],
        "reopened"
    );
    assert_eq!(
        m.notes[0]
            .tags
            .iter()
            .map(|t| t.tag.as_str())
            .collect::<Vec<_>>(),
        vec!["fresh"]
    );
    assert_eq!(m.notes[0].headings[0].level, 2);
    assert!(!index
        .tag_files("work/beta")
        .unwrap()
        .contains(&"Projects/Beta.md".to_string()));

    // Create: the unresolved link now resolves.
    write(&root, "missing note.md", "# present now\n");
    index
        .index_paths_blocking(vec![root.join("missing note.md")])
        .unwrap();
    let l = index.links("Home.md").unwrap();
    assert_eq!(
        l.iter()
            .find(|x| x.raw == "missing note")
            .unwrap()
            .target
            .as_deref(),
        Some("missing note.md")
    );
    assert!(index
        .unresolved()
        .unwrap()
        .iter()
        .all(|u| u.target != "missing note"));
    assert_eq!(
        index.backlinks("missing note.md").unwrap()[0].source,
        "Home.md"
    );

    // Rename = remove + create: links follow the new name.
    fs::rename(
        root.join("missing note.md"),
        root.join("Notes/missing note.md"),
    )
    .unwrap();
    index
        .index_paths_blocking(vec![
            root.join("missing note.md"),
            root.join("Notes/missing note.md"),
        ])
        .unwrap();
    let l = index.links("Home.md").unwrap();
    assert_eq!(
        l.iter()
            .find(|x| x.raw == "missing note")
            .unwrap()
            .target
            .as_deref(),
        Some("Notes/missing note.md")
    );

    // Delete: back to unresolved.
    fs::remove_file(root.join("Notes/missing note.md")).unwrap();
    index
        .index_paths_blocking(vec![root.join("Notes/missing note.md")])
        .unwrap();
    assert!(index
        .unresolved()
        .unwrap()
        .iter()
        .any(|u| u.target == "missing note"));

    // Same-size edit within the mtime tick is still picked up (content hash).
    write(&root, "Meta/bom.md", "x");
    index
        .index_paths_blocking(vec![root.join("Meta/bom.md")])
        .unwrap();
    write(&root, "Meta/bom.md", "y");
    index
        .index_paths_blocking(vec![root.join("Meta/bom.md")])
        .unwrap();
    assert_eq!(index.get_file("Meta/bom.md").unwrap().unwrap().size, 1);

    // Directory moved in: all descendants are indexed; removed: all dropped.
    write(&root, "Staging/a.md", "# a\n[[Home]]\n");
    write(&root, "Staging/deep/b.md", "# b\n");
    index
        .index_paths_blocking(vec![root.join("Staging")])
        .unwrap();
    assert!(index.get_file("Staging/deep/b.md").unwrap().is_some());
    fs::remove_dir_all(root.join("Staging")).unwrap();
    index
        .index_paths_blocking(vec![root.join("Staging")])
        .unwrap();
    assert!(index.get_file("Staging/a.md").unwrap().is_none());
    assert!(index.get_file("Staging/deep/b.md").unwrap().is_none());
    assert!(index
        .backlinks("Home.md")
        .unwrap()
        .iter()
        .all(|b| b.source != "Staging/a.md"));

    // Ignored and outside paths are skipped, not errors.
    write(&root, ".obsidian/x.md", "# x\n");
    let none = index
        .index_paths_blocking(vec![
            root.join(".obsidian/x.md"),
            PathBuf::from("/definitely/elsewhere.md"),
        ])
        .unwrap();
    assert!(none.is_empty());
    assert!(index.get_file(".obsidian/x.md").unwrap().is_none());
}

#[test]
fn a_path_reported_twice_in_one_batch_does_not_violate_props_keys() {
    let fx = build_fixture();
    let index = open(&fx);
    let root = index.root().to_path_buf();
    write(
        &root,
        "Fresh/n.md",
        "---\ntitle: t\nstatus: x\n---\n# n #tag\n[[Home]]\n",
    );
    // A new directory and a file inside it, as one watcher batch.
    index
        .index_paths_blocking(vec![root.join("Fresh"), root.join("Fresh/n.md")])
        .unwrap();
    assert!(index.get_file("Fresh/n.md").unwrap().is_some());
    let backlinks = index.backlinks("Home.md").unwrap();
    assert_eq!(
        backlinks
            .iter()
            .filter(|b| b.source == "Fresh/n.md")
            .count(),
        1
    );
}

fn prop_rows(index: &Index, path: &str) -> Vec<(String, Option<String>)> {
    index
        .read(|c| {
            let mut st = c.prepare(
                "SELECT p.key, p.v_text FROM props p JOIN files f ON f.id = p.file_id \
                 WHERE f.path = ?1 ORDER BY p.key",
            )?;
            let rows = st.query_map([path], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .unwrap()
}

fn fm_error_of(index: &Index, path: &str) -> Option<String> {
    index
        .read(|c| {
            Ok(
                c.query_row("SELECT fm_error FROM files WHERE path = ?1", [path], |r| {
                    r.get::<_, Option<String>>(0)
                })?,
            )
        })
        .unwrap()
}

/// Make the database reject every `props` row with this key, as a stand-in for any per-note
/// write failure.
fn poison_key(index: &Index, key: &str) {
    let conn = rusqlite::Connection::open(index.db_path()).unwrap();
    conn.busy_timeout(Duration::from_secs(10)).unwrap();
    conn.execute_batch(&format!(
        "DROP TRIGGER IF EXISTS poison; CREATE TRIGGER poison BEFORE INSERT ON props \
         WHEN NEW.key = '{key}' BEGIN SELECT RAISE(ABORT, 'synthetic poison'); END;"
    ))
    .unwrap();
}

fn unpoison(index: &Index) {
    let conn = rusqlite::Connection::open(index.db_path()).unwrap();
    conn.busy_timeout(Duration::from_secs(10)).unwrap();
    conn.execute_batch("DROP TRIGGER IF EXISTS poison;")
        .unwrap();
}

fn open_counting(fx: &Fixture) -> (Index, Arc<Mutex<Vec<ChangeBatch>>>) {
    let batches = Arc::new(Mutex::new(Vec::<ChangeBatch>::new()));
    let sink = Arc::clone(&batches);
    let index = Index::open(OpenParams {
        root: fx.vault.path().to_path_buf(),
        app_data_dir: fx.data.path().to_path_buf(),
        cancel: Arc::new(AtomicBool::new(false)),
        on_change: Some(Arc::new(move |b| sink.lock().push(b))),
    })
    .unwrap();
    index.refresh_blocking().unwrap();
    (index, batches)
}

#[test]
fn duplicate_and_variant_frontmatter_keys_make_one_row_each() {
    let fx = build_fixture();
    let index = open(&fx);
    write(
        index.root(),
        "Dup/keys.md",
        "---\nstatus: first\nStatus: other case\nstatus: last\n\"1\": a\n1: b\nstatus :   x\ntags: [a]\ntags: [b]\n---\nstatus:: inline\n",
    );
    index
        .index_paths_blocking(vec![index.root().join("Dup/keys.md")])
        .unwrap();
    assert_eq!(fm_error_of(&index, "Dup/keys.md"), None);
    let rows = prop_rows(&index, "Dup/keys.md");
    let get = |k: &str| rows.iter().filter(|(key, _)| key == k).collect::<Vec<_>>();
    // Same key twice: the last value wins. Keys are case-sensitive: `Status` is its own row.
    assert_eq!(get("status")[0].1.as_deref(), Some("x"));
    assert_eq!(get("status").len(), 1);
    assert_eq!(get("Status").len(), 1);
    assert_eq!(get("1").len(), 1);
    assert_eq!(get("1")[0].1.as_deref(), Some("b"));
    assert_eq!(get("tags").len(), 1);
    let tags = index.tag_files("b").unwrap();
    assert!(tags.contains(&"Dup/keys.md".to_string()));
    assert!(!index
        .tag_files("a")
        .unwrap()
        .contains(&"Dup/keys.md".to_string()));
}

#[test]
fn a_poisoned_note_is_isolated_marked_and_not_retried() {
    let fx = build_fixture();
    let (index, batches) = open_counting(&fx);
    poison_key(&index, "poison_key");
    let root = index.root().to_path_buf();
    write(&root, "Iso/bad.md", "---\npoison_key: 1\n---\n# bad\n");
    write(&root, "Iso/good.md", "---\nstatus: ok\n---\n# good #fine\n");
    let batch = vec![
        root.join("Iso"),
        root.join("Iso/bad.md"),
        root.join("Iso/good.md"),
    ];
    let changed = index.index_paths_blocking(batch.clone()).unwrap();
    assert!(changed.contains(&"Iso/good.md".to_string()));
    // The healthy sibling is fully indexed, the bad one is a marked bare row.
    assert_eq!(prop_rows(&index, "Iso/good.md").len(), 1);
    assert!(index.get_file("Iso/bad.md").unwrap().is_some());
    assert!(prop_rows(&index, "Iso/bad.md").is_empty());
    assert!(fm_error_of(&index, "Iso/bad.md")
        .unwrap()
        .starts_with("index error:"));
    let sent = batches.lock().len();
    // The same event again (the watcher fires every few seconds): nothing to do, no failed
    // transaction, no `index://changed`.
    for _ in 0..3 {
        let again = index.index_paths_blocking(batch.clone()).unwrap();
        assert!(again.is_empty(), "{again:?}");
    }
    assert_eq!(batches.lock().len(), sent);
    // A warm scan leaves it alone too.
    let stats = index.refresh_blocking().unwrap();
    assert!(stats.errors.is_empty(), "{:?}", stats.errors);
    // Changing the file retries it; once the cause is gone it indexes fully.
    unpoison(&index);
    write(&root, "Iso/bad.md", "---\npoison_key: 2\n---\n# bad v2\n");
    index
        .index_paths_blocking(vec![root.join("Iso/bad.md")])
        .unwrap();
    assert_eq!(prop_rows(&index, "Iso/bad.md").len(), 1);
    assert_eq!(fm_error_of(&index, "Iso/bad.md"), None);
}

#[test]
fn warm_start_and_cli_open_isolate_a_poisoned_note() {
    let fx = build_fixture();
    let index = open(&fx);
    poison_key(&index, "poison_key");
    let root = index.root().to_path_buf();
    write(&root, "Warm/bad.md", "---\npoison_key: 1\n---\nx\n");
    write(&root, "Warm/good.md", "---\nstatus: ok\n---\ny\n");
    drop(index);
    // The CLI path (`open_for_cli` scans before returning) must not fail.
    let again = open(&fx);
    assert_eq!(prop_rows(&again, "Warm/good.md").len(), 1);
    assert!(fm_error_of(&again, "Warm/bad.md")
        .unwrap()
        .starts_with("index error:"));
    let stats = again.refresh_blocking().unwrap();
    assert!(stats.errors.is_empty(), "{:?}", stats.errors);
    assert_eq!(stats.reparsed, 0);
}

#[test]
fn change_callback_reports_paths_and_cold_build_is_full() {
    let fx = build_fixture();
    let batches = Arc::new(Mutex::new(Vec::<ChangeBatch>::new()));
    let sink = Arc::clone(&batches);
    let index = Index::open(OpenParams {
        root: fx.vault.path().to_path_buf(),
        app_data_dir: fx.data.path().to_path_buf(),
        cancel: Arc::new(AtomicBool::new(false)),
        on_change: Some(Arc::new(move |b| sink.lock().push(b))),
    })
    .unwrap();
    index.refresh_blocking().unwrap();
    {
        let b = batches.lock();
        assert_eq!(b.len(), 1);
        assert!(b[0].full && b[0].paths.is_empty());
    }
    write(index.root(), "Home.md", "# changed\n");
    index
        .index_paths_blocking(vec![index.root().join("Home.md")])
        .unwrap();
    let b = batches.lock();
    assert_eq!(b[1].paths, vec!["Home.md"]);
    assert!(!b[1].full);
}

#[test]
fn corrupt_database_is_rebuilt() {
    for corrupt in [Corruption::Garbage, Corruption::Truncate] {
        let fx = build_fixture();
        let db = {
            let index = open(&fx);
            index.db_path().to_path_buf()
        };
        match corrupt {
            Corruption::Garbage => fs::write(&db, b"this is not a sqlite database at all").unwrap(),
            Corruption::Truncate => {
                let len = fs::metadata(&db).unwrap().len();
                fs::OpenOptions::new()
                    .write(true)
                    .open(&db)
                    .unwrap()
                    .set_len(len / 2)
                    .unwrap();
            }
        }
        let index = open(&fx);
        let st = index.status().unwrap();
        let reason = st.rebuilt_reason.clone().expect("rebuild reason");
        assert!(
            reason.contains("unreadable")
                || reason.contains("integrity")
                || reason.contains("version")
                || reason.contains("malformed"),
            "{reason}"
        );
        assert_eq!(st.files as usize, FIXTURE_FILES);
        assert_eq!(st.state, IndexState::Ready);
    }
}

enum Corruption {
    Garbage,
    Truncate,
}

#[test]
fn schema_and_parser_version_bumps_rebuild() {
    for key in ["schema_version", "parser_version"] {
        let fx = build_fixture();
        let db = {
            let index = open(&fx);
            index.db_path().to_path_buf()
        };
        {
            let c = rusqlite::Connection::open(&db).unwrap();
            c.execute("UPDATE meta SET value = '0' WHERE key = ?1", [key])
                .unwrap();
        }
        let index = open(&fx);
        let st = index.status().unwrap();
        assert!(
            st.rebuilt_reason.as_deref().unwrap().contains("version"),
            "{key}: {st:?}"
        );
        assert_eq!(st.files as usize, FIXTURE_FILES);
        // After the rebuild the stored versions are current again.
        let v: String = index
            .read(
                |c| Ok(c.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))?),
            )
            .unwrap();
        assert_ne!(v, "0");
        // A second open is warm, not another rebuild.
        drop(index);
        assert!(open(&fx).status().unwrap().rebuilt_reason.is_none());
    }
}

#[test]
fn cancelled_scan_stops_and_reports() {
    let fx = build_fixture();
    let cancel = Arc::new(AtomicBool::new(true));
    let index = Index::open(OpenParams {
        root: fx.vault.path().to_path_buf(),
        app_data_dir: fx.data.path().to_path_buf(),
        cancel,
        on_change: None,
    })
    .unwrap();
    assert!(matches!(
        index.refresh_blocking(),
        Err(IndexError::Cancelled)
    ));
    assert_eq!(index.status().unwrap().state, IndexState::Building);
}

#[test]
fn cli_resolves_app_data_dir_from_env_override() {
    let fx = build_fixture();
    let dir = TempDir::new().unwrap();
    std::env::set_var(INDEX_DIR_ENV, dir.path());
    let index = Index::open_for_cli(fx.vault.path(), None).unwrap();
    std::env::remove_var(INDEX_DIR_ENV);
    assert!(index.db_path().starts_with(dir.path().join("index")));
    assert_eq!(index.status().unwrap().files as usize, FIXTURE_FILES);
}

#[test]
fn readers_do_not_block_on_the_writer() {
    let fx = build_fixture();
    let index = Arc::new(open(&fx));
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let idx = Arc::clone(&index);
            std::thread::spawn(move || {
                for _ in 0..50 {
                    idx.query_files(&FileFilter::default()).unwrap();
                }
            })
        })
        .collect();
    for i in 0..20 {
        let root = index.root().to_path_buf();
        write(&root, "Home.md", &format!("# {i}\n"));
        index.queue_paths(vec![root.join("Home.md")]).unwrap();
    }
    for h in handles {
        h.join().unwrap();
    }
    index.index_paths_blocking(vec![]).unwrap(); // drain the queue
    assert_eq!(index.get_file("Home.md").unwrap().unwrap().size, 5);
}

#[test]
fn perf_smoke_3000_notes() {
    let vault = TempDir::new().unwrap();
    let data = TempDir::new().unwrap();
    let root = vault.path();
    let words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor";
    for i in 0..3000 {
        let folder = i % 60;
        let mut body = String::new();
        for l in 0..12 {
            body.push_str(&format!("[[note{:04}]] ", (i * 7 + l * 13) % 3000));
        }
        let mut text = format!(
            "---\ntitle: Note {i}\nstatus: {}\npriority: {}\ndue: 2024-0{}-1{}\ntags: [t{}, group/g{}]\nowner: \"[[note{:04}]]\"\n---\n# Heading {i}\n#inline{}\n",
            ["todo", "doing", "done"][i % 3],
            i % 5,
            1 + i % 9,
            i % 10,
            i % 20,
            i % 7,
            (i + 1) % 3000,
            i % 11
        );
        for _ in 0..6 {
            text.push_str(&format!(
                "{body}\n{words} {words} {words} {words} {words} {words}\n- [ ] task {i}\n"
            ));
        }
        write(root, &format!("f{folder:02}/note{i:04}.md"), &text);
    }
    let t0 = std::time::Instant::now();
    let index = Index::open_for_cli(root, Some(data.path())).unwrap();
    let cold = t0.elapsed();
    let st = index.status().unwrap();
    assert_eq!(st.files, 3000);
    assert!(!index.backlinks("f07/note0007.md").unwrap().is_empty());
    assert!(index.unresolved().unwrap().is_empty());
    drop(index);

    let t1 = std::time::Instant::now();
    let index = Index::open_for_cli(root, Some(data.path())).unwrap();
    let warm = t1.elapsed();

    let abs = index.root().join("f00/note0000.md");
    write(index.root(), "f00/note0000.md", "# changed\n[[note0001]]\n");
    let t2 = std::time::Instant::now();
    index.index_paths_blocking(vec![abs]).unwrap();
    let incr = t2.elapsed();

    let t3 = std::time::Instant::now();
    let page = index
        .query_files(&FileFilter {
            tag: Some("t3".into()),
            order: FileOrder::Mtime,
            limit: Some(500),
            ..Default::default()
        })
        .unwrap();
    let query = t3.elapsed();
    assert!(page.total > 0);
    println!(
        "PERF 3000 notes: cold {cold:?} (scan {} ms), warm open {warm:?}, incremental 1 note {incr:?}, tag query {query:?}, db {} KB",
        st.last_scan.as_ref().map_or(0, |s| s.duration_ms),
        fs::metadata(index.db_path()).unwrap().len() / 1024
    );
    // Generous bounds: this is a smoke test, not a benchmark.
    assert!(
        cold < Duration::from_secs(60),
        "cold build too slow: {cold:?}"
    );
    assert!(
        warm < Duration::from_secs(20),
        "warm open too slow: {warm:?}"
    );
    assert!(
        incr < Duration::from_secs(5),
        "incremental too slow: {incr:?}"
    );
}

#[test]
fn nested_tags_match_whole_segment_prefixes_only() {
    let fx = Fixture {
        vault: TempDir::new().unwrap(),
        data: TempDir::new().unwrap(),
    };
    for (rel, body) in NESTED_TAG_NOTES {
        write(fx.vault.path(), rel, body);
    }
    let index = open(&fx);
    let files = |tag: &str| index.tag_files(tag).unwrap();
    assert_eq!(
        files("research"),
        vec!["Tags/Deep.md", "Tags/Mid.md", "Tags/Top.md"]
    );
    assert_eq!(files("#Research/Hlo"), vec!["Tags/Deep.md", "Tags/Mid.md"]);
    assert_eq!(files("research/hlo/docs"), vec!["Tags/Deep.md"]);
    assert_eq!(files("researcher"), vec!["Tags/Other.md"]);
    assert!(files("res").is_empty());
    assert!(files("research/h").is_empty());
    // Parent counts include their children.
    let counts: BTreeMap<_, _> = index
        .tags()
        .unwrap()
        .into_iter()
        .map(|t| (t.tag, t.count))
        .collect();
    assert_eq!(counts.get("research"), Some(&3));
    assert_eq!(counts.get("research/hlo"), Some(&2));
    assert_eq!(counts.get("research/hlo/docs"), Some(&1));
    assert_eq!(counts.get("researcher"), Some(&1));
    // The metadata filter and Search `tag:` agree with `tag_files`.
    let filtered = |tag: &str| {
        index
            .query_files(&FileFilter {
                tag: Some(tag.into()),
                ..Default::default()
            })
            .unwrap()
            .total
    };
    assert_eq!((filtered("research"), filtered("research/h")), (3, 0));
    let hits = |q: &str| {
        index
            .search(q, &SearchOptions::default())
            .unwrap()
            .hits
            .len()
    };
    assert_eq!(hits("tag:research nested"), 3);
    assert_eq!(hits("tag:#research/hlo nested"), 2);
    assert_eq!(hits("tag:res nested"), 0);
}

#[test]
fn a_query_of_filters_only_lists_the_matching_notes_newest_first() {
    let fx = Fixture {
        vault: TempDir::new().unwrap(),
        data: TempDir::new().unwrap(),
    };
    for (rel, body) in NESTED_TAG_NOTES {
        write(fx.vault.path(), rel, body);
    }
    // Deep (body tag), Mid (front matter tag), Top: modified in that order, 10 s apart.
    let base = std::time::SystemTime::now() - std::time::Duration::from_secs(1000);
    for (i, rel) in ["Tags/Deep.md", "Tags/Mid.md", "Tags/Top.md"]
        .iter()
        .enumerate()
    {
        let f = std::fs::File::options()
            .write(true)
            .open(fx.vault.path().join(rel))
            .unwrap();
        f.set_modified(base + std::time::Duration::from_secs(10 * i as u64))
            .unwrap();
    }
    let index = open(&fx);
    let paths = |q: &str, o: &SearchOptions| -> Vec<String> {
        index
            .search(q, o)
            .unwrap()
            .hits
            .into_iter()
            .map(|h| h.path)
            .collect()
    };
    let none = SearchOptions::default();
    // Nested tags match; body and front matter tags; newest modified first.
    assert_eq!(
        paths("tag:research", &none),
        vec!["Tags/Top.md", "Tags/Mid.md", "Tags/Deep.md"]
    );
    assert_eq!(
        paths("tag:#research/hlo", &none),
        vec!["Tags/Mid.md", "Tags/Deep.md"]
    );
    assert!(paths("tag:res", &none).is_empty());
    let page = index.search("tag:research", &none).unwrap();
    assert_eq!(page.total, 3);
    assert!(page.hits[0].snippets.is_empty() && !page.hits[0].stale);
    // Bounded by the limit, `total` still counts them all; offset pages on.
    let two = SearchOptions {
        limit: Some(2),
        ..Default::default()
    };
    let page = index.search("tag:research", &two).unwrap();
    assert_eq!((page.total, page.hits.len()), (3, 2));
    let next = SearchOptions {
        limit: Some(2),
        offset: 2,
        ..Default::default()
    };
    assert_eq!(paths("tag:research", &next), vec!["Tags/Deep.md"]);
    // An opened note ranks first (the one ranker's order).
    let opened = SearchOptions {
        opened: [("Tags/Deep.md".to_string(), 5_000_i64)]
            .into_iter()
            .collect(),
        ..Default::default()
    };
    assert_eq!(paths("tag:research", &opened)[0], "Tags/Deep.md");
    // Words plus a filter, and an empty query, are as before.
    assert_eq!(paths("tag:research nested", &none).len(), 3);
    assert!(paths("", &none).is_empty());
    assert!(paths("-nested", &none).is_empty());
    // Exclusions alone are not a listing; with a positive filter they narrow it.
    assert!(paths("-kind:pdf", &none).is_empty());
    assert!(paths("-ext:md", &none).is_empty());
    assert!(paths("-kind:pdf -ext:md", &none).is_empty());
    assert!(paths("kind:note -ext:md", &none).is_empty()); // every note here is .md
    assert_eq!(paths("kind:note -ext:txt", &none).len(), 4);
    assert_eq!(paths("tag:research -kind:pdf", &none).len(), 3);
}

/// 205 tagged notes, modified a second apart (`N000` oldest): the order of a filter-only search,
/// paged in SQL with nothing opened and ranked in Rust with some opened, agrees with
/// `empty_query_key`, and pages tile the matches.
#[test]
fn a_filter_only_search_pages_in_the_one_order() {
    let fx = Fixture {
        vault: TempDir::new().unwrap(),
        data: TempDir::new().unwrap(),
    };
    let base = std::time::SystemTime::now() - std::time::Duration::from_secs(100_000);
    for i in 0..205u64 {
        let rel = format!("Many/N{i:03}.md");
        write(fx.vault.path(), &rel, "body #bulk\n");
        std::fs::File::options()
            .write(true)
            .open(fx.vault.path().join(&rel))
            .unwrap()
            .set_modified(base + std::time::Duration::from_secs(i))
            .unwrap();
    }
    let index = open(&fx);
    let page = |o: &SearchOptions, offset: u32| -> Vec<String> {
        let o = SearchOptions {
            offset,
            limit: Some(100),
            opened: o.opened.clone(),
            ..Default::default()
        };
        index
            .search("tag:bulk", &o)
            .unwrap()
            .hits
            .into_iter()
            .map(|h| h.path)
            .collect()
    };
    let tiles = |o: &SearchOptions| -> Vec<String> {
        [0, 100, 200].iter().flat_map(|&off| page(o, off)).collect()
    };
    let every_note_once = |all: &[String]| {
        let mut sorted = all.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 205);
        assert_eq!(all.len(), 205);
    };
    // Nothing opened: newest first, in SQL.
    let none = SearchOptions::default();
    let by_sql = tiles(&none);
    every_note_once(&by_sql);
    assert_eq!(by_sql[0], "Many/N204.md");
    assert_eq!(by_sql[204], "Many/N000.md");
    // The oldest opened: it is hit 0 (not only within the newest 200), the rest keep their order,
    // and the pages still list every note once.
    let opened = SearchOptions {
        opened: [("Many/N000.md".to_string(), 1_i64)].into_iter().collect(),
        ..Default::default()
    };
    let by_rank = tiles(&opened);
    every_note_once(&by_rank);
    assert_eq!(by_rank[0], "Many/N000.md");
    assert_eq!(by_rank[1..], by_sql[..204]);
}

#[test]
fn property_values_lists_distinct_scalars_with_note_counts() {
    let fx = build_fixture();
    let index = open(&fx);
    let status = index.property_values("Status").unwrap(); // case-insensitive name
    assert_eq!(status.iter().map(|(_, n)| n).sum::<i64>(), 4);
    assert!(status.iter().all(|(v, n)| !v.trim().is_empty() && *n >= 1));
    assert!(
        index.property_values("obj").unwrap().is_empty(),
        "nested values are skipped"
    );
    assert!(index.property_values("no-such-key").unwrap().is_empty());
}
