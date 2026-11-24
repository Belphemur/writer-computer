//! HTTP to one `opencode serve`: the Basic header on every request, a request per call, the event
//! stream, and a runtime of its own to run them on (spec `SPECs/opencode-backend-spec.md` section 5).
//!
//! `reqwest` here is async only, and everything else in the agent is plain threads, so [`Io`] owns
//! one current-thread runtime on one scope thread: callers on a thread use [`Io::call`] (block for
//! the answer, with a deadline), the transports spawn their own tasks on it. It lives as long as
//! the server's owner and survives the server process being restarted.
//!
//! Loopback only, no proxy, no redirects. Never logged: URLs, bodies, headers, the password, error
//! bodies (an error is reduced to its status and `_tag`).

use super::opencode_api::{encode, ErrorBody, Method, Route, WireBody};
use crate::features::scope::Spawner;
use base64::Engine as _;
use serde_json::Value;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Where a server listens and how to talk to it.
#[derive(Clone)]
pub struct Endpoint {
    /// `http://127.0.0.1:<port>`, no trailing slash.
    pub base: String,
    /// The `Authorization` header value (`Basic ...`), built from the one-time password.
    auth: String,
}

impl Endpoint {
    pub fn new(base: &str, password: &str) -> Self {
        let token =
            base64::engine::general_purpose::STANDARD.encode(format!("opencode:{password}"));
        Self {
            base: base.trim_end_matches('/').to_string(),
            auth: format!("Basic {token}"),
        }
    }

    /// An endpoint with a wrong or missing password (tests: the 401 path).
    #[cfg(test)]
    pub fn without_password(base: &str) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            auth: String::new(),
        }
    }
}

impl std::fmt::Debug for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // the header is a secret
        f.debug_struct("Endpoint")
            .field("base", &self.base)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    /// The server answered with an error status; `tag` is its `_tag` (`SessionNotFoundError`).
    Status { status: u16, tag: String },
    /// No answer: refused, reset, malformed.
    Transport(String),
    /// No answer in time.
    Timeout,
    /// Writer refused to go on, for a reason it states itself (never a server's words).
    Refused(String),
}

impl ApiError {
    pub fn is_not_found(&self) -> bool {
        matches!(self, ApiError::Status { status: 404, .. })
    }

    /// A prompt id another session holds (ids are global).
    pub fn is_conflict(&self) -> bool {
        matches!(self, ApiError::Status { status: 409, .. })
    }

    pub fn is_unauthorized(&self) -> bool {
        matches!(self, ApiError::Status { status: 401, .. })
    }

    /// The server could not be reached (as opposed to refusing the request).
    pub fn is_down(&self) -> bool {
        matches!(self, ApiError::Transport(_) | ApiError::Timeout)
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Status { status, tag } => write!(f, "OpenCode answered {status} {tag}"),
            ApiError::Transport(_) => write!(f, "OpenCode could not be reached"),
            ApiError::Timeout => write!(f, "OpenCode did not answer in time"),
            ApiError::Refused(why) => write!(f, "{why}"),
        }
    }
}

/// How long a request may take. A prompt boots the session's location on its first call (1.7 s in
/// the spike, minutes with a large user config): it gets the long one.
/// Tests have a few seconds, so a stuck call fails the test instead of holding the suite.
pub const SHORT: Duration = Duration::from_secs(if cfg!(test) { 5 } else { 30 });
pub const LONG: Duration = Duration::from_secs(if cfg!(test) { 8 } else { 180 });

/// The runtime every request and every stream of one server owner runs on.
pub struct Io {
    handle: tokio::runtime::Handle,
    http: reqwest::Client,
    stop: Arc<AtomicBool>,
}

impl Io {
    /// Builds the runtime and starts its thread on `spawner`; the thread ends with the spawner's
    /// token or with [`Io::stop`].
    pub fn start(spawner: &Spawner) -> Result<Arc<Io>, String> {
        // reqwest is built with `rustls-no-provider`: make sure one is installed
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| format!("runtime: {e}"))?;
        let handle = rt.handle().clone();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stop);
        spawner
            .spawn("opencode-io", move |token| {
                rt.block_on(async move {
                    while !flag.load(Ordering::SeqCst) && !token.is_cancelled() {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                });
                // in-flight tasks are dropped with the runtime
                rt.shutdown_background();
            })
            .map_err(|e| e.to_string())?;
        Ok(Arc::new(Io { handle, http, stop }))
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    pub fn is_stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    pub fn spawn<F>(&self, task: F)
    where
        F: Future<Output = ()> + Send + 'static,
    {
        drop(self.handle.spawn(task));
    }

    /// Runs `fut` on the runtime and blocks this thread for its answer: `None` when it did not
    /// come in `wait` (or the runtime is gone). For the two calls that may block (`start`,
    /// `unqueue`) and for tests; never from the runtime's own thread.
    pub fn call<T, F>(&self, fut: F, wait: Duration) -> Option<T>
    where
        T: Send + 'static,
        F: Future<Output = T> + Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel();
        drop(self.handle.spawn(async move {
            let _ = tx.send(fut.await);
        }));
        rx.recv_timeout(wait).ok()
    }

    pub fn client(self: &Arc<Self>, endpoint: Endpoint) -> Client {
        Client {
            io: Arc::clone(self),
            endpoint,
        }
    }
}

/// The typed side of one server: a route filled with its arguments, a body, an answer.
#[derive(Clone)]
pub struct Client {
    io: Arc<Io>,
    endpoint: Endpoint,
}

impl Client {
    pub fn io(&self) -> &Arc<Io> {
        &self.io
    }

    /// One request. `Value::Null` for an empty reply (204). `query` pairs are appended to the path.
    pub async fn request(
        &self,
        route: &Route,
        args: &[(&str, &str)],
        query: &[(&str, &str)],
        body: Option<Value>,
        wait: Duration,
    ) -> Result<Value, ApiError> {
        let mut url = format!("{}{}", self.endpoint.base, route.path(args));
        for (i, (k, v)) in query.iter().enumerate() {
            url.push(if i == 0 { '?' } else { '&' });
            url.push_str(k);
            url.push('=');
            url.push_str(&encode(v));
        }
        let method = match route.method {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
            Method::Put => reqwest::Method::PUT,
            Method::Patch => reqwest::Method::PATCH,
            Method::Delete => reqwest::Method::DELETE,
        };
        let mut req = self
            .io
            .http
            .request(method, url)
            .header("authorization", &self.endpoint.auth)
            .timeout(wait);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await.map_err(transport)?;
        let status = resp.status();
        let bytes = resp.bytes().await.map_err(transport)?;
        if !status.is_success() {
            let tag = serde_json::from_slice::<ErrorBody>(&bytes)
                .map(|b| b._tag)
                .unwrap_or_default();
            return Err(ApiError::Status {
                status: status.as_u16(),
                tag,
            });
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|_| ApiError::Transport("unreadable reply".into()))
    }

    /// `request` with a typed body.
    pub async fn send<B: WireBody>(
        &self,
        route: &Route,
        args: &[(&str, &str)],
        body: &B,
        wait: Duration,
    ) -> Result<Value, ApiError> {
        let body = serde_json::to_value(body).map_err(|e| ApiError::Transport(e.to_string()))?;
        self.request(route, args, &[], Some(body), wait).await
    }

    /// `request` with no body and no query.
    pub async fn get(&self, route: &Route, args: &[(&str, &str)]) -> Result<Value, ApiError> {
        self.request(route, args, &[], None, SHORT).await
    }

    /// Opens `GET /api/event`: the response whose body is the stream (no total timeout).
    pub async fn open_events(&self) -> Result<reqwest::Response, ApiError> {
        let resp = self
            .io
            .http
            .get(format!(
                "{}{}",
                self.endpoint.base,
                super::opencode_api::EVENT.template
            ))
            .header("authorization", &self.endpoint.auth)
            .header("accept", "text/event-stream")
            .send()
            .await
            .map_err(transport)?;
        if !resp.status().is_success() {
            return Err(ApiError::Status {
                status: resp.status().as_u16(),
                tag: String::new(),
            });
        }
        Ok(resp)
    }
}

/// A reqwest error without its URL (a path can hold an id; never a note path, but kept out of
/// every message all the same).
fn transport(e: reqwest::Error) -> ApiError {
    if e.is_timeout() {
        ApiError::Timeout
    } else {
        ApiError::Transport(
            if e.is_connect() {
                "connection refused"
            } else {
                "request failed"
            }
            .into(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_endpoint_never_shows_its_header() {
        let e = Endpoint::new("http://127.0.0.1:1234/", "s3cret");
        assert_eq!(e.base, "http://127.0.0.1:1234");
        let shown = format!("{e:?}");
        assert!(!shown.contains("s3cret") && !shown.contains("Basic"));
        assert!(e.auth.starts_with("Basic "));
    }

    #[test]
    fn query_values_are_percent_encoded() {
        assert_eq!(
            encode("The user prefers not to"),
            "The%20user%20prefers%20not%20to"
        );
        assert_eq!(encode("a&b=c"), "a%26b%3Dc");
    }
}
