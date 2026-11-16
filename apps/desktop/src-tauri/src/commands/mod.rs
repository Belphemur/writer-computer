pub mod bases;
pub mod fonts;
pub mod fs;
pub mod images;
pub mod index;
pub mod logs;
pub mod plugins;
pub mod recents;
pub mod search;
pub mod settings;
#[cfg(target_os = "macos")]
pub mod shell_install;
pub mod skills;
pub mod startup;
pub mod workspace;

use crate::error::AppError;

/// The one way an IPC command touches the disk, SQLite, a keychain, a process or any other
/// blocking resource: declare the command `async` and run the work here.
///
/// Tauri runs a plain `fn` command on the main thread, which is the webview's event loop, so any
/// blocking call inside one freezes the whole UI; an `async fn` runs on the async runtime and
/// `spawn_blocking` keeps even that off its workers. `commands::tests::sync_commands_are_allowlisted`
/// fails when a new non-async command appears, so the choice is made on purpose.
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// Commands that stay plain `fn` (so they run on the main thread) on purpose. Each does only
    /// in-memory work, a single syscall, or must create windows from the main thread. Adding a
    /// command that touches disk, SQLite, a keychain or a process? Make it `async` and run the
    /// work through `blocking` instead of extending this list.
    const SYNC_ALLOWED: &[&str] = &[
        "close_workspace",
        "open_workspace",
        "open_workspace_in_new_window",
        "open_file_in_standalone_window",
        "watch_standalone_file",
        "take_pending_open",
        "plugin_http_stream_cancel",
        "plugin_proc_close_stdin",
        "plugin_proc_kill",
        "telemetry_should_prompt",
        "telemetry_mark_prompted",
        "telemetry_report_declined",
    ];

    fn visit(dir: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                visit(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let src = std::fs::read_to_string(&path).unwrap();
                let mut lines = src.lines().peekable();
                while let Some(line) = lines.next() {
                    if line.trim() != "#[tauri::command]" {
                        continue;
                    }
                    // skip further attributes / doc comments up to the signature
                    while let Some(next) = lines.peek() {
                        let t = next.trim();
                        if t.starts_with("#[") || t.starts_with("///") {
                            lines.next();
                        } else {
                            break;
                        }
                    }
                    if let Some(sig) = lines.next() {
                        let sig = sig.trim();
                        if let Some(rest) = sig.strip_prefix("pub fn ") {
                            let name = rest.split('(').next().unwrap_or(rest);
                            out.push(name.to_string());
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn sync_commands_are_allowlisted() {
        let mut found = Vec::new();
        visit(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut found,
        );
        let unexpected: Vec<_> = found
            .iter()
            .filter(|n| !SYNC_ALLOWED.contains(&n.as_str()))
            .collect();
        assert!(
            unexpected.is_empty(),
            "non-async #[tauri::command] runs on the main thread and freezes the UI while it does \
             IO: make these `async` and use `commands::blocking`: {unexpected:?}"
        );
    }
}
