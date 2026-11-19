//! `rows: tasks` bases over the index (SPECs/tasks-spec.md 5): task properties, filters, sorts,
//! groups, urgency, nesting, custom statuses, pushdown equal to a full scan, file bases untouched.

use super::bases_source::{run_base_view, IndexSource};
use super::Index;
use crate::bases::context::FixedClock;
use crate::bases::document::Document;
use crate::bases::query::{run_view, BaseQueryResult, QueryOptions};
use std::sync::Arc;
use tempfile::TempDir;

struct Vault {
    _vault: TempDir,
    _data: TempDir,
    index: Arc<Index>,
}

fn vault(files: &[(&str, &str)]) -> Vault {
    let v = TempDir::new().unwrap();
    for (rel, text) in files {
        let p = v.path().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    let data = TempDir::new().unwrap();
    let index = Arc::new(Index::open_for_cli(v.path(), Some(data.path())).unwrap());
    Vault {
        _vault: v,
        _data: data,
        index,
    }
}

const PLAN: &str = "---\nstatus: active\n---\n# Plan\n- [ ] Draft outline 📅 2024-03-15 ⏫ #work\n  - [ ] Sub task 📅 2024-03-20\n- [x] Ship ✅ 2024-03-10\n## Later\n- [/] Review 🛫 2024-03-20 🔁 every week\n";
const INBOX: &str = "- [ ] Buy milk  [due:: 2024-03-14]\n- [-] Dropped\n- plain item\n";

fn fixture() -> Vault {
    vault(&[("Projects/Plan.md", PLAN), ("Inbox.md", INBOX)])
}

fn clock() -> FixedClock {
    FixedClock::at("2024-03-15T10:30:00")
}

fn run(v: &Vault, base: &str, narrow: bool) -> BaseQueryResult {
    let doc = Document::parse(base).unwrap();
    let source = IndexSource::new(Arc::clone(&v.index), 0, None)
        .unwrap()
        .with_pushdown(narrow)
        .with_today(crate::tasks::date::Day::parse("2024-03-15").unwrap());
    let r = run_view(&doc, None, &source, &clock(), &QueryOptions::default());
    assert_eq!(source.take_error(), None);
    r
}

/// The display strings of the rows, one string per row: columns joined by ` | `.
fn table(r: &BaseQueryResult) -> Vec<String> {
    assert_eq!(r.error, None);
    r.rows
        .iter()
        .map(|row| {
            row.cells
                .iter()
                .map(|c| c.display.clone())
                .collect::<Vec<_>>()
                .join(" | ")
        })
        .collect()
}

fn base(rest: &str) -> String {
    format!("rows: tasks\n{rest}")
}

fn view(order: &[&str], extra: &str) -> String {
    let order = order
        .iter()
        .map(|o| format!("      - {o}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!("views:\n  - type: table\n    name: T\n    order:\n{order}\n{extra}")
}

#[test]
fn every_task_is_a_row_with_its_properties_and_line() {
    let v = fixture();
    let doc = base(&view(
        &[
            "file.name",
            "task.description",
            "task.status",
            "task.due",
            "task.priority",
            "task.line",
        ],
        "",
    ));
    let r = run(&v, &doc, true);
    assert_eq!(
        table(&r),
        [
            "Inbox.md | Buy milk | TODO | 2024-03-14 |  | 1",
            "Inbox.md | Dropped | CANCELLED |  |  | 2",
            "Plan.md | Draft outline #work | TODO | 2024-03-15 | high | 5",
            "Plan.md | Sub task | TODO | 2024-03-20 |  | 6",
            "Plan.md | Ship | DONE |  |  | 7",
            "Plan.md | Review | IN_PROGRESS |  |  | 9",
        ]
    );
    assert_eq!(
        r.rows.iter().map(|x| x.line).collect::<Vec<_>>(),
        [Some(1), Some(2), Some(5), Some(6), Some(7), Some(9)]
    );
    assert_eq!(r.rows[2].path, "Projects/Plan.md");
}

#[test]
fn filters_sorts_groups_and_the_files_properties_work_on_tasks() {
    let v = fixture();
    // open tasks due before today, with a property of the file
    let overdue = base(&format!(
        "filters:\n  and:\n    - task.due < today()\n    - '!task.checked'\n{}",
        view(&["task.description", "note.status"], "")
    ));
    assert_eq!(table(&run(&v, &overdue, true)), ["Buy milk | "]);
    // the file's note properties and tags are the file's
    let in_active = base(&format!(
        "filters:\n  and:\n    - status == \"active\"\n    - 'task.status == \"TODO\"'\n{}",
        view(&["task.description", "file.name"], "")
    ));
    assert_eq!(
        table(&run(&v, &in_active, true)),
        ["Draft outline #work | Plan.md", "Sub task | Plan.md"]
    );
    // sort and group on task properties
    let grouped = base(&view(
        &["task.description"],
        "    groupBy:\n      property: task.heading\n      direction: ASC\n    sort:\n      - property: task.description\n        direction: DESC\n",
    ));
    let r = run(&v, &grouped, true);
    let groups = r.groups.as_ref().unwrap();
    assert_eq!(groups.len(), 3);
    let keys: Vec<_> = groups.iter().map(|g| g.key.display.clone()).collect();
    assert_eq!(keys, ["", "Later", "Plan"]);
    // tags are the task's own
    let tagged = base(&format!(
        "filters:\n  and:\n    - 'task.tags.contains(\"work\")'\n{}",
        view(&["task.description"], "")
    ));
    assert_eq!(table(&run(&v, &tagged, true)), ["Draft outline #work"]);
}

#[test]
fn urgency_orders_tasks_like_the_plugin() {
    let v = fixture();
    let b = base(&view(
        &["task.description", "task.urgency"],
        "    sort:\n      - property: task.urgency\n        direction: DESC\n    limit: 2\n",
    ));
    let r = run(&v, &b, true);
    // due today with high priority outranks a task due yesterday
    assert_eq!(r.rows[0].cells[0].display, "Draft outline #work");
    assert_eq!(r.rows[1].cells[0].display, "Buy milk");
    assert_eq!(r.total_matched, 6);
}

#[test]
fn nesting_is_known() {
    let v = fixture();
    let b = base(&format!(
        "filters:\n  and:\n    - 'task.parent != null'\n{}",
        view(&["task.description", "task.parent", "task.indent"], "")
    ));
    assert_eq!(table(&run(&v, &b, true)), ["Sub task | 5 | 2"]);
    let items: i64 = v
        .index
        .read(|c| Ok(c.query_row("SELECT COUNT(*) FROM list_items", [], |r| r.get(0))?))
        .unwrap();
    // 4 tasks of Plan, 2 of Inbox and its plain item: every list item is stored
    assert_eq!(items, 7);
}

#[test]
fn pushdown_equals_a_full_scan() {
    let v = fixture();
    for filters in [
        "",
        "filters:\n  and:\n    - file.inFolder(\"Projects\")\n",
        "filters:\n  and:\n    - status == \"active\"\n    - '!task.checked'\n",
        "filters:\n  or:\n    - 'task.priority == \"high\"'\n    - task.due < today()\n",
    ] {
        let b = base(&format!("{filters}{}", view(&["task.description"], "")));
        assert_eq!(run(&v, &b, true), run(&v, &b, false), "{filters}");
    }
}

#[test]
fn custom_statuses_decide_the_type() {
    let v = vault(&[
        ("a.md", "- [h] waiting\n- [ ] open\n- [x] closed\n"),
        (
            ".writer/task-statuses.json",
            r#"{"statuses":[{"symbol":"h","name":"Hold","next":" ","type":"ON_HOLD"}]}"#,
        ),
    ]);
    let b = base(&view(
        &["task.description", "task.status", "task.checked"],
        "",
    ));
    assert_eq!(
        table(&run(&v, &b, true)),
        [
            "waiting | ON_HOLD | false",
            "open | TODO | false",
            "closed | DONE | true"
        ]
    );
}

#[test]
fn file_bases_are_untouched_and_task_properties_are_empty_there() {
    let v = fixture();
    let b = view(&["file.name", "task.due"], "");
    let r = run(&v, &b, true);
    assert_eq!(r.rows.len(), 2); // the two notes
    assert!(r.rows.iter().all(|row| row.line.is_none()));
    assert!(table(&r).iter().all(|row| row.ends_with(" | ")));
    // the key survives a round trip
    let doc = Document::parse("rows: tasks\nviews: []\n").unwrap();
    assert!(doc.to_yaml().contains("rows: tasks"));
    assert!(!Document::parse("views: []\n")
        .unwrap()
        .to_yaml()
        .contains("rows"));
    let bad = Document::parse("rows: nonsense\n").unwrap();
    assert!(!bad.warnings.is_empty() && bad.to_yaml().contains("rows: nonsense"));
}

#[test]
fn run_base_view_takes_today_from_the_clock() {
    let v = fixture();
    let doc = Document::parse(&base(&view(&["task.description", "task.urgency"], ""))).unwrap();
    let a = run_base_view(&v.index, &doc, None, None, &clock()).unwrap();
    let later = FixedClock::at("2025-03-15T10:30:00");
    let b = run_base_view(&v.index, &doc, None, None, &later).unwrap();
    assert_ne!(table(&a), table(&b));
}

// ---------------------------------------------------------------------------
// ```tasks blocks lowered to bases (tasks::block), evaluated on the engine
// ---------------------------------------------------------------------------

mod blocks {
    use super::*;
    use crate::tasks::block::convert;

    const HOME: &str = "- [ ] A 📅 2024-03-10 🔺 #home\n- [ ] B 📅 2024-03-15 ⏳ 2024-03-14 🔽\n- [ ] C 📅 2024-03-20 🔼 🔁 every day\n- [x] D ✅ 2024-03-01\n- [ ] E #work #home\n";

    fn vault_with_blocks() -> Vault {
        vault(&[
            ("Home.md", HOME),
            ("Projects/Plan.md", PLAN),
            ("Inbox.md", INBOX),
        ])
    }

    /// Convert a block, run the resulting base, return the descriptions in order.
    fn descriptions(v: &Vault, block: &str) -> Vec<String> {
        let c = convert(block);
        assert!(c.unmapped.is_empty(), "{block}: {:?}", c.unmapped);
        let base = c.base.expect("a base");
        let doc = Document::parse(&base).unwrap_or_else(|e| panic!("{block}: {e:?}\n{base}"));
        assert!(doc.warnings.is_empty(), "{:?}", doc.warnings);
        let r = run(v, &base, true);
        assert_eq!(r.error, None, "{block}\n{base}");
        assert_eq!(run(v, &base, false), r, "pushdown differs for {block}");
        let col = r
            .columns
            .iter()
            .position(|c| c.id == "task.description")
            .unwrap();
        r.rows
            .iter()
            .map(|x| x.cells[col].display.clone())
            .collect()
    }

    #[test]
    fn instructions_become_filters_that_select_the_same_tasks() {
        let v = vault_with_blocks();
        let cases: &[(&str, &[&str])] = &[
            (
                "not done",
                &[
                    "A #home",
                    "B",
                    "Buy milk",
                    "C",
                    "Draft outline #work",
                    "E #work #home",
                    "Review",
                    "Sub task",
                ],
            ),
            ("done", &["D", "Dropped", "Ship"]),
            ("not done\ndue before today", &["A #home", "Buy milk"]),
            ("due today", &["B", "Draft outline #work"]),
            ("due on or after tomorrow", &["C", "Sub task"]),
            ("due after 2024-03-15", &["C", "Sub task"]),
            (
                "due in 2024-03-14 2024-03-16",
                &["B", "Buy milk", "Draft outline #work"],
            ),
            (
                "due before in 2 days\nnot done",
                &["A #home", "B", "Buy milk", "Draft outline #work"],
            ),
            ("due 1 day ago", &["Buy milk"]),
            ("not done\nno due date", &["E #work #home", "Review"]),
            (
                "has due date\nnot done",
                &[
                    "A #home",
                    "B",
                    "Buy milk",
                    "C",
                    "Draft outline #work",
                    "Sub task",
                ],
            ),
            ("scheduled before today", &["B"]),
            ("starts after today", &["Review"]),
            ("done on 2024-03-01", &["D"]),
            ("priority is high", &["Draft outline #work"]),
            ("priority above medium", &["A #home", "Draft outline #work"]),
            ("priority below none", &["B"]),
            (
                "priority is not none",
                &["A #home", "B", "C", "Draft outline #work"],
            ),
            ("is recurring", &["C", "Review"]),
            (
                "is not recurring\nnot done",
                &[
                    "A #home",
                    "B",
                    "Buy milk",
                    "Draft outline #work",
                    "E #work #home",
                    "Sub task",
                ],
            ),
            ("tags include #home", &["A #home", "E #work #home"]),
            (
                "tags do not include #home\nhas tags",
                &["Draft outline #work"],
            ),
            (
                "not done\nno tags",
                &["B", "Buy milk", "C", "Review", "Sub task"],
            ),
            ("description includes MILK", &["Buy milk"]),
            (
                "description does not include e\nnot done",
                &["B", "Buy milk", "C", "Sub task"],
            ),
            (
                "path includes projects",
                &["Draft outline #work", "Review", "Ship", "Sub task"],
            ),
            (
                "folder includes projects\nnot done",
                &["Draft outline #work", "Review", "Sub task"],
            ),
            ("filename includes inbox", &["Buy milk", "Dropped"]),
            ("heading includes later", &["Review"]),
            (
                "heading does not include later\nfilename includes plan",
                &["Draft outline #work", "Ship", "Sub task"],
            ),
            ("status.type is IN_PROGRESS", &["Review"]),
            (
                "status.type is not TODO\nstatus.type is not DONE",
                &["Dropped", "Review"],
            ),
            (
                "exclude sub-items\nfilename includes plan",
                &["Draft outline #work", "Review", "Ship"],
            ),
            (
                "description regex matches /^D/",
                &["D", "Draft outline #work", "Dropped"],
            ),
            (
                "(due before today) OR (priority is highest)",
                &["A #home", "Buy milk"],
            ),
            (
                "(not done) AND NOT (is recurring)",
                &[
                    "A #home",
                    "B",
                    "Buy milk",
                    "Draft outline #work",
                    "E #work #home",
                    "Sub task",
                ],
            ),
            ("NOT (not done)", &["D", "Dropped", "Ship"]),
            (
                "(has due date) XOR (not done)",
                &["E #work #home", "Review"],
            ),
            (
                "((due today) OR (due tomorrow)) AND (not done)",
                &["B", "Draft outline #work"],
            ),
        ];
        for (block, want) in cases {
            let mut got = descriptions(&v, &format!("{block}\nsort by description"));
            // `sort by description` is the only order these cases look at
            let mut want: Vec<String> = want.iter().map(|s| s.to_string()).collect();
            got.sort();
            want.sort();
            assert_eq!(got, want, "{block}");
        }
    }

    #[test]
    fn sorts_group_limit_and_layout() {
        let v = vault_with_blocks();
        // no date sorts last, ties keep the file order
        assert_eq!(
            descriptions(&v, "not done\nsort by due"),
            [
                "A #home",
                "Buy milk",
                "B",
                "Draft outline #work",
                "C",
                "Sub task",
                "E #work #home",
                "Review"
            ]
        );
        assert_eq!(
            descriptions(&v, "not done\nsort by due reverse\nlimit 3"),
            ["E #work #home", "Review", "C"]
        );
        // highest priority first, "none" between medium and low
        assert_eq!(
            descriptions(&v, "not done\nsort by priority"),
            [
                "A #home",
                "Draft outline #work",
                "C",
                "E #work #home",
                "Buy milk",
                "Sub task",
                "Review",
                "B"
            ]
        );
        assert_eq!(
            descriptions(&v, "not done\nsort by description\nlimit to 2 tasks"),
            ["A #home", "B"]
        );
        // default order: open first, most urgent first
        let d = descriptions(&v, "");
        assert_eq!(d.first().map(String::as_str), Some("A #home"));
        assert!(d.iter().position(|x| x == "D") > d.iter().position(|x| x == "E #work #home"));
        // group by a file property and a task property
        let c = convert("not done\ngroup by folder\nsort by description");
        let r = run(&v, c.base.as_deref().unwrap(), true);
        let keys: Vec<_> = r
            .groups
            .unwrap()
            .iter()
            .map(|g| g.key.display.clone())
            .collect();
        assert_eq!(keys, ["", "Projects"]);
        // layout chooses the columns
        let c =
            convert("hide priority\nhide due date\nshow urgency\nshow created date\nhide backlink");
        let doc = Document::parse(c.base.as_deref().unwrap()).unwrap();
        assert_eq!(
            doc.views[0].order.as_deref().unwrap(),
            [
                "task.checked",
                "task.description",
                "task.scheduled",
                "task.start",
                "task.recurrence",
                "task.urgency",
                "task.created"
            ]
        );
        // chrome with no counterpart is accepted
        assert!(convert("hide task count\nhide edit button\nshort mode\nexplain\nignore global query\n# a comment\n").base.is_some());
    }

    #[test]
    fn what_cannot_be_expressed_is_named_by_line() {
        let c = convert(
            "not done\nfilter by function task.isDone\nhappens before today\ndue this week\ngroup by tags\ngroup by path\ngroup by due\nshow tree\npreset x\nis blocked\nsort by random\nlimit groups to 3\nbogus words",
        );
        assert!(c.base.is_none());
        let named: Vec<(u32, &str)> = c
            .unmapped
            .iter()
            .map(|u| (u.line, u.text.as_str()))
            .collect();
        assert_eq!(
            named,
            [
                (2, "filter by function task.isDone"),
                (3, "happens before today"),
                (4, "due this week"),
                (5, "group by tags"),
                (7, "group by due"),
                (8, "show tree"),
                (9, "preset x"),
                (10, "is blocked"),
                (11, "sort by random"),
                (12, "limit groups to 3"),
                (13, "bogus words"),
            ]
        );
        assert!(c.unmapped[0].reason.contains("JavaScript"));
        assert!(convert("due before the day after tomorrow").base.is_none());
        assert!(convert("(due today) (not done)").base.is_none());
        assert!(convert("(due today").base.is_none());
    }

    #[test]
    fn continued_lines_and_a_task_base_that_round_trips() {
        let v = vault_with_blocks();
        assert_eq!(
            descriptions(
                &v,
                "not done\n(due today) \\\n OR (priority is highest)\nsort by description"
            ),
            ["A #home", "B", "Draft outline #work"]
        );
        let c = convert("not done\nsort by due\ngroup by priority");
        let text = c.base.unwrap();
        assert!(text.starts_with("rows: tasks\n"), "{text}");
        let doc = Document::parse(&text).unwrap();
        assert_eq!(doc.to_yaml(), text);
    }
}

#[test]
fn the_tasks_page_sections_select_what_their_names_say() {
    use crate::tasks::page::SECTIONS;
    let v = vault(&[
        (
            "Home.md",
            "- [ ] A 📅 2024-03-10 🔺\n- [ ] B 📅 2024-03-15 ⏳ 2024-03-14\n- [ ] C 📅 2024-03-20\n- [x] D 📅 2024-03-15\n- [ ] E\n- [ ] F ⏳ 2024-03-15\n",
        ),
        ("Projects/Plan.md", PLAN),
    ]);
    let names = |id: &str| -> Vec<String> {
        let s = SECTIONS.iter().find(|s| s.id == id).unwrap();
        let r = run(&v, s.base, true);
        assert_eq!(r.error, None, "{id}");
        assert_eq!(run(&v, s.base, false), r, "{id}");
        r.rows.iter().map(|x| x.cells[1].display.clone()).collect()
    };
    // today: due or scheduled today (F by schedule), most urgent first
    let today = names("today");
    assert_eq!(today.len(), 3);
    assert!(today.contains(&"B".to_string()) && today.contains(&"F".to_string()));
    assert!(today.contains(&"Draft outline #work".to_string()));
    assert_eq!(names("upcoming"), ["C", "Sub task"]);
    assert_eq!(names("overdue"), ["A"]);
    assert_eq!(names("no-date"), ["E", "Review"]);
    let by_folder = run(&v, SECTIONS[4].base, true);
    let keys: Vec<_> = by_folder
        .groups
        .unwrap()
        .iter()
        .map(|g| g.key.display.clone())
        .collect();
    assert_eq!(keys, ["", "Projects"]);
    // a closed task is on no section
    for id in ["today", "upcoming", "overdue", "no-date", "by-folder"] {
        assert!(!names(id).contains(&"D".to_string()), "{id}");
    }
}
