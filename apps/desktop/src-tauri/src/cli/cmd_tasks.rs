//! `tasks filter=…` and `task:add`, `task:done`, `task:edit`: the CLI front end of the tasks
//! feature over `crate::tasks` (the grammar and the one write path) and the Bases engine
//! (`rows: tasks`). Settings come from the global `config` file (`Overrides::from_global_dir`).

use super::args::Args;
use super::cmd_bases::format_result;
use super::cmd_notes::task_target;
use super::format::list_lines;
use super::registry::CommandSpec;
use super::{CliError, Ctx};
use crate::bases::context::{Clock, SystemClock};
use crate::bases::document::{Direction, Document, Filter, RowKind, SortKey, View};
use crate::index::bases_source::run_base_view;
use crate::tasks::date::Day;
use crate::tasks::edit::{parse_field, FieldValue, StatusChange};
use crate::tasks::grammar::Field;
use crate::tasks::ops;
use crate::tasks::settings::{Overrides, TaskSettings};

fn settings(ctx: &Ctx) -> Result<TaskSettings, CliError> {
    let o = match ctx.env.data_dir() {
        Ok(dir) => Overrides::from_global_dir(&dir),
        Err(_) => Overrides::default(),
    };
    Ok(TaskSettings::load(ctx.root()?, &o))
}

fn today(ctx: &Ctx) -> Day {
    Day::from_local_ms(
        SystemClock {
            offset_minutes: ctx.env.utc_offset_minutes,
        }
        .now_local_ms(),
    )
}

/// `"a"` for a Bases string literal.
fn literal(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The columns of a filtered listing.
const COLUMNS: [&str; 6] = [
    "file.path",
    "task.line",
    "task.symbol",
    "task.due",
    "task.priority",
    "task.description",
];

/// `writer tasks filter=<expression> [sort=<property>] [desc] [limit=<n>]`: a Bases filter over
/// task rows (`task.due < today() && !task.checked`), the same expressions a `rows: tasks` base
/// takes. The older `status=` / `done` / `todo` / `file=` selectors still apply.
pub fn query(ctx: &Ctx, args: &Args, spec: &CommandSpec) -> Result<String, CliError> {
    let format = args.format(spec)?;
    let mut exprs: Vec<String> = Vec::new();
    if let Some(f) = args.get("filter") {
        exprs.push(f.to_string());
    }
    if let Some(t) = ctx.target_opt(args)? {
        exprs.push(format!("file.path == {}", literal(&t.rel)));
    }
    if let Some(s) = args.get("status") {
        exprs.push(format!("task.symbol == {}", literal(s)));
    }
    if args.flag("done") {
        exprs.push("task.checked".into());
    }
    if args.flag("todo") {
        exprs.push("!task.checked".into());
    }
    let mut view = View::default_table();
    view.name = "Tasks".into();
    view.order = Some(COLUMNS.iter().map(|c| c.to_string()).collect());
    if let Some(s) = args.get("sort") {
        view.sort = vec![SortKey {
            property: s.to_string(),
            direction: if args.flag("desc") {
                Direction::Desc
            } else {
                Direction::Asc
            },
            extra: Vec::new(),
        }];
    }
    if let Some(n) = args.get("limit") {
        view.limit = Some(
            n.trim()
                .parse()
                .map_err(|_| CliError::Usage("limit= must be a number".into()))?,
        );
    }
    let mut doc = Document::empty(RowKind::Tasks);
    if !exprs.is_empty() {
        doc.filters = Some(Filter::And(exprs.into_iter().map(Filter::Expr).collect()));
    }
    doc.views = vec![view];
    let clock = SystemClock {
        offset_minutes: ctx.env.utc_offset_minutes,
    };
    let result = run_base_view(ctx.index()?, &doc, None, None, &clock)?;
    if let Some(e) = &result.error {
        let mut msg = e.message.clone();
        if let Some(x) = &e.expression {
            msg.push_str(&format!(" (in `{x}`)"));
        }
        return Err(CliError::Usage(msg));
    }
    if args.flag("total") {
        return Ok(format!("{}\n", result.rows.len()));
    }
    if format == "text" {
        return Ok(list_lines(result.rows.iter().map(|r| {
            let c = |i: usize| r.cells[i].display.as_str();
            let mut line = format!("{}:{}: [{}] {}", c(0), c(1), c(2), c(5));
            if !c(3).is_empty() {
                line.push_str(&format!(" (due {})", c(3)));
            }
            line
        })));
    }
    format_result(&result, &format)
}

fn field_of(name: &str) -> Result<Field, CliError> {
    parse_field(name).ok_or_else(|| {
        CliError::Usage(format!(
            "unknown field \"{name}\" (due, scheduled, start, created, priority, recurrence)"
        ))
    })
}

/// `task:add text=… [due=…] [scheduled=…] [start=…] [priority=…] [recurrence=…] [path=…]`: one
/// line appended to the inbox note (`tasks.inbox`, `Tasks.md` by default), created on first use.
pub fn add(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let s = settings(ctx)?;
    let mut fields: Vec<(Field, String)> = Vec::new();
    for name in ["due", "scheduled", "start", "priority", "recurrence"] {
        if let Some(v) = args.get(name) {
            fields.push((field_of(name)?, v.to_string()));
        }
    }
    let rel = args.get("path").unwrap_or(&s.inbox).to_string();
    let c = ops::add(ctx.root()?, &rel, args.require("text")?, &fields, &s)
        .map_err(|e| CliError::fail(e.to_string()))?;
    Ok(format!(
        "Added {}:{}\n",
        c.path,
        c.lines.first().copied().unwrap_or(0)
    ))
}

/// `task:done ref=path:line` (or `file=`/`path=` with `line=`): complete a task; a recurring one
/// writes its next occurrence.
pub fn done(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let s = settings(ctx)?;
    let (t, line) = task_target(ctx, args)?;
    let c = ops::change_status(
        ctx.root()?,
        &t.rel,
        line,
        None,
        StatusChange::Complete,
        &s,
        today(ctx),
    )
    .map_err(|e| CliError::fail(e.to_string()))?;
    let mut out = format!("Done {}:{line}\n", c.path);
    if c.lines.len() > 1 {
        out.push_str("Next occurrence written\n");
    }
    Ok(out)
}

/// `task:edit ref=path:line [due=…] [scheduled=…] [start=…] [priority=…] [recurrence=…]
/// [clear=due,priority]`: set or clear fields of one task; the line changes by those tokens only.
pub fn edit(ctx: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    let s = settings(ctx)?;
    let (t, line) = task_target(ctx, args)?;
    let mut edits: Vec<(Field, FieldValue)> = Vec::new();
    for name in ["due", "scheduled", "start", "priority", "recurrence"] {
        if let Some(v) = args.get(name) {
            edits.push((field_of(name)?, FieldValue::Set(v.to_string())));
        }
    }
    for name in args.get("clear").unwrap_or("").split(',').map(str::trim) {
        if !name.is_empty() {
            edits.push((field_of(name)?, FieldValue::Clear));
        }
    }
    if edits.is_empty() {
        return Err(CliError::Usage(
            "give at least one of due=, scheduled=, start=, priority=, recurrence= or clear="
                .into(),
        ));
    }
    // all edits land in one write: apply them to the line in order
    let root = ctx.root()?;
    let c = ops::edit_line(root, &t.rel, line, None, |l, n| {
        let mut cur = l.to_string();
        for (field, value) in &edits {
            cur = crate::tasks::edit::set_field_line(&cur, n, *field, value, &s)?;
        }
        Ok(cur)
    })
    .map_err(|e| CliError::fail(e.to_string()))?;
    Ok(format!("Edited {}:{line}\n", c.path))
}
