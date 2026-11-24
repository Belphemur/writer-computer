//! OpenCode's wire: the one place the routes, request bodies and events Writer uses are written
//! (spec `SPECs/opencode-backend-spec.md` sections 1 and 4). Pure data, Tauri-free, no I/O.
//!
//! - **Routes** are constants of one table ([`ROUTES`]); nothing else spells a path. A route is
//!   filled with [`Route::path`] and sent by the client (`client.rs`).
//! - **Request bodies** are structs with their field names listed once ([`WireBody::FIELDS`]).
//! - **Events** are declared once, name and the `data` fields Writer reads ([`events!`]): the
//!   macro writes the struct of each, the [`Event`] enum the mapper matches on and the list
//!   ([`EVENT_SPECS`]) the contract test checks against `contract/openapi-2.4.0.json`.
//!   `tools/used.json` is generated from [`used`] (`WRITER_UPDATE_CONTRACT_LIST=1 cargo test used_list`).
//!
//! Field names are OpenCode's own (`sessionID`, `assistantMessageID`), so the structs read as the
//! wire does and the contract test can compare them as they are.
//!
//! Never logged from here or anywhere that holds these values: prompts, tool input and output,
//! file contents, paths, the password. Error bodies are reduced to `_tag` and status.

// The table also describes routes, bodies and events the contract test pins but no code calls yet
// (a send-now `PATCH`, the runtime MCP routes): they are the wire, not dead code.
#![allow(non_snake_case, dead_code)]

use crate::agent::events::{McpServerStatus, McpState};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The OpenCode version this wire was recorded against; the server refuses anything older.
pub const MIN_VERSION: &str = "2.4.0";

// ---------------------------------------------------------------------------------------------
// Routes

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
        }
    }
}

/// A request body Writer sends: the names of its fields, for the contract test.
pub trait WireBody: Serialize {
    const FIELDS: &'static [&'static str];
}

/// One route: its verb, its path template (the OpenAPI spelling, `{sessionID}`) and the fields of
/// the body it takes.
#[derive(Debug)]
pub struct Route {
    pub method: Method,
    pub template: &'static str,
    pub body: &'static [&'static str],
}

impl Route {
    /// The path with every `{name}` replaced by its argument (percent-encoded). Panics on a name
    /// the template does not have or a missing one: routes are constants, so that is a bug.
    pub fn path(&self, args: &[(&str, &str)]) -> String {
        let mut out = self.template.to_string();
        for (name, value) in args {
            let key = format!("{{{name}}}");
            assert!(out.contains(&key), "route {} has no {key}", self.template);
            out = out.replace(&key, &encode(value));
        }
        assert!(
            !out.contains('{'),
            "route {} missing an argument",
            self.template
        );
        out
    }
}

/// Percent-encodes everything but unreserved characters: the one encoder of path arguments and
/// query values.
pub fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

macro_rules! bodies {
    ($($(#[$m:meta])* $name:ident { $($(#[$fm:meta])* $f:ident : $t:ty),* $(,)? })*) => {$(
        $(#[$m])*
        #[derive(Debug, Clone, Default, Serialize)]
        pub struct $name { $($(#[$fm])* pub $f: $t),* }
        impl WireBody for $name { const FIELDS: &'static [&'static str] = &[$(stringify!($f)),*]; }
    )*};
}

bodies! {
    /// `POST /api/session`.
    CreateSessionBody {
        location: Location,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<ModelRef>,
        #[serde(skip_serializing_if = "Option::is_none")]
        agent: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        permissions: Option<Vec<Value>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        parentID: Option<String>,
    }
    /// `PATCH /api/session/{sessionID}`: the ruleset is replaced, never merged.
    PatchSessionBody {
        permissions: Vec<Value>,
    }
    /// `POST /api/session/{sessionID}/prompt`; the reply is the admission of the item.
    PromptBody {
        /// `msg_`-prefixed; a repeated id is the same item (a re-send is a no-op).
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        text: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        files: Vec<Value>,
        /// `steer` or `queue`.
        #[serde(skip_serializing_if = "Option::is_none")]
        delivery: Option<String>,
    }
    SetModelBody { model: ModelRef }
    SetAgentBody { agent: String }
    /// `POST .../permission/{requestID}/reply`: `once`, `always` or `reject`. A reject carries a
    /// message: with one the model is told and the turn goes on, without it the turn ends.
    PermissionReplyBody {
        decision: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    }
    /// `POST .../form/{formID}/reply`: `{q0: "label"}` or `{q0: ["a", "b"]}` for a multi-select.
    FormReplyBody { answer: Value }
    /// `PATCH .../inbox/{inboxID}`.
    InboxPatchBody { delivery: String }
    GenerateBody { prompt: String }
    /// `PUT /api/experimental/mcp/{server}`.
    McpPutBody { config: Value }
    /// `PUT /api/experimental/session/{sessionID}/instructions/entries/{key}`.
    InstructionBody { value: String }
}

macro_rules! routes {
    ($($(#[$m:meta])* $id:ident = $method:ident $path:literal $(, body $body:ty)?;)*) => {
        $($(#[$m])* pub const $id: Route = Route {
            method: Method::$method,
            template: $path,
            body: routes!(@body $($body)?),
        };)*
        /// Every route Writer calls.
        pub const ROUTES: &[&Route] = &[$(&$id),*];
    };
    (@body) => { &[] };
    (@body $body:ty) => { <$body as WireBody>::FIELDS };
}

routes! {
    INFO = Get "/api/info";
    /// The one server-wide SSE stream.
    EVENT = Get "/api/event";
    MODELS = Get "/api/model";
    PROVIDERS = Get "/api/provider";
    MCP = Get "/api/mcp";
    SKILLS = Get "/api/skill";
    COMMANDS = Get "/api/command";
    AGENTS = Get "/api/agent";
    /// The sessions that are executing a turn now (absent: inactive): what the stream cannot say
    /// after it dropped.
    SESSIONS_ACTIVE = Get "/api/session/active";
    SESSION_CREATE = Post "/api/session", body CreateSessionBody;
    SESSION_GET = Get "/api/session/{sessionID}";
    SESSION_DELETE = Delete "/api/session/{sessionID}";
    SESSION_PATCH = Patch "/api/session/{sessionID}", body PatchSessionBody;
    PROMPT = Post "/api/session/{sessionID}/prompt", body PromptBody;
    /// `?resume=true` resumes the steering input parked by the interrupt.
    INTERRUPT = Post "/api/session/{sessionID}/interrupt";
    MODEL_SET = Post "/api/session/{sessionID}/model", body SetModelBody;
    AGENT_SET = Post "/api/session/{sessionID}/agent", body SetAgentBody;
    MESSAGES = Get "/api/session/{sessionID}/message";
    INBOX = Get "/api/session/{sessionID}/inbox";
    INBOX_CANCEL = Delete "/api/session/{sessionID}/inbox/{inboxID}";
    INBOX_PATCH = Patch "/api/session/{sessionID}/inbox/{inboxID}", body InboxPatchBody;
    PERMISSIONS = Get "/api/session/{sessionID}/permission";
    PERMISSION_REPLY = Post "/api/session/{sessionID}/permission/{requestID}/reply", body PermissionReplyBody;
    FORMS = Get "/api/session/{sessionID}/form";
    FORM_REPLY = Post "/api/session/{sessionID}/form/{formID}/reply", body FormReplyBody;
    /// `?message=` is what the asker is told.
    FORM_CANCEL = Delete "/api/session/{sessionID}/form/{formID}";
    GENERATE = Post "/api/session/{sessionID}/generate", body GenerateBody;
    /// `?projectID=` limits the list to one project's rules.
    SAVED_RULES = Get "/api/permission/saved";
    PROJECTS = Get "/api/project";
    /// `?location[directory]=` (deepObject): the location's own project, as the server resolves it.
    LOCATION = Get "/api/location";
    SAVED_RULE_DELETE = Delete "/api/permission/saved/{id}";
    MCP_PUT = Put "/api/experimental/mcp/{server}", body McpPutBody;
    MCP_DELETE = Delete "/api/experimental/mcp/{server}";
    RELOAD = Post "/api/location/reload";
    INSTRUCTION_PUT = Put "/api/experimental/session/{sessionID}/instructions/entries/{key}", body InstructionBody;
    INSTRUCTION_DELETE = Delete "/api/experimental/session/{sessionID}/instructions/entries/{key}";
}

// ---------------------------------------------------------------------------------------------
// Shared shapes

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Location {
    #[serde(default)]
    pub directory: String,
}

/// A model: `GET /api/model` entries and the `model` of sessions and steps.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub providerID: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

impl ModelRef {
    /// `provider/model`, the spelling Writer shows and stores.
    pub fn slug(&self) -> String {
        format!("{}/{}", self.providerID, self.id)
    }

    /// Parses `provider/model[#variant]`.
    pub fn parse(slug: &str) -> Option<ModelRef> {
        let (rest, variant) = match slug.split_once('#') {
            Some((r, v)) => (r, Some(v.to_string())),
            None => (slug, None),
        };
        let (provider, id) = rest.split_once('/')?;
        (!provider.is_empty() && !id.is_empty()).then(|| ModelRef {
            id: id.to_string(),
            providerID: provider.to_string(),
            variant,
        })
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub struct CacheTokens {
    #[serde(default)]
    pub read: u64,
    #[serde(default)]
    pub write: u64,
}

/// A step's tokens: `input` is the non-cached input of that step.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
pub struct Tokens {
    #[serde(default)]
    pub input: u64,
    #[serde(default)]
    pub output: u64,
    #[serde(default)]
    pub reasoning: u64,
    #[serde(default)]
    pub cache: CacheTokens,
}

/// `{type, message}`: the shape of every failure the stream reports.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct StructuredError {
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct PermissionSource {
    /// The tool call the request is about.
    #[serde(default)]
    pub id: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FormOption {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FormField {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    /// `string` or `multiselect`.
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub options: Vec<FormOption>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FormMetadataTool {
    #[serde(default)]
    pub id: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct FormMetadata {
    /// `question` for the agent's `question` tool.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub tool: FormMetadataTool,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Form {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub sessionID: String,
    #[serde(default)]
    pub metadata: FormMetadata,
    #[serde(default)]
    pub fields: Vec<FormField>,
}

/// `experimental.job.updated`'s `info`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct JobInfo {
    /// `subagent` or `shell`.
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub sessionID: String,
    #[serde(default)]
    pub childSessionID: Option<String>,
    /// `running`, `completed` or `error`.
    #[serde(default)]
    pub status: String,
}

/// An inbox item as `session.inbox.enqueued` and `GET .../inbox` carry it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct InboxItem {
    /// `user` or `synthetic`.
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub payload: Value,
}

// ---------------------------------------------------------------------------------------------
// Events

/// One frame of `GET /api/event`: `{id, created, type, location?, data, durable?, metadata?}`.
#[derive(Debug, Clone, Deserialize)]
pub struct WireEvent {
    #[serde(default)]
    pub id: String,
    /// Milliseconds since the epoch, the server's clock: what turn durations are measured on.
    #[serde(default)]
    pub created: f64,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub data: Value,
}

impl WireEvent {
    pub fn parse(payload: &str) -> Result<WireEvent, serde_json::Error> {
        serde_json::from_str(payload)
    }

    /// The session a session event is about (every one carries it).
    pub fn session_id(&self) -> Option<&str> {
        self.data.get("sessionID").and_then(Value::as_str)
    }
}

/// An event type and the `data` fields Writer reads of it.
#[derive(Debug)]
pub struct EventSpec {
    pub name: &'static str,
    pub fields: &'static [&'static str],
}

macro_rules! events {
    ($($variant:ident = $name:literal { $($f:ident : $t:ty),* $(,)? })*) => {
        $(
            // the fields are the wire's own (the contract test pins them): some are only documentation
            #[allow(dead_code)]
            #[derive(Debug, Clone, Default, Deserialize)]
            pub struct $variant { $(#[serde(default)] pub $f: $t),* }
        )*

        /// An event Writer reads, typed; every other event is [`Event::Other`].
        #[derive(Debug, Clone)]
        pub enum Event {
            $($variant($variant),)*
            Other(String),
        }

        /// Every event Writer reads, with the `data` fields it reads of each.
        pub const EVENT_SPECS: &[EventSpec] = &[
            $(EventSpec { name: $name, fields: &[$(stringify!($f)),*] },)*
        ];

        impl Event {
            /// Types the frame. An event Writer does not read is `Other`; one it reads with a
            /// field of the wrong type is an error (protocol drift, reported without content).
            pub fn parse(ev: &WireEvent) -> Result<Event, serde_json::Error> {
                match ev.kind.as_str() {
                    $($name => Ok(Event::$variant(serde_json::from_value(ev.data.clone())?)),)*
                    other => Ok(Event::Other(other.to_string())),
                }
            }
        }
    };
}

events! {
    ServerConnected = "server.connected" {}
    SessionCreated = "session.created" {
        sessionID: String,
        parentID: Option<String>,
        agent: Option<String>,
        title: Option<String>,
        model: Option<ModelRef>,
    }
    ExecutionStarted = "session.execution.started" { sessionID: String }
    ExecutionSucceeded = "session.execution.succeeded" { sessionID: String }
    ExecutionFailed = "session.execution.failed" { sessionID: String, error: StructuredError }
    ExecutionInterrupted = "session.execution.interrupted" { sessionID: String, reason: Option<String> }
    StepStarted = "session.step.started" { sessionID: String, assistantMessageID: String, agent: Option<String>, model: Option<ModelRef> }
    StepEnded = "session.step.ended" { sessionID: String, assistantMessageID: String, tokens: Tokens, cost: Option<f64> }
    StepFailed = "session.step.failed" { sessionID: String, assistantMessageID: String, error: StructuredError, tokens: Tokens, cost: Option<f64> }
    TextDelta = "session.text.delta" { sessionID: String, assistantMessageID: String, ordinal: u32, delta: String }
    TextEnded = "session.text.ended" { sessionID: String, assistantMessageID: String, ordinal: u32, text: String }
    ReasoningStarted = "session.reasoning.started" { sessionID: String, assistantMessageID: String, ordinal: u32 }
    ReasoningDelta = "session.reasoning.delta" { sessionID: String, assistantMessageID: String, ordinal: u32, delta: String }
    ReasoningEnded = "session.reasoning.ended" { sessionID: String, assistantMessageID: String, ordinal: u32, text: String }
    ToolInputStarted = "session.tool.input.started" { sessionID: String, assistantMessageID: String, id: String, name: String }
    ToolInputDelta = "session.tool.input.delta" { sessionID: String, id: String, delta: String }
    ToolCalled = "session.tool.called" { sessionID: String, id: String, input: Value }
    ToolProgress = "session.tool.progress" { sessionID: String, id: String, metadata: Value }
    ToolSuccess = "session.tool.success" { sessionID: String, id: String, content: Vec<Value>, metadata: Value }
    ToolFailed = "session.tool.failed" { sessionID: String, id: String, error: StructuredError }
    PermissionAsked = "permission.asked" { id: String, sessionID: String, action: String, resources: Vec<String>, save: Vec<String>, metadata: Value, source: PermissionSource }
    PermissionReplied = "permission.replied" { sessionID: String, requestID: String, reply: String }
    FormCreated = "form.created" { form: Form }
    FormReplied = "form.replied" { id: String, sessionID: String, answer: Value }
    FormCancelled = "form.cancelled" { id: String, sessionID: String }
    InboxEnqueued = "session.inbox.enqueued" { sessionID: String, inboxID: String, item: InboxItem }
    InboxDelivered = "session.inbox.delivered" { sessionID: String, inboxID: String }
    InboxCancelled = "session.inbox.cancelled" { sessionID: String, inboxID: String }
    JobUpdated = "experimental.job.updated" { info: JobInfo }
    RetryScheduled = "session.retry.scheduled" { sessionID: String, assistantMessageID: String, attempt: u32, error: StructuredError }
}

// ---------------------------------------------------------------------------------------------
// Message ids

/// OpenCode's id of a message Writer sends, derived from Writer's own receipt id (a uuid): the
/// same receipt is always the same item, so a re-send after a crash is a no-op, and the id of an
/// `inbox.delivered` leads back to the receipt without a map. `msg_` plus the 32 hex digits.
pub fn message_id_for(receipt: &str) -> String {
    format!("msg_{}", receipt.replace('-', ""))
}

/// The receipt behind a [`message_id_for`] id; `None` for an id OpenCode made itself.
pub fn receipt_for(message_id: &str) -> Option<String> {
    let hex = message_id.strip_prefix("msg_")?;
    if hex.len() != 32 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

// ---------------------------------------------------------------------------------------------
// Replies

/// `{data: T}`, the envelope of nearly every reply.
#[derive(Debug, Deserialize)]
pub struct Data<T> {
    pub data: T,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Info {
    #[serde(default)]
    pub version: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SessionInfo {
    #[serde(default)]
    pub id: String,
}

/// One server of `GET /api/mcp` (`Mcp.Server`): only its name and state word are read; its
/// `error`, `title` and `integrationID` are never kept.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct McpEntry {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub status: McpStatus,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct McpStatus {
    #[serde(default)]
    pub status: String,
}

/// The servers of a `GET /api/mcp` reply, as the neutral list: the one mapper of `SessionStarted`
/// and the menu (`McpState::parse` spells `needs_auth` as it spells Claude's `needs-auth`). A
/// reply that is not the envelope is no servers.
pub fn mcp_statuses(reply: Value) -> Vec<McpServerStatus> {
    serde_json::from_value::<Data<Vec<McpEntry>>>(reply)
        .map(|d| {
            d.data
                .into_iter()
                .map(|m| McpServerStatus {
                    name: m.name,
                    status: McpState::parse(&m.status.status),
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ModelLimit {
    #[serde(default)]
    pub context: u64,
}

/// `GET /api/model`: only what Writer reads (the context window, for the usage ring).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ModelInfo {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub providerID: String,
    #[serde(default)]
    pub limit: ModelLimit,
}

/// The body of an error reply: only the tag (`SessionNotFoundError`, `UnauthorizedError`, ...)
/// is read; the message can hold paths and is never kept.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ErrorBody {
    #[serde(default)]
    pub _tag: String,
}

/// What the contract list of the tools folder holds: the routes and events Writer uses, derived
/// from the tables above (`tools/used.json` is generated from this).
pub fn used() -> serde_json::Value {
    serde_json::json!({
        "note": "Generated from features/opencode/rust/opencode_api.rs by `WRITER_UPDATE_CONTRACT_LIST=1 cargo test used_list`; never edited by hand.",
        "routes": ROUTES.iter().map(|r| format!("{} {}", r.method.as_str(), r.template)).collect::<Vec<_>>(),
        "events": EVENT_SPECS.iter().map(|e| e.name).collect::<Vec<_>>(),
    })
}

// ---------------------------------------------------------------------------------------------
// The server-sent-event stream

/// Splits the bytes of an SSE response into the `data` payloads of its frames. A frame is the
/// lines up to a blank line; `data:` lines join with a newline, comments (`:`, the heartbeat) and
/// other fields are dropped. Bytes may arrive in any chunking.
#[derive(Default)]
pub struct SseParser {
    line: Vec<u8>,
    data: Vec<String>,
    /// Bytes of the current frame, to bound it.
    size: usize,
    /// The current frame went over [`SseParser::MAX_FRAME`] and is dropped to its end.
    skipping: bool,
}

impl SseParser {
    /// A frame over this size is dropped (a content-free protocol error, never an allocation
    /// that grows with the peer).
    pub const MAX_FRAME: usize = 32 * 1024 * 1024;

    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut out = Vec::new();
        for &b in bytes {
            if b != b'\n' {
                self.line.push(b);
                self.size += 1;
                if self.size > Self::MAX_FRAME {
                    self.skipping = true;
                    self.line.clear();
                    self.data.clear();
                    self.size = 0;
                }
                continue;
            }
            let line = std::mem::take(&mut self.line);
            let line = line.strip_suffix(b"\r").unwrap_or(&line);
            if line.is_empty() {
                if !self.skipping && !self.data.is_empty() {
                    out.push(self.data.join("\n"));
                }
                self.data.clear();
                self.size = 0;
                self.skipping = false;
            } else if !self.skipping {
                if let Some(rest) = line.strip_prefix(b"data:") {
                    let rest = rest.strip_prefix(b" ").unwrap_or(rest);
                    self.data.push(String::from_utf8_lossy(rest).into_owned());
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::{BTreeMap, BTreeSet};

    const CONTRACT: &str = include_str!("../contract/openapi-2.4.0.json");

    fn contract() -> Value {
        serde_json::from_str(CONTRACT).unwrap()
    }

    /// `$ref`s followed, `allOf` / `anyOf` / `oneOf` members merged: the property names an object
    /// schema can carry.
    fn props(doc: &Value, schema: &Value, out: &mut BTreeSet<String>, depth: usize) {
        if depth > 8 {
            return;
        }
        if let Some(r) = schema.get("$ref").and_then(Value::as_str) {
            let name = r.rsplit('/').next().unwrap();
            if let Some(target) = doc["components"]["schemas"].get(name) {
                props(doc, target, out, depth + 1);
            }
            return;
        }
        if let Some(p) = schema.get("properties").and_then(Value::as_object) {
            out.extend(p.keys().cloned());
        }
        for key in ["allOf", "anyOf", "oneOf"] {
            for member in schema
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                props(doc, member, out, depth + 1);
            }
        }
    }

    fn body_fields(doc: &Value, route: &Route) -> BTreeSet<String> {
        let op = &doc["paths"][route.template][route.method.as_str().to_lowercase()];
        let schema = &op["requestBody"]["content"]["application/json"]["schema"];
        let mut out = BTreeSet::new();
        props(doc, schema, &mut out, 0);
        out
    }

    /// The `data` properties of each event the contract declares (a schema whose `type` is one
    /// enum value, with a `data`).
    fn contract_events(doc: &Value) -> BTreeMap<String, BTreeSet<String>> {
        let mut out = BTreeMap::new();
        for schema in doc["components"]["schemas"].as_object().unwrap().values() {
            let ty = &schema["properties"]["type"]["enum"];
            let data = &schema["properties"]["data"];
            if let (Some([one]), false) = (ty.as_array().map(Vec::as_slice), data.is_null()) {
                let mut fields = BTreeSet::new();
                props(doc, data, &mut fields, 0);
                out.insert(one.as_str().unwrap().to_string(), fields);
            }
        }
        out
    }

    #[test]
    fn every_route_and_its_body_fields_are_in_the_contract() {
        let doc = contract();
        for route in ROUTES {
            let op = &doc["paths"][route.template][route.method.as_str().to_lowercase()];
            assert!(
                op.is_object(),
                "{} {} is not in openapi-2.4.0.json",
                route.method.as_str(),
                route.template
            );
            if !route.body.is_empty() {
                let known = body_fields(&doc, route);
                for field in route.body {
                    assert!(
                        known.contains(*field),
                        "{} {}: body field `{field}` is not in the contract (it has {known:?})",
                        route.method.as_str(),
                        route.template
                    );
                }
            }
        }
    }

    /// `GET /api/mcp` (`Mcp.Server`): every status of the contract maps to the neutral state
    /// (`needs_auth` included, which used to pass through raw), and an `error` text, a title or
    /// any other field is never kept.
    #[test]
    fn the_mcp_reply_maps_every_status_of_the_contract_and_keeps_names_and_states_only() {
        let reply = json!({"data": [
            {"name": "a", "status": {"status": "connected"}},
            {"name": "b", "status": {"status": "pending"}},
            {"name": "c", "status": {"status": "disabled"}},
            {"name": "d", "status": {"status": "failed", "error": "spawn ENOENT /secret/path"}, "title": "T"},
            {"name": "e", "status": {"status": "needs_auth", "error": "x"}},
            {"name": "my.srv", "status": {"status": "something new"}},
        ]});
        let got = mcp_statuses(reply);
        let states: Vec<_> = got.iter().map(|s| (s.name.as_str(), s.status)).collect();
        assert_eq!(
            states,
            [
                ("a", McpState::Connected),
                ("b", McpState::Pending),
                ("c", McpState::Disabled),
                ("d", McpState::Failed),
                ("e", McpState::NeedsAuth),
                ("my.srv", McpState::Unknown),
            ]
        );
        assert!(!format!("{got:?}").contains("secret"));
        assert!(mcp_statuses(json!({"nope": 1})).is_empty());
        // the statuses of the contract are exactly the ones the mapper knows
        let contract = contract();
        let server =
            &contract["components"]["schemas"]["Mcp.Server"]["properties"]["status"]["anyOf"];
        let words: Vec<String> = server
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                let name = r["$ref"].as_str().unwrap().rsplit('/').next().unwrap();
                contract["components"]["schemas"][name]["properties"]["status"]["enum"][0]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            words,
            ["connected", "pending", "disabled", "failed", "needs_auth"]
        );
        for w in &words {
            assert_ne!(McpState::parse(w), McpState::Unknown, "{w}");
        }
    }

    #[test]
    fn every_event_and_its_data_fields_are_in_the_contract() {
        let events = contract_events(&contract());
        for spec in EVENT_SPECS {
            // `server.connected` has no data object in the contract
            let Some(known) = events.get(spec.name) else {
                assert_eq!(
                    spec.name, "server.connected",
                    "{} is not in the contract",
                    spec.name
                );
                continue;
            };
            for field in spec.fields {
                assert!(
                    known.contains(*field),
                    "{}: data field `{field}` is not in the contract (it has {known:?})",
                    spec.name
                );
            }
        }
    }

    #[test]
    fn route_paths_fill_their_arguments_and_encode_them() {
        assert_eq!(
            PROMPT.path(&[("sessionID", "ses_a")]),
            "/api/session/ses_a/prompt"
        );
        assert_eq!(
            INBOX_CANCEL.path(&[("sessionID", "ses_a"), ("inboxID", "msg_b")]),
            "/api/session/ses_a/inbox/msg_b"
        );
        assert_eq!(
            MCP_PUT.path(&[("server", "a b/c")]),
            "/api/experimental/mcp/a%20b%2Fc"
        );
    }

    #[test]
    #[should_panic(expected = "missing an argument")]
    fn a_route_with_a_missing_argument_is_a_bug() {
        let _ = PROMPT.path(&[]);
    }

    #[test]
    fn message_ids_lead_back_to_their_receipt() {
        let receipt = "0b6f2c1e-8d3a-4f55-9a10-1c2d3e4f5a6b";
        let id = message_id_for(receipt);
        assert_eq!(id, "msg_0b6f2c1e8d3a4f559a101c2d3e4f5a6b");
        assert_eq!(receipt_for(&id).as_deref(), Some(receipt));
        assert_eq!(receipt_for("msg_20be2b1be001R5Or3my6K34uIo"), None);
        assert_eq!(receipt_for("ses_0b6f2c1e8d3a4f559a101c2d3e4f5a6b"), None);
    }

    #[test]
    fn model_slugs_round_trip_with_a_variant() {
        let m = ModelRef::parse("opencode/beam-free#high").unwrap();
        assert_eq!(
            (m.providerID.as_str(), m.id.as_str()),
            ("opencode", "beam-free")
        );
        assert_eq!(m.variant.as_deref(), Some("high"));
        assert_eq!(m.slug(), "opencode/beam-free");
        assert!(ModelRef::parse("beam-free").is_none());
    }

    #[test]
    fn bodies_omit_what_is_unset() {
        let body = PromptBody {
            text: "hi".into(),
            ..Default::default()
        };
        assert_eq!(serde_json::to_value(body).unwrap(), json!({"text": "hi"}));
        let reject = PermissionReplyBody {
            decision: "reject".into(),
            message: Some("no".into()),
        };
        assert_eq!(
            serde_json::to_value(reject).unwrap(),
            json!({"decision": "reject", "message": "no"})
        );
    }

    #[test]
    fn sse_frames_come_out_whatever_the_chunking() {
        let stream = ": heartbeat\n\ndata: {\"a\":1}\n\ndata: {\"b\":\ndata: 2}\r\n\r\nevent: x\ndata: {\"c\":3}\n\n";
        let whole = SseParser::default().push(stream.as_bytes());
        assert_eq!(whole, ["{\"a\":1}", "{\"b\":\n2}", "{\"c\":3}"]);
        for size in [1, 2, 3, 7] {
            let mut p = SseParser::default();
            let got: Vec<String> = stream
                .as_bytes()
                .chunks(size)
                .flat_map(|c| p.push(c))
                .collect();
            assert_eq!(got, whole, "chunks of {size}");
        }
    }

    #[test]
    fn a_frame_over_the_cap_is_dropped_and_the_next_one_still_comes() {
        let mut p = SseParser::default();
        let huge = vec![b'x'; SseParser::MAX_FRAME + 10];
        assert!(p.push(b"data: ").is_empty());
        assert!(p.push(&huge).is_empty());
        assert!(p.push(b"\n\n").is_empty());
        assert_eq!(p.push(b"data: ok\n\n"), ["ok"]);
    }

    #[test]
    fn events_parse_typed_and_unknown_ones_pass_as_other() {
        let ev = WireEvent::parse(
            r#"{"id":"e","type":"session.text.delta","data":{"sessionID":"s","assistantMessageID":"m","ordinal":2,"delta":"hi"}}"#,
        )
        .unwrap();
        assert_eq!(ev.session_id(), Some("s"));
        match Event::parse(&ev).unwrap() {
            Event::TextDelta(d) => assert_eq!((d.ordinal, d.delta.as_str()), (2, "hi")),
            other => panic!("{other:?}"),
        }
        let other = WireEvent::parse(r#"{"type":"plugin.updated","data":{}}"#).unwrap();
        assert!(matches!(Event::parse(&other).unwrap(), Event::Other(t) if t == "plugin.updated"));
        let bad =
            WireEvent::parse(r#"{"type":"session.text.delta","data":{"ordinal":"two"}}"#).unwrap();
        assert!(Event::parse(&bad).is_err());
    }

    /// The tools folder's list is generated from this file, so an upgrade review reads what
    /// Writer really uses. `WRITER_UPDATE_CONTRACT_LIST=1 cargo test used_list` regenerates it.
    #[test]
    fn used_list_matches_the_tools_folder() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../features/opencode/fixtures/tools/used.json");
        let actual = serde_json::to_string_pretty(&used()).unwrap() + "\n";
        if std::env::var_os("WRITER_UPDATE_CONTRACT_LIST").is_some() {
            std::fs::write(&path, &actual).unwrap();
        }
        let expected = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            actual, expected,
            "tools/used.json is stale (WRITER_UPDATE_CONTRACT_LIST=1 cargo test used_list)"
        );
    }
}
