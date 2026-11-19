//! The `writer` commands of the icons feature: the table the CLI registry appends
//! (`Feature::cli_commands`). The handlers are `cli::cmd_icons` (Tauri-free, over `crate::icons`);
//! this is only where they are declared, tagged with the feature so the CLI's one gate
//! (`cli::feature_off`) answers "turned off" while `features.icons.enabled` is false.

use crate::cli::cmd_icons;
use crate::cli::registry::{cmd, p, req, CommandSpec, FILE, NO_FLAGS, NO_FORMATS, PATH};

const FEATURE: Option<&str> = Some("icons");

pub static COMMANDS: &[CommandSpec] = &[
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "icon:set",
            "Icons",
            "Give a file or folder an icon (shown in the sidebar, tabs and links); icon is emoji:<emoji> or icon:<Hugeicons name>, a bare emoji or a bare name also works",
            &[
                FILE,
                PATH,
                req("icon", "emoji:🚀 or icon:Rocket01Icon"),
                p("color", "#rrggbb")
            ],
            NO_FLAGS,
            NO_FORMATS,
            None,
            writes,
            cmd_icons::icon_set
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "icon:get",
            "Icons",
            "Print the icon of a file or folder (exit 1 when it has none)",
            &[FILE, PATH, p("format", "text | json")],
            NO_FLAGS,
            &["text", "json"],
            Some("text"),
            reads,
            cmd_icons::icon_get
        )
    },
    CommandSpec {
        feature: FEATURE,
        ..cmd!(
            "icon:remove",
            "Icons",
            "Remove the icon of a file or folder",
            &[FILE, PATH],
            NO_FLAGS,
            NO_FORMATS,
            None,
            writes,
            cmd_icons::icon_remove
        )
    },
];
