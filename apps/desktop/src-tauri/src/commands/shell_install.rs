//! Install/uninstall the `writer` command on the user's PATH: the Tauri commands and the two
//! per-OS installers over the shared core in `cli_install`.
//!
//! macOS links `/usr/local/bin/writer` to the bundle binary (so an in-place update keeps working)
//! and asks for an administrator password when that folder is not writable. Linux links
//! `~/.local/bin/writer` to the AppImage file or the running binary and never elevates; the
//! `.deb`/`.rpm` ship `/usr/bin/writer` themselves. Settings > Command line is the Linux UI; the
//! menu item for the AppImage belongs to the window lane's menu definition (`lib.rs`) and calls
//! `install_cli_blocking`.

#![cfg(unix)]

use crate::cli_install::{self, CliInstallStatus, InstallError, Plan};
use std::io;
use std::path::Path;
use tauri::AppHandle;

/// Canonical on-disk location for the installed `writer` shim on macOS.
#[cfg(target_os = "macos")]
pub const INSTALL_TARGET: &str = "/usr/local/bin/writer";

#[cfg(target_os = "macos")]
fn plan() -> Result<Plan, InstallError> {
    Ok(Plan {
        target: std::path::PathBuf::from(INSTALL_TARGET),
        source: std::env::current_exe().ok(),
    })
}

#[cfg(target_os = "linux")]
fn plan() -> Result<Plan, InstallError> {
    let target = cli_install::user_target(std::env::var_os("HOME").as_deref())
        .ok_or(InstallError::TargetUnknown)?;
    Ok(Plan {
        target,
        source: cli_install::pick_source(
            std::env::var_os("APPIMAGE"),
            std::env::current_exe().ok(),
        ),
    })
}

/// Only the `.deb`/`.rpm` install a link of their own, and only Linux has them.
fn package_target() -> Option<&'static Path> {
    cfg!(target_os = "linux").then(|| Path::new(cli_install::PACKAGE_TARGET))
}

/// This process's PATH plus the login shell's: a GUI launch often misses `~/.local/bin`, which
/// the user's terminal has.
fn path_var() -> String {
    let process = std::env::var("PATH").unwrap_or_default();
    format!("{process}:{}", crate::plugin_env::login_path())
}

#[cfg(target_os = "macos")]
mod elevate {
    use super::*;
    use std::process::Command;

    fn run(script: &str, args: &[&Path]) -> Result<(), InstallError> {
        let output = Command::new("osascript")
            .args(["-e", script, "--"])
            .args(args)
            .output()?;
        if output.status.success() {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(InstallError::Elevation(if stderr.is_empty() {
            "user cancelled or authorization declined".into()
        } else {
            stderr
        }))
    }

    /// Paths are passed as positional arguments so AppleScript's `quoted form` handles escaping;
    /// we never concatenate user paths into a shell command.
    pub fn symlink(source: &Path, target: &Path) -> Result<(), InstallError> {
        let parent = target.parent().ok_or_else(|| {
            InstallError::Io(io::Error::new(
                io::ErrorKind::InvalidInput,
                "install target has no parent directory",
            ))
        })?;
        let script = r#"on run argv
  set parentDir to item 1 of argv
  set srcPath to item 2 of argv
  set tgtPath to item 3 of argv
  do shell script "mkdir -p " & quoted form of parentDir & " && rm -f " & quoted form of tgtPath & " && ln -s " & quoted form of srcPath & " " & quoted form of tgtPath with administrator privileges
end run"#;
        run(script, &[parent, source, target])
    }

    pub fn unlink(target: &Path) -> Result<(), InstallError> {
        let script = r#"on run argv
  set tgtPath to item 1 of argv
  do shell script "rm -f " & quoted form of tgtPath with administrator privileges
end run"#;
        run(script, &[target])
    }
}

#[cfg(target_os = "linux")]
mod elevate {
    use super::*;

    fn denied(target: &Path) -> InstallError {
        InstallError::Io(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("no permission to write {}", target.display()),
        ))
    }

    pub fn symlink(_source: &Path, target: &Path) -> Result<(), InstallError> {
        Err(denied(target))
    }

    pub fn unlink(target: &Path) -> Result<(), InstallError> {
        Err(denied(target))
    }
}

#[tauri::command]
pub async fn cli_status(_app: AppHandle) -> Result<CliInstallStatus, InstallError> {
    // Stats the install target and the app binary and may start the login shell: off the main thread.
    run_blocking(cli_status_blocking).await
}

/// For callers already on a blocking thread (the app menu).
pub(crate) fn cli_status_blocking() -> Result<CliInstallStatus, InstallError> {
    Ok(cli_install::status(&plan()?, package_target(), &path_var()))
}

#[tauri::command]
pub async fn install_cli(_app: AppHandle) -> Result<CliInstallStatus, InstallError> {
    // The macOS elevation fallback shows the system admin prompt and waits for it: never on the
    // main thread, which is the event loop that has to keep painting that prompt's parent window.
    run_blocking(install_cli_blocking).await
}

pub(crate) fn install_cli_blocking() -> Result<CliInstallStatus, InstallError> {
    cli_install::install(&plan()?, package_target(), &path_var(), elevate::symlink)
}

#[tauri::command]
pub async fn uninstall_cli(_app: AppHandle) -> Result<CliInstallStatus, InstallError> {
    run_blocking(uninstall_cli_blocking).await
}

pub(crate) fn uninstall_cli_blocking() -> Result<CliInstallStatus, InstallError> {
    cli_install::uninstall(&plan()?, package_target(), &path_var(), elevate::unlink)
}

async fn run_blocking(
    f: fn() -> Result<CliInstallStatus, InstallError>,
) -> Result<CliInstallStatus, InstallError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| InstallError::Io(io::Error::other(e.to_string())))?
}
