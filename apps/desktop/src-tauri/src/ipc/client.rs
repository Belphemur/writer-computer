//! The blocking client the `writer` CLI uses: read the token, connect, send one request, wait for
//! the answer (ADR 2026-11-18, point 5). No tokio: a `UnixStream` on Unix, the pipe opened as a
//! file on Windows.
//!
//! "Writer is not running" is not an error of the exchange but a fact about the endpoint: no token
//! file, no socket, or a socket nobody listens on ([`ClientError::NotRunning`]).

use super::endpoint;
use super::protocol::{parse_response, request_json, RemoteError, MAX_MESSAGE_BYTES};
use serde_json::{Map, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum ClientError {
    /// No token, no socket, or nobody behind it.
    NotRunning,
    /// The app did not answer within the wait.
    Timeout,
    /// The app answered with an error.
    Remote(RemoteError),
    /// The exchange itself went wrong (a broken or foreign answer).
    Protocol(String),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRunning => write!(f, "Writer is not running"),
            Self::Timeout => write!(f, "Writer did not answer in time"),
            Self::Remote(e) => write!(f, "{}", e.message),
            Self::Protocol(m) => write!(f, "{m}"),
        }
    }
}

/// One request id per process is enough: a connection carries one request.
const REQUEST_ID: &str = "1";

/// The wire line of a request (the client's encoder, pinned by `shared/ipc-vectors.json`).
pub fn encode_request(
    token: &str,
    cmd: &str,
    vault: Option<&str>,
    args: &Map<String, Value>,
) -> Vec<u8> {
    let mut line = serde_json::to_vec(&request_json(REQUEST_ID, token, cmd, vault, args))
        .expect("a JSON value always serializes");
    line.push(b'\n');
    line
}

/// Send `cmd` and return its result. A token the app has since rotated (the app restarted between
/// reading the file and connecting) is re-read once.
pub fn call(
    dir: &Path,
    cmd: &str,
    vault: Option<&str>,
    args: &Map<String, Value>,
    wait: Duration,
) -> Result<Value, ClientError> {
    let mut last = None;
    for _ in 0..2 {
        let token = endpoint::read_token(dir).ok_or(ClientError::NotRunning)?;
        match exchange(dir, &encode_request(&token, cmd, vault, args), wait) {
            Err(ClientError::Remote(e)) if e.code == "unauthorized" => {
                last = Some(ClientError::Remote(e));
            }
            other => return other,
        }
    }
    Err(last.unwrap_or(ClientError::NotRunning))
}

fn exchange(dir: &Path, request: &[u8], wait: Duration) -> Result<Value, ClientError> {
    let reply = transport::roundtrip(dir, request, wait)?;
    let response = parse_response(&reply).map_err(ClientError::Protocol)?;
    if response.id != REQUEST_ID && !response.id.is_empty() {
        return Err(ClientError::Protocol(
            "the answer is for another request".into(),
        ));
    }
    response.outcome.map_err(ClientError::Remote)
}

/// Read one answer line of at most [`MAX_MESSAGE_BYTES`].
fn read_answer<R: Read>(reader: R) -> Result<Vec<u8>, ClientError> {
    let mut buf = Vec::new();
    let mut limited = BufReader::new(reader).take(MAX_MESSAGE_BYTES as u64 + 2);
    match limited.read_until(b'\n', &mut buf) {
        Ok(0) => Err(ClientError::Protocol("Writer closed the connection".into())),
        Ok(_) => {
            while matches!(buf.last(), Some(b'\n' | b'\r')) {
                buf.pop();
            }
            Ok(buf)
        }
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            Err(ClientError::Timeout)
        }
        Err(e) => Err(ClientError::Protocol(e.to_string())),
    }
}

#[cfg(unix)]
mod transport {
    use super::*;
    use std::io::ErrorKind;
    use std::os::unix::net::UnixStream;

    pub fn roundtrip(dir: &Path, request: &[u8], wait: Duration) -> Result<Vec<u8>, ClientError> {
        let mut stream =
            UnixStream::connect(endpoint::socket_path(dir)).map_err(|e| match e.kind() {
                ErrorKind::NotFound | ErrorKind::ConnectionRefused => ClientError::NotRunning,
                _ => ClientError::Protocol(e.to_string()),
            })?;
        let io = |e: std::io::Error| ClientError::Protocol(e.to_string());
        stream.set_read_timeout(Some(wait)).map_err(io)?;
        stream.set_write_timeout(Some(wait)).map_err(io)?;
        stream.write_all(request).map_err(io)?;
        read_answer(&stream)
    }
}

#[cfg(windows)]
mod transport {
    use super::*;

    /// A pipe handle has no read timeout, so the exchange runs on a thread that is abandoned when
    /// the wait is over (the process exits right after).
    pub fn roundtrip(_dir: &Path, request: &[u8], wait: Duration) -> Result<Vec<u8>, ClientError> {
        let name =
            super::super::windows::pipe_name().map_err(|e| ClientError::Protocol(e.to_string()))?;
        let mut pipe = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&name)
            .map_err(|_| ClientError::NotRunning)?;
        let request = request.to_vec();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let result = pipe
                .write_all(&request)
                .map_err(|e| ClientError::Protocol(e.to_string()))
                .and_then(|()| read_answer(&mut pipe));
            let _ = tx.send(result);
        });
        rx.recv_timeout(wait).unwrap_or(Err(ClientError::Timeout))
    }
}
