//! The server half of the socket: an accept loop on the app's tokio runtime and one task per
//! connection. A connection carries exactly one request and one answer, then closes.
//!
//! The guards, in the order a request meets them: owner-only endpoint (see [`super::endpoint`]) and
//! peer uid check, at most [`MAX_CONNECTIONS`] at once, a line of at most 64 KiB read within 5 s,
//! a well-formed request, the token, the protocol version, an allowlisted command, its feature
//! being live, the vault, then the command under its own deadline. Every refusal before the
//! command is one generic error; none of them says which check failed beyond its code.
//!
//! [`handle_connection`] is generic over the stream, so the Unix socket, the Windows pipe and the
//! tests' in-memory duplex all run the same code.

use super::endpoint;
use super::host::Host;
use super::protocol::{
    parse_request, response_line, token_matches, ErrorCode, IpcError, Request, MAX_MESSAGE_BYTES,
    READ_TIMEOUT, VERSION,
};
use super::registry::{Call, IpcCommand, Registry, Vault, VaultRule};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufRead, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{Notify, Semaphore};

/// Connections served at once; a further one is dropped.
const MAX_CONNECTIONS: usize = 16;

/// What every connection shares.
pub struct Shared {
    pub registry: Registry,
    pub host: Arc<dyn Host>,
    pub token: String,
    /// How long a request line may take to arrive ([`READ_TIMEOUT`]; shorter in tests).
    pub read_timeout: Duration,
}

impl Shared {
    pub fn new(registry: Registry, host: Arc<dyn Host>, token: String) -> Self {
        Self {
            registry,
            host,
            token,
            read_timeout: READ_TIMEOUT,
        }
    }
}

/// A request that passed the checks that need no IO.
#[derive(Debug)]
pub struct Admitted {
    pub request: Request,
    pub command: &'static IpcCommand,
}

/// A refusal, with the request id when the line parsed far enough to have one.
#[derive(Debug)]
pub struct Refused {
    pub id: String,
    pub error: IpcError,
}

/// The synchronous checks in order: parse, token, version, command, feature. Pure apart from
/// `host.feature_live`, so the shared vectors run through it without a socket.
pub fn admit(shared: &Shared, line: &[u8]) -> Result<Admitted, Refused> {
    let request = parse_request(line).map_err(|error| Refused {
        id: String::new(),
        error,
    })?;
    let refuse = |code, message: &str| Refused {
        id: request.id.clone(),
        error: IpcError::new(code, message),
    };
    // The token first: a peer that cannot authenticate learns nothing else.
    if !token_matches(&shared.token, &request.token) {
        return Err(refuse(ErrorCode::Unauthorized, "unauthorized"));
    }
    if request.v != VERSION {
        return Err(refuse(
            ErrorCode::UnsupportedVersion,
            "unsupported protocol version",
        ));
    }
    let Some(command) = shared.registry.find(&request.cmd) else {
        return Err(refuse(ErrorCode::UnknownCommand, "unknown command"));
    };
    if let Some(feature) = command.feature {
        if !shared.host.feature_live(feature) {
            return Err(refuse(
                ErrorCode::FeatureOff,
                &format!("the {feature} feature is turned off"),
            ));
        }
    }
    Ok(Admitted { request, command })
}

/// Resolve the request's `vault` for the command's rule (disk: canonicalize, on the blocking pool).
async fn resolve_vault(
    host: &Arc<dyn Host>,
    rule: VaultRule,
    given: Option<String>,
) -> Result<Option<Vault>, IpcError> {
    let Some(given) = given else {
        return match rule {
            VaultRule::Optional => Ok(None),
            _ => Err(IpcError::invalid_args("vault is required")),
        };
    };
    let path = PathBuf::from(&given);
    if !path.is_absolute() {
        return Err(IpcError::invalid_args("vault must be an absolute path"));
    }
    let canonical = tokio::task::spawn_blocking(move || path.canonicalize())
        .await
        .map_err(|_| IpcError::new(ErrorCode::Internal, "the check did not finish"))?;
    let root = match canonical {
        Ok(root) if root.is_dir() => root,
        _ => {
            return Err(IpcError::new(
                ErrorCode::InvalidPath,
                "the vault is not a folder",
            ))
        }
    };
    let open = host.open_vaults().contains(&root);
    if rule == VaultRule::MustBeOpen && !open {
        return Err(IpcError::new(
            ErrorCode::VaultNotOpen,
            "that vault is not open in Writer",
        ));
    }
    Ok(Some(Vault { root, open }))
}

/// Run an admitted request. The command runs in its own task under its deadline: a panic in it
/// (a feature's code) is reported to the host as that feature's failure instead of tearing the
/// connection down silently, and a deadline overrun aborts the task.
async fn run(shared: &Shared, admitted: Admitted) -> Result<Value, IpcError> {
    let Admitted { request, command } = admitted;
    let vault = resolve_vault(&shared.host, command.vault, request.vault).await?;
    let call = Call {
        host: shared.host.clone(),
        vault,
        args: request.args,
    };
    let run = command.run;
    let mut task = tokio::spawn(async move { run(call).await });
    match tokio::time::timeout(command.timeout, &mut task).await {
        Err(_) => {
            task.abort();
            Err(IpcError::new(
                ErrorCode::Timeout,
                "the command took too long",
            ))
        }
        Ok(Ok(outcome)) => outcome,
        Ok(Err(join)) => {
            if join.is_panic() {
                shared.host.command_panicked(command.feature);
            }
            Err(IpcError::new(ErrorCode::Internal, "the command failed"))
        }
    }
}

/// One request line: at most [`MAX_MESSAGE_BYTES`] before the newline.
async fn read_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, IpcError> {
    let mut buf = Vec::new();
    // The line, its newline, and one byte more to tell "exactly at the limit" from "over".
    let mut limited = reader.take(MAX_MESSAGE_BYTES as u64 + 2);
    let n = tokio::io::AsyncBufReadExt::read_until(&mut limited, b'\n', &mut buf)
        .await
        .map_err(|_| IpcError::new(ErrorCode::BadRequest, "malformed request"))?;
    if n == 0 {
        return Err(IpcError::new(ErrorCode::BadRequest, "empty request"));
    }
    let complete = buf.last() == Some(&b'\n');
    if complete {
        buf.pop();
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
    }
    if buf.len() > MAX_MESSAGE_BYTES {
        return Err(IpcError::new(
            ErrorCode::TooLarge,
            "the request is too large",
        ));
    }
    if !complete {
        return Err(IpcError::new(
            ErrorCode::BadRequest,
            "the request is not a full line",
        ));
    }
    Ok(buf)
}

/// What one connection ended with, for the log line: the command's name (a registered one, never
/// the client's string) and the outcome.
struct Finished {
    id: String,
    command: &'static str,
    outcome: Result<Value, IpcError>,
}

async fn serve_one<R: AsyncBufRead + Unpin>(shared: &Shared, reader: &mut R) -> Finished {
    let line = match tokio::time::timeout(shared.read_timeout, read_line(reader)).await {
        Err(_) => Err(IpcError::new(
            ErrorCode::Timeout,
            "no request arrived in time",
        )),
        Ok(line) => line,
    };
    let refused = |error: IpcError, id: String| Finished {
        id,
        command: "-",
        outcome: Err(error),
    };
    let line = match line {
        Ok(line) => line,
        Err(e) => return refused(e, String::new()),
    };
    match admit(shared, &line) {
        Err(Refused { id, error }) => refused(error, id),
        Ok(admitted) => {
            let id = admitted.request.id.clone();
            let command = admitted.command.name;
            Finished {
                id,
                command,
                outcome: run(shared, admitted).await,
            }
        }
    }
}

/// Serve one connection: read, answer, close. Logs the command name, outcome and duration, and
/// nothing else (SPECs/local-logging-spec.md "IPC").
pub async fn handle_connection<S>(stream: S, shared: Arc<Shared>)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let started = Instant::now();
    let (read, mut write) = tokio::io::split(stream);
    let mut reader = BufReader::new(read);
    let done = serve_one(&shared, &mut reader).await;
    let _ = write
        .write_all(&response_line(&done.id, &done.outcome))
        .await;
    let _ = write.shutdown().await;
    let outcome = match &done.outcome {
        Ok(_) => "ok",
        Err(e) => e.code.as_str(),
    };
    tracing::info!(
        target: "ipc",
        command = done.command,
        outcome,
        duration_ms = started.elapsed().as_millis() as u64,
        "ipc {} {}",
        done.command,
        outcome
    );
}

/// The running server: stop it at exit (also on drop). Stopping closes the listener and removes
/// the socket and the token, so a client sees "not running" at once.
pub struct ServerHandle {
    shutdown: Arc<Notify>,
    dir: PathBuf,
}

impl ServerHandle {
    pub fn stop(&self) {
        self.shutdown.notify_one();
        endpoint::remove_files(&self.dir);
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Start the server of this launch on `rt`: prepare the endpoint (private dir, stale socket gone,
/// fresh token), bind, accept. Fails explicitly when the endpoint cannot be made safe; the app
/// then runs without the socket.
#[cfg(unix)]
pub fn start(
    rt: &tokio::runtime::Handle,
    dir: &Path,
    registry: Registry,
    host: Arc<dyn Host>,
) -> Result<ServerHandle, endpoint::EndpointError> {
    let (std_listener, token) = endpoint::bind_unix(dir)?;
    let listener = {
        let _guard = rt.enter();
        tokio::net::UnixListener::from_std(std_listener)?
    };
    let shared = Arc::new(Shared::new(registry, host, token));
    let shutdown = Arc::new(Notify::new());
    rt.spawn(accept_unix(listener, shared, shutdown.clone()));
    Ok(ServerHandle {
        shutdown,
        dir: dir.to_path_buf(),
    })
}

#[cfg(unix)]
async fn accept_unix(
    listener: tokio::net::UnixListener,
    shared: Arc<Shared>,
    shutdown: Arc<Notify>,
) {
    let limit = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    // SAFETY: `geteuid` has no preconditions.
    let me = unsafe { libc::geteuid() };
    loop {
        let stream = tokio::select! {
            _ = shutdown.notified() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => stream,
                Err(e) => {
                    log::warn!("ipc accept failed: {e}");
                    continue;
                }
            },
        };
        // Defence in depth beside the 0700 directory: only the same user.
        if stream.peer_cred().map_or(true, |c| c.uid() != me) {
            continue;
        }
        let Ok(permit) = limit.clone().try_acquire_owned() else {
            continue;
        };
        let shared = shared.clone();
        tokio::spawn(async move {
            handle_connection(stream, shared).await;
            drop(permit);
        });
    }
}

/// The Windows twin of [`start`]: a named pipe for the current user only (`super::windows`).
#[cfg(windows)]
pub fn start(
    rt: &tokio::runtime::Handle,
    dir: &Path,
    registry: Registry,
    host: Arc<dyn Host>,
) -> Result<ServerHandle, endpoint::EndpointError> {
    let name = super::windows::pipe_name()?;
    let first = {
        let _guard = rt.enter();
        super::windows::create_instance(&name, true)?
    };
    let token = endpoint::new_token();
    let ipc = endpoint::ipc_dir(dir);
    std::fs::create_dir_all(&ipc)?;
    let _ = std::fs::remove_file(endpoint::token_path(dir));
    crate::plugins::write_atomic_private(&ipc, endpoint::TOKEN_FILE, token.as_bytes())
        .map_err(endpoint::EndpointError::Io)?;
    let shared = Arc::new(Shared::new(registry, host, token));
    let shutdown = Arc::new(Notify::new());
    rt.spawn(accept_pipe(name, first, shared, shutdown.clone()));
    Ok(ServerHandle {
        shutdown,
        dir: dir.to_path_buf(),
    })
}

#[cfg(windows)]
async fn accept_pipe(
    name: String,
    first: tokio::net::windows::named_pipe::NamedPipeServer,
    shared: Arc<Shared>,
    shutdown: Arc<Notify>,
) {
    let limit = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut server = first;
    loop {
        tokio::select! {
            _ = shutdown.notified() => break,
            connected = server.connect() => {
                if let Err(e) = connected {
                    log::warn!("ipc pipe accept failed: {e}");
                    continue;
                }
            }
        }
        let next = match super::windows::create_instance(&name, false) {
            Ok(next) => next,
            Err(e) => {
                log::error!("ipc pipe could not make a new instance, the socket stops: {e}");
                break;
            }
        };
        let stream = std::mem::replace(&mut server, next);
        let Ok(permit) = limit.clone().try_acquire_owned() else {
            continue;
        };
        let shared = shared.clone();
        tokio::spawn(async move {
            handle_connection(stream, shared).await;
            drop(permit);
        });
    }
}
