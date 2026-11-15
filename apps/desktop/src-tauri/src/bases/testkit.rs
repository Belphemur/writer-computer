//! In-memory vault used by the tests: synthetic notes only, no real data.

use super::context::{file_basename, file_folder, FileMeta, FixedClock, RowContext};
use super::datetime;
use super::query::{PushdownHint, RowSource};
use super::value::{LinkValue, Value};
use std::cell::RefCell;
use std::rc::Rc;

#[derive(Clone, Debug, Default)]
pub struct Note {
    pub path: String,
    pub size: u64,
    pub ctime: i64,
    pub mtime: i64,
    pub props: Vec<(String, Value)>,
    pub tags: Vec<String>,
    pub links: Vec<String>,
    pub embeds: Vec<String>,
}

impl Note {
    pub fn new(path: &str) -> Note {
        Note {
            path: path.to_string(),
            size: 100,
            ctime: d("2024-01-01T09:00:00"),
            mtime: d("2024-02-01T09:00:00"),
            ..Note::default()
        }
    }
    pub fn p(mut self, k: &str, v: Value) -> Note {
        self.props.push((k.to_string(), v));
        self
    }
    pub fn tag(mut self, t: &str) -> Note {
        self.tags.push(t.to_string());
        self
    }
    pub fn link(mut self, t: &str) -> Note {
        self.links.push(t.to_string());
        self
    }
    pub fn size(mut self, n: u64) -> Note {
        self.size = n;
        self
    }
    pub fn mtime(mut self, s: &str) -> Note {
        self.mtime = d(s);
        self
    }
}

pub fn d(s: &str) -> i64 {
    datetime::parse_date(s, 0).expect("test date").0
}

pub fn date(s: &str) -> Value {
    let (ms, t) = datetime::parse_date(s, 0).expect("test date");
    Value::date(ms, t)
}

pub fn s(x: &str) -> Value {
    Value::str(x)
}

pub fn n(x: f64) -> Value {
    Value::Number(x)
}

pub fn list(items: Vec<Value>) -> Value {
    Value::List(items)
}

pub struct Store {
    pub notes: Vec<Note>,
}

impl Store {
    pub fn new(mut notes: Vec<Note>) -> Rc<Store> {
        notes.sort_by(|a, b| a.path.cmp(&b.path));
        Rc::new(Store { notes })
    }

    fn index_of(&self, path: &str) -> Option<usize> {
        self.notes.iter().position(|n| n.path == path)
    }

    /// U18 stand-in: exact path (with or without `.md`), else the first note
    /// in path order whose basename matches, case-insensitively.
    pub fn resolve(&self, text: &str) -> Option<String> {
        let t = text.trim().trim_start_matches('/');
        let lower = t.to_lowercase();
        let stripped = lower.strip_suffix(".md").unwrap_or(&lower).to_string();
        for n in &self.notes {
            let p = n.path.to_lowercase();
            if p == lower || p.strip_suffix(".md").unwrap_or(&p) == stripped {
                return Some(n.path.clone());
            }
        }
        if !stripped.contains('/') {
            for n in &self.notes {
                if file_basename(&n.path).to_lowercase() == stripped {
                    return Some(n.path.clone());
                }
            }
        }
        None
    }
}

pub struct Mem {
    pub store: Rc<Store>,
    pub idx: usize,
}

impl Mem {
    pub fn rc(store: &Rc<Store>, path: &str) -> Rc<dyn RowContext> {
        Rc::new(Mem {
            store: store.clone(),
            idx: store.index_of(path).expect("note exists"),
        })
    }
    fn note(&self) -> &Note {
        &self.store.notes[self.idx]
    }
    fn link_values(&self, texts: &[String]) -> Vec<LinkValue> {
        texts
            .iter()
            .map(|t| LinkValue {
                target: t.clone(),
                display: None,
                resolved: self.store.resolve(t),
            })
            .collect()
    }
}

impl RowContext for Mem {
    fn path(&self) -> String {
        self.note().path.clone()
    }
    fn meta(&self) -> FileMeta {
        let n = self.note();
        FileMeta {
            size: n.size,
            ctime_ms: n.ctime,
            mtime_ms: n.mtime,
        }
    }
    fn properties(&self) -> Vec<(String, Value)> {
        self.note().props.clone()
    }
    fn tags(&self) -> Vec<String> {
        self.note().tags.clone()
    }
    fn links(&self) -> Vec<LinkValue> {
        self.link_values(&self.note().links)
    }
    fn embeds(&self) -> Vec<LinkValue> {
        self.link_values(&self.note().embeds)
    }
    fn backlinks(&self) -> Vec<String> {
        let me = self.path();
        self.store
            .notes
            .iter()
            .filter(|n| {
                n.path != me
                    && n.links
                        .iter()
                        .any(|l| self.store.resolve(l).as_deref() == Some(me.as_str()))
            })
            .map(|n| n.path.clone())
            .collect()
    }
    fn resolve_link(&self, text: &str) -> Option<String> {
        self.store.resolve(text)
    }
    fn context_for_path(&self, path: &str) -> Option<Rc<dyn RowContext>> {
        let idx = self.store.index_of(path)?;
        Some(Rc::new(Mem {
            store: self.store.clone(),
            idx,
        }))
    }
}

/// Source over the whole store. With `narrow` it honours the pushdown hint
/// the way an index would (a superset of the true matches).
pub struct MemSource {
    pub store: Rc<Store>,
    pub this: Option<String>,
    pub narrow: bool,
    pub last_hint: RefCell<Option<PushdownHint>>,
}

impl MemSource {
    pub fn new(store: &Rc<Store>) -> MemSource {
        MemSource {
            store: store.clone(),
            this: None,
            narrow: false,
            last_hint: RefCell::new(None),
        }
    }
}

impl RowSource for MemSource {
    fn candidates(&self, hint: &PushdownHint) -> Result<Vec<Rc<dyn RowContext>>, String> {
        *self.last_hint.borrow_mut() = Some(hint.clone());
        let mut out: Vec<Rc<dyn RowContext>> = Vec::new();
        for (i, n) in self.store.notes.iter().enumerate() {
            if self.narrow {
                let folder = file_folder(&n.path);
                if hint
                    .folders
                    .iter()
                    .any(|f| !(f.is_empty() || folder == f || folder.starts_with(&format!("{f}/"))))
                {
                    continue;
                }
                if let Some(e) = &hint.ext {
                    if super::context::file_ext(&n.path) != e {
                        continue;
                    }
                }
            }
            out.push(Rc::new(Mem {
                store: self.store.clone(),
                idx: i,
            }));
        }
        Ok(out)
    }
    fn this_row(&self) -> Option<Rc<dyn RowContext>> {
        self.this.as_ref().map(|p| Mem::rc(&self.store, p))
    }
}

pub fn clock() -> FixedClock {
    FixedClock::at("2024-03-15T10:30:00")
}

/// About thirty synthetic notes covering mixed types, lists, links, nulls,
/// dates, duplicate basenames and property names with spaces.
pub fn sample_store() -> Rc<Store> {
    let mut v: Vec<Note> = Vec::new();
    let status = ["active", "done", "planned", "active", "done"];
    let owners = ["Alice", "Bob", "Carol"];
    for i in 0..12 {
        let name = format!("Projects/Task {:02}.md", i + 1);
        let mut note = Note::new(&name)
            .p("status", s(status[i % status.len()]))
            .p("priority", n((i % 4) as f64))
            .p("done", Value::Bool(i % 3 == 0))
            .p("owner", s(&format!("[[{}]]", owners[i % 3])))
            .p(
                "tags",
                list(vec![s("work"), s(if i % 2 == 0 { "even" } else { "odd" })]),
            )
            .tag("work")
            .tag(if i % 2 == 0 {
                "project/alpha"
            } else {
                "project/beta"
            })
            .size(100 + i as u64 * 10)
            .mtime(&format!("2024-02-{:02}T12:00:00", i + 1));
        if i % 4 != 3 {
            note = note.p("due", date(&format!("2024-03-{:02}", 10 + i)));
        } else if i == 3 {
            note = note.p("due", s("someday"));
        } else {
            note = note.p("due", Value::Null);
        }
        if i == 5 {
            note = note.p("creation date", date("2024-01-02T08:30:00"));
        }
        if i < 3 {
            note = note.link("Projects/Plan").link("Alice");
        }
        v.push(note);
    }
    v.push(
        Note::new("Projects/Plan.md")
            .p("status", s("active"))
            .p("score", n(8.5))
            .p(
                "meta",
                Value::Object(vec![("team".into(), s("core")), ("size".into(), n(3.0))]),
            )
            .tag("project")
            .link("Alice")
            .link("Archive/Plan"),
    );
    v.push(
        Note::new("Archive/Plan.md")
            .p("status", s("done"))
            .p("score", n(4.0))
            .tag("archive"),
    );
    for (name, role) in [("Alice", "lead"), ("Bob", "dev"), ("Carol", "dev")] {
        v.push(
            Note::new(&format!("People/{name}.md"))
                .p("role", s(role))
                .p("aliases", list(vec![s(&name[..1])]))
                .p("born", date(&format!("199{}-05-20", name.len())))
                .tag("person")
                .link("Projects/Task 01"),
        );
    }
    for i in 0..5 {
        v.push(
            Note::new(&format!("Journal/2024-03-{:02}.md", i + 1))
                .p("mood", n((i * 2) as f64))
                .p(
                    "stamp",
                    date(&format!("2024-03-{:02}T07:{:02}:00", i + 1, i * 10)),
                )
                .p("weekly", Value::Bool(i == 2))
                .tag("journal"),
        );
    }
    v.push(Note::new("Inbox/Untitled.md"));
    v.push(
        Note::new("Inbox/Empty props.md")
            .p("status", Value::Null)
            .p("tags", list(vec![]))
            .p("due", s("")),
    );
    v.push(Note::new("attachments/photo.png").size(5000));
    v.push(
        Note::new("Home.md")
            .link("People/Alice")
            .link("Missing Note")
            .tag("Index"),
    );
    Store::new(v)
}
