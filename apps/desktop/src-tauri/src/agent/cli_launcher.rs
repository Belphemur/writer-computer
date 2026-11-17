//! The `writer` command for the spawned agent, with no user setup (spec "Writer CLI for the
//! agent"). The Writer binary is itself the CLI (`main.rs` dispatches on argv[0]'s basename), so
//! the launcher is a symlink `<app data>/bin/writer` to the running binary, created or refreshed
//! when the first chat of a run starts and put first on the child's PATH (`env.rs`). Nothing
//! outside the app's own data directory is touched: no shell profile, no `/usr/local/bin` (that
//! one stays the user's "Install 'writer' Command Line Tool" choice).
//!
//! Tauri-free: the caller passes the directory and the executable.

use std::path::{Path, PathBuf};

/// The launcher's file name; `main.rs` runs the CLI when argv[0]'s basename is this.
pub const LAUNCHER_NAME: &str = "writer";

/// Make `dir/writer` a symlink to `exe` (replacing a stale link, e.g. after the app moved or was
/// updated) and return `dir`. A regular file named `writer` is left alone and is an error, so the
/// directory is never reported as a launcher it is not.
#[cfg(unix)]
pub fn ensure(dir: &Path, exe: &Path) -> std::io::Result<PathBuf> {
    use std::io::{Error, ErrorKind};
    std::fs::create_dir_all(dir)?;
    let link = dir.join(LAUNCHER_NAME);
    match link.symlink_metadata() {
        Ok(meta) if meta.file_type().is_symlink() => {
            if std::fs::read_link(&link)? == exe {
                return Ok(dir.to_path_buf());
            }
            std::fs::remove_file(&link)?;
        }
        Ok(_) => {
            return Err(Error::new(
                ErrorKind::AlreadyExists,
                "the launcher path is occupied by a file that is not a symlink",
            ))
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    std::os::unix::fs::symlink(exe, &link)?;
    Ok(dir.to_path_buf())
}

/// No launcher outside Unix (the CLI shim is macOS-first): the agent is told there is no CLI.
#[cfg(not(unix))]
pub fn ensure(_dir: &Path, _exe: &Path) -> std::io::Result<PathBuf> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "the writer launcher needs a Unix symlink",
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn creates_the_symlink_and_is_idempotent() {
        let d = tempfile::tempdir().unwrap();
        let exe = d.path().join("Writer");
        std::fs::write(&exe, "").unwrap();
        let dir = d.path().join("data/bin");
        assert_eq!(ensure(&dir, &exe).unwrap(), dir);
        assert_eq!(std::fs::read_link(dir.join("writer")).unwrap(), exe);
        assert_eq!(ensure(&dir, &exe).unwrap(), dir);
    }

    #[test]
    fn refreshes_a_stale_link() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("bin");
        ensure(&dir, &d.path().join("old")).unwrap();
        let new = d.path().join("new");
        ensure(&dir, &new).unwrap();
        assert_eq!(std::fs::read_link(dir.join("writer")).unwrap(), new);
    }

    #[test]
    fn never_replaces_a_regular_file() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("bin");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("writer"), "mine").unwrap();
        assert!(ensure(&dir, &d.path().join("Writer")).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("writer")).unwrap(), "mine");
    }
}
