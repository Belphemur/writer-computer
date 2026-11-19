//! The `writer` command of Dataview: `dql`, contributed to the CLI registry
//! (`Feature::cli_commands`). The handler is `cli::cmd_dql` (Tauri-free, over the DQL engine and
//! the vault index); this declares it and tags it with the feature so the CLI's one gate
//! (`cli::feature_off`) answers "turned off" while `features.dataview.enabled` is false.

use crate::cli::cmd_dql;
use crate::cli::registry::{cmd, p, CommandSpec, FILE, NO_FLAGS, PATH};

pub static COMMANDS: &[CommandSpec] = &[CommandSpec {
    feature: Some("dataview"),
    ..cmd!(
        "dql",
        "Dataview",
        "Run a Dataview query (TABLE, LIST, TASK, CALENDAR)",
        &[
            p("query", "the DQL text"),
            FILE,
            PATH,
            p("format", "json | csv | tsv | md | paths")
        ],
        NO_FLAGS,
        &["json", "csv", "tsv", "md", "paths"],
        Some("json"),
        reads,
        cmd_dql::dql
    )
}];
