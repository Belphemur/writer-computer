//! CLI integration tests: every command is driven through the argument parser
//! (`execute`) against a synthetic vault built in a temp dir, with the index
//! database in a second temp dir. No real vault is ever used.

use super::*;
use std::cell::RefCell;
use std::fs;
use std::rc::Rc;
use tempfile::TempDir;

struct FakeClipboard(Rc<RefCell<Option<String>>>, bool);

impl Clipboard for FakeClipboard {
    fn copy(&self, text: &str) -> Result<(), String> {
        if self.1 {
            return Err("--copy needs a clipboard tool, but pbcopy was not found in PATH".into());
        }
        *self.0.borrow_mut() = Some(text.to_string());
        Ok(())
    }
}

/// The CLI tests never start the app: `open --launch` has its own tests in `ipc/tests.rs`.
struct NoLauncher;

impl crate::writer_cli::Launcher for NoLauncher {
    fn launch(&self, _: Option<&std::path::Path>) -> Result<(), crate::writer_cli::LaunchError> {
        panic!("a CLI test must not start the app");
    }
}

struct T {
    vault: TempDir,
    data: TempDir,
    clip: Rc<RefCell<Option<String>>>,
}

const BASE: &str = "filters:\n  and:\n    - file.inFolder(\"Projects\")\nproperties:\n  priority:\n    displayName: Prio\nviews:\n  - type: table\n    name: All\n    order:\n      - file.name\n      - status\n      - priority\n      - due\n    sort:\n      - property: priority\n        direction: DESC\n  - type: table\n    name: Active\n    filters:\n      and:\n        - status == \"active\"\n    order:\n      - file.name\n      - tags\n";

impl T {
    fn new() -> T {
        let t = T {
            vault: TempDir::new().unwrap(),
            data: TempDir::new().unwrap(),
            clip: Rc::new(RefCell::new(None)),
        };
        t.write("Home.md", "---\ntags: [index]\n---\n# Home\nSee [[Projects/Alpha]], [[Beta]], [[missing note]].\n- [ ] top task\n");
        t.write("Projects/Alpha.md", "---\nstatus: active\npriority: 2\ndue: 2024-03-01\naliases: [Al]\ntags: [project]\n---\n# Alpha\n## Plan\nplan text\n\n## Notes\nnotes text\nLinks to [[Beta]]. #work\n- [x] done task\n- [/] partial\n");
        t.write(
            "Projects/Beta.md",
            "---\nstatus: done\npriority: 1\n---\n# Beta\nbeta body with the word Needle\n",
        );
        t.write("Archive/Old.md", "old [[Beta]]\n");
        t.write("tasks.base", BASE);
        t.write(".obsidian/app.json", "{}");
        t
    }

    fn write(&self, rel: &str, content: &str) {
        let p = self.vault.path().join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    fn read(&self, rel: &str) -> String {
        fs::read_to_string(self.vault.path().join(rel)).unwrap()
    }

    fn exists(&self, rel: &str) -> bool {
        self.vault.path().join(rel).exists()
    }

    fn run_in(&self, cwd: &std::path::Path, line: &[&str], broken_clip: bool) -> Outcome {
        let env = Env {
            app_data_dir: Some(self.data.path().to_path_buf()),
            clipboard: Box::new(FakeClipboard(Rc::clone(&self.clip), broken_clip)),
            utc_offset_minutes: 0,
            launcher: Box::new(NoLauncher),
            launch_wait: std::time::Duration::ZERO,
            read_stdin: || Ok(String::new()),
        };
        let argv: Vec<String> = line.iter().map(|s| s.to_string()).collect();
        execute(&argv, cwd, &env)
    }

    fn run(&self, line: &[&str]) -> Outcome {
        self.run_in(self.vault.path(), line, false)
    }

    fn ok(&self, line: &[&str]) -> String {
        let o = self.run(line);
        assert_eq!(o.code, EXIT_OK, "{line:?}: {}", o.stderr);
        o.stdout
    }

    /// Rows of a command's `format=json` list.
    fn count(&self, line: &[&str]) -> usize {
        let mut args = line.to_vec();
        args.push("format=json");
        serde_json::from_str::<Vec<serde_json::Value>>(&self.ok(&args))
            .unwrap()
            .len()
    }

    /// Distinct notes linking to `target` (`file=...`/`path=...`), from `graph:backlinks`.
    fn linking_notes(&self, target: &str) -> usize {
        let v: Vec<serde_json::Value> = serde_json::from_str(&self.ok(&[
            "graph:backlinks",
            target,
            "format=json",
            "limit=1000",
        ]))
        .unwrap();
        v.iter()
            .map(|b| b["source"].as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>()
            .len()
    }

    fn code(&self, line: &[&str]) -> (u8, String) {
        let o = self.run(line);
        (o.code, o.stderr)
    }
}

#[test]
fn usage_errors_exit_2_and_app_control_is_declined() {
    let t = T::new();
    for line in [
        &["files", "bogus=1"][..],
        &["files", "nope"],
        &["files", "--zzz"],
        &["frobnicate"],
        &["vault=x"],
        &["read"],
        &["search"],
        &["search", "query=a", "format=xml"],
        &["property:set", "name=a", "file=Home"],
        &["files", "folder=a", "folder=b"],
    ] {
        let (code, err) = t.code(line);
        assert_eq!(code, EXIT_USAGE, "{line:?}: {err}");
        assert!(err.starts_with("writer: "), "{err}");
    }
    let o = t.run(&["daily"]);
    assert_eq!(
        (o.code, o.stderr.as_str()),
        (2, "Not available in the Writer CLI: daily\n")
    );
    let o = t.run(&["plugin:install", "id=x"]);
    assert_eq!(
        (o.code, o.stderr.as_str()),
        (2, "Not available in the Writer CLI: plugin:install\n")
    );
    let o = t.run(&["vault:open"]);
    assert_eq!(o.code, 2);
    let o = t.run(&["read", "active"]);
    assert_eq!(o.code, 2);
    assert!(o.stderr.contains("Not available in the Writer CLI"));
    assert!(t.ok(&["help", "read"]).contains("Usage: writer"));
    assert_eq!(t.run(&["help", "daily"]).code, 2);
}

#[test]
fn help_and_version() {
    let t = T::new();
    let h = t.ok(&["help"]);
    for c in ["base:query", "property:set", "graph:backlinks", "wordcount"] {
        assert!(h.contains(c), "{c}");
    }
    let h = t.ok(&["help", "base:query"]);
    assert!(h.contains("json | csv | tsv | md | paths"));
    assert!(h.contains("(default json)"));
    assert_eq!(t.ok(&["help", "files"]), t.ok(&["files", "--help"]));
    assert_eq!(
        t.ok(&["version"]),
        format!("writer {}\n", crate::writer_cli::VERSION)
    );
    // no vault needed
    let nowhere = TempDir::new().unwrap();
    let o = t.run_in(&nowhere.path().join("missing"), &["version"], false);
    assert_eq!(o.code, 0);
}

#[test]
fn vault_and_vaults() {
    let t = T::new();
    let v = t.ok(&["vault"]);
    assert!(v.starts_with("name\t"));
    assert!(
        v.contains("files\t5\n") && v.contains("folders\t2\n"),
        "{v}"
    );
    assert_eq!(t.ok(&["vault", "info=files"]), "5\n");
    assert!(t
        .ok(&["vault", "info=path"])
        .trim_end()
        .ends_with(t.vault.path().file_name().unwrap().to_str().unwrap()));
    assert_eq!(t.run(&["vault", "info=nope"]).code, 2);
    // vaults reads recent_workspaces.json
    assert_eq!(t.ok(&["vaults"]), "");
    let root = t.vault.path().canonicalize().unwrap();
    fs::write(
        t.data.path().join("recent_workspaces.json"),
        serde_json::to_string(&[root.to_string_lossy(), "/gone".into()]).unwrap(),
    )
    .unwrap();
    let name = root.file_name().unwrap().to_str().unwrap().to_string();
    assert_eq!(t.ok(&["vaults"]), format!("{name}\n"));
    assert_eq!(t.ok(&["vaults", "total"]), "1\n");
    let verbose = t.ok(&["vaults", "verbose"]);
    assert!(
        verbose.starts_with(&format!("{name}\t"))
            && verbose.trim_end().ends_with(root.to_str().unwrap())
    );
}

#[test]
fn vault_targeting_by_argument_name_and_cwd() {
    let t = T::new();
    let other = TempDir::new().unwrap();
    let root = t.vault.path().canonicalize().unwrap();
    let vault_arg = format!("vault={}", root.display());
    let o = t.run_in(other.path(), &[&vault_arg, "files", "total"], false);
    assert_eq!((o.code, o.stdout.as_str()), (0, "5\n"));
    // by recent name
    fs::write(
        t.data.path().join("recent_workspaces.json"),
        serde_json::to_string(&[root.to_string_lossy()]).unwrap(),
    )
    .unwrap();
    let name = root.file_name().unwrap().to_str().unwrap();
    let o = t.run_in(
        other.path(),
        &[&format!("vault={name}"), "files", "total"],
        false,
    );
    assert_eq!(o.stdout, "5\n");
    // by id
    let id = vault::vault_id(t.data.path(), &root);
    let o = t.run_in(
        other.path(),
        &[&format!("vault={id}"), "files", "total"],
        false,
    );
    assert_eq!(o.stdout, "5\n");
    // unknown vault
    let o = t.run_in(other.path(), &["vault=nope", "files"], false);
    assert_eq!(o.code, 1);
    assert!(o.stderr.contains("unknown vault"));
    // cwd inside the vault resolves the vault through `.obsidian`
    let o = t.run_in(&root.join("Projects"), &["files", "total"], false);
    assert_eq!(o.stdout, "5\n");
}

#[test]
fn files_folders_file_folder() {
    let t = T::new();
    assert_eq!(
        t.ok(&["files"]),
        "Archive/Old.md\nHome.md\nProjects/Alpha.md\nProjects/Beta.md\ntasks.base\n"
    );
    assert_eq!(
        t.ok(&["files", "folder=Projects"]),
        "Projects/Alpha.md\nProjects/Beta.md\n"
    );
    assert_eq!(t.ok(&["files", "ext=base"]), "tasks.base\n");
    assert_eq!(t.ok(&["files", "total"]), "5\n");
    assert_eq!(t.ok(&["folders"]), "Archive\nProjects\n");
    assert_eq!(t.ok(&["folders", "total"]), "2\n");
    let f = t.ok(&["file", "file=Alpha"]);
    assert!(
        f.starts_with("path\tProjects/Alpha.md\nname\tAlpha\nextension\tmd\nsize\t"),
        "{f}"
    );
    assert!(f.contains("\ncreated\t") && f.contains("\nmodified\t"));
    assert_eq!(
        t.ok(&["file", "path=Home.md"]).lines().next(),
        Some("path\tHome.md")
    );
    assert_eq!(t.code(&["file", "file=Nope"]).0, 1);
    assert_eq!(t.code(&["file", "path=Nope.md"]).0, 1);
    assert_eq!(t.code(&["file"]).0, 2);
    assert_eq!(t.code(&["file", "file=Home", "path=Home.md"]).0, 2);
    assert_eq!(t.ok(&["folder", "path=Projects", "info=files"]), "2\n");
    assert_eq!(t.ok(&["folder", "path=Projects", "info=folders"]), "0\n");
    assert!(t
        .ok(&["folder", "path=Projects"])
        .starts_with("path\tProjects\nfiles\t2\nfolders\t0\nsize\t"));
    assert_eq!(t.code(&["folder", "path=Missing"]).0, 1);
    assert_eq!(t.code(&["folder", "path=../x"]).0, 1);
}

#[test]
fn read_and_confinement() {
    let t = T::new();
    assert_eq!(t.ok(&["read", "path=Archive/Old.md"]), "old [[Beta]]\n");
    assert_eq!(t.ok(&["read", "file=Old"]), "old [[Beta]]\n");
    for bad in [
        "path=../outside.md",
        "path=.obsidian/app.json",
        "path=/etc/hosts",
    ] {
        assert_eq!(t.code(&["read", bad]).0, 1, "{bad}");
    }
}

#[test]
fn create_variants() {
    let t = T::new();
    assert_eq!(
        t.ok(&["create", "name=Fresh", "content=Hello\\nWorld"]),
        "Created Fresh.md\n"
    );
    assert_eq!(t.read("Fresh.md"), "Hello\nWorld");
    assert_eq!(t.code(&["create", "name=Fresh"]).0, 1);
    assert_eq!(
        t.ok(&["create", "name=Fresh", "content=New", "overwrite"]),
        "Overwrote Fresh.md\n"
    );
    assert_eq!(t.read("Fresh.md"), "New");
    assert_eq!(
        t.ok(&["create", "path=Deep/er/Note.md", "content=x"]),
        "Created Deep/er/Note.md\n"
    );
    assert_eq!(t.ok(&["create"]), "Created Untitled.md\n");
    assert_eq!(t.ok(&["create"]), "Created Untitled 1.md\n");
    // template: text of another note, content appended
    assert_eq!(
        t.ok(&["create", "name=FromTpl", "template=Old", "content=more"]),
        "Created FromTpl.md\n"
    );
    assert_eq!(t.read("FromTpl.md"), "old [[Beta]]\nmore");
    assert_eq!(t.code(&["create", "name=X", "template=NoSuch"]).0, 1);
    // open/newtab: noted on stderr, command continues
    let o = t.run(&["create", "name=Opened", "open", "newtab"]);
    assert_eq!(o.code, 0);
    assert!(o.stderr.contains("open/newtab ignored"));
    assert!(t.exists("Opened.md"));
    // never into .obsidian or outside
    assert_eq!(t.code(&["create", "path=.obsidian/x.md"]).0, 1);
    assert_eq!(t.code(&["create", "path=../x.md"]).0, 1);
    assert!(!t.exists(".obsidian/x.md"));
    assert_eq!(t.code(&["create", "name=a", "path=b"]).0, 2);
}

#[test]
fn append_and_prepend() {
    let t = T::new();
    t.ok(&["append", "path=Archive/Old.md", "content=second"]);
    assert_eq!(t.read("Archive/Old.md"), "old [[Beta]]\nsecond\n");
    t.ok(&["append", "path=Archive/Old.md", "content=!", "inline"]);
    assert_eq!(t.read("Archive/Old.md"), "old [[Beta]]\nsecond\n!");
    t.ok(&["append", "path=Archive/Old.md", "content=next"]);
    assert_eq!(t.read("Archive/Old.md"), "old [[Beta]]\nsecond\n!\nnext\n");
    // prepend lands after the frontmatter
    t.ok(&["prepend", "file=Beta", "content=top line"]);
    assert_eq!(
        t.read("Projects/Beta.md"),
        "---\nstatus: done\npriority: 1\n---\ntop line\n# Beta\nbeta body with the word Needle\n"
    );
    // headings
    t.ok(&[
        "append",
        "file=Alpha",
        "content=added to plan",
        "heading=Plan",
    ]);
    let a = t.read("Projects/Alpha.md");
    assert!(a.contains("plan text\nadded to plan\n\n## Notes"), "{a}");
    t.ok(&[
        "prepend",
        "file=Alpha",
        "content=first in notes",
        "heading=## Notes",
    ]);
    assert!(t
        .read("Projects/Alpha.md")
        .contains("## Notes\nfirst in notes\nnotes text"));
    assert_eq!(
        t.code(&["append", "file=Alpha", "content=x", "heading=Missing"])
            .0,
        1
    );
    assert_eq!(t.code(&["append", "file=Alpha"]).0, 2);
}

#[test]
fn rename_and_move_update_links_everywhere() {
    let t = T::new();
    let out = t.ok(&["move", "file=Beta", "name=Gamma"]);
    assert_eq!(
        out,
        "Renamed Projects/Beta.md -> Projects/Gamma.md (updated 3 links in 3 files)\n"
    );
    assert!(t.exists("Projects/Gamma.md") && !t.exists("Projects/Beta.md"));
    assert!(t
        .read("Home.md")
        .contains("See [[Projects/Alpha]], [[Gamma]], [[missing note]]."));
    assert!(t.read("Projects/Alpha.md").contains("Links to [[Gamma]]."));
    assert_eq!(t.read("Archive/Old.md"), "old [[Gamma]]\n");
    // the index agrees after a fresh refresh
    assert_eq!(t.linking_notes("file=Gamma"), 3);
    // move into another folder: bare links keep resolving, path links change
    t.write("Home.md", "[[Gamma]] and [[Projects/Gamma]]\n");
    let out = t.ok(&["move", "file=Gamma", "to=Archive"]);
    assert!(
        out.starts_with("Moved Projects/Gamma.md -> Archive/Gamma.md"),
        "{out}"
    );
    assert!(t.exists("Archive/Gamma.md"));
    assert_eq!(t.read("Home.md"), "[[Gamma]] and [[Archive/Gamma]]\n");
    // full destination path with a new name
    t.ok(&["move", "path=Archive/Gamma.md", "to=Deep/Delta.md"]);
    assert!(t.exists("Deep/Delta.md"));
    assert_eq!(t.read("Home.md"), "[[Delta]] and [[Deep/Delta]]\n");
    // explicit failures
    assert_eq!(t.code(&["move", "file=Alpha", "to=Archive/Old.md"]).0, 1);
    assert_eq!(t.code(&["move", "file=Alpha", "name=a/b"]).0, 2);
    assert_eq!(t.code(&["move", "file=Alpha", "name=Alpha"]).0, 1);
    assert_eq!(t.code(&["move", "file=Alpha", "to=.obsidian"]).0, 1);
    assert!(!t.exists(".obsidian/Alpha.md"));
}

#[test]
fn delete_permanent_and_missing() {
    let t = T::new();
    assert_eq!(
        t.ok(&["delete", "file=Old", "permanent"]),
        "Deleted Archive/Old.md\n"
    );
    assert!(!t.exists("Archive/Old.md"));
    assert_eq!(t.code(&["delete", "path=Archive/Old.md", "permanent"]).0, 1);
    assert_eq!(
        t.code(&["delete", "path=.obsidian/app.json", "permanent"])
            .0,
        1
    );
    assert!(t.exists(".obsidian/app.json"));
}

#[test]
fn search_formats_regex_case_and_limit() {
    let t = T::new();
    assert_eq!(t.ok(&["search", "query=needle"]), "Projects/Beta.md\n");
    assert_eq!(t.ok(&["search", "query=needle", "case"]), "");
    assert_eq!(
        t.ok(&["search", "query=Needle", "case"]),
        "Projects/Beta.md\n"
    );
    assert_eq!(
        t.ok(&["search", "query=/pl(an|ain)/"]),
        "Projects/Alpha.md\n"
    );
    assert_eq!(t.ok(&["search", "query=beta", "total"]), "4\n");
    assert_eq!(
        t.ok(&["search", "query=beta", "limit=1"]),
        "Projects/Beta.md\n" // ranked: the file name matches
    );
    assert_eq!(t.ok(&["search", "query=alpha", "path=Archive"]), "");
    assert_eq!(
        t.ok(&["search", "query=needle", "format=json"]),
        "[\n  \"Projects/Beta.md\"\n]\n"
    );
    assert_eq!(t.code(&["search", "query=/(/"]).0, 1);
    assert_eq!(
        t.ok(&["search:context", "query=needle"]),
        "Projects/Beta.md:6: beta body with the word Needle\n"
    );
    let j: serde_json::Value =
        serde_json::from_str(&t.ok(&["search:context", "query=task", "format=json"])).unwrap();
    assert_eq!(j[0]["path"], "Home.md");
    assert_eq!(j[0]["line"], 6);
    assert_eq!(j[0]["text"], "- [ ] top task");
    assert_eq!(
        t.ok(&["search:context", "query=task", "limit=1"])
            .lines()
            .count(),
        1
    );
}

#[test]
fn search_uses_the_full_text_index_with_its_query_language() {
    let t = T::new();
    // Ranked, whole words (no substring), prefix with `*`, phrases, exclusion, OR.
    assert_eq!(t.ok(&["search", "query=needl"]), "");
    assert_eq!(t.ok(&["search", "query=needl*"]), "Projects/Beta.md\n");
    assert_eq!(
        t.ok(&["search", "query=\"\"beta body\"\""]),
        "Projects/Beta.md\n"
    );
    assert_eq!(t.ok(&["search", "query=\"\"body beta\"\""]), "");
    assert_eq!(
        t.ok(&[
            "search",
            "query=beta -needle",
            "format=json",
            "path=Projects"
        ]),
        "[\n  \"Projects/Alpha.md\"\n]\n"
    );
    assert_eq!(t.ok(&["search", "query=needle OR partial", "total"]), "2\n");
    assert_eq!(t.ok(&["search", "query=tag:project plan", "total"]), "1\n");
    // Odd input is data, never an index error.
    assert_eq!(t.ok(&["search", "query=NEAR(", "total"]), "0\n");
    assert_eq!(t.ok(&["search", "query=!!!", "total"]), "0\n");
    // Frontmatter values are searchable.
    assert_eq!(t.ok(&["search", "query=active"]), "Projects/Alpha.md\n");
    // search:context goldens: text, json, case, limit, path.
    assert_eq!(
        t.ok(&["search:context", "query=beta", "path=Projects"]),
        "Projects/Beta.md:5: # Beta\nProjects/Beta.md:6: beta body with the word Needle\nProjects/Alpha.md:14: Links to [[Beta]]. #work\n"
    );
    assert_eq!(
        t.ok(&["search:context", "query=needle", "format=json"]),
        "[\n  {\n    \"line\": 6,\n    \"path\": \"Projects/Beta.md\",\n    \"text\": \"beta body with the word Needle\"\n  }\n]\n"
    );
    assert_eq!(t.ok(&["search:context", "query=needle", "case"]), "");
    assert_eq!(
        t.ok(&["search:context", "query=Needle", "case"]),
        "Projects/Beta.md:6: beta body with the word Needle\n"
    );
    assert_eq!(
        t.ok(&["search:context", "query=beta", "limit=2"])
            .lines()
            .count(),
        2
    );
    // Regex mode is still the explicit /.../ form.
    assert_eq!(
        t.ok(&["search:context", "query=/^# B/"]),
        "Projects/Beta.md:5: # Beta\n"
    );
}

#[test]
fn search_filters_by_kind_and_ext_and_places_pdf_and_drawing_lines() {
    let t = T::new();
    t.write("tools/run.py", "def beta_helper():\n    return 'needle'\n");
    t.write(
        "Drawings/Arch.excalidraw",
        r#"{"type":"excalidraw","version":2,"elements":[{"id":"a","type":"text","text":"beta lighthouse"}],"appState":{},"files":{}}"#,
    );
    let pdf =
        crate::features::pdf::fixture_pdf(&["first sheet", "needle in the second sheet"], None);
    fs::create_dir_all(t.vault.path().join("Papers")).unwrap();
    fs::write(t.vault.path().join("Papers/Report.pdf"), pdf).unwrap();
    // a PDF is found by a word only it holds, and the kind and extension narrow a query
    assert_eq!(
        t.ok(&["search", "query=second sheet"]),
        "Papers/Report.pdf\n"
    );
    assert_eq!(
        t.ok(&["search", "query=needle kind:pdf"]),
        "Papers/Report.pdf\n"
    );
    assert_eq!(
        t.ok(&["search", "query=needle kind:code"]),
        "tools/run.py\n"
    );
    assert_eq!(t.ok(&["search", "query=needle ext:py"]), "tools/run.py\n");
    assert_eq!(
        t.ok(&["search", "query=needle -kind:code -kind:pdf"]),
        "Projects/Beta.md\n"
    );
    assert_eq!(
        t.ok(&["search", "query=lighthouse kind:drawing"]),
        "Drawings/Arch.excalidraw\n"
    );
    // an unknown kind is an error that names the known ones
    let (code, err) = t.code(&["search", "query=needle kind:spreadsheet"]);
    assert_ne!(code, EXIT_OK);
    assert!(
        err.contains("spreadsheet") && err.contains("pdf") && err.contains("note"),
        "{err}"
    );
    // lines: a file line, a PDF page, a drawing's text (no place to go to)
    assert_eq!(
        t.ok(&["search:context", "query=needle kind:code"]),
        "tools/run.py:2:     return 'needle'\n"
    );
    assert_eq!(
        t.ok(&["search:context", "query=needle kind:pdf"]),
        "Papers/Report.pdf:p2: needle in the second sheet\n"
    );
    assert_eq!(
        t.ok(&["search:context", "query=lighthouse kind:drawing"]),
        "Drawings/Arch.excalidraw: beta lighthouse\n"
    );
    let json = t.ok(&["search:context", "query=needle kind:pdf", "format=json"]);
    assert!(
        json.contains("\"page\": 2") && !json.contains("\"line\""),
        "{json}"
    );
}

#[test]
fn properties_commands() {
    let t = T::new();
    assert_eq!(
        t.ok(&["properties"]),
        "- aliases\n- due\n- priority\n- status\n- tags\n"
    );
    assert_eq!(
        t.ok(&["properties", "counts", "sort=count"]),
        "priority: 2\nstatus: 2\ntags: 2\naliases: 1\ndue: 1\n"
    );
    assert_eq!(
        t.ok(&["properties", "format=tsv", "counts", "name=status"]),
        "status\t2\n"
    );
    assert_eq!(t.ok(&["properties", "total"]), "5\n");
    let j: serde_json::Value =
        serde_json::from_str(&t.ok(&["properties", "format=json", "counts"])).unwrap();
    assert_eq!(j[3], serde_json::json!({"name": "status", "count": 2}));
    // one file
    assert_eq!(
        t.ok(&["properties", "file=Alpha"]),
        "status: active\npriority: 2\ndue: 2024-03-01\naliases:\n  - Al\ntags:\n  - project\n"
    );
    assert_eq!(
        t.ok(&["properties", "file=Beta", "format=json"]),
        "{\n  \"status\": \"done\",\n  \"priority\": 1\n}\n"
    );
    assert_eq!(
        t.ok(&["properties", "file=Beta", "format=tsv"]),
        "status\tdone\npriority\t1\n"
    );
    assert_eq!(t.code(&["properties", "file=Beta", "counts"]).0, 2);
}

#[test]
fn properties_types_flag_shows_relationships() {
    let t = T::new();
    t.write(
        "People/Ann.md",
        "---\nmanager: \"[[Home]]\"\nteam:\n  - \"[[Home]]\"\n  - \"[[Beta|B]]\"\n---\n",
    );
    t.write(
        "People/Bob.md",
        "---\nmanager: \"[[Ann]]\"\nteam: []\n---\n",
    );
    let out = t.ok(&["properties", "types", "format=tsv"]);
    assert!(out.contains("manager\trelationships\n"), "{out}");
    assert!(out.contains("team\trelationships\n"), "{out}");
    assert!(
        out.contains("status\ttext\n") && out.contains("priority\tnumber\n"),
        "{out}"
    );
    assert!(out.contains("tags\ttags\n"), "{out}");
    let j: serde_json::Value =
        serde_json::from_str(&t.ok(&["properties", "types", "counts", "name=team", "format=json"]))
            .unwrap();
    assert_eq!(
        j[0],
        serde_json::json!({"name": "team", "count": 2, "type": "relationships"})
    );
    // without the flag nothing changes
    assert!(!t.ok(&["properties"]).contains("relationships"));
}

#[test]
fn property_set_read_remove_round_trips() {
    let t = T::new();
    let original = t.read("Projects/Beta.md");
    assert_eq!(
        t.ok(&["property:set", "file=Beta", "name=status", "value=review"]),
        "Set status in Projects/Beta.md\n"
    );
    assert_eq!(
        t.read("Projects/Beta.md"),
        original.replace("status: done", "status: review")
    );
    assert_eq!(
        t.ok(&["property:read", "file=Beta", "name=status"]),
        "review\n"
    );
    // type= and keeping the existing type
    t.ok(&["property:set", "file=Beta", "name=priority", "value=5"]);
    assert!(t.read("Projects/Beta.md").contains("priority: 5\n"));
    assert_eq!(
        t.code(&["property:set", "file=Beta", "name=priority", "value=high"])
            .0,
        1
    );
    assert!(t.read("Projects/Beta.md").contains("priority: 5\n"));
    t.ok(&[
        "property:set",
        "file=Beta",
        "name=due",
        "value=2024-05-06",
        "type=date",
    ]);
    t.ok(&[
        "property:set",
        "file=Beta",
        "name=done",
        "value=true",
        "type=checkbox",
    ]);
    t.ok(&[
        "property:set",
        "file=Beta",
        "name=tags",
        "value=a, b",
        "type=list",
    ]);
    t.ok(&["property:set", "file=Beta", "name=note", "value=has: colon"]);
    let after = t.read("Projects/Beta.md");
    assert!(
        after.contains(
            "due: 2024-05-06\ndone: true\ntags:\n  - a\n  - b\nnote: \"has: colon\"\n---\n"
        ),
        "{after}"
    );
    assert_eq!(t.ok(&["property:read", "file=Beta", "name=tags"]), "a\nb\n");
    // list value keeps list type without type=
    t.ok(&["property:set", "file=Beta", "name=tags", "value=x,y,z"]);
    assert_eq!(
        t.ok(&["property:read", "file=Beta", "name=tags"]),
        "x\ny\nz\n"
    );
    for n in ["status", "priority", "due", "done", "tags", "note"] {
        t.ok(&["property:remove", "file=Beta", &format!("name={n}")]);
    }
    assert_eq!(
        t.read("Projects/Beta.md"),
        original.replace("status: done\npriority: 1\n", "")
    );
    assert_eq!(t.code(&["property:read", "file=Beta", "name=status"]).0, 1);
    assert_eq!(
        t.code(&["property:remove", "file=Beta", "name=status"]).0,
        1
    );
    // creates the frontmatter block when missing
    t.ok(&[
        "property:set",
        "path=Archive/Old.md",
        "name=reviewed",
        "value=yes",
    ]);
    assert_eq!(
        t.read("Archive/Old.md"),
        "---\nreviewed: \"yes\"\n---\nold [[Beta]]\n"
    );
    // non-markdown targets and unparsable frontmatter are refused, file untouched
    assert_eq!(
        t.code(&["property:set", "path=tasks.base", "name=a", "value=b"])
            .0,
        1
    );
    t.write("Broken.md", "---\nkey: [oops\n---\nbody\n");
    let (code, err) = t.code(&["property:set", "path=Broken.md", "name=a", "value=b"]);
    assert_eq!(code, 1);
    assert!(err.contains("cannot be parsed"), "{err}");
    assert_eq!(t.read("Broken.md"), "---\nkey: [oops\n---\nbody\n");
}

const SKILL: &str = "---\n# a skill\nname: demo\nmetadata:\n  author: ada # who\n  version: 1\n  flags:\n    beta: true\nlicense: MIT\n---\nbody\n";

#[test]
fn property_set_read_remove_reach_nested_keys_by_dotted_path() {
    let t = T::new();
    t.write("Skills/demo.md", SKILL);
    let set = |name: &str, value: &str| {
        t.ok(&[
            "property:set",
            "path=Skills/demo.md",
            &format!("name={name}"),
            &format!("value={value}"),
        ])
    };
    // one key changes, the type of the existing value is kept (a number stays a number)
    set("metadata.version", "2");
    assert_eq!(
        t.read("Skills/demo.md"),
        SKILL.replace("version: 1", "version: 2")
    );
    assert_eq!(
        t.ok(&[
            "property:read",
            "path=Skills/demo.md",
            "name=metadata.version"
        ]),
        "2\n"
    );
    assert_eq!(
        t.code(&[
            "property:set",
            "path=Skills/demo.md",
            "name=metadata.version",
            "value=two"
        ])
        .0,
        1,
        "a text value for a number is refused like at the top level"
    );
    // a level-2 key, a comment kept, a new key added at the end of its map
    set("metadata.flags.beta", "false");
    set("metadata.author", "grace");
    set("metadata.homepage", "x");
    let want = SKILL
        .replace("version: 1", "version: 2")
        .replace("beta: true", "beta: false")
        .replace("author: ada # who", "author: grace # who")
        .replace("license: MIT", "homepage: x\nlicense: MIT")
        .replace("homepage", "  homepage");
    assert_eq!(t.read("Skills/demo.md"), want);
    assert_eq!(
        t.ok(&[
            "property:read",
            "path=Skills/demo.md",
            "name=metadata.flags.beta"
        ]),
        "false\n"
    );
    // the whole map still reads as one value
    assert!(t
        .ok(&["property:read", "path=Skills/demo.md", "name=metadata"])
        .contains("\"homepage\":\"x\""));
    // remove: one key, then the rest of the file is as it was
    t.ok(&[
        "property:remove",
        "path=Skills/demo.md",
        "name=metadata.homepage",
    ]);
    t.ok(&[
        "property:remove",
        "path=Skills/demo.md",
        "name=metadata.flags.beta",
    ]);
    assert!(t.read("Skills/demo.md").contains("  flags: {}\n"));
    // a missing nested key and a too deep one are refused, the file untouched
    let before = t.read("Skills/demo.md");
    assert_eq!(
        t.code(&[
            "property:remove",
            "path=Skills/demo.md",
            "name=metadata.nope"
        ])
        .0,
        1
    );
    assert_eq!(
        t.code(&["property:read", "path=Skills/demo.md", "name=metadata.nope"])
            .0,
        1
    );
    assert_eq!(t.read("Skills/demo.md"), before);
}

#[test]
fn an_exact_dotted_property_name_wins_over_a_nested_key() {
    let t = T::new();
    let note = "---\nmetadata:\n  version: 1\nmetadata.version: top\n---\nbody\n";
    t.write("Skills/dots.md", note);
    assert_eq!(
        t.ok(&[
            "property:read",
            "path=Skills/dots.md",
            "name=metadata.version"
        ]),
        "top\n"
    );
    t.ok(&[
        "property:set",
        "path=Skills/dots.md",
        "name=metadata.version",
        "value=new",
    ]);
    assert_eq!(
        t.read("Skills/dots.md"),
        note.replace("version: top", "version: new")
    );
    t.ok(&[
        "property:remove",
        "path=Skills/dots.md",
        "name=metadata.version",
    ]);
    assert_eq!(
        t.read("Skills/dots.md"),
        "---\nmetadata:\n  version: 1\n---\nbody\n"
    );
    // a dotted name whose first part is not a map is an ordinary new property
    t.ok(&["property:set", "path=Skills/dots.md", "name=a.b", "value=1"]);
    assert!(t.read("Skills/dots.md").contains("a.b: \"1\"\n"));
}

#[test]
fn aliases_property_tags_and_tag() {
    let t = T::new();
    assert_eq!(
        t.ok(&["property:read", "file=Alpha", "name=aliases"]),
        "Al\n"
    );
    assert_eq!(t.code(&["property:read", "file=Beta", "name=aliases"]).0, 1);
    assert_eq!(t.ok(&["tags"]), "#index\n#project\n#work\n");
    assert_eq!(
        t.ok(&["tags", "counts"]),
        "#index\t1\n#project\t1\n#work\t1\n"
    );
    assert_eq!(
        t.ok(&["tags", "format=csv", "counts"]),
        "#index,1\n#project,1\n#work,1\n"
    );
    let j: serde_json::Value =
        serde_json::from_str(&t.ok(&["tags", "format=json", "counts"])).unwrap();
    assert_eq!(j[2], serde_json::json!({"tag": "#work", "count": 1}));
    assert_eq!(t.ok(&["tags", "total"]), "3\n");
    assert_eq!(t.ok(&["tags", "file=Alpha"]), "#project\n#work\n");
    assert_eq!(t.ok(&["tag", "name=#work"]), "#work\t1\n");
    assert_eq!(
        t.ok(&["tag", "name=work", "verbose"]),
        "#work\t1\nProjects/Alpha.md\n"
    );
    assert_eq!(t.ok(&["tag", "name=project", "total"]), "1\n");
}

#[test]
fn tasks_list_and_filter() {
    let t = T::new();
    assert_eq!(
        t.ok(&["tasks"]),
        "Home.md:6: [ ] top task\nProjects/Alpha.md:15: [x] done task\nProjects/Alpha.md:16: [/] partial\n"
    );
    assert_eq!(t.ok(&["tasks", "todo", "total"]), "2\n");
    assert_eq!(
        t.ok(&["tasks", "done"]),
        "Projects/Alpha.md:15: [x] done task\n"
    );
    assert_eq!(
        t.ok(&["tasks", "status=/"]),
        "Projects/Alpha.md:16: [/] partial\n"
    );
    assert_eq!(
        t.ok(&["tasks", "file=Alpha", "verbose"]),
        "Projects/Alpha.md\n  15: [x] done task\n  16: [/] partial\n"
    );
    assert_eq!(
        t.ok(&["tasks", "format=tsv", "done"]),
        "Projects/Alpha.md\t15\tx\tdone task\n"
    );
    let j: serde_json::Value =
        serde_json::from_str(&t.ok(&["tasks", "format=json", "todo"])).unwrap();
    assert_eq!(
        j[0],
        serde_json::json!({"path": "Home.md", "line": 6, "status": " ", "text": "top task"})
    );
    assert_eq!(t.code(&["tasks", "done", "todo"]).0, 2);
}

#[test]
fn task_add_done_edit_and_filtered_listing() {
    let t = T::new();
    // add: one line appended to the inbox, created on first use
    let out = t.ok(&[
        "task:add",
        "text=Pay rent",
        "due=2024-03-20",
        "priority=high",
    ]);
    assert_eq!(out, "Added Tasks.md:1\n");
    assert_eq!(
        t.read("Tasks.md"),
        "- [ ] Pay rent \u{1F4C5} 2024-03-20 \u{23EB}\n"
    );
    t.ok(&["task:add", "text=Call", "path=Inbox/More.md"]);
    assert_eq!(t.read("Inbox/More.md"), "- [ ] Call\n");
    assert_eq!(t.code(&["task:add", "text= ", "due=2024-03-20"]).0, 1);
    assert_eq!(t.code(&["task:add", "text=x", "due=2024-13-45"]).0, 1);
    // edit: only the named tokens change; clear removes one
    t.ok(&[
        "task:edit",
        "ref=Tasks.md:1",
        "due=2024-04-01",
        "recurrence=every week",
    ]);
    let line = t.read("Tasks.md");
    assert!(
        line.starts_with("- [ ] Pay rent")
            && line.contains("2024-04-01")
            && line.contains("every week"),
        "{line}"
    );
    assert!(
        line.contains('\u{23EB}') && !line.contains("2024-03-20"),
        "{line}"
    );
    t.ok(&["task:edit", "ref=Tasks.md:1", "clear=priority"]);
    assert!(!t.read("Tasks.md").contains('\u{23EB}'));
    assert_eq!(t.code(&["task:edit", "ref=Tasks.md:1"]).0, 2);
    // done: a recurring task writes its next occurrence above the completed line
    t.ok(&["task:done", "ref=Tasks.md:1"]);
    let text = t.read("Tasks.md");
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2, "{text}");
    assert!(
        lines[0].starts_with("- [ ] Pay rent") && lines[0].contains("2024-04-08"),
        "{text}"
    );
    assert!(
        lines[1].starts_with("- [x] Pay rent") && lines[1].contains('\u{2705}'),
        "{text}"
    );
    // status=: reopen a done task (the done date goes), a custom symbol, a name, an unknown one
    t.write(
        "S.md",
        "- [x] Done one \u{2705} 2024-03-01\n- [ ] Open one\n- [ ] Third\n",
    );
    t.ok(&["task:edit", "ref=S.md:1", "status=todo"]);
    assert_eq!(t.read("S.md").lines().next().unwrap(), "- [ ] Done one");
    t.ok(&["task:edit", "ref=S.md:2", "status=/"]);
    assert_eq!(t.read("S.md").lines().nth(1).unwrap(), "- [/] Open one");
    t.ok(&["task:edit", "ref=S.md:2", "status=cancelled"]);
    assert!(t
        .read("S.md")
        .lines()
        .nth(1)
        .unwrap()
        .starts_with("- [-] Open one"));
    t.ok(&["task:edit", "ref=S.md:3", "status=in-progress"]);
    assert_eq!(t.read("S.md").lines().nth(2).unwrap(), "- [/] Third");
    t.ok(&["task:edit", "ref=S.md:3", "status=x", "due=2024-05-01"]);
    assert!(t
        .read("S.md")
        .lines()
        .nth(2)
        .unwrap()
        .starts_with("- [x] Third"));
    let before = t.read("S.md");
    let (code, err) = t.code(&["task:edit", "ref=S.md:3", "status=nope"]);
    assert_eq!(code, 1);
    assert!(
        err.contains("valid:") && err.contains("done") && err.contains("in-progress"),
        "{err}"
    );
    assert_eq!(t.read("S.md"), before);
    // a stale or non-task line is refused and nothing is written
    let before = t.read("Tasks.md");
    assert_eq!(t.code(&["task:done", "ref=Tasks.md:99"]).0, 1);
    assert_eq!(t.read("Tasks.md"), before);
}

#[test]
fn tasks_filter_runs_a_bases_expression_over_task_rows() {
    let t = T::new();
    t.write(
        "Work.md",
        "- [ ] A \u{1F4C5} 2024-03-01\n- [ ] B \u{1F4C5} 2024-05-01\n- [x] C \u{1F4C5} 2024-03-02\n- [ ] D\n",
    );
    let o = t.ok(&[
        "tasks",
        "filter=!task.checked && task.due != null",
        "sort=task.due",
        "format=tsv",
    ]);
    let rows: Vec<&str> = o.lines().filter(|l| l.starts_with("Work.md")).collect();
    assert_eq!(rows.len(), 2, "{o}");
    assert!(rows[0].contains("A") && rows[1].contains("B"), "{o}");
    let o = t.ok(&["tasks", "filter=task.checked", "file=Work", "total"]);
    assert_eq!(o, "1\n");
    let o = t.ok(&[
        "tasks",
        "filter=!task.checked && task.due != null",
        "sort=task.due",
        "desc",
        "limit=1",
        "format=tsv",
    ]);
    assert!(o.contains("B") && !o.contains("\tA"), "{o}");
    assert_eq!(t.code(&["tasks", "filter=((("]).0, 2);
}

#[test]
fn graph_commands_cover_the_removed_link_listings() {
    let t = T::new();
    let paths = |args: &[&str]| -> Vec<String> {
        let v: serde_json::Value = serde_json::from_str(&t.ok(args)).unwrap();
        v.as_array()
            .unwrap()
            .iter()
            .map(|r| r["path"].as_str().unwrap().to_string())
            .collect()
    };
    // links file=Home: depth 1, direction out
    let hood: serde_json::Value = serde_json::from_str(&t.ok(&[
        "graph:neighbors",
        "file=Home",
        "direction=out",
        "depth=1",
        "format=json",
    ]))
    .unwrap();
    let mut out: Vec<&str> = hood["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|n| n["depth"] == 1)
        .map(|n| n["path"].as_str().unwrap())
        .collect();
    out.sort();
    assert_eq!(out, ["Projects/Alpha.md", "Projects/Beta.md"]);
    // backlinks file=Beta
    let mut sources: Vec<String> = serde_json::from_str::<Vec<serde_json::Value>>(&t.ok(&[
        "graph:backlinks",
        "file=Beta",
        "format=json",
    ]))
    .unwrap()
    .iter()
    .map(|b| b["source"].as_str().unwrap().to_string())
    .collect();
    sources.sort();
    assert_eq!(sources, ["Archive/Old.md", "Home.md", "Projects/Alpha.md"]);
    // unresolved
    let j: serde_json::Value =
        serde_json::from_str(&t.ok(&["graph:unresolved", "format=json"])).unwrap();
    assert_eq!(
        j,
        serde_json::json!([{"link": "missing note", "count": 1, "sources": ["Home.md"]}])
    );
    assert_eq!(
        t.ok(&["graph:unresolved", "format=tsv"]),
        "link\tcount\tsources\nmissing note\t1\tHome.md\n"
    );
    // orphans: no link at all by default; `incoming` is Obsidian's "nothing links to it"
    assert!(paths(&["graph:orphans", "format=json"]).is_empty());
    assert_eq!(
        paths(&["graph:orphans", "incoming", "format=json"]),
        ["Archive/Old.md", "Home.md"]
    );
    assert_eq!(
        paths(&["graph:orphans", "incoming", "limit=1", "format=json"]),
        ["Archive/Old.md"]
    );
    // deadends
    assert_eq!(
        paths(&["graph:deadends", "format=json"]),
        ["Projects/Beta.md"]
    );
    assert_eq!(t.ok(&["graph:deadends"]), "Projects/Beta.md\n");
}

#[test]
fn every_removed_command_exits_2_naming_its_replacement() {
    let t = T::new();
    for (name, replacement) in registry::REMOVED {
        if registry::find(name).is_some() {
            continue; // still registered in this tree (its feature removes it); the table then answers
        }
        let o = t.run(&[name, "file=Home"]);
        assert_eq!(o.code, 2, "{name}");
        assert_eq!(
            o.stderr,
            format!("writer: {name} was removed: use {replacement}\n"),
            "{name}"
        );
        assert_eq!(t.run(&["help", name]).code, 2, "{name}");
        // the first word of the replacement is a command that exists
        let first = replacement.split_whitespace().next().unwrap();
        assert!(registry::find(first).is_some(), "{name} -> {first}");
    }
    let o = t.run(&["backlinks", "file=Home"]);
    assert!(o.stderr.contains("use graph:backlinks"), "{}", o.stderr);
    // an unknown name stays a plain usage error
    let o = t.run(&["nonsense"]);
    assert_eq!(o.code, 2);
    assert!(!o.stderr.contains("removed"));
}

#[test]
fn help_lists_each_group_once_and_no_removed_command() {
    let t = T::new();
    let h = t.ok(&["help"]);
    let groups: Vec<&str> = h
        .lines()
        .filter(|l| l.ends_with(':') && !l.starts_with(' '))
        .collect();
    let mut unique = groups.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(groups.len(), unique.len(), "{groups:?}");
    let listed: Vec<&str> = h
        .lines()
        .filter(|l| l.starts_with("  "))
        .filter_map(|l| l.split_whitespace().next())
        .collect();
    for (name, _) in registry::REMOVED {
        // `excalidraw:connect` is the other lane's row; the contract test is on the name list
        assert!(
            !listed.contains(name) || *name == "excalidraw:connect",
            "{name}"
        );
    }
}

#[test]
fn move_name_renames_in_place_and_combines_with_to() {
    let t = T::new();
    assert_eq!(t.code(&["move", "file=Beta"]).0, 2);
    assert_eq!(
        t.code(&["move", "file=Beta", "to=Archive/B.md", "name=C"])
            .0,
        2
    );
    let out = t.ok(&["move", "file=Beta", "to=Archive", "name=Gamma"]);
    assert!(
        out.starts_with("Moved Projects/Beta.md -> Archive/Gamma.md"),
        "{out}"
    );
    assert!(t.exists("Archive/Gamma.md") && !t.exists("Projects/Beta.md"));
}

#[test]
fn outline_and_wordcount() {
    let t = T::new();
    assert_eq!(t.ok(&["outline", "file=Alpha"]), "Alpha\n  Plan\n  Notes\n");
    assert_eq!(
        t.ok(&["outline", "file=Alpha", "format=md"]),
        "# Alpha\n## Plan\n## Notes\n"
    );
    let j: serde_json::Value =
        serde_json::from_str(&t.ok(&["outline", "file=Alpha", "format=json"])).unwrap();
    assert_eq!(
        j[1],
        serde_json::json!({"level": 2, "text": "Plan", "line": 9})
    );
    assert_eq!(t.ok(&["outline", "file=Alpha", "total"]), "3\n");
    let w = t.ok(&["wordcount", "file=Beta"]);
    assert!(
        w.starts_with("words\t") && w.contains("\ncharacters\t"),
        "{w}"
    );
    let words: usize = t
        .ok(&["wordcount", "file=Beta", "words"])
        .trim()
        .parse()
        .unwrap();
    assert!(words >= 7);
    assert!(
        t.ok(&["wordcount", "file=Beta", "characters"])
            .trim()
            .parse::<usize>()
            .unwrap()
            > words
    );
    assert_eq!(t.code(&["wordcount", "path=tasks.base"]).0, 1);
}

impl T {
    /// What the app writes when the user flips a feature's switch (global `config`, data dir).
    fn switch(&self, id: &str, on: bool) {
        fs::write(
            self.data.path().join("config"),
            format!("features.{id}.enabled = {on}\n"),
        )
        .unwrap();
    }
}

#[test]
fn a_feature_that_is_off_answers_that_it_is_off_instead_of_running_its_commands() {
    let t = T::new();
    t.switch("bases", false);
    for line in [
        &["bases"][..],
        &["base:views", "file=tasks"],
        &["base:query", "file=tasks"],
        &["base:create", "file=tasks", "name=X"],
    ] {
        let o = t.run(line);
        assert_eq!(o.code, EXIT_FAIL, "{line:?}");
        assert!(o.stdout.is_empty(), "{line:?}: {}", o.stdout);
        assert!(
            o.stderr.contains("the bases feature is turned off")
                && o.stderr.contains("features.bases.enabled"),
            "{line:?}: {}",
            o.stderr
        );
    }
    assert!(!t.exists("X.md"), "nothing ran");
    // Usage errors and help still come first, core commands are untouched, and the command stays
    // documented.
    assert_eq!(t.code(&["bases", "bogus=1"]).0, EXIT_USAGE);
    assert!(t.ok(&["help", "base:query"]).contains("Run a base view"));
    assert!(t.ok(&["files"]).contains("tasks.base"));
    // switched on again: applies at once (the file is read each run)
    t.switch("bases", true);
    assert_eq!(t.ok(&["bases"]), "tasks.base\n");
}

#[test]
fn skills_sync_holds_the_skill_of_a_feature_that_is_off_and_leaves_what_is_installed() {
    let t = T::new();
    t.switch("bases", false);
    let out = t.ok(&["skills:sync"]);
    assert!(
        out.contains(".claude/skills/writer-bases\tskipped-feature-off"),
        "{out}"
    );
    assert!(
        out.contains(".agents/skills/writer-cli\tinstalled"),
        "core skills still install: {out}"
    );
    assert!(
        !t.exists(".claude/skills/writer-bases"),
        "nothing installed"
    );
    // already installed: left exactly as it is (even edited), never removed
    t.switch("bases", true);
    t.ok(&["skills:sync"]);
    assert!(t.exists(".claude/skills/writer-bases/SKILL.md"));
    let before = t.read(".claude/skills/writer-bases/SKILL.md");
    t.switch("bases", false);
    let out = t.ok(&["skills:sync"]);
    assert!(out.contains(".claude/skills/writer-bases\tskipped-feature-off"));
    assert_eq!(t.read(".claude/skills/writer-bases/SKILL.md"), before);
}

#[test]
fn bases_commands_and_golden_query_outputs() {
    let t = T::new();
    assert_eq!(t.ok(&["bases"]), "tasks.base\n");
    assert_eq!(t.ok(&["base:views", "file=tasks"]), "All\nActive\n");
    assert_eq!(t.ok(&["base:views", "path=tasks.base"]), "All\nActive\n");
    let json = t.ok(&["base:query", "file=tasks"]);
    assert_eq!(
        json,
        "[\n  {\n    \"file.name\": \"Alpha.md\",\n    \"status\": \"active\",\n    \"priority\": 2,\n    \"due\": \"2024-03-01\"\n  },\n  {\n    \"file.name\": \"Beta.md\",\n    \"status\": \"done\",\n    \"priority\": 1,\n    \"due\": null\n  }\n]\n"
    );
    assert_eq!(json, t.ok(&["base:query", "file=tasks", "format=json"]));
    assert_eq!(
        t.ok(&["base:query", "file=tasks", "format=csv"]),
        "file.name,status,Prio,due\nAlpha.md,active,2,2024-03-01\nBeta.md,done,1,\n"
    );
    assert_eq!(
        t.ok(&["base:query", "path=tasks.base", "format=tsv"]),
        "file.name\tstatus\tPrio\tdue\nAlpha.md\tactive\t2\t2024-03-01\nBeta.md\tdone\t1\t\n"
    );
    assert_eq!(
        t.ok(&["base:query", "file=tasks", "format=md"]),
        "| file.name | status | Prio | due |\n| --- | --- | --- | --- |\n| Alpha.md | active | 2 | 2024-03-01 |\n| Beta.md | done | 1 |  |\n"
    );
    assert_eq!(
        t.ok(&["base:query", "file=tasks", "format=paths"]),
        "Projects/Alpha.md\nProjects/Beta.md\n"
    );
    assert_eq!(
        t.ok(&["base:query", "file=tasks", "view=Active", "format=md"]),
        "| file.name | tags |\n| --- | --- |\n| Alpha.md | project |\n"
    );
    // explicit errors
    assert_eq!(t.code(&["base:query", "file=tasks", "view=Nope"]).0, 1);
    assert_eq!(t.code(&["base:query", "file=tasks", "format=yaml"]).0, 2);
    assert_eq!(t.code(&["base:query", "path=Home.md"]).0, 1);
    t.write(
        "bad.base",
        "filters: 'status =='\nviews:\n  - type: table\n    name: T\n",
    );
    let (code, err) = t.code(&["base:query", "path=bad.base"]);
    assert_eq!(code, 1);
    assert!(err.contains("status =="), "{err}");
}

#[test]
fn base_create_applies_the_view_filters() {
    let t = T::new();
    t.write(
        "Inbox.base",
        "filters:\n  and:\n    - file.inFolder(\"Projects\")\n    - status == \"planned\"\n    - file.hasTag(\"todo\")\nviews:\n  - type: table\n    name: T\n",
    );
    assert_eq!(
        t.ok(&[
            "base:create",
            "file=Inbox",
            "name=New item",
            "content=Body\\n",
            "open"
        ]),
        "Created Projects/New item.md\n"
    );
    assert_eq!(
        t.read("Projects/New item.md"),
        "---\nstatus: planned\ntags:\n  - todo\n---\nBody\n"
    );
    assert_eq!(
        t.ok(&["base:create", "file=Inbox"]),
        "Created Projects/Untitled.md\n"
    );
    assert_eq!(t.code(&["base:create", "file=Inbox", "name=New item"]).0, 1);
    assert_eq!(t.code(&["base:create", "file=Inbox", "view=Nope"]).0, 1);
}

#[test]
fn copy_pipes_output_to_the_clipboard_and_reports_a_missing_tool() {
    let t = T::new();
    let o = t.run(&["files", "folder=Projects", "--copy"]);
    assert_eq!(o.code, 0);
    assert_eq!(
        t.clip.borrow().as_deref(),
        Some("Projects/Alpha.md\nProjects/Beta.md\n")
    );
    assert_eq!(o.stdout, "Projects/Alpha.md\nProjects/Beta.md\n");
    let o = t.run_in(t.vault.path(), &["files", "--copy"], true);
    assert_eq!(o.code, 1);
    assert!(o.stderr.contains("clipboard tool"), "{}", o.stderr);
}

#[test]
fn apply_insert_pure_cases() {
    use super::cmd_notes::apply_insert;
    assert_eq!(apply_insert("", "a", None, true, false).unwrap(), "a\n");
    assert_eq!(apply_insert("x", "a", None, true, false).unwrap(), "x\na\n");
    assert_eq!(
        apply_insert("x\r\n", "a", None, true, false).unwrap(),
        "x\r\na\r\n"
    );
    assert_eq!(
        apply_insert("---\na: 1\n---\nbody", "t", None, false, false).unwrap(),
        "---\na: 1\n---\nt\nbody"
    );
    assert_eq!(
        apply_insert("# H\nx\n# I\ny\n", "n", Some("H"), true, false).unwrap(),
        "# H\nx\nn\n# I\ny\n"
    );
    assert_eq!(
        apply_insert("# H\n", "n", Some("H"), true, false).unwrap(),
        "# H\nn\n"
    );
    assert_eq!(
        apply_insert("# H", "n", Some("H"), false, false).unwrap(),
        "# H\nn\n"
    );
    assert_eq!(
        apply_insert("```\n# H\n```\n# H\nz\n", "n", Some("H"), true, false).unwrap(),
        "```\n# H\n```\n# H\nz\nn\n"
    );
}

#[test]
fn skills_sync_installs_checks_and_reports_conflicts() {
    let t = T::new();
    let out = t.ok(&["skills:sync", "check"]);
    assert!(
        out.contains(".agents/skills/writer-cli\tinstalled"),
        "{out}"
    );
    assert!(!t.exists(".agents"), "check must not write");
    let out = t.ok(&["skills:sync"]);
    assert!(
        out.contains(".claude/skills/writer-bases\tinstalled"),
        "{out}"
    );
    assert!(t.exists(".claude/skills/writer-search/SKILL.md"));
    assert!(t
        .read(".agents/skills/writer-cli/SKILL.md")
        .contains("writer-managed: true"));
    assert!(t
        .ok(&["skills:sync"])
        .lines()
        .all(|l| l.contains("\tup-to-date")));
    // A user's own skill of the same name is kept and reported on stderr.
    fs::remove_dir_all(t.vault.path().join(".claude/skills/writer-search")).unwrap();
    t.write(".claude/skills/writer-search/SKILL.md", "mine\n");
    let o = t.run(&["skills:sync"]);
    assert_eq!(o.code, EXIT_OK);
    assert!(o.stdout.contains("skipped-user-owned"), "{}", o.stdout);
    assert!(
        o.stderr.contains(".claude/skills/writer-search"),
        "{}",
        o.stderr
    );
    assert_eq!(t.read(".claude/skills/writer-search/SKILL.md"), "mine\n");
    assert_eq!(t.code(&["skills:sync", "bogus=1"]).0, EXIT_USAGE);
    assert!(t.exists(".obsidian/app.json"));
    assert_eq!(t.read(".obsidian/app.json"), "{}");
}

const LINKY: &str = "---\nrelated: \"[[Old Name]]\"\n---\n# Home\n[[Old Name]] [[Old Name|alias]] [[Old Name#H]] [[Old Name#^b]] [[docs/Old Name]] [[docs/Old Name.md#H|x]]\n[m](docs/Old%20Name.md) [n](<docs/Old Name.md#H>) [web](https://x.y/Old%20Name.md) [[Other]]\n`[[Old Name]]` code\n```\n[[Old Name]]\n```\n";

fn linky_vault() -> T {
    let t = T::new();
    t.write("docs/Old Name.md", "# Old\n## H\ntext ^b\n");
    t.write("Home2.md", LINKY);
    t.write("Other.md", "other\n");
    t.write(
        "views.base",
        "filters:\n  and:\n    - file.hasLink(link(\"Old Name\"))\n    - 'file.hasLink(file(\"docs/Old Name.md\"))'\nproperties:\n  note:\n    displayName: \"[[Old Name]]\"\nviews: []\n",
    );
    t
}

#[test]
fn rename_rewrites_every_link_form_keeping_style() {
    let t = linky_vault();
    let out = t.ok(&["move", "file=Old Name", "name=New"]);
    assert!(
        out.starts_with("Renamed docs/Old Name.md -> docs/New.md (updated "),
        "{out}"
    );
    assert!(t.exists("docs/New.md") && !t.exists("docs/Old Name.md"));
    assert_eq!(
        t.read("Home2.md"),
        "---\nrelated: \"[[New]]\"\n---\n# Home\n[[New]] [[New|alias]] [[New#H]] [[New#^b]] [[docs/New]] [[docs/New.md#H|x]]\n[m](docs/New.md) [n](<docs/New.md#H>) [web](https://x.y/Old%20Name.md) [[Other]]\n`[[Old Name]]` code\n```\n[[Old Name]]\n```\n"
    );
    let base = t.read("views.base");
    assert!(
        base.contains("link(\"New\")") && base.contains("file(\"docs/New.md\")"),
        "{base}"
    );
    assert!(base.contains("displayName: \"[[New]]\""), "{base}");
    // the index agrees: backlinks and unresolved are computed by name
    assert_eq!(t.linking_notes("file=New"), 1);
    assert_eq!(t.count(&["graph:unresolved"]), 1); // [[missing note]] only
                                                   // idempotent: the old name no longer exists
    assert_eq!(t.code(&["move", "file=Old Name", "name=New"]).0, 1);
}

#[test]
fn rename_dry_run_and_opt_out_write_nothing_to_links() {
    let t = linky_vault();
    let home = t.read("Home2.md");
    let out = t.ok(&["move", "file=Old Name", "name=New", "dry-run"]);
    assert!(
        out.starts_with("Would rename docs/Old Name.md -> docs/New.md (would update "),
        "{out}"
    );
    assert!(
        out.contains("  Home2.md (") && out.contains("  views.base ("),
        "{out}"
    );
    assert!(t.exists("docs/Old Name.md") && !t.exists("docs/New.md"));
    assert_eq!(t.read("Home2.md"), home);
    let json = t.ok(&[
        "move",
        "file=Old Name",
        "name=New",
        "dry-run",
        "format=json",
    ]);
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["dryRun"], true);
    assert_eq!(v["to"], "docs/New.md");
    assert!(v["links"].as_u64().unwrap() >= 10);
    // opt out: file moves, links stay
    t.ok(&["move", "file=Old Name", "name=New", "no-update-links"]);
    assert!(t.exists("docs/New.md"));
    assert_eq!(t.read("Home2.md"), home);
}

#[test]
fn rename_validates_names_and_never_overwrites() {
    let t = linky_vault();
    for bad in [
        "a/b", "a\\b", "x:y", "x?", "..", ".hidden", "a#b", "a^b", "a[b", "CON", "x.", "",
        "a\u{7}b",
    ] {
        let arg = format!("name={bad}");
        let (code, err) = t.code(&["move", "file=Old Name", &arg]);
        assert!(code == 1 || code == 2, "{bad:?} accepted: {err}");
    }
    t.write("docs/Sibling.md", "s\n");
    assert_eq!(t.code(&["move", "file=Old Name", "name=Sibling"]).0, 1);
    assert!(t.exists("docs/Old Name.md") && t.exists("docs/Sibling.md"));
    // a same-name file in another folder is not a collision
    t.write("elsewhere/Other.md", "x\n");
    t.ok(&["move", "file=Old Name", "name=Other"]);
    assert!(t.exists("docs/Other.md"));
    // the folder name stays; `.obsidian` is never a target
    assert_eq!(t.code(&["move", "file=Other", "to=.obsidian"]).0, 1);
}

#[test]
fn rename_attachments_notes_with_path_and_extension_rules() {
    let t = T::new();
    t.write("img/pic one.png", "png");
    t.write(
        "A.md",
        "![[pic one.png]] ![[img/pic one.png|200]] ![p](img/pic%20one.png) [[pic one]]\n",
    );
    t.ok(&["move", "path=img/pic one.png", "name=photo"]);
    assert!(t.exists("img/photo.png"));
    assert_eq!(
        t.read("A.md"),
        "![[photo.png]] ![[img/photo.png|200]] ![p](img/photo.png) [[pic one]]\n"
    );
    // explicit extension is accepted when it matches, appended otherwise
    t.ok(&["move", "path=img/photo.png", "name=shot.png"]);
    assert!(t.exists("img/shot.png"));
    t.ok(&["move", "path=Archive/Old.md", "name=v1.2"]);
    assert!(t.exists("Archive/v1.2.md"));
    assert_eq!(t.read("Projects/Beta.md").len() > 0, true);
}

#[test]
fn rename_case_only_goes_through_a_temporary_name() {
    let t = T::new();
    t.write("Notes/gamma.md", "# g\n");
    t.write("L.md", "[[gamma]] [[Notes/gamma]]\n");
    let out = t.ok(&["move", "path=Notes/gamma.md", "name=Gamma"]);
    assert!(
        out.starts_with("Renamed Notes/gamma.md -> Notes/Gamma.md"),
        "{out}"
    );
    let names: Vec<String> = fs::read_dir(t.vault.path().join("Notes"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["Gamma.md".to_string()]);
    assert_eq!(t.read("L.md"), "[[Gamma]] [[Notes/Gamma]]\n");
}

#[test]
fn rename_with_duplicate_names_keeps_links_unambiguous() {
    let t = T::new();
    t.write("a/Twin.md", "a\n");
    t.write("b/Other.md", "b\n");
    t.write("S.md", "[[a/Twin]] [[Twin]]\n");
    // renaming a/Twin to Other creates a second `Other`: bare links to it fall back to the path
    t.ok(&["move", "path=a/Twin.md", "name=Other"]);
    let s = t.read("S.md");
    assert!(s.starts_with("[[a/Other]] "), "{s}");
    assert!(
        s.contains("[[a/Other]]\n") || s.ends_with("[[Other]]\n"),
        "{s}"
    );
    assert_eq!(t.linking_notes("path=a/Other.md"), 1);
}

#[test]
fn move_dry_run_and_rename_unresolved_target() {
    let t = T::new();
    assert_eq!(t.code(&["move", "file=does not exist", "name=x"]).0, 1);
    assert_eq!(t.code(&["move", "name=x"]).0, 2);
    let out = t.ok(&["move", "file=Beta", "to=Archive", "dry-run"]);
    assert!(
        out.starts_with("Would move Projects/Beta.md -> Archive/Beta.md"),
        "{out}"
    );
    assert!(t.exists("Projects/Beta.md"));
}

#[test]
fn title_sets_clears_and_rewrites_alias_links_without_renaming() {
    let t = T::new();
    t.write("Spec.md", "---\ntitle: Old\n---\n# Heading\n");
    t.write("Ref.md", "[[Spec|Old]] [[Spec|Other]] [[Spec]]\n");
    // show: the override, then the file name when none
    assert_eq!(t.ok(&["title", "file=Spec"]), "Old\n");
    assert_eq!(t.ok(&["title", "file=Beta"]), "Beta\n");
    // dry run writes nothing
    let out = t.ok(&["title", "file=Spec", "set=New", "dry-run"]);
    assert!(
        out.starts_with("Would set title of Spec.md to \"New\" (would update 1 link in 1 file"),
        "{out}"
    );
    assert!(out.contains("  Ref.md (1 link)"), "{out}");
    assert!(t.read("Spec.md").contains("title: Old"));
    let json = t.ok(&["title", "file=Spec", "set=New", "dry-run", "format=json"]);
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(
        (v["old"].as_str(), v["new"].as_str(), v["links"].as_u64()),
        (Some("Old"), Some("New"), Some(1))
    );
    // apply
    t.ok(&["title", "file=Spec", "set=New"]);
    assert_eq!(t.read("Ref.md"), "[[Spec|New]] [[Spec|Other]] [[Spec]]\n");
    assert_eq!(t.read("Spec.md"), "---\ntitle: New\n---\n# Heading\n");
    assert!(t.exists("Spec.md"));
    // opt out of link updates, then clear (drops the alias)
    t.ok(&["title", "file=Spec", "set=Third", "no-update-links"]);
    assert_eq!(t.read("Ref.md"), "[[Spec|New]] [[Spec|Other]] [[Spec]]\n");
    t.ok(&["title", "file=Spec", "set=New", "no-update-links"]);
    t.ok(&["title", "file=Spec", "clear"]);
    assert_eq!(t.read("Ref.md"), "[[Spec]] [[Spec|Other]] [[Spec]]\n");
    assert!(!t.read("Spec.md").contains("title"));
    // usage
    assert_eq!(t.code(&["title", "file=Spec", "set=x", "clear"]).0, 2);
    assert_eq!(t.code(&["title", "file=Spec", "set="]).0, 2);
}

#[test]
fn search_finds_a_note_by_its_title_override_and_prints_only_paths() {
    let t = T::new();
    t.write(
        "Spec.md",
        "---\ntitle: Zephyrine Quartz\n---\n# Heading\nbody\n",
    );
    // the override word is nowhere else in the note; output stays a plain path list
    assert_eq!(t.ok(&["search", "query=Zephyrine"]), "Spec.md\n");
    assert_eq!(
        t.ok(&["search", "query=Zephyrine", "format=json"]).trim(),
        "[\n  \"Spec.md\"\n]"
    );
    // clearing the override removes it from search too
    t.ok(&["title", "file=Spec", "clear"]);
    assert_eq!(t.ok(&["search", "query=Zephyrine"]), "");
}

#[test]
fn nested_tags_match_ancestors_in_tag_and_search() {
    let t = T::new();
    for (rel, body) in crate::index::NESTED_TAG_NOTES {
        t.write(rel, body);
    }
    assert_eq!(t.ok(&["tag", "name=research", "total"]), "3\n");
    assert_eq!(t.ok(&["tag", "name=#research/hlo", "total"]), "2\n");
    assert_eq!(t.ok(&["tag", "name=research/hlo/docs", "total"]), "1\n");
    assert_eq!(t.ok(&["tag", "name=researcher", "total"]), "1\n");
    assert_eq!(t.ok(&["tag", "name=research/h", "total"]), "0\n");
    assert_eq!(
        t.ok(&["search", "query=tag:research nested", "total"]),
        "3\n"
    );
    assert_eq!(t.ok(&["search", "query=tag:res nested", "total"]), "0\n");
}

// ------------------------------------------------------------------------ project archive

fn make_project(t: &T, rel: &str) {
    t.write(
        &format!("{rel}/project.md"),
        "---\ncopilot-project-id: p1\ncopilot-project-name: Demo\n---\nbody\n",
    );
    t.write(&format!("{rel}/.chats/c.md"), "chat");
}

#[test]
fn project_archive_and_unarchive_round_trip_through_the_one_function() {
    let t = T::new();
    make_project(&t, "Work/Demo");
    assert_eq!(
        t.ok(&["project:archive", "path=Work/Demo"]),
        "Archived Work/Demo -> Archive/Projects/Demo\n"
    );
    assert!(!t.exists("Work/Demo"));
    assert!(t.exists("Archive/Projects/Demo/.chats/c.md"));
    let md = t.read("Archive/Projects/Demo/project.md");
    assert!(md.contains("copilot-project-archived-at:"), "{md}");
    assert!(
        md.contains("writer-project-archived-from: Work/Demo"),
        "{md}"
    );
    // the app's function gives the same state for the same folder
    let listed =
        crate::agent::project::list(&t.vault.path().canonicalize().unwrap(), true).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].info.path, "Archive/Projects/Demo");
    assert!(listed[0].info.archived_at.is_some());

    assert_eq!(
        t.ok(&["project:unarchive", "path=Archive/Projects/Demo"]),
        "Unarchived Archive/Projects/Demo -> Work/Demo\n"
    );
    assert!(t.exists("Work/Demo/.chats/c.md") && !t.exists("Archive/Projects/Demo"));
    assert!(!t.read("Work/Demo/project.md").contains("archived"));
}

#[test]
fn project_archive_honours_the_global_setting_and_refuses_bad_input() {
    let t = T::new();
    make_project(&t, "Work/Demo");
    fs::write(
        t.data.path().join("config"),
        "agent.projects-archive-folder = Old/Stuff\n",
    )
    .unwrap();
    assert_eq!(
        t.ok(&["project:archive", "path=Work/Demo"]),
        "Archived Work/Demo -> Old/Stuff/Demo\n"
    );
    // a folder outside the vault, a missing project, a plain folder and a missing path
    fs::write(
        t.data.path().join("config"),
        "agent.projects-archive-folder = ../out\n",
    )
    .unwrap();
    make_project(&t, "Work/Other");
    assert_eq!(t.code(&["project:archive", "path=Work/Other"]).0, EXIT_FAIL);
    assert!(t.exists("Work/Other/project.md"));
    assert_eq!(t.code(&["project:archive", "path=Nope"]).0, EXIT_FAIL);
    assert_eq!(t.code(&["project:archive", "path=Projects"]).0, EXIT_FAIL);
    assert_eq!(t.code(&["project:archive"]).0, EXIT_USAGE);
    assert_eq!(t.code(&["project:archive", "path=.obsidian"]).0, EXIT_FAIL);
}

#[test]
fn project_commands_follow_the_agent_feature_switch() {
    let t = T::new();
    make_project(&t, "Work/Demo");
    t.switch("agent", false);
    let o = t.run(&["project:archive", "path=Work/Demo"]);
    assert_eq!(o.code, EXIT_FAIL);
    assert!(
        o.stderr.contains("the agent feature is turned off"),
        "{}",
        o.stderr
    );
    assert!(t.exists("Work/Demo/project.md"));
}

#[test]
fn icon_commands_set_get_and_remove_through_the_one_store() {
    let t = T::new();
    assert_eq!(
        t.code(&["icon:get", "path=Home.md"]).0,
        EXIT_FAIL,
        "no icon yet"
    );
    assert!(t
        .ok(&["icon:set", "path=Projects", "icon=emoji:📁"])
        .contains("Set emoji:📁 on Projects"));
    // a bare name, a note by file name, and a colour
    t.ok(&[
        "icon:set",
        "file=Beta",
        "icon=Rocket01Icon",
        "color=#ff8800",
    ]);
    assert_eq!(t.ok(&["icon:get", "path=Projects"]), "emoji:📁\n");
    assert_eq!(
        t.ok(&["icon:get", "path=Projects/Beta.md"]),
        "icon:Rocket01Icon\n"
    );
    let json = t.ok(&["icon:get", "path=Projects/Beta.md", "format=json"]);
    assert!(
        json.contains("\"source\": \"writer\"") && json.contains("#ff8800"),
        "{json}"
    );
    assert!(t
        .read(".writer/icons.json")
        .contains("\"Projects/Beta.md\""));
    t.ok(&["icon:remove", "path=Projects"]);
    assert_eq!(t.code(&["icon:get", "path=Projects"]).0, EXIT_FAIL);
}

#[test]
fn icon_commands_refuse_bad_input_and_never_touch_obsidian() {
    let t = T::new();
    assert_eq!(
        t.code(&["icon:set", "path=Home.md", "icon=smile"]).0,
        EXIT_FAIL
    );
    assert_eq!(
        t.code(&["icon:set", "path=Home.md", "icon=🚀", "color=red"])
            .0,
        EXIT_FAIL
    );
    assert_eq!(
        t.code(&["icon:set", "path=Nope.md", "icon=🚀"]).0,
        EXIT_FAIL
    );
    assert_eq!(t.code(&["icon:set", "path=Home.md"]).0, EXIT_USAGE);
    assert_eq!(
        t.code(&["icon:set", "path=.obsidian", "icon=🚀"]).0,
        EXIT_FAIL
    );
    assert_eq!(t.code(&["icon:set", "path=../x", "icon=🚀"]).0, EXIT_FAIL);
    assert!(!t.exists(".writer/icons.json"), "nothing was written");
}

#[test]
fn an_iconize_icon_shows_through_icon_get_and_is_hidden_by_remove() {
    let t = T::new();
    let data = ".obsidian/plugins/obsidian-icon-folder/data.json";
    t.write(data, r#"{"settings":{},"Home.md":"🏠"}"#);
    let before = t.read(data);
    assert_eq!(t.ok(&["icon:get", "path=Home.md"]), "emoji:🏠\n");
    assert!(t
        .ok(&["icon:get", "path=Home.md", "format=json"])
        .contains("\"source\": \"iconize\""));
    t.ok(&["icon:remove", "path=Home.md"]);
    assert_eq!(
        t.code(&["icon:get", "path=Home.md"]).0,
        EXIT_FAIL,
        "hidden, not revealed"
    );
    assert_eq!(t.read(data), before, "Iconize's file is never written");
}

#[test]
fn rename_and_delete_keep_the_icons_in_step() {
    let _on = crate::icons::TEST_SWITCH.lock();
    crate::icons::set_enabled(true);
    let t = T::new();
    t.ok(&["icon:set", "path=Projects/Beta.md", "icon=🎯"]);
    t.ok(&["move", "path=Projects/Beta.md", "name=Gamma"]);
    assert_eq!(t.ok(&["icon:get", "path=Projects/Gamma.md"]), "emoji:🎯\n");
    assert_eq!(t.code(&["icon:get", "path=Projects/Beta.md"]).0, EXIT_FAIL);
    t.ok(&["delete", "path=Projects/Gamma.md", "permanent"]);
    assert!(!t.read(".writer/icons.json").contains("Gamma"));
}

#[test]
fn icon_commands_follow_the_icons_feature_switch() {
    let t = T::new();
    t.switch("icons", false);
    for line in [
        &["icon:set", "path=Home.md", "icon=🚀"][..],
        &["icon:get", "path=Home.md"],
        &["icon:remove", "path=Home.md"],
    ] {
        let o = t.run(line);
        assert_eq!(o.code, EXIT_FAIL, "{line:?}");
        assert!(
            o.stderr.contains("the icons feature is turned off"),
            "{line:?}: {}",
            o.stderr
        );
    }
    assert!(!t.exists(".writer/icons.json"), "nothing was written");
}
