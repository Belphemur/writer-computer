//! The command registry: one entry per command, the single source for
//! validation, `help` and dispatch (consolidation: no per-command branches
//! elsewhere).

use super::args::Args;
use super::CliError;
use super::{cmd_app, cmd_files, cmd_graph, cmd_notes, cmd_query, cmd_skills, mcp, Ctx};

pub type Handler = fn(&Ctx, &Args, &CommandSpec) -> Result<String, CliError>;

pub struct ParamSpec {
    pub name: &'static str,
    pub required: bool,
    pub desc: &'static str,
    /// A JSON document: taken as written (no `\n` unescaping, no quote stripping), and `@<vault
    /// file>` or `-` (stdin) stand for its text (`cli/mod.rs`, `resolve_json_inputs`).
    pub json: bool,
}

pub struct CommandSpec {
    pub name: &'static str,
    pub group: &'static str,
    pub summary: &'static str,
    pub params: &'static [ParamSpec],
    pub flags: &'static [(&'static str, &'static str)],
    pub formats: &'static [&'static str],
    pub default_format: Option<&'static str>,
    pub run: Handler,
    /// Does it change the vault (or the app's window)? Set deliberately on every command (the
    /// `cmd!` macro takes `reads` or `writes`): the MCP server marks write tools (`mcp.rs`) and the
    /// agent allows read tools without a prompt.
    pub writes: bool,
    /// The built-in feature that contributes this command (`features::Feature::cli_commands`):
    /// while its switch is off the command reports that instead of running. `None` for core.
    pub feature: Option<&'static str>,
}

pub(crate) const fn p(name: &'static str, desc: &'static str) -> ParamSpec {
    ParamSpec {
        name,
        required: false,
        desc,
        json: false,
    }
}

/// An optional JSON-valued parameter (see [`ParamSpec::json`]).
pub(crate) const fn pj(name: &'static str, desc: &'static str) -> ParamSpec {
    ParamSpec {
        json: true,
        ..p(name, desc)
    }
}

/// A required JSON-valued parameter.
pub(crate) const fn reqj(name: &'static str, desc: &'static str) -> ParamSpec {
    ParamSpec {
        json: true,
        ..req(name, desc)
    }
}

pub(crate) const fn req(name: &'static str, desc: &'static str) -> ParamSpec {
    ParamSpec {
        name,
        required: true,
        desc,
        json: false,
    }
}

pub(crate) const FILE: ParamSpec = p(
    "file",
    "file name, resolved like a wikilink (no folder, no extension)",
);
pub(crate) const PATH: ParamSpec = p("path", "exact vault-relative path, e.g. folder/note.md");

const RELOCATE_FLAGS: &[(&str, &str)] = &[
    (
        "dry-run",
        "print the plan (files and link counts) and change nothing",
    ),
    (
        "no-update-links",
        "do not rewrite links to the file (they are updated by default)",
    ),
];

pub(crate) const NO_FLAGS: &[(&str, &str)] = &[];
pub(crate) const NO_PARAMS: &[ParamSpec] = &[];
pub(crate) const NO_FORMATS: &[&str] = &[];
const GRAPH_FORMATS: &[&str] = &["text", "json", "tsv"];

/// `reads` or `writes` -> `CommandSpec::writes`; anything else does not compile.
macro_rules! access {
    (reads) => {
        false
    };
    (writes) => {
        true
    };
}

pub(crate) use access;

macro_rules! cmd {
    ($name:expr, $group:expr, $summary:expr, $params:expr, $flags:expr, $formats:expr, $default:expr, $access:tt, $run:expr) => {
        CommandSpec {
            name: $name,
            group: $group,
            summary: $summary,
            params: $params,
            flags: $flags,
            formats: $formats,
            default_format: $default,
            run: $run,
            writes: $crate::cli::registry::access!($access),
            feature: None,
        }
    };
}
pub(crate) use cmd;

pub static COMMANDS: &[CommandSpec] = &[
    // Vault
    cmd!(
        "vault",
        "Vault",
        "Show the current vault (one value with info=)",
        &[p("info", "name | path | files | folders | size")],
        NO_FLAGS,
        NO_FORMATS,
        None,
        reads,
        cmd_files::vault
    ),
    cmd!(
        "vaults",
        "Vault",
        "List the vaults Writer knows (recent workspaces)",
        NO_PARAMS,
        &[
            ("total", "print only the count"),
            ("verbose", "include vault paths")
        ],
        NO_FORMATS,
        None,
        reads,
        cmd_files::vaults
    ),
    // Files and folders
    cmd!(
        "files",
        "Files",
        "List files",
        &[
            p("folder", "only files under this folder"),
            p("ext", "only this extension")
        ],
        &[("total", "print only the count")],
        NO_FORMATS,
        None,
        reads,
        cmd_files::files
    ),
    cmd!(
        "file",
        "Files",
        "Show information about a file",
        &[FILE, PATH],
        NO_FLAGS,
        NO_FORMATS,
        None,
        reads,
        cmd_files::file
    ),
    cmd!(
        "folders",
        "Files",
        "List folders",
        &[p("folder", "only folders under this folder")],
        &[("total", "print only the count")],
        NO_FORMATS,
        None,
        reads,
        cmd_files::folders
    ),
    cmd!(
        "folder",
        "Files",
        "Show information about a folder",
        &[
            req("path", "folder path"),
            p("info", "files | folders | size (one value only)")
        ],
        NO_FLAGS,
        NO_FORMATS,
        None,
        reads,
        cmd_files::folder
    ),
    // Content
    cmd!(
        "read",
        "Content",
        "Print a file's contents",
        &[FILE, PATH],
        NO_FLAGS,
        NO_FORMATS,
        None,
        reads,
        cmd_notes::read
    ),
    cmd!(
        "create",
        "Content",
        "Create a note",
        &[
            p("name", "note name (default Untitled)"),
            p("path", "exact path"),
            p("content", "initial text"),
            p("template", "note whose text is the starting content")
        ],
        &[
            ("overwrite", "replace an existing file"),
            ("open", "accepted, ignored (the app is not controlled)"),
            ("newtab", "accepted, ignored")
        ],
        NO_FORMATS,
        None,
        writes,
        cmd_notes::create
    ),
    cmd!(
        "append",
        "Content",
        "Append text to a file",
        &[
            FILE,
            PATH,
            req("content", "text to add"),
            p("heading", "append to the end of this section")
        ],
        &[(
            "inline",
            "no newline between the existing text and the new text"
        )],
        NO_FORMATS,
        None,
        writes,
        cmd_notes::append
    ),
    cmd!(
        "prepend",
        "Content",
        "Insert text after the frontmatter",
        &[
            FILE,
            PATH,
            req("content", "text to add"),
            p("heading", "insert right after this heading")
        ],
        &[("inline", "no newline after the new text")],
        NO_FORMATS,
        None,
        writes,
        cmd_notes::prepend
    ),
    cmd!(
        "move",
        "Content",
        "Move and/or rename a file and update links to it",
        &[
            FILE,
            PATH,
            p("to", "destination folder or path"),
            p(
                "name",
                "new file name, in the destination folder (extension kept if omitted)"
            ),
            p("format", "text | json")
        ],
        RELOCATE_FLAGS,
        &["text", "json"],
        Some("text"),
        writes,
        cmd_notes::mv
    ),
    cmd!(
        "title",
        "Content",
        "Show, set or clear a note's display title (the title property); the file is not renamed",
        &[
            FILE,
            PATH,
            p(
                "set",
                "new display title (links showing the old title follow)"
            ),
            p("format", "text | json")
        ],
        &[
            (
                "clear",
                "remove the title property (the note shows its file name)"
            ),
            (
                "dry-run",
                "print the plan (files and link counts) and change nothing",
            ),
            (
                "no-update-links",
                "do not rewrite links that show the old title as their alias",
            ),
        ],
        &["text", "json"],
        Some("text"),
        writes,
        cmd_notes::title
    ),
    cmd!(
        "delete",
        "Content",
        "Move a file to the trash",
        &[FILE, PATH],
        &[("permanent", "delete for good instead of using the trash")],
        NO_FORMATS,
        None,
        writes,
        cmd_notes::delete
    ),
    // Search
    cmd!(
        "search",
        "Search",
        "List files whose text or name matches a query, best match first",
        &[
            req(
                "query",
                "words, \"phrase\", -word, a OR b, pre*, tag:/path:/file:/kind:/ext:, or /regex/"
            ),
            p("path", "limit to this folder"),
            p("limit", "maximum number of files"),
            p("format", "text | json")
        ],
        &[
            ("total", "print only the count"),
            ("case", "case sensitive")
        ],
        &["text", "json"],
        Some("text"),
        reads,
        cmd_query::search
    ),
    cmd!(
        "search:context",
        "Search",
        "Matching lines as path:line: text, best file first",
        &[
            req(
                "query",
                "words, \"phrase\", -word, a OR b, pre*, tag:/path:/file:/kind:/ext:, or /regex/"
            ),
            p("path", "limit to this folder"),
            p("limit", "maximum number of lines"),
            p("format", "text | json")
        ],
        &[("case", "case sensitive")],
        &["text", "json"],
        Some("text"),
        reads,
        cmd_query::search_context
    ),
    // Properties
    cmd!(
        "properties",
        "Properties",
        "List properties (of one file, or the vault with counts)",
        &[
            FILE,
            PATH,
            p("name", "only this property"),
            p("sort", "count"),
            p("format", "yaml | json | tsv")
        ],
        &[
            ("total", "print only the count"),
            ("counts", "include occurrence counts"),
            ("types", "include each property's type")
        ],
        &["yaml", "json", "tsv"],
        Some("yaml"),
        reads,
        cmd_query::properties
    ),
    cmd!(
        "property:set",
        "Properties",
        "Set a property in a note's frontmatter",
        &[
            req("name", "property name, or a.b for a key in a map"),
            req("value", "value"),
            p("type", "text | list | number | checkbox | date | datetime"),
            FILE,
            PATH
        ],
        NO_FLAGS,
        NO_FORMATS,
        None,
        writes,
        cmd_query::property_set
    ),
    cmd!(
        "property:read",
        "Properties",
        "Print a property value",
        &[
            req("name", "property name, or a.b for a key in a map"),
            FILE,
            PATH
        ],
        NO_FLAGS,
        NO_FORMATS,
        None,
        reads,
        cmd_query::property_read
    ),
    cmd!(
        "property:remove",
        "Properties",
        "Remove a property",
        &[
            req("name", "property name, or a.b for a key in a map"),
            FILE,
            PATH
        ],
        NO_FLAGS,
        NO_FORMATS,
        None,
        writes,
        cmd_query::property_remove
    ),
    // Tags
    cmd!(
        "tags",
        "Tags",
        "List tags",
        &[
            FILE,
            PATH,
            p("sort", "count"),
            p("format", "json | tsv | csv")
        ],
        &[
            ("total", "print only the count"),
            ("counts", "include counts")
        ],
        &["json", "tsv", "csv"],
        Some("tsv"),
        reads,
        cmd_query::tags
    ),
    cmd!(
        "tag",
        "Tags",
        "Show a tag",
        &[req("name", "tag, with or without #")],
        &[
            ("total", "print only the file count"),
            ("verbose", "include the file list")
        ],
        NO_FORMATS,
        None,
        reads,
        cmd_query::tag
    ),
    // Tasks
    cmd!(
        "tasks",
        "Tasks",
        "List tasks (filter= takes a Bases expression over task rows)",
        &[
            FILE,
            PATH,
            p("status", "status character"),
            p(
                "filter",
                "expression, e.g. task.due < today() && !task.checked"
            ),
            p("sort", "task property, e.g. task.due or task.urgency"),
            p("limit", "at most this many tasks"),
            p("format", "text | json | tsv | csv")
        ],
        &[
            ("total", "print only the count"),
            ("done", "completed only"),
            ("todo", "not completed only"),
            ("desc", "with sort=: descending"),
            ("verbose", "group by file with line numbers")
        ],
        &["text", "json", "tsv", "csv"],
        Some("text"),
        reads,
        cmd_query::tasks
    ),
    // Graph (SPECs/note-graph-spec.md 8.1)
    cmd!(
        "graph:neighbors",
        "Graph",
        "Notes within a few links of a note, with how each is reached",
        &[
            FILE,
            PATH,
            p("depth", "1 to 4 (default 2)"),
            p("kind", "link | embed | property (comma separated)"),
            p("label", "only this property name"),
            p("direction", "in | out | both (default both)"),
            p("limit", "most notes (default 50)"),
            p("format", "text | json | tsv")
        ],
        NO_FLAGS,
        GRAPH_FORMATS,
        Some("text"),
        reads,
        cmd_graph::neighbors
    ),
    cmd!(
        "graph:path",
        "Graph",
        "The shortest chain of links between two notes",
        &[
            req("from", "start note, resolved like a wikilink"),
            req("to", "end note"),
            p("maxdepth", "most links to follow (default 6)"),
            p("format", "text | json | tsv")
        ],
        NO_FLAGS,
        GRAPH_FORMATS,
        Some("text"),
        reads,
        cmd_graph::path
    ),
    cmd!(
        "graph:relationships",
        "Graph",
        "Property links (manager: [[X]]); with no file or label, the property names in use",
        &[
            FILE,
            PATH,
            p("label", "only this property name"),
            p("format", "text | json | tsv")
        ],
        NO_FLAGS,
        GRAPH_FORMATS,
        Some("text"),
        reads,
        cmd_graph::relationships
    ),
    cmd!(
        "graph:backlinks",
        "Graph",
        "Notes linking to a note, with kind, property, section and optionally the line",
        &[
            FILE,
            PATH,
            p("limit", "most links (default 20, 50 with context)"),
            p("format", "text | json | tsv")
        ],
        &[(
            "context",
            "add the line holding each link (capped, read from the note)"
        )],
        GRAPH_FORMATS,
        Some("text"),
        reads,
        cmd_graph::backlinks
    ),
    cmd!(
        "graph:related",
        "Graph",
        "Notes not linked to a note but sharing linked notes with it",
        &[
            FILE,
            PATH,
            p("limit", "most notes (default 10)"),
            p("format", "text | json | tsv")
        ],
        NO_FLAGS,
        GRAPH_FORMATS,
        Some("text"),
        reads,
        cmd_graph::related
    ),
    cmd!(
        "graph:hubs",
        "Graph",
        "The most linked notes",
        &[
            p("limit", "most notes (default 20)"),
            p("format", "text | json | tsv")
        ],
        NO_FLAGS,
        GRAPH_FORMATS,
        Some("text"),
        reads,
        cmd_graph::hubs
    ),
    cmd!(
        "graph:components",
        "Graph",
        "Groups of connected notes, largest first, with one example each",
        &[
            p("limit", "most groups (default 20)"),
            p("format", "text | json | tsv")
        ],
        NO_FLAGS,
        GRAPH_FORMATS,
        Some("text"),
        reads,
        cmd_graph::components
    ),
    cmd!(
        "graph:orphans",
        "Graph",
        "Notes with no link in or out",
        &[p("limit", "most notes"), p("format", "text | json | tsv")],
        &[(
            "incoming",
            "only notes nothing links to (links out allowed)"
        )],
        GRAPH_FORMATS,
        Some("text"),
        reads,
        cmd_graph::orphans
    ),
    cmd!(
        "graph:deadends",
        "Graph",
        "Notes with no outgoing link",
        &[p("limit", "most notes"), p("format", "text | json | tsv")],
        NO_FLAGS,
        GRAPH_FORMATS,
        Some("text"),
        reads,
        cmd_graph::deadends
    ),
    cmd!(
        "graph:unresolved",
        "Graph",
        "Links that match no file, with how many and which notes hold them",
        &[p("limit", "most links"), p("format", "text | json | tsv")],
        NO_FLAGS,
        GRAPH_FORMATS,
        Some("text"),
        reads,
        cmd_graph::unresolved
    ),
    // Structure
    cmd!(
        "outline",
        "Structure",
        "Headings of a file",
        &[FILE, PATH, p("format", "tree | md | json")],
        &[("total", "print only the count")],
        &["tree", "md", "json"],
        Some("tree"),
        reads,
        cmd_query::outline
    ),
    cmd!(
        "wordcount",
        "Structure",
        "Words and characters of a file",
        &[FILE, PATH],
        &[("words", "words only"), ("characters", "characters only")],
        NO_FORMATS,
        None,
        reads,
        cmd_query::wordcount
    ),
    // The running app (over the local socket, `ipc/`)
    cmd!(
        "status",
        "App",
        "Show whether Writer is running, its version and the open vaults",
        &[p("format", "text | json")],
        NO_FLAGS,
        &["text", "json"],
        Some("text"),
        reads,
        cmd_app::status
    ),
    cmd!(
        "open",
        "App",
        "Open a file in the vault's Writer window",
        &[
            FILE,
            PATH,
            p("line", "line to reveal (from 1)"),
            p("anchor", "heading slug to reveal")
        ],
        &[
            ("newtab", "open in a new tab"),
            ("launch", "start Writer first when it is not running")
        ],
        NO_FORMATS,
        None,
        writes,
        cmd_app::open
    ),
    cmd!(
        "reveal",
        "App",
        "Reveal a file or folder in the sidebar of the vault's Writer window",
        &[FILE, PATH],
        NO_FLAGS,
        NO_FORMATS,
        None,
        writes,
        cmd_app::reveal
    ),
    cmd!(
        "active",
        "App",
        "Show the active tab of the vault's Writer window: path, kind and line (never its text)",
        &[p("format", "text | json")],
        NO_FLAGS,
        &["text", "json"],
        Some("text"),
        reads,
        cmd_app::active
    ),
    // Skills
    cmd!(
        "skills:sync",
        "Skills",
        "Install or update the Writer-managed agent skills in this vault",
        NO_PARAMS,
        &[("check", "report what would change, write nothing")],
        NO_FORMATS,
        None,
        writes,
        cmd_skills::skills_sync
    ),
    // Meta
    cmd!(
        "mcp",
        "Meta",
        "Serve the commands as MCP tools on stdin and stdout, for an agent (one vault; not a tool itself)",
        NO_PARAMS,
        NO_FLAGS,
        NO_FORMATS,
        None,
        reads,
        mcp::run
    ),
    cmd!(
        "help",
        "Meta",
        "List commands, or show help for one",
        NO_PARAMS,
        NO_FLAGS,
        NO_FORMATS,
        None,
        reads,
        help
    ),
    cmd!(
        "version",
        "Meta",
        "Show the Writer version",
        NO_PARAMS,
        NO_FLAGS,
        NO_FORMATS,
        None,
        reads,
        version
    ),
];

/// Every command: the core table followed by the ones features contribute
/// (`features::Feature::cli_commands`). This, not `COMMANDS`, is what `find`, `help` and dispatch
/// read.
pub fn commands() -> impl Iterator<Item = &'static CommandSpec> {
    COMMANDS.iter().chain(crate::features::cli_commands())
}

pub fn find(name: &str) -> Option<&'static CommandSpec> {
    commands().find(|c| c.name == name)
}

/// Commands that were removed because a surviving one does the job (ADR 2026-11-19, prune the
/// CLI): the removed name and what to run instead. The one table; asking for a removed name exits
/// 2 and names the replacement, so old scripts and agents learn the new spelling. A name that is
/// still registered runs (the table only answers for names `find` does not know).
pub const REMOVED: &[(&str, &str)] = &[
    ("links", "graph:neighbors file=<name> direction=out depth=1"),
    ("backlinks", "graph:backlinks"),
    ("orphans", "graph:orphans incoming"),
    ("deadends", "graph:deadends"),
    ("unresolved", "graph:unresolved"),
    ("rename", "move file=<name> name=<new name>"),
    ("aliases", "property:read name=aliases"),
    (
        "task",
        "tasks to list, task:add, task:done or task:edit to change",
    ),
    ("excalidraw:connect", "excalidraw:add with edges"),
];

/// What replaces `name`, when it is a removed command.
pub fn removed(name: &str) -> Option<&'static str> {
    REMOVED.iter().find(|(n, _)| *n == name).map(|(_, r)| *r)
}

/// The error of a removed command.
pub fn removed_message(name: &str, replacement: &str) -> String {
    format!("{name} was removed: use {replacement}")
}

/// Every command grouped by its group name, in registry order (core and feature commands of one
/// group merge): what `help` and the skill reference print.
pub fn groups() -> Vec<(&'static str, Vec<&'static CommandSpec>)> {
    let mut out: Vec<(&'static str, Vec<&'static CommandSpec>)> = Vec::new();
    for c in commands() {
        match out.iter_mut().find(|(g, _)| *g == c.group) {
            Some((_, list)) => list.push(c),
            None => out.push((c.group, vec![c])),
        }
    }
    out
}

/// Commands of the public Obsidian CLI that need a running Obsidian-style app
/// or features Writer does not have.
pub fn app_control(name: &str) -> bool {
    if find(name).is_some() {
        return false;
    }
    const EXACT: &[&str] = &[
        "search:open",
        "templates",
        "bookmarks",
        "bookmark",
        "diff",
        "history",
        "sync",
        "plugins",
        "themes",
        "snippets",
        "workspaces",
        "tabs",
        "web",
        "devtools",
        "eval",
        "commands",
        "hotkeys",
        "recents",
        "reload",
        "restart",
        "random",
        "unique",
        "daily",
        "workspace",
        "plugin",
        "theme",
        "snippet",
        "publish",
        "tab",
        "dev",
        "command",
        "hotkey",
        "template",
    ];
    const PREFIXES: &[&str] = &[
        "vault:",
        "daily:",
        "template:",
        "bookmark:",
        "history:",
        "sync:",
        "plugin:",
        "plugins:",
        "theme:",
        "themes:",
        "snippet:",
        "snippets:",
        "publish:",
        "workspace:",
        "tab:",
        "dev:",
        "hotkey:",
        "command:",
        "random:",
        "web:",
        "diff:",
        "unique:",
    ];
    EXACT.contains(&name) || PREFIXES.iter().any(|p| name.starts_with(p))
}

pub fn help_for(spec: &CommandSpec) -> String {
    let mut out = format!(
        "{}\n\nUsage: writer [vault=<name|id|path>] {}",
        spec.summary, spec.name
    );
    for p in spec.params {
        if p.required {
            out.push_str(&format!(" {}=<{}>", p.name, p.name));
        } else {
            out.push_str(&format!(" [{}=<{}>]", p.name, p.name));
        }
    }
    for (f, _) in spec.flags {
        out.push_str(&format!(" [{}]", super::args::flag_display(f)));
    }
    out.push('\n');
    if !spec.params.is_empty() {
        out.push_str("\nParameters:\n");
        for p in spec.params {
            out.push_str(&format!(
                "  {:<10} {}{}\n",
                format!("{}=", p.name),
                p.desc,
                if p.required { " (required)" } else { "" }
            ));
        }
    }
    if !spec.flags.is_empty() {
        out.push_str("\nFlags:\n");
        for (f, d) in spec.flags {
            out.push_str(&format!("  {:<10} {d}\n", super::args::flag_display(f)));
        }
    }
    if let Some(d) = spec.default_format {
        out.push_str(&format!(
            "\nFormats: {} (default {d})\n",
            spec.formats.join(", ")
        ));
    }
    out.push_str("\nAdd --copy to copy the output to the clipboard.\n");
    out
}

fn help(_: &Ctx, args: &Args, _: &CommandSpec) -> Result<String, CliError> {
    match args.positional.as_slice() {
        [] => {
            let mut out = String::from(
                "Usage: writer [vault=<name|id|path>] <command> [param=value ...] [flag ...] [--copy]\n\nvault= must be the first argument; without it the vault containing the working directory is used.\nfile=<name> resolves like a wikilink; path=<path> is exact from the vault root.\n",
            );
            for (group, list) in groups() {
                out.push_str(&format!("\n{group}:\n"));
                for c in list {
                    out.push_str(&format!("  {:<16} {}\n", c.name, c.summary));
                }
            }
            out.push_str("\nRun `writer help <command>` for parameters and flags.\n");
            Ok(out)
        }
        [name] => match find(name) {
            Some(spec) => Ok(help_for(spec)),
            None if removed(name).is_some() => Err(CliError::Usage(removed_message(
                name,
                removed(name).unwrap_or_default(),
            ))),
            None if app_control(name) => Err(CliError::Usage(format!(
                "Not available in the Writer CLI: {name}"
            ))),
            None => Err(CliError::Usage(format!("unknown command \"{name}\""))),
        },
        _ => Err(CliError::Usage(
            "help takes at most one command name".into(),
        )),
    }
}

fn version(_: &Ctx, _: &Args, _: &CommandSpec) -> Result<String, CliError> {
    Ok(format!("writer {}\n", crate::writer_cli::VERSION))
}
