//! The MCP servers menu, neutral: one shape for every agent backend (ADR 2026-11-24, spec
//! `SPECs/native-agent-spec.md` 7.1). Tauri-free and pure apart from the cache.
//!
//! - [`Switches`]: the one rule "is this server on", over the list a backend keeps in its setting
//!   (`default_on` says whether the list holds the servers switched off or the ones switched on).
//!   The web twin is `src/lib/switches.ts`; both read `shared/agent-mcp/vectors.json`.
//! - [`McpServer`], [`McpMenu`] and [`assemble`]: what the pane draws. Servers that share a
//!   [`server_key`] are one row (one switch: both harnesses spell a tool by the key), with their
//!   raw names kept; Writer's own `writer` server is first, always on and locked.
//! - [`McpCache`]: the last list of servers per backend and vault, in memory only, with a
//!   single-flight probe. Fed by the menu's own probe and by what the chats see (`init`, the
//!   config watch), so a refresh is a click, never a poll, and never a persisted names file.
//!
//! What a backend adds is `BackendOps::mcp_switches`, `mcp_list` and `mcp_apply` (`backend.rs`).
//! Names and statuses only: no target, URL, environment or config text passes through here.

use super::events::{McpServerStatus, McpState};
use super::mcp_wiring::server_key;
use crate::cli::mcp::SERVER_NAME;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// When a switch takes effect for a chat, said by the backend (the menu's one "applies" line).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum Applies {
    /// The next time a chat's session starts (a running one restarts under `agent.auto-reload`).
    NextStart,
    /// At once, in running chats too.
    Live,
}

/// What a backend says about its switches: the setting that holds them and what it holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SwitchSpec {
    /// The list setting (`agent.<backend>.disabled-mcp-servers` or `...enabled-...`).
    pub setting: &'static str,
    /// `true`: servers are on unless listed (the list holds the switched-off ones). `false`: off
    /// unless listed.
    pub default_on: bool,
    pub applies: Applies,
}

/// The switches of one backend: its default and the stored list (server keys).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Switches {
    pub default_on: bool,
    pub switched: Vec<String>,
}

impl Switches {
    /// The stored list is read once into keys ([`server_key`], in order, no duplicates): a raw
    /// name a user typed (`my.srv`) is the key every harness knows (`my_srv`).
    pub fn new(spec: &SwitchSpec, switched: Vec<String>) -> Self {
        let mut keys: Vec<String> = Vec::with_capacity(switched.len());
        for key in switched.iter().map(|n| server_key(n)) {
            if !keys.contains(&key) {
                keys.push(key);
            }
        }
        Self {
            default_on: spec.default_on,
            switched: keys,
        }
    }

    /// Whether the server called `name` (raw or key) is listed. A list of switched-off servers
    /// (`default_on`) is the tool globs of the harness that denies by prefix (`mcp__a__*` also
    /// covers `a__b`), so a stored key is the name or a prefix of it followed by `__`. A list of
    /// switched-on servers is an allow-list: an entry is exactly its own key, never `a__b` for
    /// `a`, or one entry would switch on servers nobody named. Written once; the web twin is
    /// `isMcpSwitchOn` (`switches.ts`), both pinned by `shared/agent-mcp/vectors.json`.
    fn listed(&self, name: &str) -> bool {
        let key = server_key(name);
        self.switched.iter().any(|s| {
            key == *s
                || (self.default_on
                    && key
                        .strip_prefix(s.as_str())
                        .is_some_and(|r| r.starts_with("__")))
        })
    }

    /// Whether the server called `name` (raw or key) is on. Writer's own server always is.
    pub fn on(&self, name: &str) -> bool {
        server_key(name) == SERVER_NAME || self.default_on != self.listed(name)
    }

    /// The keys that are off without knowing which servers exist: the stored list when servers
    /// are on unless listed, nothing when they are off unless listed (those need the server
    /// list). Sorted, never Writer's own server.
    pub fn denied(&self) -> Vec<String> {
        if !self.default_on {
            return Vec::new();
        }
        let mut keys: Vec<String> = self
            .switched
            .iter()
            .filter(|k| *k != SERVER_NAME)
            .cloned()
            .collect();
        keys.sort();
        keys
    }
}

/// One row of the menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    /// The key every harness knows the server by: what the switch is stored under and what its tools are prefixed with.
    pub name: String,
    /// The raw names that share the key, sorted (one entry unless names collided).
    pub names: Vec<String>,
    pub status: McpState,
    /// Writer's own server: always on, not a switch.
    pub owned_by_writer: bool,
    pub enabled: bool,
}

/// What `agent_mcp_servers` answers: the rows and what the pane says around them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpMenu {
    pub backend: String,
    /// The setting the switches are written to.
    pub setting: String,
    pub default_on: bool,
    pub servers: Vec<McpServer>,
    /// When the list was last read (ms since the epoch), null before the first read.
    pub checked_at_ms: Option<u64>,
    /// Why the last read failed (a short phrase, never output of the program).
    pub error: Option<String>,
    pub applies: Applies,
}

/// Worst first: the state a row of collided names shows.
fn badness(s: McpState) -> u8 {
    match s {
        McpState::Failed => 0,
        McpState::NeedsAuth => 1,
        McpState::Pending => 2,
        McpState::Disconnected => 3,
        McpState::Unknown => 4,
        McpState::Disabled => 5,
        McpState::Connected => 6,
    }
}

/// The rows: Writer's first (its state from the list when the backend lists it, else unknown),
/// then every listed server and every switched one the list no longer holds (so a stale switch can
/// always be undone), by key. Servers sharing a key are one row, in their worst state.
pub fn assemble(listed: &[McpServerStatus], sw: &Switches) -> Vec<McpServer> {
    let mut rows: BTreeMap<String, (Vec<String>, McpState)> = BTreeMap::new();
    for s in listed {
        let slot = rows
            .entry(server_key(&s.name))
            .or_insert_with(|| (Vec::new(), s.status));
        if !slot.0.contains(&s.name) {
            slot.0.push(s.name.clone());
        }
        if badness(s.status) < badness(slot.1) {
            slot.1 = s.status;
        }
    }
    for key in sw.switched.iter().map(|n| server_key(n)) {
        rows.entry(key.clone())
            .or_insert_with(|| (vec![key], McpState::Unknown));
    }
    let writer_state = rows
        .remove(SERVER_NAME)
        .map_or(McpState::Unknown, |(_, s)| s);
    let mut out = vec![McpServer {
        name: SERVER_NAME.into(),
        names: vec![SERVER_NAME.into()],
        status: writer_state,
        owned_by_writer: true,
        enabled: true,
    }];
    let mut rest: Vec<(String, (Vec<String>, McpState))> = rows.into_iter().collect();
    rest.sort_by_cached_key(|(k, _)| (k.to_lowercase(), k.clone()));
    out.extend(rest.into_iter().map(|(key, (mut names, status))| {
        names.sort();
        McpServer {
            enabled: sw.on(&key),
            name: key,
            names,
            status,
            owned_by_writer: false,
        }
    }));
    out
}

/// What the cache knows of one backend in one vault.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Snapshot {
    pub servers: Vec<McpServerStatus>,
    pub checked_at_ms: Option<u64>,
    pub error: Option<String>,
}

impl McpMenu {
    pub fn build(backend: &str, spec: &SwitchSpec, sw: &Switches, snap: &Snapshot) -> Self {
        Self {
            backend: backend.into(),
            setting: spec.setting.into(),
            default_on: spec.default_on,
            servers: assemble(&snap.servers, sw),
            checked_at_ms: snap.checked_at_ms,
            error: snap.error.clone(),
            applies: spec.applies,
        }
    }
}

#[derive(Default)]
struct State {
    /// Raw name to its latest state.
    servers: BTreeMap<String, McpState>,
    checked_at_ms: Option<u64>,
    error: Option<String>,
    /// Counts finished probes: a caller that waited on another's probe sees it moved.
    generation: u64,
}

#[derive(Default)]
struct Entry {
    /// Held for the length of a probe: one probe per backend and vault at a time.
    flight: Mutex<()>,
    state: Mutex<State>,
}

type Key = (String, PathBuf);

/// The last servers of every backend and vault, in memory (never written anywhere).
pub struct McpCache {
    entries: Mutex<HashMap<Key, Arc<Entry>>>,
    clock: fn() -> u64,
}

fn system_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

impl Default for McpCache {
    fn default() -> Self {
        Self::with_clock(system_ms)
    }
}

impl McpCache {
    pub fn with_clock(clock: fn() -> u64) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            clock,
        }
    }

    fn entry(&self, backend: &str, root: &Path) -> Arc<Entry> {
        let mut map = self.entries.lock();
        Arc::clone(
            map.entry((backend.to_string(), root.to_path_buf()))
                .or_default(),
        )
    }

    fn snapshot_of(state: &State) -> Snapshot {
        Snapshot {
            servers: state
                .servers
                .iter()
                .map(|(name, status)| McpServerStatus {
                    name: name.clone(),
                    status: *status,
                })
                .collect(),
            checked_at_ms: state.checked_at_ms,
            error: state.error.clone(),
        }
    }

    /// What is known now; nothing is probed.
    pub fn snapshot(&self, backend: &str, root: &Path) -> Snapshot {
        Self::snapshot_of(&self.entry(backend, root).state.lock())
    }

    /// Servers a chat (its `init`) or the config watch saw: names are united with what is known,
    /// a seen server takes its latest state. Not a read of the list, so `checked_at` stays.
    pub fn observe(&self, backend: &str, root: &Path, seen: &[McpServerStatus]) {
        if seen.is_empty() {
            return;
        }
        let entry = self.entry(backend, root);
        let mut state = entry.state.lock();
        for s in seen {
            state.servers.insert(s.name.clone(), s.status);
        }
    }

    /// Reads the list with `probe`, one at a time per backend and vault: a caller that arrives
    /// while another probe runs waits for it and takes its result (the probe may start every
    /// server, so it is never run twice at once). A good read replaces the servers (it is the
    /// whole list) and stamps the time; a failed one keeps what was known and records why.
    pub fn refresh(
        &self,
        backend: &str,
        root: &Path,
        probe: impl FnOnce() -> Result<Vec<McpServerStatus>, String>,
    ) -> Snapshot {
        let entry = self.entry(backend, root);
        let seen = entry.state.lock().generation;
        let _flight = entry.flight.lock();
        if entry.state.lock().generation != seen {
            return Self::snapshot_of(&entry.state.lock());
        }
        let result = probe();
        let mut state = entry.state.lock();
        state.generation += 1;
        match result {
            Ok(list) => {
                state.servers = list.into_iter().map(|s| (s.name, s.status)).collect();
                state.checked_at_ms = Some((self.clock)());
                state.error = None;
            }
            Err(e) => state.error = Some(e),
        }
        Self::snapshot_of(&state)
    }
}

/// The contract of a backend's switches, for the backend's own test: the setting is in the
/// owner's settings fragment as a global list that defaults to empty, in the backend's namespace,
/// and its name says what the list holds (`disabled-` for a default-on backend, `enabled-` for a
/// default-off one).
#[cfg(test)]
pub(crate) fn assert_switch_contract(backend: &str, spec: &SwitchSpec, fragment: &str) {
    let fragment: serde_json::Value = serde_json::from_str(fragment).unwrap();
    let def = fragment["settings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["key"] == spec.setting)
        .unwrap_or_else(|| panic!("{backend}: {} is not in its fragment", spec.setting));
    assert_eq!(def["type"], "list", "{backend}");
    assert_eq!(def["scope"], "global", "{backend}");
    assert_eq!(def["default"], serde_json::json!([]), "{backend}");
    let want = format!(
        "agent.{backend}.{}-mcp-servers",
        if spec.default_on {
            "disabled"
        } else {
            "enabled"
        }
    );
    assert_eq!(spec.setting, want, "{backend}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::channel;

    const VECTORS: &str = include_str!("../../../shared/agent-mcp/vectors.json");
    const MENU: &str = include_str!("../../../shared/agent-mcp/menu.json");

    fn spec(default_on: bool) -> SwitchSpec {
        SwitchSpec {
            setting: "agent.test.mcp",
            default_on,
            applies: Applies::NextStart,
        }
    }

    fn strings(v: &Value) -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap().to_string())
            .collect()
    }

    fn status(v: &Value) -> Vec<McpServerStatus> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|s| McpServerStatus {
                name: s["name"].as_str().unwrap().into(),
                status: McpState::parse(s["status"].as_str().unwrap()),
            })
            .collect()
    }

    /// The vectors the web twin (`switches.ts`) reads too.
    #[test]
    fn the_shared_vectors_hold_for_the_key_and_the_switch_rule() {
        let v: Value = serde_json::from_str(VECTORS).unwrap();
        for c in v["keys"].as_array().unwrap() {
            assert_eq!(
                server_key(c["raw"].as_str().unwrap()),
                c["key"].as_str().unwrap(),
                "{c}"
            );
        }
        for c in v["on"].as_array().unwrap() {
            let sw = Switches {
                default_on: c["defaultOn"].as_bool().unwrap(),
                switched: strings(&c["list"]),
            };
            let name = c["name"].as_str().unwrap();
            assert_eq!(sw.on(name), c["on"].as_bool().unwrap(), "{c}");
        }
        for c in v["mcpOn"].as_array().unwrap() {
            let sw = Switches::new(
                &spec(c["defaultOn"].as_bool().unwrap()),
                strings(&c["list"]),
            );
            assert_eq!(
                sw.on(c["name"].as_str().unwrap()),
                c["on"].as_bool().unwrap(),
                "{c}"
            );
        }
        let w = Switches {
            default_on: false,
            switched: vec![],
        };
        assert!(
            w.on("writer"),
            "Writer's server is on whatever the list says"
        );
        assert!(!w.on("other"));
    }

    #[test]
    fn denied_is_the_stored_keys_only_when_servers_are_on_unless_listed() {
        let on = Switches::new(&spec(true), vec!["b.c".into(), "a".into(), "writer".into()]);
        assert_eq!(on.denied(), ["a", "b_c"], "sorted keys, never writer");
        // stored twice, raw and as its key: one entry
        let twice = Switches::new(&spec(true), vec!["my.srv".into(), "my_srv".into()]);
        assert_eq!(twice.switched, ["my_srv"]);
        let off = Switches::new(&spec(false), vec!["a".into()]);
        assert!(off.denied().is_empty());
    }

    #[test]
    fn colliding_names_are_one_row_in_their_worst_state_with_every_raw_name() {
        let listed = [
            McpServerStatus {
                name: "my.srv".into(),
                status: McpState::Connected,
            },
            McpServerStatus {
                name: "my srv".into(),
                status: McpState::Failed,
            },
            McpServerStatus {
                name: "my:srv".into(),
                status: McpState::Connected,
            },
        ];
        let rows = assemble(&listed, &Switches::new(&spec(true), vec![]));
        assert_eq!(rows.len(), 2, "writer and one row");
        assert_eq!(rows[1].name, "my_srv");
        assert_eq!(rows[1].names, ["my srv", "my.srv", "my:srv"]);
        assert_eq!(rows[1].status, McpState::Failed);
    }

    /// `mcp__a__*` also covers `a__b`: the menu says what the glob does, and a raw stored name
    /// is the key it stands for.
    #[test]
    fn a_switched_off_server_takes_the_servers_its_glob_covers_with_it() {
        let listed = [
            st("a", McpState::Connected),
            st("a__b", McpState::Connected),
            st("ab", McpState::Connected),
            st("my.srv", McpState::Connected),
        ];
        let sw = Switches::new(&spec(true), vec!["a".into(), "my.srv".into()]);
        let on: Vec<(String, bool)> = assemble(&listed, &sw)
            .into_iter()
            .skip(1)
            .map(|r| (r.name, r.enabled))
            .collect();
        assert_eq!(
            on,
            [
                ("a".into(), false),
                ("a__b".into(), false),
                ("ab".into(), true),
                ("my_srv".into(), false),
            ]
        );
    }

    #[test]
    fn a_stale_switch_is_still_a_row_so_it_can_be_undone() {
        let rows = assemble(&[], &Switches::new(&spec(true), vec!["gone".into()]));
        assert_eq!(rows[1].name, "gone");
        assert!(!rows[1].enabled);
        assert_eq!(rows[1].status, McpState::Unknown);
    }

    /// The golden of the menu (`shared/agent-mcp/menu.json`; the web test renders the same file).
    /// `WRITER_UPDATE_GOLDEN=1 cargo test mcp_menu` rewrites the `menu` of every case.
    #[test]
    fn the_menu_matches_its_golden() {
        let mut golden: Value = serde_json::from_str(MENU).unwrap();
        let update = std::env::var_os("WRITER_UPDATE_GOLDEN").is_some();
        for case in golden["cases"].as_array_mut().unwrap() {
            let sp = SwitchSpec {
                setting: "agent.test.mcp",
                default_on: case["defaultOn"].as_bool().unwrap(),
                applies: serde_json::from_value(case["applies"].clone()).unwrap(),
            };
            let sw = Switches::new(&sp, strings(&case["switched"]));
            let snap = Snapshot {
                servers: status(&case["listed"]),
                checked_at_ms: case["checkedAtMs"].as_u64(),
                error: case["error"].as_str().map(String::from),
            };
            let got = serde_json::to_value(McpMenu::build("test", &sp, &sw, &snap)).unwrap();
            if update {
                case["menu"] = got;
            } else {
                assert_eq!(got, case["menu"], "{}", case["name"]);
            }
        }
        if update {
            let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../shared/agent-mcp/menu.json");
            std::fs::write(path, serde_json::to_string_pretty(&golden).unwrap() + "\n").unwrap();
        }
    }

    fn st(name: &str, status: McpState) -> McpServerStatus {
        McpServerStatus {
            name: name.into(),
            status,
        }
    }

    #[test]
    fn observe_unites_names_and_keeps_the_latest_state_but_not_the_time() {
        let cache = McpCache::with_clock(|| 7);
        let root = Path::new("/v");
        cache.observe("claude", root, &[st("a", McpState::Failed)]);
        cache.observe(
            "claude",
            root,
            &[st("a", McpState::Connected), st("b", McpState::Pending)],
        );
        let snap = cache.snapshot("claude", root);
        assert_eq!(
            snap.servers,
            [st("a", McpState::Connected), st("b", McpState::Pending)]
        );
        assert_eq!(snap.checked_at_ms, None);
        assert!(cache
            .snapshot("claude", Path::new("/other"))
            .servers
            .is_empty());
        assert!(cache.snapshot("other", root).servers.is_empty());
    }

    #[test]
    fn a_good_probe_replaces_the_list_and_stamps_the_time_a_bad_one_keeps_it() {
        let cache = McpCache::with_clock(|| 42);
        let root = Path::new("/v");
        cache.observe("claude", root, &[st("old", McpState::Connected)]);
        let snap = cache.refresh("claude", root, || Ok(vec![st("new", McpState::Connected)]));
        assert_eq!(snap.servers, [st("new", McpState::Connected)]);
        assert_eq!(snap.checked_at_ms, Some(42));
        let snap = cache.refresh("claude", root, || Err("mcp list timed out".into()));
        assert_eq!(snap.servers, [st("new", McpState::Connected)]);
        assert_eq!(snap.error.as_deref(), Some("mcp list timed out"));
        assert_eq!(snap.checked_at_ms, Some(42));
    }

    #[test]
    fn a_caller_that_arrives_during_a_probe_takes_its_result() {
        let cache = Arc::new(McpCache::with_clock(|| 1));
        let probes = Arc::new(AtomicUsize::new(0));
        let (entered_tx, entered_rx) = channel::<()>();
        let (release_tx, release_rx) = channel::<()>();
        let first = {
            let (cache, probes) = (Arc::clone(&cache), Arc::clone(&probes));
            std::thread::spawn(move || {
                cache.refresh("claude", Path::new("/v"), || {
                    probes.fetch_add(1, Ordering::SeqCst);
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(vec![st("a", McpState::Connected)])
                })
            })
        };
        entered_rx.recv().unwrap();
        let second = {
            let (cache, probes) = (Arc::clone(&cache), Arc::clone(&probes));
            std::thread::spawn(move || {
                cache.refresh("claude", Path::new("/v"), || {
                    probes.fetch_add(1, Ordering::SeqCst);
                    Ok(vec![])
                })
            })
        };
        // the second is waiting on the flight (it read the generation before the first finished)
        std::thread::sleep(std::time::Duration::from_millis(150));
        release_tx.send(()).unwrap();
        let (a, b) = (first.join().unwrap(), second.join().unwrap());
        assert_eq!(probes.load(Ordering::SeqCst), 1, "one probe");
        assert_eq!(a, b);
        assert_eq!(a.servers, [st("a", McpState::Connected)]);
        // different backends do not wait for each other
        let other = cache.refresh("other", Path::new("/v"), || Ok(vec![]));
        assert!(other.servers.is_empty());
    }

    #[test]
    fn the_state_words_of_every_backend_map_to_one_state() {
        for (word, state) in [
            ("connected", McpState::Connected),
            ("\u{2714} Connected", McpState::Connected),
            ("needs-auth", McpState::NeedsAuth),
            ("needs_auth", McpState::NeedsAuth),
            ("\u{26a0} Needs authentication", McpState::NeedsAuth),
            ("failed", McpState::Failed),
            ("\u{2717} Failed to connect", McpState::Failed),
            ("pending", McpState::Pending),
            (
                "\u{23f8} Pending approval (run `claude` to approve)",
                McpState::Pending,
            ),
            ("disabled", McpState::Disabled),
            ("disconnected", McpState::Disconnected),
            ("something else", McpState::Unknown),
        ] {
            assert_eq!(McpState::parse(word), state, "{word}");
        }
        // an unknown state on the wire is `unknown`, not an error
        let s: McpState = serde_json::from_value(json!("brand-new")).unwrap();
        assert_eq!(s, McpState::Unknown);
        assert_eq!(
            serde_json::to_value(McpState::NeedsAuth).unwrap(),
            json!("needs-auth")
        );
    }
}
