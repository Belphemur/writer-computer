//! The command registry: one entry per command, the single source for
//! validation, `help` and dispatch (consolidation: no per-command branches
//! elsewhere).

use super::args::Args;
use super::CliError;
use super::{cmd_bases, cmd_files, cmd_notes, cmd_query, Ctx};

pub type Handler = fn(&Ctx, &Args, &CommandSpec) -> Result<String, CliError>;

pub struct ParamSpec {
    pub name: &'static str,
    pub required: bool,
    pub desc: &'static str,
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
}

const fn p(name: &'static str, desc: &'static str) -> ParamSpec {
    ParamSpec {
        name,
        required: false,
        desc,
    }
}

const fn req(name: &'static str, desc: &'static str) -> ParamSpec {
    ParamSpec {
        name,
        required: true,
        desc,
    }
}

const FILE: ParamSpec = p(
    "file",
    "file name, resolved like a wikilink (no folder, no extension)",
);
const PATH: ParamSpec = p("path", "exact vault-relative path, e.g. folder/note.md");

const NO_FLAGS: &[(&str, &str)] = &[];
const NO_PARAMS: &[ParamSpec] = &[];
const NO_FORMATS: &[&str] = &[];

macro_rules! cmd {
    ($name:expr, $group:expr, $summary:expr, $params:expr, $flags:expr, $formats:expr, $default:expr, $run:expr) => {
        CommandSpec {
            name: $name,
            group: $group,
            summary: $summary,
            params: $params,
            flags: $flags,
            formats: $formats,
            default_format: $default,
            run: $run,
        }
    };
}

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
        cmd_notes::prepend
    ),
    cmd!(
        "move",
        "Content",
        "Move a file and update links to it",
        &[FILE, PATH, req("to", "destination folder or path")],
        NO_FLAGS,
        NO_FORMATS,
        None,
        cmd_notes::mv
    ),
    cmd!(
        "rename",
        "Content",
        "Rename a file and update links to it",
        &[
            FILE,
            PATH,
            req("name", "new name (extension kept if omitted)")
        ],
        NO_FLAGS,
        NO_FORMATS,
        None,
        cmd_notes::rename
    ),
    cmd!(
        "delete",
        "Content",
        "Move a file to the trash",
        &[FILE, PATH],
        &[("permanent", "delete for good instead of using the trash")],
        NO_FORMATS,
        None,
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
                "words, \"phrase\", -word, a OR b, pre*, tag:/path:/file:, or /regex/"
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
        cmd_query::search
    ),
    cmd!(
        "search:context",
        "Search",
        "Matching lines as path:line: text, best file first",
        &[
            req(
                "query",
                "words, \"phrase\", -word, a OR b, pre*, tag:/path:/file:, or /regex/"
            ),
            p("path", "limit to this folder"),
            p("limit", "maximum number of lines"),
            p("format", "text | json")
        ],
        &[("case", "case sensitive")],
        &["text", "json"],
        Some("text"),
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
            ("counts", "include occurrence counts")
        ],
        &["yaml", "json", "tsv"],
        Some("yaml"),
        cmd_query::properties
    ),
    cmd!(
        "property:set",
        "Properties",
        "Set a property in a note's frontmatter",
        &[
            req("name", "property name"),
            req("value", "value"),
            p("type", "text | list | number | checkbox | date | datetime"),
            FILE,
            PATH
        ],
        NO_FLAGS,
        NO_FORMATS,
        None,
        cmd_query::property_set
    ),
    cmd!(
        "property:read",
        "Properties",
        "Print a property value",
        &[req("name", "property name"), FILE, PATH],
        NO_FLAGS,
        NO_FORMATS,
        None,
        cmd_query::property_read
    ),
    cmd!(
        "property:remove",
        "Properties",
        "Remove a property",
        &[req("name", "property name"), FILE, PATH],
        NO_FLAGS,
        NO_FORMATS,
        None,
        cmd_query::property_remove
    ),
    cmd!(
        "aliases",
        "Properties",
        "List aliases",
        &[FILE, PATH],
        &[
            ("total", "print only the count"),
            ("verbose", "include file paths")
        ],
        NO_FORMATS,
        None,
        cmd_query::aliases
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
        cmd_query::tag
    ),
    // Tasks
    cmd!(
        "tasks",
        "Tasks",
        "List tasks",
        &[
            FILE,
            PATH,
            p("status", "status character"),
            p("format", "text | json | tsv | csv")
        ],
        &[
            ("total", "print only the count"),
            ("done", "completed only"),
            ("todo", "not completed only"),
            ("verbose", "group by file with line numbers")
        ],
        &["text", "json", "tsv", "csv"],
        Some("text"),
        cmd_query::tasks
    ),
    cmd!(
        "task",
        "Tasks",
        "Show or change one task",
        &[
            p("ref", "path:line"),
            FILE,
            PATH,
            p("line", "line number"),
            p("status", "set this status character")
        ],
        &[
            ("toggle", "flip done/not done"),
            ("done", "mark done"),
            ("todo", "mark not done")
        ],
        NO_FORMATS,
        None,
        cmd_notes::task
    ),
    // Links
    cmd!(
        "links",
        "Links",
        "Outgoing links of a file",
        &[FILE, PATH],
        &[("total", "print only the count")],
        NO_FORMATS,
        None,
        cmd_query::links
    ),
    cmd!(
        "backlinks",
        "Links",
        "Files linking to a file",
        &[FILE, PATH, p("format", "json | tsv | csv")],
        &[
            ("counts", "include link counts"),
            ("total", "print only the count")
        ],
        &["json", "tsv", "csv"],
        Some("tsv"),
        cmd_query::backlinks
    ),
    cmd!(
        "unresolved",
        "Links",
        "Links that match no file",
        &[p("format", "json | tsv | csv")],
        &[
            ("total", "print only the count"),
            ("counts", "include counts"),
            ("verbose", "include source files")
        ],
        &["json", "tsv", "csv"],
        Some("tsv"),
        cmd_query::unresolved
    ),
    cmd!(
        "orphans",
        "Links",
        "Files nothing links to",
        NO_PARAMS,
        &[("total", "print only the count")],
        NO_FORMATS,
        None,
        cmd_query::orphans
    ),
    cmd!(
        "deadends",
        "Links",
        "Files with no outgoing links",
        NO_PARAMS,
        &[("total", "print only the count")],
        NO_FORMATS,
        None,
        cmd_query::deadends
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
        cmd_query::wordcount
    ),
    // Bases
    cmd!(
        "bases",
        "Bases",
        "List .base files",
        NO_PARAMS,
        NO_FLAGS,
        NO_FORMATS,
        None,
        cmd_bases::bases
    ),
    cmd!(
        "base:views",
        "Bases",
        "List the views of a base",
        &[FILE, PATH],
        NO_FLAGS,
        NO_FORMATS,
        None,
        cmd_bases::base_views
    ),
    cmd!(
        "base:create",
        "Bases",
        "Create a note in a base view",
        &[
            FILE,
            PATH,
            p("view", "view name"),
            p("name", "note name"),
            p("content", "initial text")
        ],
        &[
            ("open", "accepted, ignored"),
            ("newtab", "accepted, ignored")
        ],
        NO_FORMATS,
        None,
        cmd_bases::base_create
    ),
    cmd!(
        "base:query",
        "Bases",
        "Run a base view",
        &[
            FILE,
            PATH,
            p("view", "view name"),
            p("format", "json | csv | tsv | md | paths")
        ],
        NO_FLAGS,
        &["json", "csv", "tsv", "md", "paths"],
        Some("json"),
        cmd_bases::base_query
    ),
    // Meta
    cmd!(
        "help",
        "Meta",
        "List commands, or show help for one",
        NO_PARAMS,
        NO_FLAGS,
        NO_FORMATS,
        None,
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
        version
    ),
];

pub fn find(name: &str) -> Option<&'static CommandSpec> {
    COMMANDS.iter().find(|c| c.name == name)
}

/// Commands of the public Obsidian CLI that need a running Obsidian-style app
/// or features Writer does not have.
pub fn app_control(name: &str) -> bool {
    if find(name).is_some() {
        return false;
    }
    const EXACT: &[&str] = &[
        "open",
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
        out.push_str(&format!(" [{f}]"));
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
            out.push_str(&format!("  {f:<10} {d}\n"));
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
            let mut group = "";
            for c in COMMANDS {
                if c.group != group {
                    group = c.group;
                    out.push_str(&format!("\n{group}:\n"));
                }
                out.push_str(&format!("  {:<16} {}\n", c.name, c.summary));
            }
            out.push_str("\nRun `writer help <command>` for parameters and flags.\n");
            Ok(out)
        }
        [name] => match find(name) {
            Some(spec) => Ok(help_for(spec)),
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
