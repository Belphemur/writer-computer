//! Tests of the CLI-to-app socket (ADR 2026-11-18, "Tests"). The protocol and the guards run
//! through `handle_connection` over an in-memory duplex stream and a fake `Host`; the endpoint
//! (permissions, stale socket, token rotation) and the client over a real Unix socket. Fixture
//! vaults live in temp dirs; nothing touches a real vault or the real app data dir. The Windows
//! pipe (`windows.rs`) has no test: it cannot run here.

use super::bridge::WindowBridge;
use super::client::{self, ClientError};
use super::endpoint;
use super::host::BoxFuture;
use super::protocol::{self, ErrorCode, IpcError};
use super::registry::{boxed, IpcCommand, Registry, VaultRule};
use super::server::{self, admit, handle_connection, Shared};
use super::Host;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN: &str = "T0KEN-0123456789";

fn vectors() -> Value {
    serde_json::from_str(include_str!("../../../shared/ipc-vectors.json")).unwrap()
}

// ---------- a fake app ----------

#[derive(Default)]
struct FakeHost {
    vaults: Mutex<Vec<PathBuf>>,
    /// Feature ids that are live.
    live: Mutex<Vec<String>>,
    /// What each topic answers.
    answers: Mutex<HashMap<String, Value>>,
    /// Every call, in order, as `(what, detail)`.
    calls: Mutex<Vec<(String, Value)>>,
    panicked: Mutex<Vec<Option<&'static str>>>,
}

impl FakeHost {
    fn with_vault(root: &Path) -> Arc<FakeHost> {
        let h = FakeHost::default();
        h.vaults.lock().push(root.to_path_buf());
        Arc::new(h)
    }
    fn answer(&self, topic: &str, value: Value) {
        self.answers.lock().insert(topic.into(), value);
    }
    fn calls(&self) -> Vec<(String, Value)> {
        self.calls.lock().clone()
    }
}

impl Host for FakeHost {
    fn app_version(&self) -> String {
        "9.9.9".into()
    }
    fn open_vaults(&self) -> Vec<PathBuf> {
        self.vaults.lock().clone()
    }
    fn feature_live(&self, id: &str) -> bool {
        self.live.lock().iter().any(|l| l == id)
    }
    fn command_panicked(&self, feature: Option<&'static str>) {
        self.panicked.lock().push(feature);
    }
    fn open_vault_window<'a>(
        &'a self,
        root: &'a Path,
        focus: bool,
    ) -> BoxFuture<'a, Result<(), IpcError>> {
        Box::pin(async move {
            self.calls
                .lock()
                .push(("open_window".into(), json!({ "focus": focus })));
            let mut vaults = self.vaults.lock();
            if !vaults.iter().any(|v| v == root) {
                vaults.push(root.to_path_buf());
            }
            Ok(())
        })
    }
    fn ask_window<'a>(
        &'a self,
        _root: &'a Path,
        topic: &'a str,
        payload: Value,
    ) -> BoxFuture<'a, Result<Value, IpcError>> {
        Box::pin(async move {
            self.calls.lock().push((format!("ask:{topic}"), payload));
            Ok(self.answers.lock().get(topic).cloned().unwrap_or(json!({})))
        })
    }
}

// ---------- extra commands: the fixture feature's contribution, a slow one, a panicking one ----------

use crate::features::fixture::{ipc_greet as greet, IPC_COMMANDS as FEATURE_COMMANDS};

static TEST_COMMANDS: &[IpcCommand] = &[
    IpcCommand {
        name: "test:slow",
        vault: VaultRule::Optional,
        timeout: Duration::from_millis(100),
        feature: None,
        run: |_| boxed(std::future::pending()),
    },
    IpcCommand {
        name: "test:panic",
        vault: VaultRule::Optional,
        timeout: Duration::from_secs(5),
        feature: Some("fixture-hello"),
        run: |_| boxed(async { panic!("boom") }),
    },
];

fn shared_with(host: Arc<FakeHost>, extra: &'static [IpcCommand]) -> Arc<Shared> {
    let mut shared = Shared::new(Registry::new(extra.iter()), host, TOKEN.into());
    shared.read_timeout = Duration::from_millis(150);
    Arc::new(shared)
}

fn shared(host: Arc<FakeHost>) -> Arc<Shared> {
    shared_with(host, &[])
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// Send `bytes` as one connection and return the answer line, parsed, and the bytes after it.
async fn exchange_bytes(shared: &Arc<Shared>, bytes: &[u8]) -> (Value, Vec<u8>) {
    let (mut client, server) = tokio::io::duplex(1 << 20);
    let task = tokio::spawn(handle_connection(server, shared.clone()));
    client.write_all(bytes).await.unwrap();
    client.shutdown().await.unwrap(); // the end of what the client has to say
    let mut out = Vec::new();
    client.read_to_end(&mut out).await.unwrap();
    task.await.unwrap();
    let end = out
        .iter()
        .position(|b| *b == b'\n')
        .expect("an answer line");
    let line: Value = serde_json::from_slice(&out[..end]).unwrap();
    (line, out[end + 1..].to_vec())
}

async fn ask(shared: &Arc<Shared>, cmd: &str, vault: Option<&Path>, args: Value) -> Value {
    let mut line = serde_json::to_vec(&protocol::request_json(
        "1",
        TOKEN,
        cmd,
        vault.map(|v| v.to_str().unwrap()),
        args.as_object().unwrap(),
    ))
    .unwrap();
    line.push(b'\n');
    exchange_bytes(shared, &line).await.0
}

fn code_of(answer: &Value) -> &str {
    assert_eq!(answer["ok"], false, "{answer}");
    answer["error"]["code"].as_str().unwrap()
}

/// A vault in a temp dir with `Note.md`, `Projects/Alpha.md` and a symlink out of it.
struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    outside: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let root = base.join("vault");
    let outside = base.join("outside");
    std::fs::create_dir_all(root.join("Projects")).unwrap();
    std::fs::create_dir_all(root.join(".obsidian")).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(root.join("Note.md"), "private text\n").unwrap();
    std::fs::write(root.join("Projects/Alpha.md"), "# Alpha\n").unwrap();
    std::fs::write(root.join(".obsidian/app.json"), "{}").unwrap();
    std::fs::write(outside.join("secret.md"), "secret\n").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("out")).unwrap();
    Fixture {
        _dir: dir,
        root,
        outside,
    }
}

// ---------- the shared vectors ----------

#[test]
fn the_server_admits_every_vector_request_and_refuses_every_vector_refusal() {
    let v = vectors();
    assert_eq!(v["version"], protocol::VERSION);
    assert_eq!(v["maxMessageBytes"], protocol::MAX_MESSAGE_BYTES);
    let s = shared(Arc::new(FakeHost::default()));
    assert_eq!(s.token, v["token"].as_str().unwrap());
    for case in v["requests"].as_array().unwrap() {
        let line = serde_json::to_vec(&case["line"]).unwrap();
        let admitted = admit(&s, &line).unwrap_or_else(|r| panic!("{}: {:?}", case["name"], r));
        assert_eq!(admitted.command.name, case["cmd"].as_str().unwrap());
        assert_eq!(admitted.request.vault.as_deref(), case["vault"].as_str());
    }
    for case in v["refusals"].as_array().unwrap() {
        let refused = admit(&s, case["raw"].as_str().unwrap().as_bytes())
            .expect_err(case["name"].as_str().unwrap());
        assert_eq!(
            refused.error.code.as_str(),
            case["code"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn the_server_encodes_every_vector_response_and_the_client_decodes_it() {
    for case in vectors()["responses"].as_array().unwrap() {
        let expect = &case["expect"];
        let id = expect["id"].as_str().unwrap();
        let outcome = if expect["ok"].as_bool().unwrap() {
            Ok(expect["result"].clone())
        } else {
            Err(IpcError::new(
                match expect["code"].as_str().unwrap() {
                    "unauthorized" => ErrorCode::Unauthorized,
                    "bad_request" => ErrorCode::BadRequest,
                    other => panic!("add {other} to the test"),
                },
                expect["message"].as_str().unwrap(),
            ))
        };
        let line = protocol::response_line(id, &outcome);
        assert_eq!(*line.last().unwrap(), b'\n');
        let sent: Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(sent, case["line"], "{}", case["name"]);

        let parsed = protocol::parse_response(&serde_json::to_vec(&case["line"]).unwrap()).unwrap();
        assert_eq!(parsed.id, id);
        match (parsed.outcome, expect["ok"].as_bool().unwrap()) {
            (Ok(result), true) => assert_eq!(result, expect["result"]),
            (Err(e), false) => {
                assert_eq!(e.code, expect["code"].as_str().unwrap());
                assert_eq!(e.message, expect["message"].as_str().unwrap());
            }
            _ => panic!("{}: ok does not match", case["name"]),
        }
    }
}

#[test]
fn the_client_encodes_every_vector_request_exactly() {
    for case in vectors()["requests"].as_array().unwrap() {
        let args = case["args"].as_object().unwrap();
        let line = client::encode_request(
            TOKEN,
            case["cmd"].as_str().unwrap(),
            case["vault"].as_str(),
            args,
        );
        assert_eq!(*line.last().unwrap(), b'\n');
        let sent: Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(sent, case["line"], "{}", case["name"]);
    }
}

#[test]
fn a_foreign_answer_is_not_trusted_by_the_client() {
    assert!(protocol::parse_response(b"not json").is_err());
    assert!(protocol::parse_response(br#"{"v":2,"id":"1","ok":true}"#).is_err());
    assert!(protocol::parse_response(br#"{"v":1,"id":"1"}"#).is_err());
}

// ---------- the guards ----------

#[test]
fn a_wrong_or_missing_token_gets_one_generic_error_and_the_connection_closes() {
    rt().block_on(async {
        let s = shared(Arc::new(FakeHost::default()));
        let wrong = json!({"v":1,"id":"5","token":"nope","cmd":"status","args":{}});
        let missing = json!({"v":1,"id":"6","cmd":"status","args":{}});
        for (req, id) in [(wrong, "5"), (missing, "6")] {
            let mut line = serde_json::to_vec(&req).unwrap();
            line.push(b'\n');
            let (answer, rest) = exchange_bytes(&s, &line).await;
            assert_eq!(code_of(&answer), "unauthorized");
            assert_eq!(answer["id"], id);
            assert_eq!(answer["error"]["message"], "unauthorized", "no detail");
            assert!(rest.is_empty(), "the connection closed after one answer");
        }
    });
}

#[test]
fn an_oversized_message_is_refused_and_one_at_the_limit_is_read() {
    rt().block_on(async {
        let s = shared(Arc::new(FakeHost::default()));
        let line_of = |len: usize| {
            let base = json!({"v":1,"id":"1","token":TOKEN,"cmd":"status","args":{"pad":""}});
            let base_len = serde_json::to_vec(&base).unwrap().len();
            let mut v = base;
            v["args"]["pad"] = json!("x".repeat(len - base_len));
            let mut bytes = serde_json::to_vec(&v).unwrap();
            assert_eq!(bytes.len(), len);
            bytes.push(b'\n');
            bytes
        };
        // exactly 64 KiB: past the size check; `status` takes no `pad`, so it is refused for that
        let (answer, _) = exchange_bytes(&s, &line_of(protocol::MAX_MESSAGE_BYTES)).await;
        assert_eq!(code_of(&answer), "invalid_args");
        // one byte more
        let (answer, _) = exchange_bytes(&s, &line_of(protocol::MAX_MESSAGE_BYTES + 1)).await;
        assert_eq!(code_of(&answer), "too_large");
        // a line that never ends
        let endless = vec![b'a'; protocol::MAX_MESSAGE_BYTES * 2];
        let (answer, _) = exchange_bytes(&s, &endless).await;
        assert_eq!(code_of(&answer), "too_large");
    });
}

#[test]
fn a_request_that_does_not_arrive_in_time_times_out() {
    rt().block_on(async {
        let s = shared(Arc::new(FakeHost::default()));
        let (mut client, server) = tokio::io::duplex(1024);
        let task = tokio::spawn(handle_connection(server, s));
        // the client holds the connection open and sends nothing
        let mut out = Vec::new();
        client.read_to_end(&mut out).await.unwrap();
        task.await.unwrap();
        let answer: Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(code_of(&answer), "timeout");
    });
}

#[test]
fn a_line_without_a_newline_or_with_garbage_is_a_bad_request() {
    rt().block_on(async {
        let s = shared(Arc::new(FakeHost::default()));
        let (answer, _) = exchange_bytes(&s, b"{\"v\":1").await;
        assert_eq!(code_of(&answer), "bad_request");
        let (answer, _) = exchange_bytes(&s, b"hello\n").await;
        assert_eq!(code_of(&answer), "bad_request");
        assert_eq!(answer["id"], "");
    });
}

#[test]
fn a_command_that_overruns_its_deadline_times_out_and_one_that_panics_fails_its_feature() {
    rt().block_on(async {
        let host = Arc::new(FakeHost::default());
        host.live.lock().push("fixture-hello".into());
        let s = shared_with(host.clone(), TEST_COMMANDS);
        let answer = ask(&s, "test:slow", None, json!({})).await;
        assert_eq!(code_of(&answer), "timeout");
        let answer = ask(&s, "test:panic", None, json!({})).await;
        assert_eq!(code_of(&answer), "internal");
        assert_eq!(*host.panicked.lock(), vec![Some("fixture-hello")]);
    });
}

// ---------- the commands ----------

#[test]
fn status_reports_the_version_the_open_vaults_and_whether_the_vault_is_open() {
    rt().block_on(async {
        let f = fixture();
        let host = FakeHost::with_vault(&f.root);
        let s = shared(host);
        let answer = ask(&s, "status", None, json!({})).await;
        assert_eq!(answer["ok"], true);
        assert_eq!(answer["result"]["version"], "9.9.9");
        assert_eq!(
            answer["result"]["vaults"],
            json!([f.root.to_str().unwrap()])
        );
        assert_eq!(answer["result"]["vaultOpen"], Value::Null);
        let answer = ask(&s, "status", Some(&f.root), json!({})).await;
        assert_eq!(answer["result"]["vaultOpen"], true);
        let closed = f.outside.clone();
        let answer = ask(&s, "status", Some(&closed), json!({})).await;
        assert_eq!(answer["result"]["vaultOpen"], false);
    });
}

#[test]
fn open_confines_the_path_and_asks_the_window_through_its_open_path() {
    rt().block_on(async {
        let f = fixture();
        let host = FakeHost::with_vault(&f.root);
        let s = shared(host.clone());
        let answer = ask(
            &s,
            "open",
            Some(&f.root),
            json!({"path":"Projects/Alpha.md","newTab":true,"line":4}),
        )
        .await;
        assert_eq!(answer["ok"], true, "{answer}");
        assert_eq!(answer["result"]["path"], "Projects/Alpha.md");
        let calls = host.calls();
        assert_eq!(calls[0].0, "open_window");
        assert_eq!(calls[0].1["focus"], true);
        assert_eq!(calls[1].0, "ask:open");
        assert_eq!(
            calls[1].1["path"],
            f.root.join("Projects/Alpha.md").to_str().unwrap()
        );
        assert_eq!(calls[1].1["newTab"], true);
        assert_eq!(calls[1].1["line"], 4);
        // a vault that is not open yet is opened by `open`
        let closed = tempfile::tempdir().unwrap();
        let closed_root = closed.path().canonicalize().unwrap();
        std::fs::write(closed_root.join("A.md"), "a").unwrap();
        let answer = ask(&s, "open", Some(&closed_root), json!({"path":"A.md"})).await;
        assert_eq!(answer["ok"], true, "{answer}");
        assert!(host.vaults.lock().contains(&closed_root));
    });
}

#[test]
fn open_refuses_both_line_and_anchor_and_unknown_arguments() {
    rt().block_on(async {
        let f = fixture();
        let s = shared(FakeHost::with_vault(&f.root));
        let both = ask(
            &s,
            "open",
            Some(&f.root),
            json!({"path":"Note.md","line":2,"anchor":"x"}),
        )
        .await;
        assert_eq!(code_of(&both), "invalid_args");
        let zero = ask(
            &s,
            "open",
            Some(&f.root),
            json!({"path":"Note.md","line":0}),
        )
        .await;
        assert_eq!(code_of(&zero), "invalid_args");
        let extra = ask(
            &s,
            "open",
            Some(&f.root),
            json!({"path":"Note.md","eval":"1"}),
        )
        .await;
        assert_eq!(code_of(&extra), "invalid_args");
        let none = ask(&s, "open", Some(&f.root), json!({})).await;
        assert_eq!(code_of(&none), "invalid_args");
        let no_vault = ask(&s, "open", None, json!({"path":"Note.md"})).await;
        assert_eq!(code_of(&no_vault), "invalid_args");
    });
}

#[test]
fn every_path_argument_is_confined_to_the_vault_and_must_exist() {
    rt().block_on(async {
        let f = fixture();
        let host = FakeHost::with_vault(&f.root);
        let s = shared(host.clone());
        let secret = f.outside.join("secret.md");
        let hostile = [
            ("../outside/secret.md", "invalid_path"),
            (secret.to_str().unwrap(), "invalid_path"),
            ("out/secret.md", "invalid_path"), // a symlink out of the vault
            (".obsidian/app.json", "invalid_path"),
            ("", "invalid_path"),
            ("missing.md", "not_found"),
            ("Projects", "not_found"), // a folder is not a file for `open`
        ];
        for cmd in ["open", "reveal"] {
            for (path, code) in hostile {
                // `reveal` takes folders too
                let expected = if cmd == "reveal" && path == "Projects" {
                    "ok"
                } else {
                    code
                };
                let answer = ask(&s, cmd, Some(&f.root), json!({ "path": path })).await;
                if expected == "ok" {
                    assert_eq!(answer["ok"], true, "{cmd} {path}");
                } else {
                    assert_eq!(code_of(&answer), expected, "{cmd} {path:?}");
                }
            }
        }
        // nothing reached the window for a refused path
        assert!(
            host.calls()
                .iter()
                .all(|(_, d)| !d.to_string().contains("secret")),
            "{:?}",
            host.calls()
        );
    });
}

#[test]
fn reveal_and_active_need_the_vault_to_be_open() {
    rt().block_on(async {
        let f = fixture();
        let s = shared(Arc::new(FakeHost::default())); // no vault open
        let answer = ask(&s, "reveal", Some(&f.root), json!({"path":"Note.md"})).await;
        assert_eq!(code_of(&answer), "vault_not_open");
        let answer = ask(&s, "active", Some(&f.root), json!({})).await;
        assert_eq!(code_of(&answer), "vault_not_open");
        let answer = ask(&s, "active", None, json!({})).await;
        assert_eq!(code_of(&answer), "invalid_args");
    });
}

#[test]
fn active_returns_the_path_kind_and_line_and_never_text() {
    rt().block_on(async {
        let f = fixture();
        let host = FakeHost::with_vault(&f.root);
        // a web handler that wrongly answers with text, a selection and a path outside the vault
        host.answer(
            "active",
            json!({
                "path": f.root.join("Projects/Alpha.md").to_str().unwrap(),
                "kind": "markdown",
                "line": 7,
                "text": "the whole note",
                "selection": "chosen words",
                "extra": {"content": "x"}
            }),
        );
        let s = shared(host.clone());
        let answer = ask(&s, "active", Some(&f.root), json!({})).await;
        assert_eq!(answer["ok"], true, "{answer}");
        let result = answer["result"].as_object().unwrap();
        let keys: Vec<_> = result.keys().cloned().collect();
        assert_eq!(keys, ["kind", "line", "path"], "exactly these fields");
        assert_eq!(result["path"], "Projects/Alpha.md");
        assert_eq!(result["kind"], "markdown");
        assert_eq!(result["line"], 7);
        assert!(!answer.to_string().contains("whole note"));
        assert!(!answer.to_string().contains("chosen words"));

        host.answer(
            "active",
            json!({"path": f.outside.join("secret.md").to_str().unwrap(), "kind": "not a kind!"}),
        );
        let answer = ask(&s, "active", Some(&f.root), json!({})).await;
        assert_eq!(
            answer["result"],
            json!({"path": null, "kind": null, "line": null})
        );
    });
}

#[test]
fn a_feature_command_is_registered_with_its_feature_and_gone_without_it() {
    rt().block_on(async {
        let host = Arc::new(FakeHost::default());
        let line = |cmd: &str| {
            let mut m = Map::new();
            m.insert("name".into(), json!("Ada"));
            let mut l =
                serde_json::to_vec(&protocol::request_json("1", TOKEN, cmd, None, &m)).unwrap();
            l.push(b'\n');
            l
        };
        // the feature is running and live: it works and uses the shared plumbing
        let with = shared_with(host.clone(), FEATURE_COMMANDS);
        host.live.lock().push("fixture-hello".into());
        let (answer, _) = exchange_bytes(&with, &line("fixture-hello:greet")).await;
        assert_eq!(answer["result"]["greeting"], "hello Ada");
        // its switch is off or it failed: the command says so
        host.live.lock().clear();
        let (answer, _) = exchange_bytes(&with, &line("fixture-hello:greet")).await;
        assert_eq!(code_of(&answer), "feature_off");
        // the feature is not running at all: the command does not exist
        let without = shared(host.clone());
        let (answer, _) = exchange_bytes(&without, &line("fixture-hello:greet")).await;
        assert_eq!(code_of(&answer), "unknown_command");
    });
}

#[test]
fn a_contributed_command_cannot_replace_a_core_one() {
    static CLASH: &[IpcCommand] = &[IpcCommand {
        name: "status",
        vault: VaultRule::Optional,
        timeout: Duration::from_secs(5),
        feature: Some("fixture-hello"),
        run: greet,
    }];
    let registry = Registry::new(CLASH.iter());
    let status = registry.find("status").unwrap();
    assert_eq!(status.feature, None, "the core command stays");
    assert_eq!(
        registry.names().iter().filter(|n| **n == "status").count(),
        1
    );
    assert_eq!(registry.names(), ["status", "open", "reveal", "active"]);
}

// ---------- logging ----------

#[derive(Clone, Default)]
struct LogBuf(Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for LogBuf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
    type Writer = LogBuf;
    fn make_writer(&'a self) -> LogBuf {
        self.clone()
    }
}

#[test]
fn the_log_has_the_command_name_outcome_and_duration_and_never_args_paths_or_the_token() {
    let f = fixture();
    let host = FakeHost::with_vault(&f.root);
    std::fs::write(f.root.join("Quiet secret title.md"), "x").unwrap();
    let s = shared(host);
    // tracing caches, per call site, whether any subscriber wants it; tests running in parallel
    // reach the same call site without one and can leave it cached as "never" for a moment. An
    // empty capture is that race, not a missing log line: a new subscriber rebuilds the cache.
    let log = (0..10)
        .find_map(|_| {
            let buf = LogBuf::default();
            let subscriber = tracing_subscriber::fmt()
                .with_writer(buf.clone())
                .with_max_level(tracing::Level::INFO)
                .finish();
            tracing::subscriber::with_default(subscriber, || {
                rt().block_on(async {
                    ask(&s, "open", Some(&f.root), json!({"path":"Quiet secret title.md","anchor":"private-heading"})).await;
                    ask(&s, "open", Some(&f.root), json!({"path":"../outside/secret.md"})).await;
                    // an unauthorized request that names a command of its own invention
                    let line = format!(
                        "{}\n",
                        json!({"v":1,"id":"9","token":"guess-1234","cmd":"evil-command-name","args":{}})
                    );
                    exchange_bytes(&s, line.as_bytes()).await;
                });
            });
            let log = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
            (!log.is_empty()).then_some(log)
        })
        .expect("the server logged nothing");
    assert!(
        log.contains("command=\"open\"") || log.contains("command=open"),
        "{log}"
    );
    assert!(
        log.contains("outcome=\"ok\"") || log.contains("outcome=ok"),
        "{log}"
    );
    assert!(
        log.contains("outcome=\"invalid_path\"") || log.contains("outcome=invalid_path"),
        "{log}"
    );
    assert!(log.contains("duration_ms"), "{log}");
    assert!(log.contains("unauthorized"), "{log}");
    for secret in [
        "Quiet secret title",
        "private-heading",
        "outside",
        f.root.to_str().unwrap(),
        TOKEN,
        "guess-1234",
        "evil-command-name",
    ] {
        assert!(!log.contains(secret), "the log leaks {secret:?}: {log}");
    }
}

// ---------- the window bridge ----------

#[test]
fn the_bridge_waits_for_a_ready_window_and_only_that_window_can_answer() {
    rt().block_on(async {
        let bridge = Arc::new(WindowBridge::default());
        let sent = Arc::new(Mutex::new(Vec::<(String, String, Value)>::new()));
        let asker = {
            let (bridge, sent) = (bridge.clone(), sent.clone());
            tokio::spawn(async move {
                bridge
                    .ask("w-1", "open", json!({"a": 1}), |id, topic, payload| {
                        sent.lock().push((id.into(), topic.into(), payload));
                        Ok(())
                    })
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            sent.lock().is_empty(),
            "nothing is sent to a window that is not ready"
        );
        bridge.mark_ready("w-1");
        tokio::time::sleep(Duration::from_millis(50)).await;
        let (id, topic, payload) = sent.lock()[0].clone();
        assert_eq!((topic.as_str(), payload), ("open", json!({"a": 1})));
        assert!(
            !bridge.reply("w-2", &id, Ok(json!("spoofed"))),
            "another window is not heard"
        );
        assert!(!bridge.reply("w-1", "unknown-id", Ok(json!(1))));
        assert!(bridge.reply("w-1", &id, Ok(json!({"done": true}))));
        assert_eq!(asker.await.unwrap().unwrap(), json!({"done": true}));
        assert!(!bridge.reply("w-1", &id, Ok(json!(2))), "answered once");
    });
}

#[test]
fn a_window_that_closes_fails_what_it_owed_and_a_dropped_ask_leaves_nothing_behind() {
    rt().block_on(async {
        let bridge = Arc::new(WindowBridge::default());
        bridge.mark_ready("w-1");
        let asker = {
            let bridge = bridge.clone();
            tokio::spawn(async move {
                bridge
                    .ask("w-1", "active", json!({}), |_, _, _| Ok(()))
                    .await
            })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        bridge.forget("w-1");
        let err = asker.await.unwrap().unwrap_err();
        assert_eq!(err.code, ErrorCode::Unavailable);

        // a timed-out command drops its ask: the pending entry goes with it
        bridge.mark_ready("w-1");
        let id = Arc::new(Mutex::new(String::new()));
        let id2 = id.clone();
        let slow = bridge.ask("w-1", "x", json!({}), move |i, _, _| {
            *id2.lock() = i.into();
            Ok(())
        });
        let _ = tokio::time::timeout(Duration::from_millis(30), slow).await;
        assert!(
            !bridge.reply("w-1", &id.lock(), Ok(json!(1))),
            "no pending request is left"
        );

        // an emit that fails is reported as unavailable
        let err = bridge
            .ask("w-1", "x", json!({}), |_, _, _| Err("gone".into()))
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::Unavailable);
    });
}

#[test]
fn tokens_compare_whole_and_in_constant_shape() {
    assert!(protocol::token_matches("abc", "abc"));
    assert!(!protocol::token_matches("abc", "abd"));
    assert!(!protocol::token_matches("abc", "ab"));
    assert!(!protocol::token_matches("abc", ""));
    assert_ne!(endpoint::new_token(), endpoint::new_token());
    assert_eq!(endpoint::new_token().len(), 32);
}

#[test]
fn an_answer_too_large_for_the_wire_becomes_an_error_not_a_truncation() {
    let big = Ok(json!({"x": "y".repeat(protocol::MAX_MESSAGE_BYTES)}));
    let line = protocol::response_line("1", &big);
    let v: Value = serde_json::from_slice(&line).unwrap();
    assert_eq!(v["error"]["code"], "too_large");
    assert!(line.len() <= protocol::MAX_MESSAGE_BYTES);
}

// ---------- the endpoint and the client, over a real Unix socket ----------

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    /// A runtime that runs on its own thread, so the blocking client can talk to it.
    pub struct Runtime {
        pub handle: tokio::runtime::Handle,
        stop: Option<tokio::sync::oneshot::Sender<()>>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Runtime {
        pub fn new() -> Runtime {
            let (tx, rx) = std::sync::mpsc::channel();
            let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
            let thread = std::thread::spawn(move || {
                let rt = rt();
                tx.send(rt.handle().clone()).unwrap();
                rt.block_on(async {
                    let _ = stopped.await;
                });
            });
            Runtime {
                handle: rx.recv().unwrap(),
                stop: Some(stop),
                thread: Some(thread),
            }
        }
    }

    impl Drop for Runtime {
        fn drop(&mut self) {
            let _ = self.stop.take().unwrap().send(());
            self.thread.take().unwrap().join().unwrap();
        }
    }

    /// A running server in `dir`, the way the app starts it.
    pub fn serve(dir: &Path, host: Arc<FakeHost>, rt: &Runtime) -> server::ServerHandle {
        server::start(&rt.handle, dir, Registry::new([]), host).unwrap()
    }

    #[test]
    fn the_endpoint_is_owner_only_and_a_stale_socket_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        // a previous launch crashed and left a socket nobody listens on
        std::fs::create_dir_all(endpoint::ipc_dir(&data)).unwrap();
        drop(std::os::unix::net::UnixListener::bind(endpoint::socket_path(&data)).unwrap());
        assert!(endpoint::socket_path(&data).exists());

        let data_mode = mode(&data);
        let (listener, token) = endpoint::bind_unix(&data).unwrap();
        assert_eq!(mode(&endpoint::ipc_dir(&data)), 0o700, "the ipc dir");
        assert_eq!(
            mode(&data),
            data_mode,
            "the app data dir itself is not touched"
        );
        assert_eq!(mode(&endpoint::socket_path(&data)), 0o600, "the socket");
        assert_eq!(mode(&endpoint::token_path(&data)), 0o600, "the token");
        assert!(std::fs::metadata(endpoint::socket_path(&data))
            .unwrap()
            .file_type()
            .is_socket());
        assert_eq!(
            std::fs::read_to_string(endpoint::token_path(&data)).unwrap(),
            token
        );
        assert_eq!(endpoint::read_token(&data).as_deref(), Some(token.as_str()));
        // no temp file is left beside it
        let names: Vec<_> = std::fs::read_dir(endpoint::ipc_dir(&data))
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names.len(), 2, "{names:?}");
        drop(listener);
    }

    #[test]
    fn a_live_socket_and_a_file_that_is_not_a_socket_are_never_taken_over() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("live");
        let (_listener, token) = endpoint::bind_unix(&live).unwrap();
        let err = endpoint::bind_unix(&live).unwrap_err();
        assert!(matches!(err, endpoint::EndpointError::InUse(_)), "{err}");
        assert_eq!(
            std::fs::read_to_string(endpoint::token_path(&live)).unwrap(),
            token,
            "the live server keeps its token"
        );

        let other = dir.path().join("other");
        std::fs::create_dir_all(endpoint::ipc_dir(&other)).unwrap();
        std::fs::write(endpoint::socket_path(&other), "mine").unwrap();
        assert!(endpoint::bind_unix(&other).is_err());
        assert_eq!(
            std::fs::read_to_string(endpoint::socket_path(&other)).unwrap(),
            "mine"
        );
    }

    #[test]
    fn every_launch_gets_a_new_token() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("d");
        let (first_listener, first) = endpoint::bind_unix(&data).unwrap();
        drop(first_listener); // the first launch is gone; its socket file stays behind
        let (_second_listener, second) = endpoint::bind_unix(&data).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            endpoint::read_token(&data).unwrap(),
            second,
            "the file holds the newest token"
        );
    }

    #[test]
    fn a_socket_path_too_long_for_the_os_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let long = dir.path().join("x".repeat(120));
        let err = endpoint::bind_unix(&long).unwrap_err();
        assert!(err.to_string().contains("too long"), "{err}");
    }

    #[test]
    fn the_real_default_socket_path_fits_the_os_limit() {
        // the macOS default is `~/Library/Application Support/com.writer-computer/ipc/ipc.sock`;
        // a 24-character user name is already longer than most real ones
        let home = format!("/Users/{}", "u".repeat(24));
        let data = PathBuf::from(&home)
            .join("Library/Application Support")
            .join(crate::index::RELEASE_IDENTIFIER);
        let len = endpoint::socket_path(&data).as_os_str().len();
        assert!(len < endpoint::MAX_SOCKET_PATH, "{len}");
        // and the actual one of this machine
        if let Ok(real) = crate::index::cli_app_data_dir() {
            assert!(endpoint::socket_path(&real).as_os_str().len() < endpoint::MAX_SOCKET_PATH);
        }
    }

    #[test]
    fn the_ipc_folder_is_created_and_a_wrong_mode_is_corrected() {
        let dir = tempfile::tempdir().unwrap();
        let ipc = endpoint::ipc_dir(dir.path());
        std::fs::create_dir_all(&ipc).unwrap();
        std::fs::set_permissions(&ipc, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (_l, _t) = endpoint::bind_unix(dir.path()).unwrap();
        assert_eq!(mode(&ipc), 0o700);
    }

    #[test]
    fn the_client_talks_to_the_server_and_a_stopped_server_is_not_running() {
        let f = fixture();
        let data = tempfile::tempdir().unwrap();
        let host = FakeHost::with_vault(&f.root);
        host.answer("active", json!({"path": f.root.join("Note.md").to_str().unwrap(), "kind": "markdown", "line": 3}));
        let rt = Runtime::new();
        let handle = serve(data.path(), host.clone(), &rt);
        let vault = f.root.to_str().unwrap();
        let wait = Duration::from_secs(5);

        let status = client::call(data.path(), "status", Some(vault), &Map::new(), wait).unwrap();
        assert_eq!(status["version"], "9.9.9");
        assert_eq!(status["vaultOpen"], true);

        let mut args = Map::new();
        args.insert("path".into(), json!("Note.md"));
        let opened = client::call(data.path(), "open", Some(vault), &args, wait).unwrap();
        assert_eq!(opened["path"], "Note.md");

        let active = client::call(data.path(), "active", Some(vault), &Map::new(), wait).unwrap();
        assert_eq!(
            active,
            json!({"path": "Note.md", "kind": "markdown", "line": 3})
        );

        let mut bad = Map::new();
        bad.insert("path".into(), json!("../outside/secret.md"));
        match client::call(data.path(), "open", Some(vault), &bad, wait) {
            Err(ClientError::Remote(e)) => assert_eq!(e.code, "invalid_path"),
            other => panic!("{other:?}"),
        }

        // the token the app rotated is picked up: a stale one is re-read once
        std::fs::write(endpoint::token_path(data.path()), "stale").unwrap();
        assert!(matches!(
            client::call(data.path(), "status", None, &Map::new(), wait),
            Err(ClientError::Remote(e)) if e.code == "unauthorized"
        ));

        handle.stop();
        assert!(!endpoint::socket_path(data.path()).exists());
        assert!(!endpoint::token_path(data.path()).exists());
        assert_eq!(
            client::call(data.path(), "status", None, &Map::new(), wait),
            Err(ClientError::NotRunning)
        );
    }

    #[test]
    fn no_token_or_a_socket_nobody_listens_on_is_not_running() {
        let data = tempfile::tempdir().unwrap();
        let wait = Duration::from_secs(1);
        assert_eq!(
            client::call(data.path(), "status", None, &Map::new(), wait),
            Err(ClientError::NotRunning),
            "no token file"
        );
        // a crashed app: token and socket file remain, nothing listens
        std::fs::create_dir_all(endpoint::ipc_dir(data.path())).unwrap();
        std::fs::write(endpoint::token_path(data.path()), TOKEN).unwrap();
        assert_eq!(
            client::call(data.path(), "status", None, &Map::new(), wait),
            Err(ClientError::NotRunning),
            "no socket"
        );
        drop(std::os::unix::net::UnixListener::bind(endpoint::socket_path(data.path())).unwrap());
        assert_eq!(
            client::call(data.path(), "status", None, &Map::new(), wait),
            Err(ClientError::NotRunning),
            "a stale socket"
        );
    }

    #[test]
    fn a_server_that_never_answers_makes_the_client_time_out() {
        let data = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(endpoint::ipc_dir(data.path())).unwrap();
        std::fs::write(endpoint::token_path(data.path()), TOKEN).unwrap();
        let listener =
            std::os::unix::net::UnixListener::bind(endpoint::socket_path(data.path())).unwrap();
        let keep = std::thread::spawn(move || {
            let (_conn, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_millis(600));
        });
        let started = std::time::Instant::now();
        let r = client::call(
            data.path(),
            "status",
            None,
            &Map::new(),
            Duration::from_millis(200),
        );
        assert_eq!(r, Err(ClientError::Timeout));
        assert!(started.elapsed() < Duration::from_millis(550));
        keep.join().unwrap();
    }

    #[test]
    fn a_new_launch_serves_with_a_new_token_and_the_old_one_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let f = fixture();
        let host = FakeHost::with_vault(&f.root);
        let rt = Runtime::new();
        let first = serve(data.path(), host.clone(), &rt);
        let old = endpoint::read_token(data.path()).unwrap();
        first.stop();
        let _second = serve(data.path(), host, &rt);
        let new = endpoint::read_token(data.path()).unwrap();
        assert_ne!(old, new);
        // a raw request with the old token
        use std::io::{Read, Write};
        let mut s =
            std::os::unix::net::UnixStream::connect(endpoint::socket_path(data.path())).unwrap();
        s.write_all(&client::encode_request(&old, "status", None, &Map::new()))
            .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        assert!(out.contains("\"unauthorized\""), "{out}");
    }
}

// ---------- the CLI over the socket ----------

#[cfg(unix)]
mod cli {
    use super::unix::{serve, Runtime};
    use super::*;
    use crate::cli::{
        execute, Clipboard, Env, Outcome, EXIT_FAIL, EXIT_NOT_RUNNING, EXIT_OK, EXIT_USAGE,
    };
    use crate::writer_cli::{LaunchError, Launcher};
    use std::cell::RefCell;
    use std::rc::Rc;

    struct NoClipboard;
    impl Clipboard for NoClipboard {
        fn copy(&self, _: &str) -> Result<(), String> {
            Err("no clipboard in tests".into())
        }
    }

    /// Records what it was asked to launch; `on_launch` plays the app coming up.
    struct FakeLauncher {
        launched: Rc<RefCell<Vec<Option<PathBuf>>>>,
        on_launch: Box<dyn Fn()>,
        fail: bool,
    }

    impl Launcher for FakeLauncher {
        fn launch(&self, target: Option<&Path>) -> Result<(), LaunchError> {
            self.launched
                .borrow_mut()
                .push(target.map(Path::to_path_buf));
            if self.fail {
                return Err(LaunchError::AppNotFound("Writer is not installed".into()));
            }
            (self.on_launch)();
            Ok(())
        }
    }

    struct Cli {
        vault: Fixture,
        data: tempfile::TempDir,
        launched: Rc<RefCell<Vec<Option<PathBuf>>>>,
    }

    impl Cli {
        fn new() -> Cli {
            Cli {
                vault: fixture(),
                data: tempfile::tempdir().unwrap(),
                launched: Rc::default(),
            }
        }

        fn run_with(&self, line: &[&str], launcher: FakeLauncher, wait: Duration) -> Outcome {
            let env = Env {
                app_data_dir: Some(self.data.path().to_path_buf()),
                clipboard: Box::new(NoClipboard),
                utc_offset_minutes: 0,
                launcher: Box::new(launcher),
                launch_wait: wait,
            };
            let argv: Vec<String> = line.iter().map(|s| s.to_string()).collect();
            execute(&argv, &self.vault.root, &env)
        }

        fn launcher(&self, on_launch: impl Fn() + 'static) -> FakeLauncher {
            FakeLauncher {
                launched: self.launched.clone(),
                on_launch: Box::new(on_launch),
                fail: false,
            }
        }

        fn run(&self, line: &[&str]) -> Outcome {
            self.run_with(line, self.launcher(|| {}), Duration::from_millis(300))
        }
    }

    #[test]
    fn without_the_app_every_app_command_says_so_with_its_own_exit_code() {
        let c = Cli::new();
        for line in [
            &["status"][..],
            &["open", "path=Note.md"],
            &["reveal", "path=Note.md"],
            &["active"],
        ] {
            let o = c.run(line);
            assert_eq!(o.code, EXIT_NOT_RUNNING, "{line:?}");
            assert_eq!(o.stderr, "writer: Writer is not running\n", "{line:?}");
            assert!(o.stdout.is_empty());
        }
        assert_ne!(EXIT_NOT_RUNNING, EXIT_USAGE);
        assert_ne!(EXIT_NOT_RUNNING, EXIT_FAIL);
        assert!(
            c.launched.borrow().is_empty(),
            "nothing starts the app without --launch"
        );
        // a bad invocation is still a usage error, before the app is looked for
        assert_eq!(c.run(&["open"]).code, EXIT_USAGE);
        assert_eq!(c.run(&["open", "path=Note.md", "line=0"]).code, EXIT_USAGE);
        assert_eq!(
            c.run(&["files", "--launch"]).code,
            EXIT_USAGE,
            "--launch only where listed"
        );
    }

    #[test]
    fn the_app_commands_reach_the_running_app() {
        let c = Cli::new();
        let host = FakeHost::with_vault(&c.vault.root);
        host.answer("active", json!({"path": c.vault.root.join("Projects/Alpha.md").to_str().unwrap(), "kind": "markdown", "line": 12}));
        let rt = Runtime::new();
        let _server = serve(c.data.path(), host.clone(), &rt);

        let o = c.run(&["status"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert!(
            o.stdout.starts_with("Writer 9.9.9 is running\n"),
            "{}",
            o.stdout
        );
        assert!(o
            .stdout
            .contains(&format!("vault\t{}", c.vault.root.display())));
        assert!(o.stdout.contains("this vault is open"));
        let o = c.run(&["status", "format=json"]);
        let v: Value = serde_json::from_str(&o.stdout).unwrap();
        assert_eq!(v["vaultOpen"], true);

        let o = c.run(&["open", "path=Projects/Alpha.md", "line=3", "newtab"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert_eq!(o.stdout, "Opened Projects/Alpha.md\n");
        let asked = host
            .calls()
            .into_iter()
            .find(|(w, _)| w == "ask:open")
            .unwrap()
            .1;
        assert_eq!(
            (asked["newTab"].clone(), asked["line"].clone()),
            (json!(true), json!(3))
        );

        let o = c.run(&["reveal", "path=Projects"]);
        assert_eq!(o.stdout, "Revealed Projects\n", "{}", o.stderr);

        let o = c.run(&["active"]);
        assert_eq!(
            o.stdout,
            "path\tProjects/Alpha.md\nkind\tmarkdown\nline\t12\n"
        );
        let o = c.run(&["active", "format=json"]);
        assert_eq!(
            serde_json::from_str::<Value>(&o.stdout).unwrap(),
            json!({"path": "Projects/Alpha.md", "kind": "markdown", "line": 12})
        );
        host.answer("active", json!({}));
        assert_eq!(c.run(&["active"]).stdout, "No active note\n");

        // an error from the app is a failure with its message
        let o = c.run(&["open", "path=nope.md"]);
        assert_eq!(o.code, EXIT_FAIL);
        assert!(o.stderr.contains("file not found"), "{}", o.stderr);
        let o = c.run(&["open", "path=../outside/secret.md"]);
        assert_eq!(o.code, EXIT_FAIL, "{}", o.stderr);
    }

    #[test]
    fn open_resolves_a_file_name_like_a_wikilink_before_asking_the_app() {
        let c = Cli::new();
        let host = FakeHost::with_vault(&c.vault.root);
        let rt = Runtime::new();
        let _server = serve(c.data.path(), host.clone(), &rt);
        let o = c.run(&["open", "file=Alpha"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert_eq!(o.stdout, "Opened Projects/Alpha.md\n");
    }

    #[test]
    fn open_launch_starts_the_app_on_the_vault_waits_for_its_socket_and_opens() {
        let c = Cli::new();
        let host = FakeHost::with_vault(&c.vault.root);
        let rt = Runtime::new();
        let started: Rc<RefCell<Option<server::ServerHandle>>> = Rc::default();
        let (dir, host2, handle, started2) = (
            c.data.path().to_path_buf(),
            host.clone(),
            rt.handle.clone(),
            started.clone(),
        );
        // the app comes up a moment after it was launched
        let launcher = c.launcher(move || {
            let (dir, host, handle, started) =
                (dir.clone(), host2.clone(), handle.clone(), started2.clone());
            // `Rc` stays on this thread: start from here after a short pause the poll must bridge
            std::thread::sleep(Duration::from_millis(400));
            *started.borrow_mut() =
                Some(server::start(&handle, &dir, Registry::new([]), host).unwrap());
        });
        let o = c.run_with(
            &["open", "path=Note.md", "--launch"],
            launcher,
            Duration::from_secs(10),
        );
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert_eq!(o.stdout, "Opened Note.md\n");
        assert_eq!(
            *c.launched.borrow(),
            [Some(c.vault.root.clone())],
            "launched once, on the vault"
        );
        assert!(host.calls().iter().any(|(w, _)| w == "ask:open"));
    }

    #[test]
    fn open_launch_when_the_app_is_already_running_does_not_launch() {
        let c = Cli::new();
        let host = FakeHost::with_vault(&c.vault.root);
        let rt = Runtime::new();
        let _server = serve(c.data.path(), host, &rt);
        let o = c.run(&["open", "path=Note.md", "--launch"]);
        assert_eq!(o.code, EXIT_OK, "{}", o.stderr);
        assert!(c.launched.borrow().is_empty());
    }

    #[test]
    fn open_launch_reports_a_launch_that_fails_and_an_app_that_never_comes_up() {
        let c = Cli::new();
        let failing = FakeLauncher {
            launched: c.launched.clone(),
            on_launch: Box::new(|| {}),
            fail: true,
        };
        let o = c.run_with(
            &["open", "path=Note.md", "--launch"],
            failing,
            Duration::from_millis(200),
        );
        assert_eq!(o.code, EXIT_FAIL);
        assert!(o.stderr.contains("not installed"), "{}", o.stderr);

        let o = c.run_with(
            &["open", "path=Note.md", "--launch"],
            c.launcher(|| {}),
            Duration::from_millis(300),
        );
        assert_eq!(
            o.code, EXIT_NOT_RUNNING,
            "it launched but no socket appeared"
        );
    }

    #[test]
    fn the_parity_refusals_stay_and_help_lists_the_app_commands() {
        let c = Cli::new();
        for cmd in ["search:open", "daily", "tabs", "eval"] {
            let o = c.run(&[cmd]);
            assert_eq!(o.code, EXIT_USAGE, "{cmd}");
            assert!(
                o.stderr.contains("Not available in the Writer CLI"),
                "{cmd}"
            );
        }
        let help = c.run(&["help", "open"]).stdout;
        assert!(
            help.contains("[--launch]") && help.contains("[newtab]"),
            "{help}"
        );
        let all = c.run(&["help"]).stdout;
        assert!(
            all.contains("App:") && all.contains("status") && all.contains("active"),
            "{all}"
        );
    }
}
