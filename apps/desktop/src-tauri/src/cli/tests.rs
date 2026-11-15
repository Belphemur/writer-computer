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
    for c in ["base:query", "property:set", "backlinks", "wordcount"] {
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
    let out = t.ok(&["rename", "file=Beta", "name=Gamma"]);
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
    assert_eq!(t.ok(&["backlinks", "file=Gamma", "total"]), "3\n");
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
    assert_eq!(t.code(&["rename", "file=Alpha", "name=a/b"]).0, 2);
    assert_eq!(t.code(&["rename", "file=Alpha", "name=Alpha"]).0, 1);
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
        "Archive/Old.md\n"
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

#[test]
fn aliases_tags_and_tag() {
    let t = T::new();
    assert_eq!(t.ok(&["aliases"]), "Al\n");
    assert_eq!(t.ok(&["aliases", "verbose"]), "Projects/Alpha.md\tAl\n");
    assert_eq!(t.ok(&["aliases", "file=Beta", "total"]), "0\n");
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
fn tasks_and_task() {
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
    // task: show and change exactly one character
    assert_eq!(t.ok(&["task", "file=Alpha", "line=15"]), "[x]\n");
    let before = t.read("Projects/Alpha.md");
    assert_eq!(t.ok(&["task", "file=Alpha", "line=15", "toggle"]), "[ ]\n");
    assert_eq!(
        t.read("Projects/Alpha.md"),
        before.replace("- [x] done task", "- [ ] done task")
    );
    assert_eq!(t.ok(&["task", "ref=Projects/Alpha.md:15", "done"]), "[x]\n");
    assert_eq!(t.read("Projects/Alpha.md"), before);
    assert_eq!(
        t.ok(&["task", "file=Alpha", "line=16", "status=-"]),
        "[-]\n"
    );
    assert!(t.read("Projects/Alpha.md").contains("- [-] partial"));
    assert_eq!(t.ok(&["task", "path=Home.md", "line=6", "todo"]), "[ ]\n");
    assert_eq!(t.code(&["task", "file=Alpha", "line=1", "toggle"]).0, 1);
    assert_eq!(t.code(&["task", "file=Alpha", "line=999", "toggle"]).0, 1);
    assert_eq!(
        t.code(&["task", "file=Alpha", "line=15", "toggle", "done"])
            .0,
        2
    );
    assert_eq!(t.code(&["task", "file=Alpha", "line=15", "status=ab"]).0, 2);
}

#[test]
fn links_backlinks_unresolved_orphans_deadends() {
    let t = T::new();
    assert_eq!(
        t.ok(&["links", "file=Home"]),
        "Projects/Alpha.md\nProjects/Beta.md\nmissing note\n"
    );
    assert_eq!(t.ok(&["links", "file=Home", "total"]), "3\n");
    assert_eq!(
        t.ok(&["backlinks", "file=Beta"]),
        "Archive/Old.md\nHome.md\nProjects/Alpha.md\n"
    );
    assert_eq!(
        t.ok(&["backlinks", "file=Beta", "counts", "format=csv"]),
        "Archive/Old.md,1\nHome.md,1\nProjects/Alpha.md,1\n"
    );
    let j: serde_json::Value =
        serde_json::from_str(&t.ok(&["backlinks", "file=Alpha", "format=json"])).unwrap();
    assert_eq!(j, serde_json::json!([{"path": "Home.md"}]));
    assert_eq!(t.ok(&["unresolved"]), "missing note\n");
    assert_eq!(
        t.ok(&["unresolved", "counts", "verbose"]),
        "missing note\t1\tHome.md\n"
    );
    assert_eq!(t.ok(&["unresolved", "total"]), "1\n");
    assert_eq!(t.ok(&["orphans"]), "Archive/Old.md\nHome.md\n");
    assert_eq!(t.ok(&["deadends"]), "Projects/Beta.md\n");
    assert_eq!(t.ok(&["orphans", "total"]), "2\n");
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
