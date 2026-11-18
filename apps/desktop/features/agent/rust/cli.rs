//! The `writer` commands of the agent feature: the table the CLI registry appends
//! (`Feature::cli_commands`). The handlers are `cli::cmd_project` (Tauri-free, over
//! `agent::project`); this is only where they are declared, tagged with the feature so the CLI's
//! one gate (`cli::feature_off`) answers "turned off" while `features.agent.enabled` is false.

use crate::cli::cmd_project;
use crate::cli::registry::{cmd, req, CommandSpec, NO_FLAGS, NO_FORMATS};

const FEATURE: Option<&str> = Some("agent");

pub static COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "project:archive",
            "Agent",
            "Archive an agent project: flag it and move its folder into the archive folder (setting agent.projects-archive-folder, default Archive/Projects)",
            &[req("path", "vault-relative project folder, e.g. Projects/Client")],
            NO_FLAGS,
            NO_FORMATS,
            None,
            cmd_project::project_archive
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "project:unarchive",
            "Agent",
            "Unarchive an agent project: move its folder back to where it was archived from and clear the flag",
            &[req("path", "vault-relative archived project folder, e.g. Archive/Projects/Client")],
            NO_FLAGS,
            NO_FORMATS,
            None,
            cmd_project::project_unarchive
        )
    },
];
