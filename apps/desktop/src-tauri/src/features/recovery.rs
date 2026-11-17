//! Crash markers, the startup counter and safe mode: what a feature failure that cannot unwind
//! (an Objective-C exception, a segfault, an abort) leaves behind for the next launch.
//! ADR 2026-11-17 "contain feature failures with unwinding panics and recover from native
//! crashes on the next launch"; SPECs/builtin-plugins-spec.md "Failure containment and recovery".
//!
//! Tauri-free: this file only knows files in `<app data dir>/features/` and the pure decision
//! [`recover`]. `features/mod.rs` writes the markers around risky code and applies the plan.
//!
//! - `inside.json`: [`Marker`], written (atomically) before a feature runs `setup`, a hook or a
//!   declared native call, removed right after. Left behind by another process = that process
//!   died inside the feature.
//! - `active-native.json`: [`Active`] list of features whose native code is live (the mouse
//!   monitor). Removed on a clean exit. Left behind by another process = the process died while
//!   native code of that feature was installed.
//! - `startup.json`: [`Startup`], the number of launches that did not reach "ready" (the first
//!   window finished loading). [`SAFE_MODE_AFTER`] in a row start the next run in safe mode.
//!
//! A corrupt or unreadable file is ignored with a warning (never a reason not to start). Nothing
//! here is written per IPC call or per keystroke.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// Launches in a row that never became ready before the next launch is a safe-mode launch.
pub const SAFE_MODE_AFTER: u32 = 2;

const INSIDE: &str = "inside.json";
const ACTIVE: &str = "active-native.json";
const STARTUP: &str = "startup.json";

/// `features.<id>.enabled`: the setting a marker without its own narrower one blames.
pub fn enabled_setting(id: &str) -> String {
    format!("features.{id}.enabled")
}

/// "The process `pid` was inside `boundary` of feature `id` at `at` (unix ms)". `setting` is the
/// narrowest setting to switch off when that process died there (absent: the feature's kill switch).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Marker {
    pub id: String,
    pub boundary: String,
    pub pid: u32,
    pub at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setting: Option<String>,
}

/// Native code of feature `id` that stays live in process `pid` until a clean exit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Active {
    pub id: String,
    pub pid: u32,
    pub at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setting: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Startup {
    failed: u32,
}

/// One setting to switch off because the previous run died in its feature.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Disable {
    pub id: String,
    pub setting: String,
    pub boundary: String,
}

#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    pub disable: Vec<Disable>,
    pub safe_mode: bool,
}

/// What the last run left behind, as read from disk.
#[derive(Debug, Default)]
pub struct Found {
    pub inside: Option<Marker>,
    pub active: Vec<Active>,
    pub failed_startups: u32,
}

/// The decision, pure. A marker or active entry written by `own_pid` is ours, not a crash; one
/// from another process is a crash of that feature, blamed on its narrowest setting unless
/// `is_on(setting)` says it is already off (nothing to turn off, no notice). `failed_startups`
/// counts earlier launches that never became ready.
pub fn recover(found: &Found, own_pid: u32, is_on: &dyn Fn(&str) -> bool) -> Plan {
    let mut plan = Plan {
        safe_mode: found.failed_startups >= SAFE_MODE_AFTER,
        ..Plan::default()
    };
    let mut blame = |id: &str, setting: &Option<String>, boundary: &str| {
        let setting = setting.clone().unwrap_or_else(|| enabled_setting(id));
        if is_on(&setting) && !plan.disable.iter().any(|d| d.setting == setting) {
            plan.disable.push(Disable {
                id: id.to_string(),
                setting,
                boundary: boundary.to_string(),
            });
        }
    };
    if let Some(m) = found.inside.as_ref().filter(|m| m.pid != own_pid) {
        blame(&m.id, &m.setting, &m.boundary);
    }
    for a in found.active.iter().filter(|a| a.pid != own_pid) {
        blame(&a.id, &a.setting, "native");
    }
    plan
}

/// The three files in `<app data dir>/features/`.
#[derive(Debug, Clone)]
pub struct Files {
    dir: PathBuf,
}

impl Files {
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            dir: app_data_dir.join("features"),
        }
    }

    fn write(&self, name: &str, bytes: &[u8]) {
        let res = fs::create_dir_all(&self.dir)
            .map_err(|e| e.to_string())
            .and_then(|()| crate::plugins::write_atomic(&self.dir, name, bytes));
        if let Err(e) = res {
            log::warn!("feature recovery: cannot write {name}: {e}");
        }
    }

    fn remove(&self, name: &str) {
        if let Err(e) = fs::remove_file(self.dir.join(name)) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("feature recovery: cannot remove {name}: {e}");
            }
        }
    }

    fn read<T: for<'de> Deserialize<'de>>(&self, name: &str) -> Option<T> {
        let text = match fs::read_to_string(self.dir.join(name)) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(e) => {
                log::warn!("feature recovery: cannot read {name}: {e}");
                return None;
            }
        };
        match serde_json::from_str(&text) {
            Ok(v) => Some(v),
            Err(_) => {
                log::warn!("feature recovery: {name} is corrupt and was ignored");
                None
            }
        }
    }

    pub fn write_inside(&self, marker: &Marker) {
        self.write(INSIDE, &serde_json::to_vec(marker).unwrap_or_default());
    }

    pub fn clear_inside(&self) {
        self.remove(INSIDE);
    }

    /// An empty list removes the file.
    pub fn write_active(&self, list: &[Active]) {
        if list.is_empty() {
            self.remove(ACTIVE);
        } else {
            self.write(ACTIVE, &serde_json::to_vec(list).unwrap_or_default());
        }
    }

    pub fn write_failed_startups(&self, failed: u32) {
        self.write(
            STARTUP,
            &serde_json::to_vec(&Startup { failed }).unwrap_or_default(),
        );
    }

    pub fn read_all(&self) -> Found {
        Found {
            inside: self.read(INSIDE),
            active: self.read(ACTIVE).unwrap_or_default(),
            failed_startups: self.read::<Startup>(STARTUP).map_or(0, |s| s.failed),
        }
    }

    /// Forget what the last run left: the plan has been applied.
    pub fn clear_found(&self) {
        self.remove(INSIDE);
        self.remove(ACTIVE);
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: u32 = 100;
    const OTHER: u32 = 200;

    fn marker(id: &str, pid: u32, setting: Option<&str>) -> Marker {
        Marker {
            id: id.into(),
            boundary: "setup".into(),
            pid,
            at: 1,
            setting: setting.map(String::from),
        }
    }

    fn all_on(_: &str) -> bool {
        true
    }

    #[test]
    fn a_stale_marker_from_another_process_disables_that_feature() {
        let found = Found {
            inside: Some(marker("fx-native", OTHER, None)),
            ..Found::default()
        };
        let plan = recover(&found, ME, &all_on);
        assert_eq!(plan.disable.len(), 1);
        assert_eq!(plan.disable[0].id, "fx-native");
        assert_eq!(plan.disable[0].setting, "features.fx-native.enabled");
        assert_eq!(plan.disable[0].boundary, "setup");
        assert!(!plan.safe_mode);
    }

    #[test]
    fn an_own_pid_or_absent_marker_does_nothing() {
        let own = Found {
            inside: Some(marker("a", ME, None)),
            ..Found::default()
        };
        assert_eq!(recover(&own, ME, &all_on), Plan::default());
        assert_eq!(recover(&Found::default(), ME, &all_on), Plan::default());
    }

    #[test]
    fn the_narrowest_setting_the_marker_names_is_the_one_turned_off() {
        let found = Found {
            active: vec![Active {
                id: "fx-native".into(),
                pid: OTHER,
                at: 1,
                setting: Some("features.fx-native.native".into()),
            }],
            ..Found::default()
        };
        let plan = recover(&found, ME, &all_on);
        assert_eq!(plan.disable[0].setting, "features.fx-native.native");
        assert_eq!(plan.disable[0].boundary, "native");
        // already off: nothing to do and no notice
        let off = recover(&found, ME, &|k| k != "features.fx-native.native");
        assert!(off.disable.is_empty());
    }

    #[test]
    fn one_setting_is_disabled_once() {
        let found = Found {
            inside: Some(marker("a", OTHER, Some("features.a.native"))),
            active: vec![Active {
                id: "a".into(),
                pid: OTHER,
                at: 1,
                setting: Some("features.a.native".into()),
            }],
            ..Found::default()
        };
        assert_eq!(recover(&found, ME, &all_on).disable.len(), 1);
    }

    #[test]
    fn two_failed_startups_give_safe_mode_and_a_ready_one_resets_the_counter() {
        let found = |n| Found {
            failed_startups: n,
            ..Found::default()
        };
        assert!(!recover(&found(0), ME, &all_on).safe_mode);
        assert!(!recover(&found(1), ME, &all_on).safe_mode);
        assert!(recover(&found(2), ME, &all_on).safe_mode);
        assert!(recover(&found(5), ME, &all_on).safe_mode);

        let dir = tempfile::tempdir().unwrap();
        let files = Files::new(dir.path());
        files.write_failed_startups(2);
        assert_eq!(files.read_all().failed_startups, 2);
        files.write_failed_startups(0); // what "ready" does
        assert_eq!(files.read_all().failed_startups, 0);
    }

    #[test]
    fn markers_round_trip_and_clear() {
        let dir = tempfile::tempdir().unwrap();
        let files = Files::new(dir.path());
        assert!(files.read_all().inside.is_none());
        let m = marker("a", ME, Some("features.a.native"));
        files.write_inside(&m);
        let active = Active {
            id: "a".into(),
            pid: ME,
            at: 2,
            setting: None,
        };
        files.write_active(std::slice::from_ref(&active));
        let found = files.read_all();
        assert_eq!(found.inside, Some(m));
        assert_eq!(found.active, vec![active]);
        files.clear_found();
        let found = files.read_all();
        assert!(found.inside.is_none() && found.active.is_empty());
    }

    #[test]
    fn a_corrupt_marker_file_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let files = Files::new(dir.path());
        std::fs::create_dir_all(dir.path().join("features")).unwrap();
        for name in [INSIDE, ACTIVE, STARTUP] {
            std::fs::write(dir.path().join("features").join(name), "{ not json").unwrap();
        }
        let found = files.read_all();
        assert!(found.inside.is_none() && found.active.is_empty());
        assert_eq!(found.failed_startups, 0);
        assert_eq!(recover(&found, ME, &all_on), Plan::default());
    }
}
