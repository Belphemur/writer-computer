//! Pilot 2 of the built-in features (SPECs/builtin-plugins-spec.md): mouse side buttons.
//!
//! Rust half of `features/mouse-buttons/`. On macOS the native `NSEvent` monitor
//! ([`macos_mouse`]) turns buttons 3 and 4 into the `mouse-buttons:navigate` event; the web half
//! (`web/`) listens for it and also handles the DOM events other webviews deliver. The monitor is
//! installed whenever `features.mouse-buttons.enabled` is on (default); that kill switch is the
//! only control (the `WRITER_NATIVE_MOUSE` opt-in is gone). When it is off the runner never calls
//! [`Feature::setup`], so the monitor is never installed and the web half registers nothing.
//! The monitor aborted the app twice (spec "Crash"); every defence in [`macos_mouse`] stays, but a
//! native abort cannot be caught in release builds, so the kill switch is the escape hatch.
//! Spec: `SPECs/mouse-side-buttons-spec.md`.

#[cfg(target_os = "macos")]
pub(crate) mod macos_mouse;

use crate::features::Feature;
use tauri::{AppHandle, Runtime};

pub struct MouseButtons;

impl<R: Runtime> Feature<R> for MouseButtons {
    fn manifest_source(&self) -> &'static str {
        include_str!("../feature.json")
    }

    fn setup(&self, app: &AppHandle<R>) -> Result<(), String> {
        native_setup(app)
    }
}

#[cfg(target_os = "macos")]
fn native_setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    macos_mouse::install(app)
}

#[cfg(not(target_os = "macos"))]
fn native_setup<R: Runtime>(_app: &AppHandle<R>) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::{is_enabled, plan, Manifest};
    use tauri::Wry;

    #[test]
    fn manifest_names_the_event_the_monitor_emits() {
        let m: Manifest = serde_json::from_str(include_str!("../feature.json")).unwrap();
        assert_eq!(m.id, "mouse-buttons");
        #[cfg(target_os = "macos")]
        assert_eq!(m.rust.events, [macos_mouse::EVENT]);
    }

    #[test]
    fn enabled_by_default_it_is_planned_so_the_runner_installs_the_monitor() {
        let dir = tempfile::tempdir().unwrap();
        let s = crate::config::Settings::new(dir.path().to_path_buf()).unwrap();
        let feats: Vec<&'static dyn Feature<Wry>> = vec![&MouseButtons];
        assert_eq!(plan(feats, &s).len(), 1, "no env var gates it any more");
    }

    #[test]
    fn switched_off_it_is_not_planned_and_the_monitor_is_not_installed() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = crate::config::Settings::new(dir.path().to_path_buf()).unwrap();
        s.set_global(
            "features.mouse-buttons.enabled",
            crate::config::ConfigValue::Bool(false),
        )
        .unwrap();
        let feats: Vec<&'static dyn Feature<Wry>> = vec![&MouseButtons];
        assert!(plan(feats, &s).is_empty(), "the runner never sets it up");
        #[cfg(target_os = "macos")]
        assert!(!macos_mouse::is_installed());
        let m: Manifest = serde_json::from_str(include_str!("../feature.json")).unwrap();
        assert!(!is_enabled(&s, &m));
    }
}
