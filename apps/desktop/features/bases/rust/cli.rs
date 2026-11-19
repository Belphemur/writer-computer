//! The `writer` commands of Bases: the table the CLI registry appends (`Feature::cli_commands`).
//! The handlers are `cli::cmd_bases` (Tauri-free, over the engine and the vault index); this is
//! only where they are declared, tagged with the feature so the CLI's one gate
//! (`cli::feature_off`) answers "turned off" while `features.bases.enabled` is false.

use crate::cli::cmd_bases;
use crate::cli::registry::{cmd, p, CommandSpec, FILE, NO_FLAGS, NO_FORMATS, NO_PARAMS, PATH};

/// Every command here is `Some("bases")`: one place names the feature.
const FEATURE: Option<&str> = Some("bases");

pub static COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "bases",
            "Bases",
            "List .base files",
            NO_PARAMS,
            NO_FLAGS,
            NO_FORMATS,
            None,
            reads,
            cmd_bases::bases
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "base:views",
            "Bases",
            "List the views of a base",
            &[FILE, PATH],
            NO_FLAGS,
            NO_FORMATS,
            None,
            reads,
            cmd_bases::base_views
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
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
            writes,
            cmd_bases::base_create
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
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
            reads,
            cmd_bases::base_query
        )
    },
];
