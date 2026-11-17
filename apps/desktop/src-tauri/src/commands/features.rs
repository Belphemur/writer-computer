//! Failure containment for the webview (SPECs/builtin-plugins-spec.md "Failure containment and
//! recovery"): the recovery report and this session's failures, and "Restart normally" out of
//! safe mode. In-memory reads and one small file write; the logic is in `features/`.

use crate::commands::blocking;
use crate::features::{self, Status};

#[tauri::command]
pub async fn features_status(app: tauri::AppHandle) -> Result<Status, crate::error::AppError> {
    Ok(features::status(&app))
}

/// Leaves safe mode: resets the failed-startup counter, then restarts the app.
#[tauri::command]
pub async fn features_restart_normally(
    app: tauri::AppHandle,
) -> Result<(), crate::error::AppError> {
    let handle = app.clone();
    blocking(move || {
        features::forget_failed_startups(&handle);
        Ok(())
    })
    .await?;
    app.restart()
}
