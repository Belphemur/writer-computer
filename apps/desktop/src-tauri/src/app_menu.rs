//! The one app menu definition and its two renderers (ADR 2026-11-20, point 3).
//!
//! `definition(os)` is plain data (Tauri-free, so a test compares both OSes). The renderer turns
//! it into a Tauri menu: on macOS the native menu bar, on Linux a popup menu opened from the
//! chrome bar's menu button (`app_menu_popup`); Linux gets no menu-bar row. macOS-only items
//! (Services, Hide, Hide Others, Show All, the osascript command-line-tool install) are not
//! created on Linux, and GTK supports only a few predefined items, so the rest become ordinary
//! items with an id handled in `lib.rs`.

use crate::error::AppError;
use crate::platform::Os;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::menu::{
    IsMenuItem, Menu, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::Wry;

pub const UPDATER_CHECK_ID: &str = "updater.check";
pub const PREFERENCES_ID: &str = "preferences.open";
/// The macOS "Install 'writer' Command Line Tool" item (install and uninstall toggle). Linux has
/// no such item yet: it comes back with its listener when the CLI install lane lands.
pub const CLI_ID: &str = "cli.toggle";
pub const QUIT_ID: &str = "app.quit";
pub const MINIMIZE_ID: &str = "window.minimize";
pub const FULLSCREEN_ID: &str = "window.fullscreen";
pub const CLOSE_WINDOW_ID: &str = "window.close";

pub const CLI_INSTALL_LABEL_MACOS: &str = "Install 'writer' Command Line Tool…";
pub const CLI_UNINSTALL_LABEL_MACOS: &str = "Uninstall 'writer' Command Line Tool…";

/// A toolkit-provided item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Native {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Fullscreen,
    CloseWindow,
}

/// What a native item is on Linux: GTK (muda) implements only About, Cut, Copy, Paste and Select
/// All, so some become an ordinary item and the macOS-only ones are dropped.
enum OnLinux {
    Native,
    Item(&'static str, &'static str),
    Omitted,
}

impl Native {
    fn on_linux(self) -> OnLinux {
        match self {
            Native::About | Native::Cut | Native::Copy | Native::Paste | Native::SelectAll => {
                OnLinux::Native
            }
            Native::Quit => OnLinux::Item(QUIT_ID, "Quit"),
            Native::Minimize => OnLinux::Item(MINIMIZE_ID, "Minimize"),
            Native::Fullscreen => OnLinux::Item(FULLSCREEN_ID, "Toggle Full Screen"),
            Native::CloseWindow => OnLinux::Item(CLOSE_WINDOW_ID, "Close Window"),
            // macOS-only, or answered by the responder chain there (Undo, Redo).
            Native::Services
            | Native::Hide
            | Native::HideOthers
            | Native::ShowAll
            | Native::Undo
            | Native::Redo => OnLinux::Omitted,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Separator,
    Item {
        id: &'static str,
        label: &'static str,
        accelerator: Option<&'static str>,
    },
    Native(Native),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    pub title: &'static str,
    pub entries: Vec<Entry>,
}

fn item(id: &'static str, label: &'static str, accelerator: Option<&'static str>) -> Entry {
    Entry::Item {
        id,
        label,
        accelerator,
    }
}

/// The menu, for one OS.
pub fn definition(os: Os) -> Vec<Section> {
    use Entry::{Native as N, Separator as S};
    let all = vec![
        Section {
            title: "Writer",
            entries: vec![
                N(Native::About),
                S,
                item(UPDATER_CHECK_ID, "Check for Updates…", None),
                S,
                item(PREFERENCES_ID, "Preferences…", Some("CmdOrCtrl+,")),
                item(CLI_ID, CLI_INSTALL_LABEL_MACOS, None),
                S,
                N(Native::Services),
                S,
                N(Native::Hide),
                N(Native::HideOthers),
                N(Native::ShowAll),
                S,
                N(Native::Quit),
            ],
        },
        Section {
            title: "Edit",
            entries: vec![
                N(Native::Undo),
                N(Native::Redo),
                S,
                N(Native::Cut),
                N(Native::Copy),
                N(Native::Paste),
                N(Native::SelectAll),
            ],
        },
        Section {
            title: "Window",
            entries: vec![
                N(Native::Minimize),
                N(Native::Fullscreen),
                N(Native::CloseWindow),
            ],
        },
    ];
    match os {
        Os::MacOs => all,
        Os::Linux => all.into_iter().map(for_linux).collect(),
    }
}

fn for_linux(section: Section) -> Section {
    let mut entries: Vec<Entry> = Vec::new();
    for entry in section.entries {
        let resolved = match entry {
            Entry::Native(n) => match n.on_linux() {
                OnLinux::Native => Some(Entry::Native(n)),
                OnLinux::Item(id, label) => Some(item(id, label, None)),
                OnLinux::Omitted => None,
            },
            // macOS-only for now (see `CLI_ID`).
            Entry::Item { id: CLI_ID, .. } => None,
            // A popup menu's accelerators never fire (only a menu bar's do); Linux binds its
            // chords in the web keybinding registry instead.
            Entry::Item { id, label, .. } => Some(item(id, label, None)),
            other => Some(other),
        };
        let Some(resolved) = resolved else { continue };
        // Dropping items can leave a separator first or doubled; never keep one.
        let is_sep = resolved == Entry::Separator;
        if is_sep && matches!(entries.last(), None | Some(Entry::Separator)) {
            continue;
        }
        entries.push(resolved);
    }
    if entries.last() == Some(&Entry::Separator) {
        entries.pop();
    }
    Section { entries, ..section }
}

/// What an ordinary item does: the one place an id is tied to its handler, so a test can say that
/// every id of every definition is handled (`lib.rs` matches on this, never on strings).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    CheckForUpdates,
    OpenPreferences,
    ToggleCli,
    Quit,
    Minimize,
    ToggleFullscreen,
    CloseWindow,
}

impl Action {
    pub fn from_id(id: &str) -> Option<Action> {
        Some(match id {
            UPDATER_CHECK_ID => Action::CheckForUpdates,
            PREFERENCES_ID => Action::OpenPreferences,
            CLI_ID => Action::ToggleCli,
            QUIT_ID => Action::Quit,
            MINIMIZE_ID => Action::Minimize,
            FULLSCREEN_ID => Action::ToggleFullscreen,
            CLOSE_WINDOW_ID => Action::CloseWindow,
            _ => return None,
        })
    }
}

/// The rendered menu and the ordinary items by id (the updater and the macOS command item
/// rewrite their text later).
pub struct Built {
    pub menu: Menu<Wry>,
    pub items: HashMap<&'static str, MenuItem<Wry>>,
}

fn native_item(app: &tauri::AppHandle, n: Native) -> tauri::Result<PredefinedMenuItem<Wry>> {
    match n {
        Native::About => PredefinedMenuItem::about(app, Some("About Writer"), None),
        Native::Services => PredefinedMenuItem::services(app, None),
        Native::Hide => PredefinedMenuItem::hide(app, None),
        Native::HideOthers => PredefinedMenuItem::hide_others(app, None),
        Native::ShowAll => PredefinedMenuItem::show_all(app, None),
        Native::Quit => PredefinedMenuItem::quit(app, None),
        Native::Undo => PredefinedMenuItem::undo(app, None),
        Native::Redo => PredefinedMenuItem::redo(app, None),
        Native::Cut => PredefinedMenuItem::cut(app, None),
        Native::Copy => PredefinedMenuItem::copy(app, None),
        Native::Paste => PredefinedMenuItem::paste(app, None),
        Native::SelectAll => PredefinedMenuItem::select_all(app, None),
        Native::Minimize => PredefinedMenuItem::minimize(app, None),
        Native::Fullscreen => PredefinedMenuItem::fullscreen(app, None),
        Native::CloseWindow => PredefinedMenuItem::close_window(app, None),
    }
}

/// Render `definition(os)` as a Tauri menu.
pub fn build(app: &tauri::AppHandle, os: Os) -> tauri::Result<Built> {
    let mut items = HashMap::new();
    let mut menu = MenuBuilder::new(app);
    for section in definition(os) {
        let mut sub = SubmenuBuilder::new(app, section.title);
        for entry in &section.entries {
            sub = match entry {
                Entry::Separator => sub.separator(),
                Entry::Native(n) => sub.item(&native_item(app, *n)? as &dyn IsMenuItem<Wry>),
                Entry::Item {
                    id,
                    label,
                    accelerator,
                } => {
                    let mut b = MenuItemBuilder::with_id(*id, *label);
                    if let Some(a) = accelerator {
                        b = b.accelerator(*a);
                    }
                    let built = b.build(app)?;
                    let sub = sub.item(&built);
                    items.insert(*id, built);
                    sub
                }
            };
        }
        menu = menu.item(&sub.build()?);
    }
    Ok(Built {
        menu: menu.build()?,
        items,
    })
}

/// The Linux popup menu, built once at startup (it holds the updater's item), and the window it
/// was last opened on: Minimize, Close and Full Screen act on that window, not on whichever one
/// happens to report focus once the popup has taken it.
pub struct PopupMenu {
    pub menu: Menu<Wry>,
    window: Mutex<Option<String>>,
}

impl PopupMenu {
    pub fn new(menu: Menu<Wry>) -> Self {
        Self {
            menu,
            window: Mutex::new(None),
        }
    }

    /// The label of the window the menu was last opened on.
    pub fn window_label(&self) -> Option<String> {
        self.window.lock().ok().and_then(|w| w.clone())
    }
}

/// Open the app menu at the pointer: the chrome bar's menu button and the Alt key call this.
/// Linux only: the state is managed there alone, and on macOS (the native menu bar) this is a
/// no-op.
#[tauri::command]
pub async fn app_menu_popup(app: tauri::AppHandle, window: tauri::Window) -> Result<(), AppError> {
    use tauri::menu::ContextMenu;
    use tauri::Manager;
    let Some(popup) = app.try_state::<PopupMenu>() else {
        return Ok(());
    };
    if let Ok(mut w) = popup.window.lock() {
        *w = Some(window.label().to_string());
    }
    popup
        .menu
        .popup(window)
        .map_err(|e| AppError::Io(e.to_string()))
}

/// Quit the app through the same exit path as the macOS quit item (Linux's Ctrl+Q).
#[tauri::command]
pub async fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(os: Os) -> Vec<&'static str> {
        definition(os)
            .iter()
            .flat_map(|s| s.entries.iter())
            .filter_map(|e| match e {
                Entry::Item { id, .. } => Some(*id),
                _ => None,
            })
            .collect()
    }

    fn natives(os: Os) -> Vec<Native> {
        definition(os)
            .iter()
            .flat_map(|s| s.entries.iter())
            .filter_map(|e| match e {
                Entry::Native(n) => Some(*n),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn both_oses_share_the_titles_and_the_app_items() {
        let titles = |os| definition(os).iter().map(|s| s.title).collect::<Vec<_>>();
        assert_eq!(titles(Os::MacOs), titles(Os::Linux));
        for id in [UPDATER_CHECK_ID, PREFERENCES_ID] {
            assert!(ids(Os::MacOs).contains(&id), "{id} on macOS");
            assert!(ids(Os::Linux).contains(&id), "{id} on Linux");
        }
        assert_eq!(
            ids(Os::MacOs)
                .into_iter()
                .filter(
                    |i| ![QUIT_ID, MINIMIZE_ID, FULLSCREEN_ID, CLOSE_WINDOW_ID, CLI_ID].contains(i)
                )
                .collect::<Vec<_>>(),
            ids(Os::Linux)
                .into_iter()
                .filter(
                    |i| ![QUIT_ID, MINIMIZE_ID, FULLSCREEN_ID, CLOSE_WINDOW_ID, CLI_ID].contains(i)
                )
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn macos_only_items_are_absent_on_linux() {
        let linux = natives(Os::Linux);
        for n in [
            Native::Services,
            Native::Hide,
            Native::HideOthers,
            Native::ShowAll,
        ] {
            assert!(natives(Os::MacOs).contains(&n));
            assert!(!linux.contains(&n), "{n:?} on Linux");
        }
        // The command-line-tool item comes back on Linux with its listener.
        assert!(ids(Os::MacOs).contains(&CLI_ID));
        assert!(!ids(Os::Linux).contains(&CLI_ID));
    }

    #[test]
    fn every_item_id_of_both_menus_has_a_handled_action() {
        for os in [Os::MacOs, Os::Linux] {
            for id in ids(os) {
                assert!(Action::from_id(id).is_some(), "{os:?}: {id} has no handler");
            }
        }
    }

    #[derive(serde::Deserialize)]
    struct ReservedChords {
        macos: Vec<String>,
        other: Vec<String>,
    }

    fn accelerators(os: Os) -> Vec<String> {
        definition(os)
            .iter()
            .flat_map(|s| s.entries.iter())
            .filter_map(|e| match e {
                Entry::Item { accelerator, .. } => {
                    accelerator.map(|a| a.replace("CmdOrCtrl", "Mod"))
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn reserved_chords_cover_the_menu_accelerators_and_linux_has_none() {
        let reserved: ReservedChords =
            serde_json::from_str(include_str!("../../shared/reserved-chords.json")).unwrap();
        for a in accelerators(Os::MacOs) {
            assert!(reserved.macos.contains(&a), "{a} is not reserved on macOS");
        }
        assert_eq!(accelerators(Os::Linux), Vec::<String>::new());
        assert!(reserved.other.is_empty());
    }

    fn outline(os: Os) -> String {
        definition(os)
            .iter()
            .map(|s| {
                let entries: Vec<String> = s
                    .entries
                    .iter()
                    .map(|e| match e {
                        Entry::Separator => "-".to_string(),
                        Entry::Native(n) => format!("{n:?}"),
                        Entry::Item {
                            id,
                            label,
                            accelerator,
                        } => format!("{id}={label}[{}]", accelerator.unwrap_or("")),
                    })
                    .collect();
                format!("{}: {}", s.title, entries.join(" | "))
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_macos_menu_is_what_it_was_before_the_shared_definition() {
        assert_eq!(
            outline(Os::MacOs),
            "Writer: About | - | updater.check=Check for Updates…[] | - | preferences.open=Preferences…[CmdOrCtrl+,] | cli.toggle=Install 'writer' Command Line Tool…[] | - | Services | - | Hide | HideOthers | ShowAll | - | Quit\n\
Edit: Undo | Redo | - | Cut | Copy | Paste | SelectAll\n\
Window: Minimize | Fullscreen | CloseWindow"
        );
    }

    #[test]
    fn the_linux_menu_outline() {
        assert_eq!(
            outline(Os::Linux),
            "Writer: About | - | updater.check=Check for Updates…[] | - | preferences.open=Preferences…[] | - | app.quit=Quit[]\n\
Edit: Cut | Copy | Paste | SelectAll\n\
Window: window.minimize=Minimize[] | window.fullscreen=Toggle Full Screen[] | window.close=Close Window[]"
        );
    }

    #[test]
    fn linux_uses_only_what_gtk_implements_natively() {
        for n in natives(Os::Linux) {
            assert!(matches!(n.on_linux(), OnLinux::Native), "{n:?}");
        }
    }

    #[test]
    fn linux_replaces_unsupported_predefined_items_with_ordinary_ones() {
        for id in [QUIT_ID, MINIMIZE_ID, FULLSCREEN_ID, CLOSE_WINDOW_ID] {
            assert!(ids(Os::Linux).contains(&id), "{id}");
            assert!(!ids(Os::MacOs).contains(&id), "{id}");
        }
    }

    #[test]
    fn linux_sections_never_start_or_end_with_a_separator_or_double_one() {
        for section in definition(Os::Linux) {
            assert_ne!(section.entries.first(), Some(&Entry::Separator));
            assert_ne!(section.entries.last(), Some(&Entry::Separator));
            assert!(section
                .entries
                .windows(2)
                .all(|w| !(w[0] == Entry::Separator && w[1] == Entry::Separator)));
        }
    }

    #[test]
    fn item_ids_are_unique_per_os() {
        for os in [Os::MacOs, Os::Linux] {
            let mut all = ids(os);
            let n = all.len();
            all.sort_unstable();
            all.dedup();
            assert_eq!(all.len(), n);
        }
    }
}
