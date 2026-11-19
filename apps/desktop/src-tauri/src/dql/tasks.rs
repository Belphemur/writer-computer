//! `TASK` queries: how Dataview's task fields map onto the task rows of the Tasks feature.
//!
//! The Tasks ADR (`2026-11-18-make-tasks-a-native-built-in-feature-with-task-rows-in-bases`)
//! defines `rows: tasks` bases whose rows are tasks with the properties `task.description`,
//! `task.status`, `task.done`, `task.due`, `task.scheduled`, `task.start`, `task.created`,
//! `task.priority`, `task.recurrence`, `task.urgency`, `task.tags` and `task.line`, plus the
//! file's `file.*` and `note.*`. This table is the one place that names them for DQL, so the
//! day the Tasks feature settles a name (is `task.status` the status type or the symbol?) it is
//! one line here. The lowering is pinned by unit tests; executing a task query needs the Tasks
//! feature's rows; `a_task_query_returns_the_task_rows_the_fixture_expects` in `tests.rs` runs one.

/// What a Dataview task field becomes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskMap {
    /// The task property `task.<name>`.
    Prop(&'static str),
    /// `task.status == <type>`.
    StatusIs(&'static str),
    /// `task.status != <type>`.
    StatusIsNot(&'static str),
    /// No equivalent on a task row (the clause is named when converting or running).
    Unsupported(&'static str),
}

pub const TASK_FIELDS: &[(&str, TaskMap)] = &[
    ("text", TaskMap::Prop("description")),
    // Dataview's `completed` is a done checkbox; `checked` any checkbox that is not "open"
    ("completed", TaskMap::StatusIs("DONE")),
    ("checked", TaskMap::StatusIsNot("TODO")),
    ("status", TaskMap::Prop("status")),
    ("due", TaskMap::Prop("due")),
    ("scheduled", TaskMap::Prop("scheduled")),
    ("start", TaskMap::Prop("start")),
    ("created", TaskMap::Prop("created")),
    ("completion", TaskMap::Prop("done")),
    ("line", TaskMap::Prop("line")),
    ("tags", TaskMap::Prop("tags")),
    (
        "fullyCompleted",
        TaskMap::Unsupported("fullyCompleted needs the task's subtasks"),
    ),
    (
        "annotated",
        TaskMap::Unsupported("annotated has no equivalent"),
    ),
    ("visual", TaskMap::Unsupported("visual has no equivalent")),
    (
        "parent",
        TaskMap::Unsupported("parent is not on a task row"),
    ),
    (
        "children",
        TaskMap::Unsupported("children is not on a task row"),
    ),
    (
        "subtasks",
        TaskMap::Unsupported("subtasks is not on a task row"),
    ),
    (
        "position",
        TaskMap::Unsupported("position has no equivalent"),
    ),
    (
        "header",
        TaskMap::Unsupported("header is not on a task row"),
    ),
    (
        "section",
        TaskMap::Unsupported("section is not on a task row"),
    ),
    (
        "link",
        TaskMap::Unsupported("a task link is not on a task row"),
    ),
];

pub fn task_field(name: &str) -> Option<TaskMap> {
    TASK_FIELDS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, m)| *m)
}
