//! Pilot 2 of the built-in features (SPECs/builtin-plugins-spec.md): mouse side buttons.
//!
//! Rust half of `features/mouse-buttons/`. On macOS the native `NSEvent` monitor
//! ([`macos_mouse`]) turns buttons 3 and 4 into the `mouse-buttons:navigate` event; the web half
//! (`web/`) listens for it and also handles the DOM events other webviews deliver. The monitor is
//! opt-in (`WRITER_NATIVE_MOUSE`) since it aborted the app twice (spec "Crash"); the kill switch
//! `features.mouse-buttons.enabled` sits above that: when it is off the runner never calls
//! [`Feature::setup`], so the monitor is never installed and the web half registers nothing.
//! Spec: `SPECs/mouse-side-buttons-spec.md`.

#[cfg(target_os = "macos")]
pub(crate) mod macos_mouse;

use crate::features::Feature;
use tauri::{AppHandle, Runtime};

/// Environment switch for the native monitor (opt-in, see the module docs).
pub(crate) const NATIVE_ENV: &str = "WRITER_NATIVE_MOUSE";

pub struct MouseButtons;

impl<R: Runtime> Feature<R> for MouseButtons {
    fn manifest_source(&self) -> &'static str {
        include_str!("../feature.json")
    }

    fn setup(&self, app: &AppHandle<R>) -> Result<(), String> {
        native_setup(app, std::env::var_os(NATIVE_ENV).is_some())
    }
}

#[cfg(target_os = "macos")]
fn native_setup<R: Runtime>(app: &AppHandle<R>, requested: bool) -> Result<(), String> {
    if requested {
        macos_mouse::install(app)
    } else {
        log::info!("native mouse monitor disabled (set {NATIVE_ENV}=1 to enable)");
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
fn native_setup<R: Runtime>(_app: &AppHandle<R>, _requested: bool) -> Result<(), String> {
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
