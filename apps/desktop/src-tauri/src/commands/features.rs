//! Failure containment for the webview (SPECs/builtin-plugins-spec.md "Failure containment and
//! recovery"): the recovery report and this session's failures, and "Restart normally" out of
//! safe mode. In-memory reads and one small file write; the logic is in `features/`.

use crate::commands::blocking;
use crate::error::AppError;
use crate::features::{self, secrets, Status};

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

// Feature secrets (`features::secrets`): the scope check (the feature declares the key) is in
// Rust, so a feature cannot read another's secret. Arguments are never logged.

/// The value of a feature's declared secret, for that feature's web half; `None` when not set.
#[tauri::command]
pub async fn feature_secret_get(
    app: tauri::AppHandle,
    id: String,
    key: String,
) -> Result<Option<String>, AppError> {
    blocking(move || Ok(secrets::secret(&app, &id, &key)?.map(|v| v.expose().to_owned()))).await
}

#[tauri::command]
pub async fn feature_secret_set(
    app: tauri::AppHandle,
    id: String,
    key: String,
    secret: String,
) -> Result<(), AppError> {
    blocking(move || secrets::set_secret(&app, &id, &key, &secret)).await
}

#[tauri::command]
pub async fn feature_secret_delete(
    app: tauri::AppHandle,
    id: String,
    key: String,
) -> Result<(), AppError> {
    blocking(move || secrets::delete_secret(&app, &id, &key)).await
}

/// Which of the feature's declared secrets hold a value (keys only): Settings > Features shows
/// "set" or "not set" from it and never receives a value.
#[tauri::command]
pub async fn feature_secret_keys_set(
    app: tauri::AppHandle,
    id: String,
) -> Result<Vec<String>, AppError> {
    blocking(move || secrets::secret_keys_set(&app, &id)).await
}
