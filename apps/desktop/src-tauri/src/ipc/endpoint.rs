//! Where the socket lives and who may reach it (ADR 2026-11-18, point 1 and 2).
//!
//! Unix: `ipc/ipc.sock` and `ipc/ipc.token` in the app data dir, the `ipc/` folder `0700` (created
//! or corrected at startup), the socket and the token `0600`.
//! Windows: a named pipe `\\.\pipe\writer-<hash of the user SID>` with a security descriptor that
//! grants only the current user ([`windows`]). The token is a fresh `uuid` v4 per launch, written
//! atomically beside the socket; a launch deletes the old token before it binds, so a client never
//! pairs an old token with the new socket.

use std::path::{Path, PathBuf};

pub const SOCKET_FILE: &str = "ipc.sock";
pub const TOKEN_FILE: &str = "ipc.token";

/// `sockaddr_un.sun_path` is 104 bytes on macOS and 108 on Linux, with the terminating NUL.
#[cfg(unix)]
pub const MAX_SOCKET_PATH: usize = 100;

/// The folder of the endpoint: `ipc/` inside the app data dir, `0700`, holding the socket and the
/// token. The app data dir itself is never chmod-ed.
pub const IPC_DIR: &str = "ipc";

pub fn ipc_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(IPC_DIR)
}

/// Every function below takes the app data dir and works inside [`ipc_dir`].
pub fn socket_path(dir: &Path) -> PathBuf {
    ipc_dir(dir).join(SOCKET_FILE)
}

pub fn token_path(dir: &Path) -> PathBuf {
    ipc_dir(dir).join(TOKEN_FILE)
}

/// A new per-launch token: 122 random bits.
pub fn new_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[derive(Debug, thiserror::Error)]
pub enum EndpointError {
    #[error("another Writer is already serving {0}")]
    InUse(String),
    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for EndpointError {
    fn from(e: std::io::Error) -> Self {
        EndpointError::Io(e.to_string())
    }
}

/// Create `dir` if needed and make it owner-only.
#[cfg(unix)]
fn ensure_private_dir(dir: &Path) -> Result<(), EndpointError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// Remove what a previous launch left at the socket path. A socket that still answers belongs to a
/// live Writer and is left alone ([`EndpointError::InUse`]); one that refuses is stale and is
/// unlinked. Anything that is not a socket is never deleted.
#[cfg(unix)]
fn clear_stale_socket(path: &Path) -> Result<(), EndpointError> {
    use std::os::unix::fs::FileTypeExt;
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    if !meta.file_type().is_socket() {
        return Err(EndpointError::Io(format!(
            "{SOCKET_FILE} exists and is not a socket; not touching it"
        )));
    }
    if std::os::unix::net::UnixStream::connect(path).is_ok() {
        return Err(EndpointError::InUse(SOCKET_FILE.into()));
    }
    std::fs::remove_file(path)?;
    Ok(())
}

/// Prepare the endpoint of this launch: private dir, no stale socket, old token removed, socket
/// bound and `0600`, new token written (`0600`, atomically). Returns the listener and the token.
#[cfg(unix)]
pub fn bind_unix(dir: &Path) -> Result<(std::os::unix::net::UnixListener, String), EndpointError> {
    use std::os::unix::fs::PermissionsExt;
    let socket = socket_path(dir);
    if socket.as_os_str().len() >= MAX_SOCKET_PATH {
        return Err(EndpointError::Io(format!(
            "the app data directory is too long for a socket: {SOCKET_FILE} would be {} bytes, the limit is {MAX_SOCKET_PATH}",
            socket.as_os_str().len()
        )));
    }
    let ipc = ipc_dir(dir);
    ensure_private_dir(&ipc)?;
    clear_stale_socket(&socket)?;
    match std::fs::remove_file(token_path(dir)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let listener = std::os::unix::net::UnixListener::bind(&socket)?;
    let finish = || -> Result<String, EndpointError> {
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        let token = new_token();
        crate::plugins::write_atomic_private(&ipc, TOKEN_FILE, token.as_bytes())
            .map_err(EndpointError::Io)?;
        Ok(token)
    };
    match finish() {
        Ok(token) => Ok((listener, token)),
        Err(e) => {
            let _ = std::fs::remove_file(&socket);
            Err(e)
        }
    }
}

/// Remove the socket and the token (exit). A missing file is fine.
pub fn remove_files(dir: &Path) {
    let _ = std::fs::remove_file(socket_path(dir));
    let _ = std::fs::remove_file(token_path(dir));
}

/// The token a client reads. `None` when the app is not running (no file) or the file is empty.
pub fn read_token(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(token_path(dir)).ok()?;
    let token = text.trim();
    (!token.is_empty()).then(|| token.to_string())
}
