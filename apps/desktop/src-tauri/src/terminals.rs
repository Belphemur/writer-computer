//! The one terminal table for "Open in Terminal" on macOS and Linux (spec `SPECs/linux-support-spec.md`,
//! "Open in Terminal"). Each entry says how to open a folder on each OS; the launcher
//! (`commands/workspace.rs` `terminal_launch_specs`) and the settings dropdown (`detect`) both read it.
//! Tauri-free: detection takes the presence check as a parameter so tests need no installed terminal.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaunchPlatform {
    MacOs,
    Windows,
    Linux,
}

pub fn current_platform() -> LaunchPlatform {
    match std::env::consts::OS {
        "macos" => LaunchPlatform::MacOs,
        "windows" => LaunchPlatform::Windows,
        _ => LaunchPlatform::Linux,
    }
}

/// The folder placeholder in `LinuxLaunch::dir_args`.
const DIR: &str = "{dir}";

/// How a terminal opens a folder on Linux: the program and the arguments that carry the directory
/// (`{dir}` is replaced). An empty list relies on the working directory the launcher sets.
pub struct LinuxLaunch {
    pub program: &'static str,
    pub dir_args: &'static [&'static str],
}

pub struct Terminal {
    /// Stored in `workspace.default-terminal`.
    pub id: &'static str,
    pub label: &'static str,
    /// The application name for `open -a` (macOS), when the terminal has a Mac build.
    pub mac_app: Option<&'static str>,
    pub linux: Option<LinuxLaunch>,
}

const fn linux(program: &'static str, dir_args: &'static [&'static str]) -> Option<LinuxLaunch> {
    Some(LinuxLaunch { program, dir_args })
}

/// Order is the fallback order of the Linux "System default" (after `$TERMINAL` and
/// `x-terminal-emulator`) and the order of the dropdown.
pub const TERMINALS: &[Terminal] = &[
    Terminal {
        id: "ghostty",
        label: "Ghostty",
        mac_app: Some("Ghostty"),
        linux: linux("ghostty", &["--working-directory={dir}"]),
    },
    Terminal {
        id: "kitty",
        label: "kitty",
        mac_app: Some("kitty"),
        linux: linux("kitty", &["--directory", DIR]),
    },
    Terminal {
        id: "wezterm",
        label: "WezTerm",
        mac_app: Some("WezTerm"),
        linux: linux("wezterm", &["start", "--cwd", DIR]),
    },
    Terminal {
        id: "alacritty",
        label: "Alacritty",
        mac_app: Some("Alacritty"),
        linux: linux("alacritty", &["--working-directory", DIR]),
    },
    Terminal {
        id: "iterm2",
        label: "iTerm2",
        mac_app: Some("iTerm"),
        linux: None,
    },
    Terminal {
        id: "warp",
        label: "Warp",
        mac_app: Some("Warp"),
        linux: None,
    },
    Terminal {
        id: "foot",
        label: "foot",
        mac_app: None,
        linux: linux("foot", &["-D", DIR]),
    },
    Terminal {
        id: "gnome-terminal",
        label: "GNOME Terminal",
        mac_app: None,
        linux: linux("gnome-terminal", &["--working-directory={dir}"]),
    },
    Terminal {
        id: "console",
        label: "GNOME Console",
        mac_app: None,
        linux: linux("kgx", &["--working-directory={dir}"]),
    },
    Terminal {
        id: "konsole",
        label: "Konsole",
        mac_app: None,
        linux: linux("konsole", &["--workdir", DIR]),
    },
    Terminal {
        id: "xfce4-terminal",
        label: "Xfce Terminal",
        mac_app: None,
        linux: linux("xfce4-terminal", &["--working-directory={dir}"]),
    },
    Terminal {
        id: "terminal",
        label: "Terminal",
        mac_app: Some("Terminal"),
        linux: None,
    },
    // Debian's alternative: no folder flag is portable, the working directory does the job.
    Terminal {
        id: "x-terminal-emulator",
        label: "x-terminal-emulator",
        mac_app: None,
        linux: linux("x-terminal-emulator", &[]),
    },
];

/// The macOS default and the Linux alternative tried before the rest of the table.
pub const MAC_DEFAULT_ID: &str = "terminal";
pub const LINUX_ALTERNATIVE_ID: &str = "x-terminal-emulator";

impl Terminal {
    /// Every name a stored setting may use for this terminal (case-insensitive): the id, the label,
    /// the macOS app name and the Linux program, so values typed before the dropdown still resolve.
    pub fn names(&self) -> Vec<&'static str> {
        let mut names = vec![self.id, self.label];
        names.extend(self.mac_app);
        names.extend(self.linux.as_ref().map(|launch| launch.program));
        names.dedup();
        names
    }

    pub fn matches(&self, name: &str) -> bool {
        let name = name.trim();
        self.names()
            .iter()
            .any(|candidate| candidate.eq_ignore_ascii_case(name))
    }

    /// The Linux program and its arguments for `dir`.
    pub fn linux_command(&self, dir: &Path) -> Option<(&'static str, Vec<String>)> {
        let launch = self.linux.as_ref()?;
        let dir = dir.to_string_lossy();
        let args = launch
            .dir_args
            .iter()
            .map(|arg| arg.replace(DIR, &dir))
            .collect();
        Some((launch.program, args))
    }
}

pub fn find(name: &str) -> Option<&'static Terminal> {
    TERMINALS.iter().find(|terminal| terminal.matches(name))
}

pub fn by_id(id: &str) -> &'static Terminal {
    TERMINALS
        .iter()
        .find(|terminal| terminal.id == id)
        .expect("terminal id is in the table")
}

/// One dropdown row of the settings page.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TerminalInfo {
    pub id: String,
    pub label: String,
    /// Every name a stored value may use for it, so the page can recognise an older value.
    pub names: Vec<String>,
}

/// The terminals present on this machine, in table order. `present` answers for one entry; the real
/// one is `installed`.
pub fn detect(platform: LaunchPlatform, present: impl Fn(&Terminal) -> bool) -> Vec<TerminalInfo> {
    TERMINALS
        .iter()
        .filter(|terminal| match platform {
            LaunchPlatform::MacOs => terminal.mac_app.is_some(),
            LaunchPlatform::Linux => terminal.linux.is_some(),
            LaunchPlatform::Windows => false,
        })
        .filter(|terminal| present(terminal))
        .map(|terminal| TerminalInfo {
            id: terminal.id.into(),
            label: terminal.label.into(),
            names: terminal.names().into_iter().map(String::from).collect(),
        })
        .collect()
}

/// Application bundle folders searched on macOS.
fn mac_app_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    dirs.extend(home.map(|home| home.join("Applications")));
    dirs
}

/// Cheap local presence check: an app bundle on macOS, an executable on the login-shell PATH on
/// Linux. Runs the login shell once (cached), so call it off the main thread and only when the
/// settings page opens.
pub fn installed(platform: LaunchPlatform, terminal: &Terminal) -> bool {
    match platform {
        LaunchPlatform::MacOs => {
            let home = std::env::var_os("HOME").map(PathBuf::from);
            terminal.mac_app.is_some_and(|app| {
                mac_app_dirs(home.as_deref())
                    .iter()
                    .any(|dir| dir.join(format!("{app}.app")).is_dir())
            })
        }
        LaunchPlatform::Linux => terminal.linux.as_ref().is_some_and(|launch| {
            crate::plugin_env::which(launch.program)
                .ok()
                .flatten()
                .is_some()
        }),
        LaunchPlatform::Windows => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_every_entry_opens_somewhere() {
        let mut ids: Vec<_> = TERMINALS.iter().map(|t| t.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), TERMINALS.len());
        assert!(TERMINALS
            .iter()
            .all(|t| t.mac_app.is_some() || t.linux.is_some()));
        assert!(by_id(MAC_DEFAULT_ID).mac_app.is_some());
        assert!(by_id(LINUX_ALTERNATIVE_ID).linux.is_some());
    }

    #[test]
    fn the_table_covers_the_agreed_terminals_on_each_os() {
        let on = |f: fn(&Terminal) -> bool| -> Vec<&str> {
            TERMINALS.iter().filter(|t| f(t)).map(|t| t.id).collect()
        };
        let mac = on(|t| t.mac_app.is_some());
        let linux = on(|t| t.linux.is_some());
        for id in ["ghostty", "kitty", "wezterm", "alacritty"] {
            assert!(mac.contains(&id) && linux.contains(&id), "{id}");
        }
        for id in ["iterm2", "warp", "terminal"] {
            assert!(mac.contains(&id) && !linux.contains(&id), "{id}");
        }
        for id in [
            "foot",
            "gnome-terminal",
            "console",
            "konsole",
            "xfce4-terminal",
            "x-terminal-emulator",
        ] {
            assert!(linux.contains(&id) && !mac.contains(&id), "{id}");
        }
    }

    #[test]
    fn linux_commands_carry_the_folder() {
        let dir = Path::new("/notes dir");
        let command = |id: &str| by_id(id).linux_command(dir).unwrap();
        assert_eq!(
            command("ghostty"),
            (
                "ghostty",
                vec!["--working-directory=/notes dir".to_string()]
            )
        );
        assert_eq!(
            command("kitty"),
            (
                "kitty",
                vec!["--directory".to_string(), "/notes dir".to_string()]
            )
        );
        assert_eq!(
            command("wezterm"),
            (
                "wezterm",
                ["start", "--cwd", "/notes dir"].map(String::from).to_vec()
            )
        );
        assert_eq!(
            command("alacritty"),
            (
                "alacritty",
                ["--working-directory", "/notes dir"]
                    .map(String::from)
                    .to_vec()
            )
        );
        assert_eq!(
            command("foot"),
            ("foot", ["-D", "/notes dir"].map(String::from).to_vec())
        );
        assert_eq!(
            command("konsole"),
            (
                "konsole",
                ["--workdir", "/notes dir"].map(String::from).to_vec()
            )
        );
        assert_eq!(
            command("gnome-terminal"),
            (
                "gnome-terminal",
                vec!["--working-directory=/notes dir".to_string()]
            )
        );
        assert_eq!(command("console").0, "kgx");
        assert_eq!(command("xfce4-terminal").0, "xfce4-terminal");
        assert_eq!(
            command("x-terminal-emulator"),
            ("x-terminal-emulator", vec![])
        );
        assert!(by_id("iterm2").linux_command(dir).is_none());
    }

    #[test]
    fn stored_names_resolve_case_insensitively() {
        assert_eq!(find("Ghostty").unwrap().id, "ghostty");
        assert_eq!(find(" iTerm ").unwrap().id, "iterm2");
        assert_eq!(find("iTerm2").unwrap().id, "iterm2");
        assert_eq!(find("kgx").unwrap().id, "console");
        assert_eq!(find("GNOME Terminal").unwrap().id, "gnome-terminal");
        assert!(find("ghostty --execute x").is_none());
        assert!(find("").is_none());
    }

    #[test]
    fn detection_lists_what_is_present_for_the_os() {
        let found = |platform, present: &[&str]| {
            detect(platform, |t| present.contains(&t.id))
                .into_iter()
                .map(|info| info.id)
                .collect::<Vec<_>>()
        };
        // An entry without a launch for the OS is never listed, even if "present".
        assert_eq!(
            found(LaunchPlatform::Linux, &["kitty", "iterm2", "foot"]),
            ["kitty", "foot"]
        );
        assert_eq!(
            found(
                LaunchPlatform::MacOs,
                &["kitty", "iterm2", "foot", "terminal"]
            ),
            ["kitty", "iterm2", "terminal"]
        );
        assert!(found(LaunchPlatform::Windows, &["kitty"]).is_empty());
        assert!(found(LaunchPlatform::Linux, &[]).is_empty());
    }

    #[test]
    fn mac_app_dirs_include_the_user_applications_folder() {
        let dirs = mac_app_dirs(Some(Path::new("/Users/a")));
        assert!(dirs.contains(&PathBuf::from("/Users/a/Applications")));
        assert!(dirs.contains(&PathBuf::from("/Applications")));
    }
}
