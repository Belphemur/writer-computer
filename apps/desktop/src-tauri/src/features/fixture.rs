//! Test-only fixture feature: proves registration, enablement, the ACL contract and the plain
//! function path without shipping a no-op feature. Its data lives in
//! `tests/fixtures/features/fixture-hello/` so `build.rs` (which scans `src/features/*/`) never
//! turns it into a real plugin.

use super::{Feature, InvokeHandler};
use tauri::Runtime;

pub const MANIFEST: &str = include_str!("../../tests/fixtures/features/fixture-hello/feature.json");
pub const SETTINGS: &str =
    include_str!("../../tests/fixtures/features/fixture-hello/settings.schema.json");

pub fn greeting(name: &str) -> String {
    format!("hello {name}")
}

#[tauri::command]
pub async fn hello_greet(name: String) -> Result<String, String> {
    Ok(greeting(&name))
}

#[tauri::command]
pub async fn hello_shout(name: String) -> Result<String, String> {
    Ok(greeting(&name).to_uppercase())
}

pub fn handler<R: Runtime>() -> InvokeHandler<R> {
    Box::new(tauri::generate_handler![hello_greet, hello_shout])
}

pub struct FixtureHello;

impl<R: Runtime> Feature<R> for FixtureHello {
    fn manifest_source(&self) -> &'static str {
        MANIFEST
    }
    fn settings_source(&self) -> Option<&'static str> {
        Some(SETTINGS)
    }
    fn invoke_handler(&self) -> Option<InvokeHandler<R>> {
        Some(handler::<R>())
    }
}

pub fn registry<R: Runtime>() -> Vec<&'static dyn Feature<R>> {
    vec![&FixtureHello]
}
