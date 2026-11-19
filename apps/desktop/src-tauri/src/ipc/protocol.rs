//! The wire format of the CLI-to-app socket (ADR 2026-11-18, spec `SPECs/writer-cli-spec.md`
//! "Talking to the running app"): one JSON object per line, UTF-8, at most [`MAX_MESSAGE_BYTES`].
//!
//! ```text
//! {"v":1,"id":"1","token":"...","cmd":"open","vault":"/abs/vault","args":{"path":"Note.md"}}
//! {"v":1,"id":"1","ok":true,"result":{...}}
//! {"v":1,"id":"1","ok":false,"error":{"code":"invalid_args","message":"..."}}
//! ```
//!
//! The shapes are pinned for both ends by `shared/ipc-vectors.json` (read by the server tests and
//! the client tests). Nothing here does IO.

use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::time::Duration;

/// The protocol version both ends speak. An unknown `v` is refused.
pub const VERSION: u32 = 1;
/// The longest request or response line, newline excluded.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// How long the server waits for a request line to arrive.
pub const READ_TIMEOUT: Duration = Duration::from_secs(5);
/// The default time a command may take (server deadline and client wait).
pub const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

/// A machine-readable refusal. The string form is the wire `code`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// Not JSON, not an object of the expected shape, or not a single line.
    BadRequest,
    /// The token is missing or wrong. The message never says which.
    Unauthorized,
    UnsupportedVersion,
    UnknownCommand,
    /// The command belongs to a feature that is off or failed.
    FeatureOff,
    /// The command needs a vault that is not open in Writer.
    VaultNotOpen,
    InvalidArgs,
    /// A path that must exist does not, or escapes the vault.
    InvalidPath,
    NotFound,
    Timeout,
    TooLarge,
    /// Writer is busy (too many connections) or the window did not answer.
    Unavailable,
    Internal,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadRequest => "bad_request",
            Self::Unauthorized => "unauthorized",
            Self::UnsupportedVersion => "unsupported_version",
            Self::UnknownCommand => "unknown_command",
            Self::FeatureOff => "feature_off",
            Self::VaultNotOpen => "vault_not_open",
            Self::InvalidArgs => "invalid_args",
            Self::InvalidPath => "invalid_path",
            Self::NotFound => "not_found",
            Self::Timeout => "timeout",
            Self::TooLarge => "too_large",
            Self::Unavailable => "unavailable",
            Self::Internal => "internal",
        }
    }
}

/// A refusal or failure: a code and a short message (never note text, paths or the token).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IpcError {
    pub code: ErrorCode,
    pub message: String,
}

impl IpcError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
    pub fn invalid_args(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgs, message)
    }
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for IpcError {}

impl From<crate::vault_ops::VaultOpError> for IpcError {
    fn from(e: crate::vault_ops::VaultOpError) -> Self {
        match e {
            crate::vault_ops::VaultOpError::NotFound(_) => {
                IpcError::new(ErrorCode::NotFound, e.to_string())
            }
            // The confinement messages quote the argument the caller sent; they stay on the
            // socket (never logged), so the caller learns what it got wrong.
            other => IpcError::new(ErrorCode::InvalidPath, other.to_string()),
        }
    }
}

/// One request line, as sent. `id` is echoed back.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Request {
    pub v: u32,
    #[serde(default)]
    pub id: String,
    /// Missing is the same as wrong: refused as `unauthorized`, not as a shape error.
    #[serde(default)]
    pub token: String,
    pub cmd: String,
    #[serde(default)]
    pub vault: Option<String>,
    #[serde(default)]
    pub args: Map<String, Value>,
}

/// The JSON of a request (the client's encoder; the server only ever parses).
pub fn request_json(
    id: &str,
    token: &str,
    cmd: &str,
    vault: Option<&str>,
    args: &Map<String, Value>,
) -> Value {
    let mut v = json!({ "v": VERSION, "id": id, "token": token, "cmd": cmd, "args": args });
    if let Some(vault) = vault {
        v["vault"] = json!(vault);
    }
    v
}

/// Parse one request line (without its newline). The error is always the generic
/// `bad_request`: a peer that sends garbage learns nothing about the shape.
pub fn parse_request(line: &[u8]) -> Result<Request, IpcError> {
    serde_json::from_slice(line)
        .map_err(|_| IpcError::new(ErrorCode::BadRequest, "malformed request"))
}

/// The response line (with its trailing newline). `id` is empty when the request never parsed.
pub fn response_line(id: &str, outcome: &Result<Value, IpcError>) -> Vec<u8> {
    let body = match outcome {
        Ok(result) => json!({ "v": VERSION, "id": id, "ok": true, "result": result }),
        Err(e) => json!({
            "v": VERSION, "id": id, "ok": false,
            "error": { "code": e.code.as_str(), "message": e.message }
        }),
    };
    let mut line = serde_json::to_vec(&body).expect("a JSON value always serializes");
    if line.len() > MAX_MESSAGE_BYTES {
        // A result that does not fit is a bug of the command, not something to truncate.
        line = serde_json::to_vec(&json!({
            "v": VERSION, "id": id, "ok": false,
            "error": { "code": ErrorCode::TooLarge.as_str(), "message": "the answer is too large" }
        }))
        .expect("a JSON value always serializes");
    }
    line.push(b'\n');
    line
}

/// A parsed response line, on the client.
#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub id: String,
    pub outcome: Result<Value, RemoteError>,
}

/// An error the app answered with: the wire code (kept as a string so a newer app's code does not
/// break an older CLI) and message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteError {
    pub code: String,
    pub message: String,
}

pub fn parse_response(line: &[u8]) -> Result<Response, String> {
    let v: Value =
        serde_json::from_slice(line).map_err(|_| "the answer is not JSON".to_string())?;
    if v.get("v").and_then(Value::as_u64) != Some(u64::from(VERSION)) {
        return Err("the app speaks another protocol version".into());
    }
    let id = v
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let outcome = match v.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
        Some(false) => {
            let text = |k: &str| {
                v.pointer(&format!("/error/{k}"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            };
            Err(RemoteError {
                code: text("code"),
                message: text("message"),
            })
        }
        None => return Err("the answer has no ok field".into()),
    };
    Ok(Response { id, outcome })
}

/// Constant-time token comparison (the length of a token is not secret, its bytes are).
pub fn token_matches(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
