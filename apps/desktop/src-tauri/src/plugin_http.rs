// Ported from opensidian (GPL-3.0-or-later), Copyright (C) 2026 Jendrik Poloczek.
// SPDX-License-Identifier: GPL-3.0-or-later
//! The HTTP(S) client behind an Obsidian plugin's `requestUrl` and a CORS-free
//! `fetch` (obsidian-copilot's LLM calls, including SSE streaming).
//!
//! Opensidian's version is a hand-rolled http:// client over std TCP because it
//! carries no TLS crate; Writer already ships reqwest + rustls, so this is a
//! fresh implementation of the same contract. Policy:
//!  - the caller (commands/plugins.rs) only reaches this module for a TRUSTED
//!    vault;
//!  - schemes: http and https only;
//!  - loopback and private ranges are allowed (Ollama, LM Studio, ...), but
//!    cloud-metadata endpoints are not: checked on the literal host of every
//!    hop AND on every address DNS returns (`GuardedResolver`), so a hostname
//!    that resolves to 169.254.169.254 is refused too;
//!  - request body <= 32 MiB; non-stream response body <= 64 MiB (a stream has
//!    no cap, it is delivered chunk by chunk);
//!  - hop-by-hop headers are dropped in both directions;
//!  - redirects are followed by hand (so every hop is re-checked) unless the
//!    caller asks not to; credentials do not follow a cross-origin redirect;
//!  - bodies, URLs' query strings and Authorization headers are never logged
//!    (this module does not log at all).

use base64::Engine as _;
use parking_lot::Mutex;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const MAX_REQUEST_BODY: usize = 32 * 1024 * 1024;
pub const MAX_RESPONSE_BODY: usize = 64 * 1024 * 1024;
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
pub const MAX_TIMEOUT_MS: u64 = 600_000;
pub const MAX_REDIRECTS: usize = 10;
pub const MAX_STREAMS: usize = 16;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    // framing/addressing is ours to set
    "host",
    "content-length",
];

/// Headers that must not follow a redirect to another origin.
const CREDENTIAL_HEADERS: &[&str] = &["authorization", "cookie", "x-api-key"];

#[derive(Debug, Clone, Deserialize)]
pub struct HttpRequest {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    /// UTF-8 request body. Mutually exclusive with `body_base64`.
    pub body: Option<String>,
    /// Binary request body, standard base64.
    pub body_base64: Option<String>,
    /// Default 60000, clamped to 1..=600000. For a stream this is the time to
    /// the response head and the idle time between chunks.
    pub timeout_ms: Option<u64>,
    /// Default true.
    pub follow_redirects: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HttpResponse {
    pub status: u16,
    /// Lowercased names, arrival order, duplicates kept, hop-by-hop removed.
    pub headers: Vec<(String, String)>,
    pub body_base64: String,
    /// The final URL after redirects.
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    Head {
        status: u16,
        headers: Vec<(String, String)>,
        url: String,
    },
    Chunk {
        data_base64: String,
    },
    End,
    Error {
        message: String,
    },
}

/* ------------------------------------------------------------ egress rules */

/// Cloud-metadata addresses: instance credentials live here.
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    let ip = match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    };
    match ip {
        IpAddr::V4(v4) => {
            v4 == Ipv4Addr::new(169, 254, 169, 254) // AWS / GCP / Azure / OpenStack
                || v4 == Ipv4Addr::new(169, 254, 170, 2) // ECS task credentials
                || v4 == Ipv4Addr::new(100, 100, 100, 200) // Alibaba
        }
        IpAddr::V6(v6) => v6 == Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254),
    }
}

fn is_blocked_hostname(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    h == "metadata.google.internal" || h == "metadata" || h == "instance-data"
}

/// The scheme/host gate applied to the first URL and every redirect hop.
pub fn check_url(u: &str) -> Result<url::Url, String> {
    let p = url::Url::parse(u).map_err(|_| "refused: not a valid URL".to_string())?;
    if !matches!(p.scheme(), "http" | "https") {
        return Err(format!("refused: unsupported scheme {:?}", p.scheme()));
    }
    match p.host() {
        None => return Err("refused: URL has no host".into()),
        Some(url::Host::Ipv4(a)) if is_blocked_ip(IpAddr::V4(a)) => {
            return Err(format!("refused: {a} is a cloud-metadata address"))
        }
        Some(url::Host::Ipv6(a)) if is_blocked_ip(IpAddr::V6(a)) => {
            return Err(format!("refused: {a} is a cloud-metadata address"))
        }
        Some(url::Host::Domain(d)) if is_blocked_hostname(d) => {
            return Err(format!("refused: {d} is a cloud-metadata host"))
        }
        Some(_) => {}
    }
    Ok(p)
}

/// DNS results are filtered too, so a name cannot smuggle a metadata address.
struct GuardedResolver;

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await?
                .filter(|a| !is_blocked_ip(a.ip()))
                .collect();
            if addrs.is_empty() {
                return Err(format!("refused: {host} resolves only to blocked addresses").into());
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

/* ---------------------------------------------------------------- client */

#[derive(Clone)]
pub struct HttpClient {
    client: reqwest::Client,
}

impl HttpClient {
    pub fn new(use_system_proxy: bool) -> Result<Self, String> {
        // reqwest is built with `rustls-no-provider`; make sure one is installed.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let mut b = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            .dns_resolver(GuardedResolver)
            .user_agent(concat!(
                "writer/",
                env!("CARGO_PKG_VERSION"),
                " plugin-host"
            ));
        if !use_system_proxy {
            b = b.no_proxy();
        }
        Ok(Self {
            client: b.build().map_err(|e| format!("http client: {e}"))?,
        })
    }

    pub fn shared() -> Result<Self, String> {
        static C: std::sync::OnceLock<HttpClient> = std::sync::OnceLock::new();
        if let Some(c) = C.get() {
            return Ok(c.clone());
        }
        let c = Self::new(true)?;
        Ok(C.get_or_init(|| c).clone())
    }
}

struct Prepared {
    url: url::Url,
    method: reqwest::Method,
    headers: Vec<(HeaderName, HeaderValue)>,
    body: Vec<u8>,
    timeout: Duration,
    follow: bool,
}

fn prepare(req: &HttpRequest) -> Result<Prepared, String> {
    let url = check_url(&req.url)?;
    let method = reqwest::Method::from_bytes(
        req.method
            .as_deref()
            .unwrap_or("GET")
            .to_ascii_uppercase()
            .as_bytes(),
    )
    .map_err(|_| "refused: invalid HTTP method".to_string())?;
    if matches!(method.as_str(), "CONNECT" | "TRACE") {
        return Err(format!("refused: method {method} is not allowed"));
    }
    let mut headers = Vec::new();
    for (k, v) in req.headers.iter().flatten() {
        if HOP_BY_HOP.contains(&k.to_ascii_lowercase().as_str()) {
            continue;
        }
        let name = HeaderName::from_bytes(k.as_bytes())
            .map_err(|_| format!("refused: invalid header name {k:?}"))?;
        let value = HeaderValue::from_str(v)
            .map_err(|_| format!("refused: invalid value for header {k:?}"))?;
        headers.push((name, value));
    }
    let body = match (&req.body, &req.body_base64) {
        (Some(_), Some(_)) => return Err("refused: both body and body_base64 given".into()),
        (Some(s), None) => {
            if s.len() > MAX_REQUEST_BODY {
                return Err("refused: request body over the 32 MiB cap".into());
            }
            s.clone().into_bytes()
        }
        (None, Some(b)) => {
            // 4 base64 chars carry 3 bytes: reject before allocating
            if b.len() / 4 * 3 > MAX_REQUEST_BODY + 3 {
                return Err("refused: request body over the 32 MiB cap".into());
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(b)
                .map_err(|_| "refused: body_base64 is not valid base64".to_string())?;
            if bytes.len() > MAX_REQUEST_BODY {
                return Err("refused: request body over the 32 MiB cap".into());
            }
            bytes
        }
        (None, None) => Vec::new(),
    };
    let ms = req
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);
    Ok(Prepared {
        url,
        method,
        headers,
        body,
        timeout: Duration::from_millis(ms),
        follow: req.follow_redirects.unwrap_or(true),
    })
}

fn same_origin(a: &url::Url, b: &url::Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

fn clean_headers(h: &HeaderMap) -> Vec<(String, String)> {
    h.iter()
        .filter(|(k, _)| !HOP_BY_HOP.contains(&k.as_str()))
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|v| (k.as_str().to_ascii_lowercase(), v.to_string()))
        })
        .collect()
}

fn timed_out() -> String {
    "ETIMEDOUT: request timed out".into()
}

/// Send, following redirects by hand. `deadline` bounds the time to a head.
async fn send(
    c: &HttpClient,
    p: &Prepared,
    deadline: Instant,
) -> Result<(reqwest::Response, url::Url), String> {
    let mut url = p.url.clone();
    let mut method = p.method.clone();
    let mut body = p.body.clone();
    let mut headers = p.headers.clone();
    for _ in 0..=MAX_REDIRECTS {
        let mut rb = c.client.request(method.clone(), url.clone());
        for (k, v) in &headers {
            rb = rb.header(k.clone(), v.clone());
        }
        if !body.is_empty() {
            rb = rb.body(body.clone());
        }
        let left = deadline.saturating_duration_since(Instant::now());
        let resp = tokio::time::timeout(left, rb.send())
            .await
            .map_err(|_| timed_out())?
            .map_err(|e| format!("request failed: {}", e.without_url()))?;
        let code = resp.status().as_u16();
        let loc = resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        if !p.follow || !matches!(code, 301 | 302 | 303 | 307 | 308) {
            return Ok((resp, url));
        }
        let Some(loc) = loc else {
            return Ok((resp, url));
        };
        let next = url
            .join(&loc)
            .map_err(|_| "refused: bad redirect Location".to_string())?;
        let next = check_url(next.as_str()).map_err(|e| format!("redirect {e}"))?;
        if code == 303 || (matches!(code, 301 | 302) && method == reqwest::Method::POST) {
            if method != reqwest::Method::HEAD {
                method = reqwest::Method::GET;
            }
            body.clear();
            headers.retain(|(k, _)| !k.as_str().starts_with("content-"));
        }
        if !same_origin(&url, &next) {
            headers.retain(|(k, _)| !CREDENTIAL_HEADERS.contains(&k.as_str()));
        }
        url = next;
    }
    Err(format!("ELOOP: more than {MAX_REDIRECTS} redirects"))
}

/// One buffered request: the whole response body, capped at 64 MiB.
pub async fn request(c: &HttpClient, req: &HttpRequest) -> Result<HttpResponse, String> {
    let p = prepare(req)?;
    let deadline = Instant::now() + p.timeout;
    let (mut resp, url) = send(c, &p, deadline).await?;
    if resp
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE_BODY as u64)
    {
        return Err("E2BIG: response body over the 64 MiB cap".into());
    }
    let status = resp.status().as_u16();
    let headers = clean_headers(resp.headers());
    let mut body = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let next = tokio::time::timeout(left, resp.chunk())
            .await
            .map_err(|_| timed_out())?
            .map_err(|e| format!("response failed: {}", e.without_url()))?;
        let Some(chunk) = next else { break };
        if body.len() + chunk.len() > MAX_RESPONSE_BODY {
            return Err("E2BIG: response body over the 64 MiB cap".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(HttpResponse {
        status,
        headers,
        body_base64: base64::engine::general_purpose::STANDARD.encode(&body),
        url: url.to_string(),
    })
}

/* --------------------------------------------------------------- streaming */

/// Returns false once the receiver is gone; the stream then stops.
pub type Emit = Arc<dyn Fn(StreamEvent) -> bool + Send + Sync>;

struct StreamEntry {
    label: String,
    root: PathBuf,
    cancelled: Arc<AtomicBool>,
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Default)]
pub struct StreamRegistry {
    next: AtomicU64,
    entries: Arc<Mutex<HashMap<u64, StreamEntry>>>,
}

impl StreamRegistry {
    #[cfg(test)]
    pub fn active(&self) -> usize {
        self.entries.lock().len()
    }

    /// Validate the request, then run it in the background. Validation errors
    /// (bad URL, blocked target, ...) come back here; everything later is an
    /// `Error` event. `label`/`root` tie the stream to a window and vault.
    pub fn start(
        &self,
        client: HttpClient,
        label: &str,
        root: PathBuf,
        req: &HttpRequest,
        emit: Emit,
    ) -> Result<u64, String> {
        let p = prepare(req)?;
        let mut entries = self.entries.lock();
        if entries.len() >= MAX_STREAMS {
            return Err(format!("EBUSY: more than {MAX_STREAMS} open streams"));
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst) + 1;
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancelled);
        let registry = Arc::clone(&self.entries);
        // The task's final `remove` waits on the lock we hold until the handle
        // is stored, so a fast stream cannot leave a stale entry behind.
        let handle = tauri::async_runtime::spawn(async move {
            let guarded: Emit = {
                let flag = Arc::clone(&flag);
                Arc::new(move |ev| !flag.load(Ordering::SeqCst) && emit(ev))
            };
            run_stream(&client, &p, &guarded).await;
            registry.lock().remove(&id);
        });
        entries.insert(
            id,
            StreamEntry {
                label: label.to_string(),
                root,
                cancelled,
                handle: Some(handle),
            },
        );
        Ok(id)
    }

    fn cancel_entry(entry: &mut StreamEntry) {
        entry.cancelled.store(true, Ordering::SeqCst);
        if let Some(h) = entry.handle.take() {
            h.abort();
        }
    }

    /// Cancel one stream of window `label`. Unknown or foreign ids are a no-op.
    /// After this returns no further event is delivered for the stream.
    pub fn cancel(&self, label: &str, id: u64) -> bool {
        let mut entries = self.entries.lock();
        if entries.get(&id).is_some_and(|e| e.label == label) {
            if let Some(mut e) = entries.remove(&id) {
                Self::cancel_entry(&mut e);
                return true;
            }
        }
        false
    }

    pub fn cancel_window(&self, label: &str) {
        self.cancel_where(|e| e.label == label);
    }

    /// Trust revoked or vault switched: cancel every stream of that vault.
    pub fn cancel_root(&self, root: &std::path::Path) {
        self.cancel_where(|e| e.root == root);
    }

    fn cancel_where(&self, pred: impl Fn(&StreamEntry) -> bool) {
        let mut entries = self.entries.lock();
        let ids: Vec<u64> = entries
            .iter()
            .filter(|(_, e)| pred(e))
            .map(|(i, _)| *i)
            .collect();
        for id in ids {
            if let Some(mut e) = entries.remove(&id) {
                Self::cancel_entry(&mut e);
            }
        }
    }
}

async fn run_stream(c: &HttpClient, p: &Prepared, emit: &Emit) {
    let deadline = Instant::now() + p.timeout;
    let (mut resp, url) = match send(c, p, deadline).await {
        Ok(r) => r,
        Err(message) => {
            emit(StreamEvent::Error { message });
            return;
        }
    };
    if !emit(StreamEvent::Head {
        status: resp.status().as_u16(),
        headers: clean_headers(resp.headers()),
        url: url.to_string(),
    }) {
        return;
    }
    loop {
        match tokio::time::timeout(p.timeout, resp.chunk()).await {
            Err(_) => {
                emit(StreamEvent::Error {
                    message: timed_out(),
                });
                return;
            }
            Ok(Err(e)) => {
                emit(StreamEvent::Error {
                    message: format!("response failed: {}", e.without_url()),
                });
                return;
            }
            Ok(Ok(None)) => {
                emit(StreamEvent::End);
                return;
            }
            Ok(Ok(Some(chunk))) => {
                let data_base64 = base64::engine::general_purpose::STANDARD.encode(&chunk);
                if !emit(StreamEvent::Chunk { data_base64 }) {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;

    fn client() -> HttpClient {
        HttpClient::new(false).unwrap()
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tauri::async_runtime::block_on(f)
    }

    fn read_head(c: &mut TcpStream) -> String {
        let mut b = Vec::new();
        let mut k = [0u8; 4096];
        loop {
            let n = c.read(&mut k).unwrap_or(0);
            b.extend_from_slice(&k[..n]);
            if let Some(e) = b.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&b[..e]).to_string();
                let cl = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while b.len() < e + 4 + cl {
                    let n = c.read(&mut k).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    b.extend_from_slice(&k[..n]);
                }
                return String::from_utf8_lossy(&b).into_owned();
            }
            if n == 0 {
                return String::from_utf8_lossy(&b).into_owned();
            }
        }
    }

    /// Serve `n` connections with `handler`; returns (port, requests seen).
    fn serve(
        n: usize,
        handler: impl Fn(usize, String, TcpStream) + Send + 'static,
    ) -> (u16, mpsc::Receiver<String>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for i in 0..n {
                let Ok((mut c, _)) = l.accept() else { return };
                let req = read_head(&mut c);
                let _ = tx.send(req.clone());
                handler(i, req, c);
            }
        });
        (port, rx)
    }

    fn get(url: String) -> HttpRequest {
        HttpRequest {
            url,
            method: None,
            headers: None,
            body: None,
            body_base64: None,
            timeout_ms: Some(5_000),
            follow_redirects: None,
        }
    }

    #[test]
    fn status_headers_and_binary_body() {
        let (port, rx) = serve(1, |_, _, mut c| {
            let _ = c.write_all(
                b"HTTP/1.1 201 Created\r\nX-A: 1\r\nConnection: close\r\nContent-Length: 3\r\n\r\n\x00\xff\x07",
            );
        });
        let mut r = get(format!("http://127.0.0.1:{port}/p?q=1"));
        r.method = Some("post".into());
        r.headers = Some(HashMap::from([
            ("X-Token".to_string(), "abc".to_string()),
            ("Connection".to_string(), "upgrade".to_string()),
        ]));
        r.body_base64 = Some(base64::engine::general_purpose::STANDARD.encode(b"hi"));
        let out = run(request(&client(), &r)).unwrap();
        assert_eq!(out.status, 201);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&out.body_base64)
                .unwrap(),
            vec![0u8, 0xff, 7]
        );
        assert!(out.headers.contains(&("x-a".into(), "1".into())));
        assert!(!out.headers.iter().any(|(k, _)| k == "connection"));
        let seen = rx.recv().unwrap();
        assert!(seen.starts_with("POST /p?q=1 HTTP/1.1\r\n"));
        assert!(seen.to_ascii_lowercase().contains("x-token: abc"));
        assert!(!seen.to_ascii_lowercase().contains("upgrade"));
        assert!(seen.ends_with("\r\n\r\nhi"));
    }

    #[test]
    fn redirects_are_followed_or_returned() {
        let (port, rx) = serve(3, |i, _, mut c| {
            let _ = match i {
                0 => c.write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n",
                ),
                1 => c.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"),
                _ => c.write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n",
                ),
            };
        });
        let mut r = get(format!("http://127.0.0.1:{port}/first"));
        r.method = Some("POST".into());
        r.body = Some("{}".into());
        r.headers = Some(HashMap::from([(
            "Content-Type".to_string(),
            "application/json".to_string(),
        )]));
        let out = run(request(&client(), &r)).unwrap();
        assert_eq!(out.status, 200);
        assert_eq!(out.url, format!("http://127.0.0.1:{port}/next"));
        let first = rx.recv().unwrap();
        let second = rx.recv().unwrap();
        assert!(first.starts_with("POST /first"));
        assert!(second.starts_with("GET /next"));
        assert!(!second.to_ascii_lowercase().contains("content-type"));

        // follow_redirects=false hands the 3xx back
        let mut r = get(format!("http://127.0.0.1:{port}/again"));
        r.follow_redirects = Some(false);
        let out = run(request(&client(), &r)).unwrap();
        assert_eq!(out.status, 302);
        assert!(out.headers.contains(&("location".into(), "/next".into())));
    }

    #[test]
    fn redirect_to_metadata_is_refused() {
        let (port, _rx) = serve(1, |_, _, mut c| {
            let _ = c.write_all(
                b"HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data\r\nContent-Length: 0\r\n\r\n",
            );
        });
        let err = run(request(
            &client(),
            &get(format!("http://127.0.0.1:{port}/")),
        ))
        .unwrap_err();
        assert!(err.contains("cloud-metadata"), "{err}");
    }

    #[test]
    fn credentials_do_not_cross_origins() {
        let (other, rx_other) = serve(1, |_, _, mut c| {
            let _ = c.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        });
        let (port, _rx) = serve(1, move |_, _, mut c| {
            let _ = c.write_all(
                format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: http://localhost:{other}/x\r\nContent-Length: 0\r\n\r\n")
                    .as_bytes(),
            );
        });
        let mut r = get(format!("http://127.0.0.1:{port}/"));
        r.headers = Some(HashMap::from([(
            "Authorization".to_string(),
            "Bearer secret".to_string(),
        )]));
        run(request(&client(), &r)).unwrap();
        let seen = rx_other.recv().unwrap().to_ascii_lowercase();
        assert!(!seen.contains("authorization"), "{seen}");
    }

    #[test]
    fn metadata_addresses_and_bad_schemes_are_refused() {
        for u in [
            "http://169.254.169.254/latest/meta-data/",
            "http://[fd00:ec2::254]/",
            "http://[::ffff:169.254.169.254]/",
            "http://2852039166/", // decimal form of 169.254.169.254
            "http://metadata.google.internal/computeMetadata/v1/",
            "https://169.254.169.254/",
        ] {
            let err = run(request(&client(), &get(u.into()))).unwrap_err();
            assert!(err.starts_with("refused:"), "{u}: {err}");
        }
        for u in ["file:///etc/passwd", "ftp://example.com/", "not a url"] {
            assert!(run(request(&client(), &get(u.into())))
                .unwrap_err()
                .starts_with("refused:"));
        }
        // local and private ranges stay allowed
        for u in [
            "http://localhost:1/",
            "http://127.0.0.1:1/",
            "http://10.1.2.3/",
            "http://192.168.0.5/",
        ] {
            assert!(check_url(u).is_ok(), "{u}");
        }
        assert!(is_blocked_ip("169.254.170.2".parse().unwrap()));
        assert!(!is_blocked_ip("169.254.1.1".parse().unwrap()));
    }

    #[test]
    fn request_validation() {
        let mut r = get("http://127.0.0.1:1/".into());
        r.body = Some("a".into());
        r.body_base64 = Some("YQ==".into());
        assert!(run(request(&client(), &r)).is_err());
        let mut r = get("http://127.0.0.1:1/".into());
        r.body_base64 = Some("!!!".into());
        assert!(run(request(&client(), &r)).is_err());
        let mut r = get("http://127.0.0.1:1/".into());
        r.method = Some("TRACE".into());
        assert!(run(request(&client(), &r)).is_err());
        let mut r = get("http://127.0.0.1:1/".into());
        r.body = Some("x".repeat(MAX_REQUEST_BODY + 1));
        assert!(run(request(&client(), &r)).unwrap_err().contains("32 MiB"));
    }

    #[test]
    fn response_over_cap_is_refused() {
        // declared length over the cap: refused from the head, nothing read
        let (port, _rx) = serve(1, |_, _, mut c| {
            let _ = c.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                    MAX_RESPONSE_BODY + 1
                )
                .as_bytes(),
            );
        });
        let err = run(request(
            &client(),
            &get(format!("http://127.0.0.1:{port}/")),
        ))
        .unwrap_err();
        assert!(err.contains("64 MiB"), "{err}");

        // undeclared (chunked) body that grows past the cap
        let (port, _rx) = serve(1, |_, _, mut c| {
            let _ = c.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
            let block = vec![b'a'; 1024 * 1024];
            for _ in 0..(MAX_RESPONSE_BODY / block.len() + 2) {
                if c.write_all(format!("{:x}\r\n", block.len()).as_bytes())
                    .is_err()
                    || c.write_all(&block).is_err()
                    || c.write_all(b"\r\n").is_err()
                {
                    return;
                }
            }
        });
        let mut r = get(format!("http://127.0.0.1:{port}/"));
        r.timeout_ms = Some(30_000);
        let err = run(request(&client(), &r)).unwrap_err();
        assert!(err.contains("64 MiB"), "{err}");
    }

    #[test]
    fn timeout_applies() {
        let (port, _rx) = serve(1, |_, _, c| {
            std::thread::sleep(Duration::from_millis(1500));
            drop(c);
        });
        let mut r = get(format!("http://127.0.0.1:{port}/"));
        r.timeout_ms = Some(200);
        assert!(run(request(&client(), &r))
            .unwrap_err()
            .contains("ETIMEDOUT"));
    }

    fn collect_events() -> (Emit, mpsc::Receiver<StreamEvent>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        (Arc::new(move |ev| tx.lock().send(ev).is_ok()), rx)
    }

    #[test]
    fn stream_delivers_head_chunks_end() {
        let (port, _rx) = serve(1, |_, _, mut c| {
            let _ = c.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
            );
            for part in ["data: 1\n\n", "data: 2\n\n"] {
                let _ = c.write_all(format!("{:x}\r\n{part}\r\n", part.len()).as_bytes());
                let _ = c.flush();
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = c.write_all(b"0\r\n\r\n");
        });
        let reg = StreamRegistry::default();
        let (emit, rx) = collect_events();
        let id = reg
            .start(
                client(),
                "main",
                PathBuf::from("/v"),
                &get(format!("http://127.0.0.1:{port}/s")),
                emit,
            )
            .unwrap();
        assert!(id > 0);
        let mut body = Vec::new();
        let mut head = None;
        loop {
            match rx.recv_timeout(Duration::from_secs(5)).unwrap() {
                StreamEvent::Head {
                    status, headers, ..
                } => head = Some((status, headers)),
                StreamEvent::Chunk { data_base64 } => body.extend(
                    base64::engine::general_purpose::STANDARD
                        .decode(data_base64)
                        .unwrap(),
                ),
                StreamEvent::End => break,
                StreamEvent::Error { message } => panic!("{message}"),
            }
        }
        let (status, headers) = head.unwrap();
        assert_eq!(status, 200);
        assert!(headers.contains(&("content-type".into(), "text/event-stream".into())));
        assert_eq!(String::from_utf8(body).unwrap(), "data: 1\n\ndata: 2\n\n");
        // the finished stream unregisters itself
        for _ in 0..50 {
            if reg.active() == 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(reg.active(), 0);
    }

    #[test]
    fn stream_error_event_for_blocked_target_and_connect_failure() {
        let reg = StreamRegistry::default();
        let (emit, _rx) = collect_events();
        assert!(reg
            .start(
                client(),
                "main",
                PathBuf::from("/v"),
                &get("http://169.254.169.254/".into()),
                emit,
            )
            .unwrap_err()
            .starts_with("refused:"));
        let (emit, rx) = collect_events();
        reg.start(
            client(),
            "main",
            PathBuf::from("/v"),
            &get("http://127.0.0.1:1/".into()),
            emit,
        )
        .unwrap();
        assert!(matches!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            StreamEvent::Error { .. }
        ));
    }

    #[test]
    fn stream_cancel_stops_events_and_closes_connection() {
        let (closed_tx, closed_rx) = mpsc::channel();
        let (port, _rx) = serve(1, move |_, _, mut c| {
            let _ = c.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
            let _ = c.write_all(b"2\r\nhi\r\n");
            let _ = c.flush();
            // keep writing until the client goes away
            for _ in 0..200 {
                std::thread::sleep(Duration::from_millis(25));
                if c.write_all(b"2\r\nhi\r\n").is_err() {
                    let _ = closed_tx.send(());
                    return;
                }
            }
        });
        let reg = StreamRegistry::default();
        let (emit, rx) = collect_events();
        let id = reg
            .start(
                client(),
                "w1",
                PathBuf::from("/v"),
                &get(format!("http://127.0.0.1:{port}/s")),
                emit,
            )
            .unwrap();
        // wait for the head and a chunk
        let mut got_chunk = false;
        while !got_chunk {
            if matches!(
                rx.recv_timeout(Duration::from_secs(5)).unwrap(),
                StreamEvent::Chunk { .. }
            ) {
                got_chunk = true;
            }
        }
        // another window cannot cancel it
        assert!(!reg.cancel("w2", id));
        assert!(reg.cancel("w1", id));
        assert!(!reg.cancel("w1", id), "second cancel is a no-op");
        while rx.try_recv().is_ok() {} // drain what raced the cancel
        closed_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("server saw the connection close");
        std::thread::sleep(Duration::from_millis(100));
        assert!(rx.try_recv().is_err(), "no events after cancel");
        assert_eq!(reg.active(), 0);
    }

    #[test]
    fn cancel_window_and_root_sweep() {
        let (port, _rx) = serve(2, |_, _, mut c| {
            let _ = c.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
            std::thread::sleep(Duration::from_secs(2));
        });
        let reg = StreamRegistry::default();
        for (label, root) in [("a", "/v1"), ("b", "/v2")] {
            let (emit, _r) = collect_events();
            reg.start(
                client(),
                label,
                PathBuf::from(root),
                &get(format!("http://127.0.0.1:{port}/s")),
                emit,
            )
            .unwrap();
        }
        assert_eq!(reg.active(), 2);
        reg.cancel_window("a");
        assert_eq!(reg.active(), 1);
        reg.cancel_root(std::path::Path::new("/v2"));
        assert_eq!(reg.active(), 0);
    }
}
