//! Where `writer excalidraw:preview` puts its image: a `writer-previews/` folder in the OS temp
//! directory, outside every vault, readable by the user alone (`0700`, files `0600`). A preview
//! is a look at the drawing, not a file of the user's, so it never lands in the vault and old
//! ones are swept on the next preview. Tauri-free; the base directory is a parameter so tests
//! never touch the real temp folder.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const FOLDER: &str = "writer-previews";
/// A preview older than this is deleted by the next one.
pub const KEEP: Duration = Duration::from_secs(60 * 60);

fn private_dir(base: &Path) -> std::io::Result<PathBuf> {
    let dir = base.join(FOLDER);
    match std::fs::symlink_metadata(&dir) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            return Err(std::io::Error::other(
                "the previews folder is not a plain folder",
            ))
        }
        Err(_) => {
            let mut b = std::fs::DirBuilder::new();
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
            b.create(&dir)?;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

/// Delete the files of `dir` last written more than [`KEEP`] before `now`.
fn sweep(dir: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let old = e
            .metadata()
            .ok()
            .filter(|m| m.is_file())
            .and_then(|m| m.modified().ok())
            .is_some_and(|t| now.duration_since(t).is_ok_and(|age| age > KEEP));
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// A name that is safe in any folder: the drawing's stem reduced to a short, plain label.
fn label(stem: &str) -> String {
    let plain: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .take(32)
        .collect();
    if plain.is_empty() {
        "drawing".into()
    } else {
        plain
    }
}

/// Write `bytes` as a new preview file under `base`/writer-previews and return its absolute path.
pub fn save(
    base: &Path,
    stem: &str,
    ext: &str,
    bytes: &[u8],
    now: SystemTime,
) -> std::io::Result<PathBuf> {
    let dir = private_dir(base)?;
    sweep(&dir, now);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let path = dir.join(format!("{}-{}.{ext}", label(stem), &id[..8]));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    opts.open(&path)?.write_all(bytes)?;
    Ok(path)
}
