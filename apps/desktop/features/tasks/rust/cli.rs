//! The `writer` commands of Tasks: the table the CLI registry appends (`Feature::cli_commands`).
//! The handlers are `cli::cmd_tasks` (Tauri-free, over `crate::tasks`); this is only where they
//! are declared, tagged with the feature so the CLI's one gate answers "turned off" while
//! `features.tasks.enabled` is false.

use crate::cli::cmd_tasks;
use crate::cli::registry::{cmd, p, CommandSpec, FILE, NO_FLAGS, NO_FORMATS, PATH};

const FEATURE: Option<&str> = Some("tasks");

pub static COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "task:add",
            "Tasks",
            "Add a task to the inbox note",
            &[
                p("text", "task text"),
                p("due", "YYYY-MM-DD"),
                p("scheduled", "YYYY-MM-DD"),
                p("start", "YYYY-MM-DD"),
                p("priority", "highest | high | medium | low | lowest"),
                p("recurrence", "e.g. every week"),
                PATH
            ],
            NO_FLAGS,
            NO_FORMATS,
            None,
            writes,
            cmd_tasks::add
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "task:done",
            "Tasks",
            "Complete a task (a recurring one writes its next occurrence)",
            &[p("ref", "path:line"), FILE, PATH, p("line", "line number")],
            NO_FLAGS,
            NO_FORMATS,
            None,
            writes,
            cmd_tasks::done
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "task:edit",
            "Tasks",
            "Set the status or fields of a task, or clear fields",
            &[
                p("ref", "path:line"),
                FILE,
                PATH,
                p("line", "line number"),
                p(
                    "status",
                    "status symbol (x, space, /, -, a custom one) or name (done, todo, in-progress, cancelled)"
                ),
                p("due", "YYYY-MM-DD"),
                p("scheduled", "YYYY-MM-DD"),
                p("start", "YYYY-MM-DD"),
                p("priority", "highest | high | medium | low | lowest"),
                p("recurrence", "e.g. every week"),
                p("clear", "fields to remove, comma separated")
            ],
            NO_FLAGS,
            NO_FORMATS,
            None,
            writes,
            cmd_tasks::edit
        )
    },
];
