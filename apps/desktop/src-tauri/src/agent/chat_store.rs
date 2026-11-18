//! Chat history as hidden markdown notes (ADR 2026-11-17 "store agent chats as markdown notes in
//! a hidden chats folder"; spec `SPECs/native-agent-spec.md` section 9). Tauri-free: the Tauri
//! commands in `commands/agent_chats.rs` are thin wrappers.
//!
//! Layout. A chat lives at `<project>/.chats/YYYY-MM-DD-HHmm-<slug>-<id8>.md`, or at
//! `<vault>/.writer/chats/...` when it has no project. Both are hidden folders, so the vault
//! index (`index::paths::is_indexable_rel`), the watcher, the sidebar, Quick Open and `rg` never
//! see them. Identity is the frontmatter `writer-chat-id`, never the file name.
//!
//! Note format (the TypeScript mirror is `features/agent/web/lib/chat-note.ts`; both read the golden notes
//! in `tests/fixtures/agent-chat-notes/`):
//!
//! ```text
//! ---
//! writer-chat-id: <uuid>            # also the CLI session id on the first spawn
//! writer-chat-title: Plan the review
//! ...
//! ---
//!
//! ## user · 2026-11-17 09:12        # header time is UTC, for humans; exact time is in writer:msg
//! <!-- writer:msg {"id":"m1","at":1796000000000} -->
//!
//! message text, markdown
//!
//! > context: [[Plan]], #client
//!
//! ## assistant · 2026-11-17 09:13
//! <!-- writer:msg {"id":"m2","at":1796000060000,"reason":"completed"} -->
//!
//! answer text
//!
//! <!-- writer:tools [{"id":"toolu_1","tool":"Bash","input":{"command":"ls"},"outcome":"ok"}] -->
//! <!-- writer:changes {"turnId":"t1","files":[{"path":"a.md","status":"modified","added":3,"removed":1}]} -->
//! ```
//!
//! `writer:changes` (optional, assistant messages, always last) is the "Changes" card's compact
//! summary: paths, status and +/- counts, never file contents. Notes without it are unchanged.
//! `<!-- writer:session-changes {"files":[...]} -->` (optional, before the first message, after
//! `writer:trimmed`) is the same kind of list for the whole chat (the row above the composer);
//! `bound_note` keeps it when it trims.
//!
//! A message line that would read as structure (`## user ·`, `## assistant ·`, `> context:`,
//! `<!-- writer:`) is stored with a leading U+200B and unescaped on read, so splitting the file on
//! section headers never needs a Markdown parser.
//!
//! Writes go through one lock and one atomic write (`vault_ops::write_text`). Frontmatter edits
//! of an existing note use the byte-minimal patcher (`index::patch`), so properties the user added
//! (and their comments, order and quoting) survive every write. The note is bounded
//! ([`MAX_NOTE_BYTES`]): the oldest messages are dropped first and counted in a
//! `writer:trimmed` marker. Nothing here logs note content.

use super::events::{ChatSummary, TitleSource};
use crate::index::frontmatter::{self, fm_span};
use crate::index::patch::{self, NoteProperty, PatchError};
use crate::vault_ops::{self, VaultOpError};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Hidden folder under a project.
pub const PROJECT_CHATS_DIR: &str = ".chats";
/// Hidden folder under the vault root for chats without a project.
pub const VAULT_CHATS_DIR: &str = ".writer/chats";
/// A chat note never grows past this; older messages are dropped first.
pub const MAX_NOTE_BYTES: usize = 1024 * 1024;
/// Reading a note for `load` is refused above this (a hand-edited or foreign file).
const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;
/// `list` reads only this much of each note (frontmatter is far smaller).
const HEAD_BYTES: usize = 32 * 1024;
/// Default replay budget when a CLI session is gone (spec: at most 8,000 estimated tokens).
pub const DEFAULT_REPLAY_TOKENS: usize = 8_000;
const MAX_TITLE_CHARS: usize = 200;
const MAX_WALK_DIRS: usize = 100_000;
const MAX_WALK_DEPTH: usize = 16;

/// Zero-width space used to escape structural lines inside a message.
pub const ESCAPE: char = '\u{200B}';

pub const K_ID: &str = "writer-chat-id";
pub const K_TITLE: &str = "writer-chat-title";
pub const K_RENAMED: &str = "writer-chat-renamed";
/// Set once an automatic title was applied (`ChatAction::AutoTitle`); a save keeps the title then.
pub const K_TITLE_AUTO: &str = "writer-chat-title-auto";
pub const K_BACKEND: &str = "writer-chat-backend";
pub const K_SESSION: &str = "writer-chat-session-id";
pub const K_PROJECT: &str = "writer-chat-project";
pub const K_PROJECT_PATH: &str = "writer-chat-project-path";
pub const K_CLI_VERSION: &str = "writer-chat-cli-version";
pub const K_MODEL: &str = "writer-chat-model";
pub const K_CREATED: &str = "writer-chat-created";
pub const K_UPDATED: &str = "writer-chat-updated";
pub const K_TURNS: &str = "writer-chat-turns";
pub const K_PINNED: &str = "writer-chat-pinned";
pub const K_ARCHIVED_AT: &str = "writer-chat-archived-at";
pub const K_USAGE: &str = "writer-chat-usage";
pub const K_PREVIEW: &str = "writer-chat-preview";

/// Properties only the chat actions (rename, pin, archive) own once the note exists: a save never
/// overwrites them, so a stale pane cannot undo a rename or a pin made from the history list.
const ACTION_OWNED: [&str; 5] = [K_RENAMED, K_TITLE_AUTO, K_PINNED, K_ARCHIVED_AT, K_TITLE];

#[derive(Debug, thiserror::Error)]
pub enum ChatStoreError {
    #[error("{0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    Io(String),
}

impl From<std::io::Error> for ChatStoreError {
    fn from(e: std::io::Error) -> Self {
        if e.kind() == std::io::ErrorKind::NotFound {
            ChatStoreError::NotFound(e.to_string())
        } else {
            ChatStoreError::Io(e.to_string())
        }
    }
}

impl From<VaultOpError> for ChatStoreError {
    fn from(e: VaultOpError) -> Self {
        match e {
            VaultOpError::NotFound(m) => ChatStoreError::NotFound(m),
            VaultOpError::Invalid(m) => ChatStoreError::Invalid(m),
            other => ChatStoreError::Io(other.to_string()),
        }
    }
}

impl From<PatchError> for ChatStoreError {
    fn from(e: PatchError) -> Self {
        ChatStoreError::Invalid(e.to_string())
    }
}

type Result<T> = std::result::Result<T, ChatStoreError>;

// ---------------------------------------------------------------------------------------------
// Parsed note

/// The frontmatter of a chat note. Field names are the wire names of the golden
/// `*.parsed.json` files, shared with `chat-note.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatMeta {
    pub chat_id: String,
    pub title: String,
    pub title_renamed: bool,
    /// An automatic title was applied (see [`ChatMeta::title_source`]).
    pub title_auto: bool,
    pub backend: Option<String>,
    pub session_id: Option<String>,
    pub project: Option<String>,
    pub project_path: Option<String>,
    pub cli_version: Option<String>,
    pub model: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub turns: u32,
    pub pinned: bool,
    pub archived_at: Option<i64>,
    /// Free-form usage record: opaque to the bindings.
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub usage: Option<Value>,
    pub preview: Option<String>,
}

impl ChatMeta {
    /// Who chose the title: the user (a rename always wins), an automatic title, or nobody yet
    /// (the first message cut to 60 characters). Derived from the two flags so a note written
    /// before automatic titles reads as `none` or `user`.
    pub fn title_source(&self) -> TitleSource {
        if self.title_renamed {
            TitleSource::User
        } else if self.title_auto {
            TitleSource::Auto
        } else {
            TitleSource::None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    fn label(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }
}

/// One message of the transcript.
#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub role: Role,
    pub id: String,
    pub at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    /// Vault-relative paths of the images attached to a user message (`images` of its
    /// `writer:msg` comment); their `![[...]]` embed lines are not part of `text`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
    /// A user message sent into the running turn (`"steer":true` in its `writer:msg` comment; a
    /// note without the mark reads as `false`, an older Writer ignores it).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub steer: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub tools: Option<Value>,
    /// The turn's `TurnChangesSummary` (paths and counts, never contents), assistant only.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub changes: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ParsedBody {
    /// Messages dropped by the size bound (`<!-- writer:trimmed {"messages":N} -->`).
    pub trimmed: u32,
    pub turns: Vec<Turn>,
}

fn is_structural(line: &str) -> bool {
    line.starts_with("## user ·")
        || line.starts_with("## assistant ·")
        || line.starts_with("> context:")
        || line.starts_with("<!-- writer:")
}

/// Undo [`escape_text`] on one line.
pub fn unescape_line(line: &str) -> &str {
    if line.starts_with(ESCAPE) && is_structural(line.trim_start_matches(ESCAPE)) {
        &line[ESCAPE.len_utf8()..]
    } else {
        line
    }
}

/// Escape a message so no line of it reads as note structure. The Rust side only needs this for
/// tests and tools; the pane writes through `chat-note.ts`, which implements the same rule.
pub fn escape_text(text: &str) -> String {
    text.split('\n')
        .map(|l| {
            if is_structural(l.trim_start_matches(ESCAPE)) {
                format!("{ESCAPE}{l}")
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn header_role(line: &str) -> Option<Role> {
    if line.starts_with("## user ·") {
        Some(Role::User)
    } else if line.starts_with("## assistant ·") {
        Some(Role::Assistant)
    } else {
        None
    }
}

fn comment_payload<'a>(line: &'a str, name: &str) -> Option<&'a str> {
    let rest = line.strip_prefix("<!-- writer:")?.strip_prefix(name)?;
    let rest = rest.strip_prefix(' ')?;
    rest.trim_end().strip_suffix("-->").map(str::trim)
}

fn trim_blank_edges<'a>(lines: &'a [&'a str]) -> &'a [&'a str] {
    let mut a = 0;
    let mut b = lines.len();
    while a < b && lines[a].trim().is_empty() {
        a += 1;
    }
    while b > a && lines[b - 1].trim().is_empty() {
        b -= 1;
    }
    &lines[a..b]
}

/// Parse the part of a note after its frontmatter. Lenient: a hand-edited note with a missing
/// `writer:msg` comment still yields its messages (synthetic id and the header time).
pub fn parse_body(body: &str) -> ParsedBody {
    let body = body.replace("\r\n", "\n");
    let lines: Vec<&str> = body.split('\n').collect();
    let mut trimmed = 0u32;
    let mut sections: Vec<(Role, &str, Vec<&str>)> = Vec::new();
    for line in &lines {
        if let Some(role) = header_role(line) {
            let when = line
                .split_once("· ")
                .map(|(_, t)| t.trim())
                .unwrap_or_default();
            sections.push((role, when, Vec::new()));
        } else if let Some(cur) = sections.last_mut() {
            cur.2.push(line);
        } else if let Some(p) = comment_payload(line, "trimmed") {
            if let Ok(v) = serde_json::from_str::<Value>(p) {
                trimmed = v.get("messages").and_then(Value::as_u64).unwrap_or(0) as u32;
            }
        }
    }
    let turns = sections
        .into_iter()
        .enumerate()
        .map(|(i, (role, when, lines))| parse_section(i, role, when, &lines))
        .collect();
    ParsedBody { trimmed, turns }
}

fn parse_section(index: usize, role: Role, when: &str, lines: &[&str]) -> Turn {
    let mut rest = trim_blank_edges(lines);
    let mut id = format!("m{}", index + 1);
    let mut at = parse_header_time(when).unwrap_or(0);
    let mut reason = None;
    let mut images: Option<Vec<String>> = None;
    let mut steer = false;
    if let Some(first) = rest.first() {
        if let Some(p) = comment_payload(first, "msg") {
            if let Ok(v) = serde_json::from_str::<Value>(p) {
                if let Some(s) = v.get("id").and_then(Value::as_str) {
                    id = s.to_string();
                }
                if let Some(n) = v.get("at").and_then(Value::as_i64) {
                    at = n;
                }
                reason = v.get("reason").and_then(Value::as_str).map(String::from);
                steer = v.get("steer").and_then(Value::as_bool) == Some(true);
                images = v
                    .get("images")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(String::from)
                            .collect()
                    })
                    .filter(|a: &Vec<String>| !a.is_empty());
            }
            rest = trim_blank_edges(&rest[1..]);
            // one embed line per image comes first (the note shows them above the text)
            if let Some(n) = images.as_ref().map(Vec::len) {
                let embeds = rest
                    .iter()
                    .take(n)
                    .take_while(|l| l.starts_with("!["))
                    .count();
                rest = trim_blank_edges(&rest[embeds..]);
            }
        }
    }
    // `writer:changes` is the last comment of a message, after `writer:tools`
    let mut changes = None;
    if let Some(last) = rest.last() {
        if let Some(p) = comment_payload(last, "changes") {
            changes = serde_json::from_str::<Value>(p).ok();
            rest = trim_blank_edges(&rest[..rest.len() - 1]);
        }
    }
    let mut tools = None;
    if let Some(last) = rest.last() {
        if let Some(p) = comment_payload(last, "tools") {
            tools = serde_json::from_str::<Value>(p).ok();
            rest = trim_blank_edges(&rest[..rest.len() - 1]);
        }
    }
    let mut context = None;
    if let Some(last) = rest.last() {
        if let Some(c) = last.strip_prefix("> context: ") {
            context = Some(c.trim().to_string());
            rest = trim_blank_edges(&rest[..rest.len() - 1]);
        }
    }
    let text = rest
        .iter()
        .map(|l| unescape_line(l))
        .collect::<Vec<_>>()
        .join("\n");
    Turn {
        role,
        id,
        at,
        reason,
        text,
        context,
        images,
        steer,
        tools,
        changes,
    }
}

/// `2026-11-17 09:12` (UTC) to epoch milliseconds.
fn parse_header_time(s: &str) -> Option<i64> {
    let (date, time) = s.split_once(' ')?;
    let mut d = date.split('-');
    let (y, m, day): (i64, i64, i64) = (
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
    );
    let mut t = time.split(':');
    let (hh, mm): (i64, i64) = (t.next()?.parse().ok()?, t.next()?.parse().ok()?);
    Some((days_from_civil(y, m, day) * 86_400 + hh * 3600 + mm * 60) * 1000)
}

// Howard Hinnant's civil-date algorithms (public domain); no chrono dependency.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `YYYY-MM-DD-HHmm` (UTC) of an epoch-millisecond timestamp.
fn file_stamp(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{d:02}-{:02}{:02}",
        rem / 3600,
        rem % 3600 / 60
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------------------------
// Frontmatter

fn prop<'a>(props: &'a [NoteProperty], name: &str) -> Option<&'a Value> {
    props.iter().find(|p| p.name == name).map(|p| &p.value)
}

fn prop_str(props: &[NoteProperty], name: &str) -> Option<String> {
    match prop(props, name)? {
        Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn prop_i64(props: &[NoteProperty], name: &str) -> Option<i64> {
    match prop(props, name)? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn prop_bool(props: &[NoteProperty], name: &str) -> bool {
    match prop(props, name) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// The chat metadata of a note, or `None` when it has no `writer-chat-id` (not a chat note).
pub fn meta_from_text(text: &str) -> Result<Option<ChatMeta>> {
    let props = patch::read_properties(text)?;
    let Some(chat_id) = prop_str(&props, K_ID) else {
        return Ok(None);
    };
    let usage = match prop(&props, K_USAGE) {
        Some(v @ Value::Object(m)) if !m.is_empty() => Some(v.clone()),
        _ => None,
    };
    Ok(Some(ChatMeta {
        title: prop_str(&props, K_TITLE).unwrap_or_else(|| "New chat".into()),
        title_renamed: prop_bool(&props, K_RENAMED),
        title_auto: prop_bool(&props, K_TITLE_AUTO),
        backend: prop_str(&props, K_BACKEND),
        session_id: prop_str(&props, K_SESSION),
        project: prop_str(&props, K_PROJECT),
        project_path: prop_str(&props, K_PROJECT_PATH),
        cli_version: prop_str(&props, K_CLI_VERSION),
        model: prop_str(&props, K_MODEL),
        created_at: prop_i64(&props, K_CREATED).unwrap_or(0),
        updated_at: prop_i64(&props, K_UPDATED).unwrap_or(0),
        turns: prop_i64(&props, K_TURNS).unwrap_or(0).max(0) as u32,
        pinned: prop_bool(&props, K_PINNED),
        archived_at: prop_i64(&props, K_ARCHIVED_AT),
        usage,
        preview: prop_str(&props, K_PREVIEW),
        chat_id,
    }))
}

/// A whole note: metadata plus transcript.
pub fn parse_note(text: &str) -> Result<(ChatMeta, ParsedBody)> {
    let meta = meta_from_text(text)?
        .ok_or_else(|| ChatStoreError::Invalid("not a chat note (no writer-chat-id)".into()))?;
    let body = &text[frontmatter::split(text).body_start..];
    Ok((meta, parse_body(body)))
}

fn clean_title(s: &str) -> String {
    let one: String = s
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect();
    one
}

// ---------------------------------------------------------------------------------------------
// Names and locations

/// A uuid in its canonical 8-4-4-4-12 form; anything else never reaches the file system.
pub fn is_valid_chat_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && [8usize, 4, 4, 4, 12]
            .iter()
            .zip(&parts)
            .all(|(n, p)| p.len() == *n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn check_id(id: &str) -> Result<()> {
    if is_valid_chat_id(id) {
        Ok(())
    } else {
        Err(ChatStoreError::Invalid("invalid chat id".into()))
    }
}

fn id8(id: &str) -> String {
    id.chars().take(8).collect::<String>().to_ascii_lowercase()
}

/// ASCII slug of a title, at most 40 characters, never empty.
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 40 {
            break;
        }
    }
    let out = out.trim_matches('-').to_string();
    if out.is_empty() {
        "chat".into()
    } else {
        out
    }
}

/// `YYYY-MM-DD-HHmm-<slug>-<id8>.md`.
pub fn file_name(created_ms: i64, title: &str, chat_id: &str) -> String {
    format!(
        "{}-{}-{}.md",
        file_stamp(created_ms),
        slugify(title),
        id8(chat_id)
    )
}

fn rel_string(root: &Path, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in rel.components() {
        parts.push(c.as_os_str().to_str()?.to_string());
    }
    Some(parts.join("/"))
}

/// The chats folder for a project (vault-relative folder, confined and existing) or for the
/// vault root. `root` must be canonical. The folder itself is not created here.
pub fn chats_dir(root: &Path, project_path: Option<&str>) -> Result<PathBuf> {
    match project_path.map(str::trim).filter(|p| !p.is_empty()) {
        None => Ok(root.join(VAULT_CHATS_DIR)),
        Some(p) => {
            let c = vault_ops::confine(root, p)?;
            if !c.abs.is_dir() {
                return Err(ChatStoreError::NotFound(format!(
                    "project folder {} does not exist",
                    c.rel
                )));
            }
            Ok(c.abs.join(PROJECT_CHATS_DIR))
        }
    }
}

/// The project a chats folder belongs to (`None` for the vault's own chats).
fn project_of_dir(root: &Path, dir: &Path) -> Option<String> {
    if dir == root.join(VAULT_CHATS_DIR) {
        return None;
    }
    rel_string(root, dir.parent()?)
}

/// Every chats folder in the vault: the vault's own plus each `<folder>/.chats`. Hidden folders
/// other than `.chats` and `node_modules` are not entered, symlinks are not followed, and the
/// walk is bounded.
pub fn all_chat_dirs(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let own = root.join(VAULT_CHATS_DIR);
    if own.is_dir() {
        out.push(own);
    }
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    let mut visited = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        visited += 1;
        if visited > MAX_WALK_DIRS {
            log::warn!("agent chats: directory walk stopped at {MAX_WALK_DIRS} folders");
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if !ft.is_dir() {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name == PROJECT_CHATS_DIR {
                out.push(entry.path());
            } else if name.starts_with('.') || name == "node_modules" {
                continue;
            } else if depth < MAX_WALK_DEPTH {
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    out.sort();
    out
}

// ---------------------------------------------------------------------------------------------
// Location cache and write lock

fn cache() -> &'static Mutex<HashMap<(PathBuf, String), PathBuf>> {
    static CACHE: OnceLock<Mutex<HashMap<(PathBuf, String), PathBuf>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn remember(root: &Path, id: &str, abs: &Path) {
    cache()
        .lock()
        .insert((root.to_path_buf(), id.to_string()), abs.to_path_buf());
}

fn forget(root: &Path, id: &str) {
    cache().lock().remove(&(root.to_path_buf(), id.to_string()));
}

/// Serialises every write (save, rename, pin, archive, delete) so a read-modify-write of one note
/// never interleaves with another.
fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Default::default)
}

// ---------------------------------------------------------------------------------------------
// Reading

fn read_head(path: &Path, max: usize) -> std::io::Result<String> {
    let mut buf = Vec::with_capacity(max.min(4096));
    std::fs::File::open(path)?
        .take(max as u64)
        .read_to_end(&mut buf)?;
    // A cut can land inside a multi-byte character: drop the partial tail.
    match String::from_utf8(buf) {
        Ok(s) => Ok(s),
        Err(e) => {
            let valid = e.utf8_error().valid_up_to();
            let mut b = e.into_bytes();
            b.truncate(valid);
            Ok(String::from_utf8(b).unwrap_or_default())
        }
    }
}

fn read_whole(path: &Path) -> Result<String> {
    let len = std::fs::metadata(path)?.len();
    if len > MAX_READ_BYTES {
        return Err(ChatStoreError::Invalid(format!(
            "chat note is {len} bytes; the limit is {MAX_READ_BYTES}"
        )));
    }
    Ok(vault_ops::read_text(path)?)
}

/// Metadata of the note at `abs` reading only its head when the frontmatter fits.
fn read_meta(abs: &Path) -> Result<Option<ChatMeta>> {
    let head = read_head(abs, HEAD_BYTES)?;
    if fm_span(&head).is_some() {
        return meta_from_text(&head);
    }
    meta_from_text(&read_whole(abs)?)
}

fn summary_of(root: &Path, abs: &Path, meta: &ChatMeta) -> ChatSummary {
    ChatSummary {
        chat_id: meta.chat_id.clone(),
        path: rel_string(root, abs).unwrap_or_default(),
        title: meta.title.clone(),
        project_path: abs.parent().and_then(|d| project_of_dir(root, d)),
        session_id: meta.session_id.clone(),
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        turn_count: meta.turns,
        archived: meta.archived_at.is_some(),
        pinned: meta.pinned,
        preview: meta.preview.clone(),
        title_source: meta.title_source(),
    }
}

/// Which chats `list` returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListScope {
    /// One project's chats (`None`: the vault's own chats).
    Project(Option<String>),
    /// Every chat in the vault, grouped by the caller through `ChatSummary::project_path`.
    All,
}

#[derive(Debug, Clone)]
pub struct ListOptions {
    pub scope: ListScope,
    pub include_archived: bool,
    /// Case-insensitive; every whitespace-separated word must occur in the title or the preview
    /// (the first user message). Empty or absent: no filter.
    pub query: Option<String>,
}

fn matches_query(meta: &ChatMeta, words: &[String]) -> bool {
    if words.is_empty() {
        return true;
    }
    let hay = format!(
        "{}\n{}",
        meta.title.to_lowercase(),
        meta.preview.as_deref().unwrap_or("").to_lowercase()
    );
    words.iter().all(|w| hay.contains(w.as_str()))
}

/// Chats, newest update first. Unreadable or foreign notes in a chats folder are skipped (logged
/// by count only).
pub fn list(root: &Path, opts: &ListOptions) -> Result<Vec<ChatSummary>> {
    let dirs = match &opts.scope {
        ListScope::Project(p) => vec![chats_dir(root, p.as_deref())?],
        ListScope::All => all_chat_dirs(root),
    };
    let words: Vec<String> = opts
        .query
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_lowercase)
        .collect();
    let mut out = Vec::new();
    let mut skipped = 0usize;
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_note = path.extension().is_some_and(|e| e == "md")
                && entry.file_type().is_ok_and(|t| t.is_file());
            if !is_note {
                continue;
            }
            match read_meta(&path) {
                Ok(Some(meta)) => {
                    if !is_valid_chat_id(&meta.chat_id) {
                        skipped += 1;
                        continue;
                    }
                    remember(root, &meta.chat_id, &path);
                    if (opts.include_archived || meta.archived_at.is_none())
                        && matches_query(&meta, &words)
                    {
                        out.push(summary_of(root, &path, &meta));
                    }
                }
                _ => skipped += 1,
            }
        }
    }
    if skipped > 0 {
        log::warn!("agent chats: skipped {skipped} unreadable notes while listing");
    }
    out.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then(b.created_at.cmp(&a.created_at))
            .then(a.chat_id.cmp(&b.chat_id))
    });
    Ok(out)
}

/// The note of `chat_id`, or `None`. Uses the location cache, then the vault's own chats folder,
/// then a walk; candidates are matched by the `-<id8>.md` suffix and confirmed by the id in the
/// frontmatter.
pub fn find(root: &Path, chat_id: &str) -> Result<Option<PathBuf>> {
    check_id(chat_id)?;
    if let Some(p) = cache()
        .lock()
        .get(&(root.to_path_buf(), chat_id.to_string()))
        .cloned()
    {
        if p.is_file() {
            return Ok(Some(p));
        }
        forget(root, chat_id);
    }
    let suffix = format!("-{}.md", id8(chat_id));
    for dir in all_chat_dirs(root) {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if !name.to_str().is_some_and(|n| n.ends_with(&suffix)) {
                continue;
            }
            let path = entry.path();
            if let Ok(Some(meta)) = read_meta(&path) {
                if meta.chat_id.eq_ignore_ascii_case(chat_id) {
                    remember(root, chat_id, &path);
                    return Ok(Some(path));
                }
            }
        }
    }
    Ok(None)
}

fn require(root: &Path, chat_id: &str) -> Result<PathBuf> {
    find(root, chat_id)?.ok_or_else(|| ChatStoreError::NotFound(format!("chat {chat_id}")))
}

/// The summary and the full note text.
pub fn load(root: &Path, chat_id: &str) -> Result<(ChatSummary, String)> {
    let abs = require(root, chat_id)?;
    let text = read_whole(&abs)?;
    let meta = meta_from_text(&text)?
        .ok_or_else(|| ChatStoreError::Invalid("not a chat note (no writer-chat-id)".into()))?;
    Ok((summary_of(root, &abs, &meta), text))
}

// ---------------------------------------------------------------------------------------------
// Writing

fn set(text: &str, name: &str, value: &Value) -> Result<String> {
    Ok(patch::set_property(text, name, value, None)?)
}

fn section_starts(text: &str, from: usize) -> Vec<usize> {
    let mut v = Vec::new();
    let mut pos = from;
    for line in text[from..].split_inclusive('\n') {
        if header_role(line).is_some() {
            v.push(pos);
        }
        pos += line.len();
    }
    v
}

/// Drop the oldest messages until the note fits `max` bytes, recording how many in a
/// `writer:trimmed` marker; a single message that is still too large is cut.
pub fn bound_note(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let body_start = frontmatter::split(text).body_start;
    let starts = section_starts(text, body_start);
    let Some(&first) = starts.first() else {
        return cut_at_boundary(text, max);
    };
    let before = &text[body_start..first];
    let already = parse_body(before).trimmed;
    // the chat's changed-notes list (paths and counts) sits before the first message too
    let session = before
        .lines()
        .find(|l| comment_payload(l, "session-changes").is_some())
        .map(|l| format!("{l}\n"))
        .unwrap_or_default();
    let head = &text[..body_start];
    // Keep the longest suffix of whole sections that fits with the marker.
    let reserve = head.len() + 80 + session.len();
    let mut keep_from = starts.len() - 1;
    let mut size = text.len() - starts[keep_from];
    while keep_from > 0 {
        let candidate = size + (starts[keep_from] - starts[keep_from - 1]);
        if candidate + reserve > max {
            break;
        }
        keep_from -= 1;
        size = candidate;
    }
    let dropped = keep_from as u32 + already;
    let mut out = String::with_capacity(size + reserve);
    out.push_str(head);
    if !head.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&format!(
        "\n<!-- writer:trimmed {{\"messages\":{dropped}}} -->\n{session}\n"
    ));
    out.push_str(&text[starts[keep_from]..]);
    if out.len() > max {
        // One message alone is over the bound.
        return cut_at_boundary(&out, max);
    }
    out
}

fn cut_at_boundary(text: &str, max: usize) -> String {
    const TAIL: &str = "\n\n<!-- writer:truncated -->\n";
    let mut cut = max.saturating_sub(TAIL.len()).min(text.len());
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{TAIL}", &text[..cut])
}

fn target_path(
    root: &Path,
    props: &[NoteProperty],
    meta_created: i64,
    title: &str,
    id: &str,
) -> Result<PathBuf> {
    let project = prop_str(props, K_PROJECT_PATH);
    let dir = chats_dir(root, project.as_deref())?;
    Ok(dir.join(file_name(meta_created, title, id)))
}

/// Write the pane's note. `markdown` is a full note (frontmatter and body) produced by
/// `chat-note.ts`; its `writer-chat-id` must equal `chat_id`. A new chat is created in its
/// project's (or the vault's) chats folder; an existing note keeps its place, its name, its
/// user-added properties, and the title, pin and archive state its actions set.
pub fn save(
    root: &Path,
    chat_id: &str,
    markdown: &str,
    title_hint: Option<&str>,
) -> Result<ChatSummary> {
    check_id(chat_id)?;
    if markdown.len() > MAX_READ_BYTES as usize {
        return Err(ChatStoreError::Invalid("chat note is too large".into()));
    }
    let markdown = markdown.replace("\r\n", "\n");
    if fm_span(&markdown).is_none() {
        return Err(ChatStoreError::Invalid(
            "a chat note needs frontmatter".into(),
        ));
    }
    let incoming = patch::read_properties(&markdown)?;
    match prop_str(&incoming, K_ID) {
        Some(id) if id.eq_ignore_ascii_case(chat_id) => {}
        _ => {
            return Err(ChatStoreError::Invalid(
                "writer-chat-id does not match the chat id".into(),
            ))
        }
    }
    let now = now_ms();
    let _guard = write_lock().lock();
    let existing = find(root, chat_id)?;

    let text = match &existing {
        Some(abs) => merge_into_existing(&read_whole(abs)?, &markdown, &incoming)?,
        None => {
            let mut t = markdown.clone();
            let title = prop_str(&incoming, K_TITLE)
                .or_else(|| title_hint.map(str::to_string))
                .map(|s| clean_title(&s))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "New chat".into());
            t = set(&t, K_TITLE, &json!(title))?;
            if prop_i64(&incoming, K_CREATED).is_none() {
                t = set(&t, K_CREATED, &json!(now))?;
            }
            if prop_i64(&incoming, K_UPDATED).is_none() {
                t = set(&t, K_UPDATED, &json!(now))?;
            }
            t
        }
    };
    let text = bound_note(&finish_newline(&text), MAX_NOTE_BYTES);
    let meta =
        meta_from_text(&text)?.ok_or_else(|| ChatStoreError::Invalid("not a chat note".into()))?;
    let abs = match existing {
        Some(a) => a,
        None => {
            let props = patch::read_properties(&text)?;
            let abs = target_path(root, &props, meta.created_at, &meta.title, chat_id)?;
            if let Some(dir) = abs.parent() {
                std::fs::create_dir_all(dir)?;
            }
            abs
        }
    };
    vault_ops::write_text(&abs, &text)?;
    remember(root, chat_id, &abs);
    Ok(summary_of(root, &abs, &meta))
}

fn finish_newline(text: &str) -> String {
    let mut s = text.trim_end_matches('\n').to_string();
    s.push('\n');
    s
}

/// The existing note's frontmatter patched with the incoming `writer-chat-*` values, followed by
/// the incoming body.
fn merge_into_existing(
    existing: &str,
    incoming_text: &str,
    incoming: &[NoteProperty],
) -> Result<String> {
    let current = patch::read_properties(existing)?;
    // a title chosen by the user or by the automatic titler is never overwritten by a save
    let title_locked = prop_bool(&current, K_RENAMED) || prop_bool(&current, K_TITLE_AUTO);
    let mut t = existing.to_string();
    if fm_span(&t).is_none() {
        // A chat note whose frontmatter the user deleted: start over from the pane's copy.
        return Ok(incoming_text.to_string());
    }
    for p in incoming {
        if !p.name.starts_with("writer-chat-") {
            continue;
        }
        let owned = ACTION_OWNED.contains(&p.name.as_str());
        if owned && (p.name != K_TITLE || title_locked) {
            continue;
        }
        if p.name == K_TITLE {
            let title = clean_title(p.value.as_str().unwrap_or(""));
            if title.is_empty() {
                continue;
            }
            t = set(&t, &p.name, &json!(title))?;
        } else {
            t = set(&t, &p.name, &p.value)?;
        }
    }
    let head = &t[..frontmatter::split(&t).body_start];
    let body = &incoming_text[frontmatter::split(incoming_text).body_start..];
    Ok(format!("{head}{body}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatAction {
    Rename,
    /// Apply an automatic title once: a no-op when the user renamed the chat or a title was
    /// already applied automatically.
    AutoTitle,
    /// The user asked for a new automatic title (history "Regenerate title"): overwrites any
    /// title, user-set included, and leaves an automatic one (`writer-chat-title-auto` set, the
    /// rename flag removed) so a later manual rename wins again.
    RegenerateTitle,
    Pin,
    Unpin,
    Archive,
    Unarchive,
    Delete,
}

/// Apply an action. Returns the updated summary, `None` after a delete. `permanent` skips the
/// system Trash (tests, and callers that must not play the Finder trash sound).
pub fn action(
    root: &Path,
    chat_id: &str,
    action: ChatAction,
    title: Option<&str>,
    permanent: bool,
) -> Result<Option<ChatSummary>> {
    check_id(chat_id)?;
    let _guard = write_lock().lock();
    let abs = require(root, chat_id)?;
    match action {
        ChatAction::Delete => {
            crate::commands::fs::delete_entry_with(
                abs.to_str()
                    .ok_or_else(|| ChatStoreError::Invalid("path is not valid UTF-8".into()))?,
                permanent,
            )
            .map_err(|e| ChatStoreError::Io(e.to_string()))?;
            forget(root, chat_id);
            Ok(None)
        }
        ChatAction::Rename => set_title(root, &abs, chat_id, title, TitleSource::User),
        ChatAction::AutoTitle => {
            let meta = read_meta(&abs)?.ok_or_else(|| {
                ChatStoreError::Invalid("not a chat note (no writer-chat-id)".into())
            })?;
            if meta.title_source() != TitleSource::None {
                return finish(root, &abs).map(Some);
            }
            set_title(root, &abs, chat_id, title, TitleSource::Auto)
        }
        ChatAction::RegenerateTitle => set_title(root, &abs, chat_id, title, TitleSource::Auto),
        ChatAction::Pin | ChatAction::Unpin => {
            let pinned = action == ChatAction::Pin;
            vault_ops::edit_note(&abs, |t| {
                patch::set_property(t, K_PINNED, &json!(pinned), None)
            })?;
            finish(root, &abs).map(Some)
        }
        ChatAction::Archive | ChatAction::Unarchive => {
            let value = if action == ChatAction::Archive {
                json!(now_ms())
            } else {
                Value::Null
            };
            vault_ops::edit_note(&abs, |t| {
                patch::set_property(t, K_ARCHIVED_AT, &value, None)
            })?;
            finish(root, &abs).map(Some)
        }
    }
}

/// The one title writer (rename, automatic, regenerated): sets `writer-chat-title` and the flag of
/// `source`, renames the file's slug. `User` sets the rename flag; `Auto` sets the automatic flag
/// and removes the rename flag (the title is no longer the user's).
fn set_title(
    root: &Path,
    abs: &Path,
    chat_id: &str,
    title: Option<&str>,
    source: TitleSource,
) -> Result<Option<ChatSummary>> {
    let title = clean_title(title.unwrap_or(""));
    if title.is_empty() {
        return Err(ChatStoreError::Invalid(
            "a chat title cannot be empty".into(),
        ));
    }
    vault_ops::edit_note(abs, |t| {
        let t = patch::set_property(t, K_TITLE, &json!(title), None)?;
        if source == TitleSource::User {
            return patch::set_property(&t, K_RENAMED, &json!(true), None);
        }
        let t = patch::set_property(&t, K_TITLE_AUTO, &json!(true), None)?;
        match patch::remove_property(&t, K_RENAMED) {
            Err(PatchError::NotFound(_)) => Ok(t),
            other => other,
        }
    })?;
    let abs = rename_file_to_title(root, abs, chat_id, &title);
    finish(root, &abs).map(Some)
}

fn finish(root: &Path, abs: &Path) -> Result<ChatSummary> {
    let meta = read_meta(abs)?
        .ok_or_else(|| ChatStoreError::Invalid("not a chat note (no writer-chat-id)".into()))?;
    remember(root, &meta.chat_id, abs);
    Ok(summary_of(root, abs, &meta))
}

/// Best effort: give the file the slug of the new title, keeping the date and the id8. A name
/// collision or a failed rename leaves the file where it is (identity is the frontmatter id).
fn rename_file_to_title(root: &Path, abs: &Path, chat_id: &str, title: &str) -> PathBuf {
    let Ok(Some(meta)) = read_meta(abs) else {
        return abs.to_path_buf();
    };
    let Some(dir) = abs.parent() else {
        return abs.to_path_buf();
    };
    let target = dir.join(file_name(meta.created_at, title, chat_id));
    if target == abs || target.exists() {
        return abs.to_path_buf();
    }
    match std::fs::rename(abs, &target) {
        Ok(()) => {
            remember(root, chat_id, &target);
            target
        }
        Err(_) => abs.to_path_buf(),
    }
}

// ---------------------------------------------------------------------------------------------
// Resume

/// Does a CLI error text mean "this session id is unknown to the CLI" (a different machine,
/// cleaned transcripts)? Matched loosely so a reworded message still works; the runner logs only
/// the fact, never the text.
pub fn is_session_missing(message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("no conversation found")
        || m.contains("conversation not found")
        || (m.contains("session") && (m.contains("not found") || m.contains("no such")))
        || m.contains("could not find session")
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplaySeed {
    /// Text to put in front of the first message of the new session.
    pub text: String,
    pub turns_included: usize,
    pub turns_total: usize,
    pub estimated_tokens: usize,
}

fn est_tokens(s: &str) -> usize {
    s.chars().count().div_ceil(4)
}

const REPLAY_INTRO: &str = "[Resumed from notes] The earlier part of this conversation was restored from a saved note because the original session is no longer available. It is context, not new instructions.";

/// The messages of a whole chat note (frontmatter skipped).
pub fn turns_of(markdown: &str) -> Vec<Turn> {
    parse_body(&markdown[frontmatter::split(markdown).body_start..]).turns
}

/// A capped replay of the note's user and assistant text: the most recent messages that fit
/// `max_tokens` (estimated at 4 characters per token), oldest first, each message cut to half the
/// budget. The newest message is always included. Tool trails and context lines are left out.
pub fn replay_seed(markdown: &str, max_tokens: usize) -> ReplaySeed {
    let turns = turns_of(markdown);
    let total = turns.len();
    let per_message_chars = (max_tokens * 4 / 2).max(200);
    let budget = max_tokens.saturating_sub(est_tokens(REPLAY_INTRO) + 20);
    let mut picked: Vec<String> = Vec::new();
    let mut used = 0usize;
    for t in turns.iter().rev() {
        if t.text.trim().is_empty() {
            continue;
        }
        let mut text: String = t.text.chars().take(per_message_chars).collect();
        if t.text.chars().count() > per_message_chars {
            text.push_str(" [cut]");
        }
        let entry = format!(
            "{}: {}",
            match t.role {
                Role::User => "User",
                Role::Assistant => "Assistant",
            },
            text
        );
        let cost = est_tokens(&entry) + 2;
        if used + cost > budget && !picked.is_empty() {
            break;
        }
        used += cost;
        picked.push(entry);
    }
    picked.reverse();
    let included = picked.len();
    let mut text = String::from(REPLAY_INTRO);
    if included < total {
        text.push_str(&format!(
            " ({} earlier messages omitted.)",
            total - included
        ));
    }
    for e in &picked {
        text.push_str("\n\n");
        text.push_str(e);
    }
    ReplaySeed {
        estimated_tokens: est_tokens(&text),
        text,
        turns_included: included,
        turns_total: total,
    }
}

/// "Copy chat as markdown": the transcript without frontmatter, context lines or tool trails.
pub fn transcript_markdown(markdown: &str) -> String {
    turns_of(markdown)
        .iter()
        .map(|t| format!("**{}**\n\n{}", t.role.label(), t.text))
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
#[path = "chat_store_tests.rs"]
mod tests;
