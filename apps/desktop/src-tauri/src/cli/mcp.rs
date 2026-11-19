//! `writer mcp`: the command registry served as MCP tools over stdio (ADR 2026-11-19, spec
//! `SPECs/writer-cli-spec.md` "MCP server"). Hand-written JSON-RPC 2.0, newline-delimited, for the
//! subset a client needs: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`,
//! `ping`. No SDK, no second implementation: the tools are derived from [`registry::commands`]
//! and a call runs [`execute_invocation`], the same validation, feature gate and handler as the
//! command line.
//!
//! Privacy: nothing here logs arguments or results; a rejected message is logged by size only.

use super::args::{Args, Invocation};
use super::registry::{self, CommandSpec};
use super::{execute_invocation, feature_off, CliError, Ctx, Env, EXIT_OK};
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};
use std::path::Path;

/// The server's name in the client's config. How a tool is named to the model is the backend
/// adapter's business (`agent::mcp_wiring::ToolsAdapter`), never decided here.
pub const SERVER_NAME: &str = "writer";
/// Commands that are not tools: meta commands, the server itself, and the one that rewrites the
/// agent's own skill files.
const EXCLUDED: &[&str] = &["help", "version", "mcp", "skills:sync"];
/// The largest message the loop accepts, in bytes (a tool call carrying a whole note fits).
pub const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
/// The most bytes of a tool's text one result carries; the rest is cut with a note.
const MAX_RESULT_BYTES: usize = 200 * 1024;
/// Protocol revisions the server speaks, newest first; a client's request is answered with the
/// same revision when listed, else the newest.
const PROTOCOLS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

/// The tool name of a command: `:` is not allowed in every client, so it becomes `_`
/// (`graph:backlinks` -> `graph_backlinks`).
pub fn tool_name(spec: &CommandSpec) -> String {
    tool_name_of(spec.name)
}

/// [`tool_name`] from a command's name, for text that names a tool (the agent's system prompt).
pub fn tool_name_of(command: &str) -> String {
    command.replace(':', "_")
}

/// A tool of the server as the registry defines it, with no backend's naming or format in it
/// (ADR 2026-11-19 "Hand Writer's MCP server to every agent backend through its adapter").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolSpec {
    /// The server's name of the tool ([`tool_name`]); a backend prefixes it its own way.
    pub name: String,
    /// The tool changes the vault, so a call asks first.
    pub writes: bool,
}

impl From<&CommandSpec> for ToolSpec {
    fn from(spec: &CommandSpec) -> Self {
        ToolSpec {
            name: tool_name(spec),
            writes: spec.writes,
        }
    }
}

/// The tool a command is served as, for text that names tools (the agent's prompts).
pub fn tool_of(command: &str) -> ToolSpec {
    ToolSpec {
        name: tool_name_of(command),
        writes: registry::find(command).is_some_and(|c| c.writes),
    }
}

/// Is this command served as a tool at all (feature switches aside)?
pub fn is_tool(spec: &CommandSpec) -> bool {
    !EXCLUDED.contains(&spec.name)
}

/// The commands served as tools right now: the registry minus [`EXCLUDED`] and minus the commands
/// of a feature whose switch is off.
pub fn tool_specs(env: &Env) -> Vec<&'static CommandSpec> {
    registry::commands()
        .filter(|c| is_tool(c) && feature_off(c, env).is_none())
        .collect()
}

/// Every tool the server can serve, read and write, from the registry (feature switches aside,
/// like [`is_tool`]): the one list a backend adapter derives its names and rules from.
pub fn tools() -> Vec<ToolSpec> {
    registry::commands()
        .filter(|c| is_tool(c))
        .map(ToolSpec::from)
        .collect()
}

fn string_property(desc: &str) -> Value {
    json!({ "type": "string", "description": desc })
}

/// The MCP tool definition of a command: one string property per parameter, a boolean per flag,
/// `format` an enum of the formats the command lists.
fn tool_json(spec: &CommandSpec) -> Value {
    let mut properties = Map::new();
    let mut required = Vec::new();
    for p in spec.params {
        let mut prop = string_property(p.desc);
        if p.name == "format" && !spec.formats.is_empty() {
            prop["enum"] = json!(spec.formats);
        }
        properties.insert(p.name.to_string(), prop);
        if p.required {
            required.push(p.name);
        }
    }
    for (flag, desc) in spec.flags {
        properties.insert(
            (*flag).to_string(),
            json!({ "type": "boolean", "description": desc }),
        );
    }
    let mut schema = json!({
        "type": "object",
        "properties": properties,
        "additionalProperties": false,
    });
    if !required.is_empty() {
        schema["required"] = json!(required);
    }
    let mut annotations = json!({ "readOnlyHint": !spec.writes, "openWorldHint": false });
    if spec.writes {
        annotations["destructiveHint"] = json!(true);
    }
    json!({
        "name": tool_name(spec),
        "description": spec.summary,
        "inputSchema": schema,
        "annotations": annotations,
    })
}

/// A JSON scalar as the text a `key=value` parameter holds.
fn scalar_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// The invocation a `tools/call` stands for: no grammar involved (a value is taken as it is, with
/// no `\n` unescaping and no quote stripping), the schema's own checks left to `validate`.
fn invocation_for(
    spec: &CommandSpec,
    vault: &str,
    arguments: &Map<String, Value>,
) -> Result<Invocation, String> {
    let mut inv = Invocation {
        vault: Some(vault.to_string()),
        command: spec.name.to_string(),
        ..Invocation::default()
    };
    for (key, value) in arguments {
        if spec.flags.iter().any(|(f, _)| f == key) {
            match value {
                Value::Bool(true) => inv.flags.push(key.clone()),
                Value::Bool(false) | Value::Null => {}
                _ => return Err(format!("{key} is a flag: give true or false")),
            }
        } else if value.is_null() {
            continue;
        } else {
            let text = scalar_text(value).ok_or_else(|| format!("{key} must be a string"))?;
            inv.params.push((key.clone(), text));
        }
    }
    Ok(inv)
}

/// `text` cut to [`MAX_RESULT_BYTES`] at a character boundary, with a note when it was cut.
fn capped(text: String) -> String {
    if text.len() <= MAX_RESULT_BYTES {
        return text;
    }
    let mut end = MAX_RESULT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n[output cut at {MAX_RESULT_BYTES} bytes; narrow the query]\n",
        &text[..end]
    )
}

fn text_content(text: String) -> Value {
    json!({ "type": "text", "text": text })
}

/// What `tools/call` answers: the handler's stdout as text, or an `isError` result with its error
/// line. A rejected argument is an `isError` result too (the model reads it and retries).
fn call_result(
    spec: &CommandSpec,
    arguments: &Map<String, Value>,
    cwd: &Path,
    env: &Env,
    vault: &str,
) -> Value {
    let error = |text: String| json!({ "content": [text_content(text)], "isError": true });
    let inv = match invocation_for(spec, vault, arguments) {
        Ok(inv) => inv,
        Err(e) => return error(format!("{}: {e}", spec.name)),
    };
    let out = execute_invocation(&inv, cwd, env);
    if out.code != EXIT_OK {
        let text = out.stderr.trim().trim_start_matches("writer: ").to_string();
        return error(capped(if text.is_empty() { out.stdout } else { text }));
    }
    let mut content = vec![text_content(capped(out.stdout))];
    if !out.stderr.trim().is_empty() {
        content.push(text_content(capped(out.stderr)));
    }
    json!({ "content": content, "isError": false })
}

/// One JSON-RPC reply, or `None` for a notification (which gets none).
fn handle(message: &Value, cwd: &Path, env: &Env, vault: &str) -> Option<Value> {
    let id = message.get("id").cloned();
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        // A response from the client (the server sends no requests) or junk: nothing to answer.
        return id.map(|id| error_reply(id, INVALID_REQUEST, "expected a request"));
    };
    let params = message.get("params");
    let result = match method {
        "initialize" => Ok(initialize_result(params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({
            "tools": tool_specs(env).into_iter().map(tool_json).collect::<Vec<_>>()
        })),
        "tools/call" => tools_call(params, cwd, env, vault),
        m if m.starts_with("notifications/") => return None,
        _ => Err((METHOD_NOT_FOUND, format!("method not found: {method}"))),
    };
    let id = id?; // a request without an id is a notification: no reply, not even an error
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => error_reply(id, code, &message),
    })
}

fn initialize_result(params: Option<&Value>) -> Value {
    let asked = params
        .and_then(|p| p.get("protocolVersion"))
        .and_then(Value::as_str);
    let version = PROTOCOLS
        .iter()
        .find(|v| Some(**v) == asked)
        .unwrap_or(&PROTOCOLS[0]);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": SERVER_NAME, "version": crate::writer_cli::VERSION },
    })
}

fn tools_call(
    params: Option<&Value>,
    cwd: &Path,
    env: &Env,
    vault: &str,
) -> Result<Value, (i64, String)> {
    let name = params
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .ok_or((INVALID_PARAMS, "tools/call needs a tool name".to_string()))?;
    let spec = tool_specs(env)
        .into_iter()
        .find(|c| tool_name(c) == name)
        .ok_or_else(|| (INVALID_PARAMS, format!("unknown tool: {name}")))?;
    let empty = Map::new();
    let arguments = match params.and_then(|p| p.get("arguments")) {
        None | Some(Value::Null) => &empty,
        Some(Value::Object(m)) => m,
        Some(_) => return Err((INVALID_PARAMS, "arguments must be an object".to_string())),
    };
    Ok(call_result(spec, arguments, cwd, env, vault))
}

fn error_reply(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// One line of the input.
#[derive(Debug, PartialEq)]
enum Line {
    Text(Vec<u8>),
    /// Longer than the cap: the rest of the line was read and dropped.
    TooLong(usize),
    Eof,
}

/// Read up to the next newline without ever holding more than `max` bytes of it.
fn read_line(reader: &mut impl BufRead, max: usize) -> std::io::Result<Line> {
    let mut buf = Vec::new();
    let mut total = 0usize;
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok(if total == 0 {
                Line::Eof
            } else if total > max {
                Line::TooLong(total)
            } else {
                Line::Text(buf)
            });
        }
        let (take, found) = match chunk.iter().position(|b| *b == b'\n') {
            Some(i) => (i + 1, true),
            None => (chunk.len(), false),
        };
        let body = &chunk[..if found { take - 1 } else { take }];
        total += body.len();
        if total <= max {
            buf.extend_from_slice(body);
        }
        reader.consume(take);
        if found {
            return Ok(if total > max {
                Line::TooLong(total)
            } else {
                Line::Text(buf)
            });
        }
    }
}

fn send(out: &mut impl Write, value: &Value) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    line.push(b'\n');
    out.write_all(&line)?;
    out.flush()
}

/// The server loop: one message per line in, one reply per request out, until the input ends.
/// A line that is too long, not UTF-8 or not JSON is answered with a JSON-RPC error (id `null`)
/// and the loop goes on; only an I/O error on the pipes ends it.
pub fn serve(
    input: &mut impl BufRead,
    output: &mut impl Write,
    cwd: &Path,
    env: &Env,
    vault: &str,
    max_bytes: usize,
) -> std::io::Result<()> {
    loop {
        let bytes = match read_line(input, max_bytes)? {
            Line::Eof => return Ok(()),
            Line::TooLong(n) => {
                tracing::warn!(target: "cli", bytes = n, "mcp: message over the size cap dropped");
                let reply = error_reply(
                    Value::Null,
                    INVALID_REQUEST,
                    &format!("message larger than {max_bytes} bytes"),
                );
                send(output, &reply)?;
                continue;
            }
            Line::Text(b) => b,
        };
        if bytes.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let parsed = std::str::from_utf8(&bytes)
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str::<Value>(t).map_err(|e| e.to_string()));
        let reply = match parsed {
            Err(_) => {
                tracing::warn!(target: "cli", bytes = bytes.len(), "mcp: malformed message dropped");
                Some(error_reply(Value::Null, PARSE_ERROR, "invalid JSON"))
            }
            Ok(Value::Object(m)) => handle(&Value::Object(m), cwd, env, vault),
            Ok(_) => Some(error_reply(
                Value::Null,
                INVALID_REQUEST,
                "expected one JSON object per line (batches are not supported)",
            )),
        };
        if let Some(reply) = reply {
            send(output, &reply)?;
        }
    }
}

/// `writer mcp`: serve this vault on stdin and stdout until the client closes the pipe.
pub fn run(ctx: &Ctx, _: &Args, _: &CommandSpec) -> Result<String, CliError> {
    // Fail at start, with the usual message, when there is no vault to serve.
    let vault = ctx.root()?.to_string_lossy().into_owned();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    serve(
        &mut stdin.lock(),
        &mut stdout.lock(),
        ctx.cwd(),
        ctx.env,
        &vault,
        MAX_MESSAGE_BYTES,
    )?;
    Ok(String::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use tempfile::TempDir;

    struct Fixture {
        vault: TempDir,
        data: TempDir,
    }

    impl Fixture {
        fn new() -> Fixture {
            let f = Fixture {
                vault: TempDir::new().unwrap(),
                data: TempDir::new().unwrap(),
            };
            f.write("Home.md", "# Home\nSee [[Beta]].\n");
            f.write(
                "Beta.md",
                "---\nstatus: done\n---\n# Beta\nbeta body with the word Needle\n",
            );
            f.write(".obsidian/app.json", "{}");
            f
        }

        fn write(&self, rel: &str, content: &str) {
            let p = self.vault.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, content).unwrap();
        }

        fn env(&self) -> Env {
            Env {
                app_data_dir: Some(self.data.path().to_path_buf()),
                clipboard: Box::new(crate::cli::SystemClipboard),
                utc_offset_minutes: 0,
                launcher: Box::new(crate::writer_cli::SystemLauncher),
                launch_wait: std::time::Duration::ZERO,
            }
        }

        /// Feed raw input to the loop and parse each reply line.
        fn exchange(&self, input: &[u8], max: usize) -> Vec<Value> {
            let env = self.env();
            let vault = self.vault.path().canonicalize().unwrap();
            let mut out = Vec::new();
            serve(
                &mut Cursor::new(input.to_vec()),
                &mut out,
                self.vault.path(),
                &env,
                &vault.to_string_lossy(),
                max,
            )
            .unwrap();
            String::from_utf8(out)
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect()
        }

        fn rpc(&self, messages: &[Value]) -> Vec<Value> {
            let text: String = messages.iter().map(|m| format!("{m}\n")).collect();
            self.exchange(text.as_bytes(), MAX_MESSAGE_BYTES)
        }

        fn request(&self, method: &str, params: Value) -> Value {
            let mut r =
                self.rpc(&[json!({"jsonrpc":"2.0","id":1,"method":method,"params":params})]);
            assert_eq!(r.len(), 1);
            r.remove(0)
        }

        fn call(&self, tool: &str, arguments: Value) -> Value {
            let r = self.request("tools/call", json!({"name": tool, "arguments": arguments}));
            assert!(r.get("error").is_none(), "{r}");
            r["result"].clone()
        }
    }

    fn text_of(result: &Value) -> String {
        result["content"][0]["text"].as_str().unwrap().to_string()
    }

    #[test]
    fn initialize_answers_with_the_client_revision_or_the_newest() {
        let f = Fixture::new();
        let r = f.request("initialize", json!({"protocolVersion":"2024-11-05"}));
        assert_eq!(r["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(r["result"]["serverInfo"]["name"], "writer");
        assert_eq!(r["result"]["capabilities"]["tools"]["listChanged"], false);
        let r = f.request("initialize", json!({"protocolVersion":"1999-01-01"}));
        assert_eq!(r["result"]["protocolVersion"], PROTOCOLS[0]);
        let r = f.request("initialize", Value::Null);
        assert_eq!(r["result"]["protocolVersion"], PROTOCOLS[0]);
        assert_eq!(r["jsonrpc"], "2.0");
    }

    #[test]
    fn ping_and_notifications() {
        let f = Fixture::new();
        let replies = f.rpc(&[
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":"a","method":"ping"}),
            json!({"jsonrpc":"2.0","method":"ping"}),
        ]);
        // the notification and the id-less request get no reply; the id is echoed as it came
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["id"], "a");
        assert_eq!(replies[0]["result"], json!({}));
    }

    #[test]
    fn tools_list_is_the_registry_minus_the_excluded_commands() {
        let f = Fixture::new();
        let r = f.request("tools/list", Value::Null);
        let tools = r["result"]["tools"].as_array().unwrap();
        let listed: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        let expected: Vec<String> = registry::commands()
            .filter(|c| !EXCLUDED.contains(&c.name))
            .map(tool_name)
            .collect();
        assert_eq!(listed, expected);
        for name in EXCLUDED {
            assert!(registry::find(name).is_some(), "{name} is not a command");
            assert!(!listed.contains(&name.replace(':', "_").as_str()));
        }
        assert!(listed.contains(&"search") && listed.contains(&"graph_backlinks"));
    }

    #[test]
    fn every_tool_schema_follows_its_command_spec() {
        let f = Fixture::new();
        let env = f.env();
        for spec in tool_specs(&env) {
            let t = tool_json(spec);
            let props = t["inputSchema"]["properties"].as_object().unwrap();
            let mut keys: Vec<&str> = props.keys().map(String::as_str).collect();
            keys.sort();
            let mut want: Vec<&str> = spec
                .params
                .iter()
                .map(|p| p.name)
                .chain(spec.flags.iter().map(|(n, _)| *n))
                .collect();
            want.sort();
            let before = want.len();
            want.dedup();
            assert_eq!(
                before,
                want.len(),
                "{}: a flag shares a parameter's name",
                spec.name
            );
            assert_eq!(keys, want, "{}", spec.name);
            let required: Vec<&str> = t["inputSchema"]
                .get("required")
                .map(|r| {
                    r.as_array()
                        .unwrap()
                        .iter()
                        .map(|x| x.as_str().unwrap())
                        .collect()
                })
                .unwrap_or_default();
            let want_required: Vec<&str> = spec
                .params
                .iter()
                .filter(|p| p.required)
                .map(|p| p.name)
                .collect();
            assert_eq!(required, want_required, "{}", spec.name);
            for p in spec.params {
                assert_eq!(props[p.name]["type"], "string");
                assert_eq!(props[p.name]["description"], p.desc);
                if p.name == "format" && !spec.formats.is_empty() {
                    assert_eq!(props[p.name]["enum"], json!(spec.formats), "{}", spec.name);
                }
            }
            for (flag, _) in spec.flags {
                assert_eq!(props[*flag]["type"], "boolean", "{}", spec.name);
            }
            assert_eq!(t["description"], spec.summary);
            assert_eq!(
                t["annotations"]["readOnlyHint"], !spec.writes,
                "{}",
                spec.name
            );
            assert_eq!(t["inputSchema"]["additionalProperties"], false);
        }
    }

    #[test]
    fn tool_names_are_unique_and_valid_for_a_client() {
        let mut seen = std::collections::HashSet::new();
        for c in registry::commands().filter(|c| is_tool(c)) {
            let n = tool_name(c);
            assert!(
                !n.is_empty()
                    && n.len() + "mcp__writer__".len() <= 64
                    && n.chars()
                        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'),
                "{n}"
            );
            assert!(seen.insert(n.clone()), "two commands make the tool {n}");
        }
    }

    #[test]
    fn writes_mark_the_commands_that_change_the_vault() {
        const WRITES: &[&str] = &[
            "create",
            "append",
            "prepend",
            "move",
            "rename",
            "title",
            "delete",
            "property:set",
            "property:remove",
            "task",
            "base:create",
            "task:add",
            "task:done",
            "task:edit",
            "excalidraw:create",
            "excalidraw:add",
            "excalidraw:update",
            "excalidraw:export",
            "excalidraw:preview",
            "icon:set",
            "icon:remove",
            "project:archive",
            "project:unarchive",
            "open",
            "reveal",
            "skills:sync",
        ];
        // Pinned for the commands this names (a pruned one is simply absent); a new command only
        // has to say `reads` or `writes` in its `cmd!`, which the compiler enforces.
        for name in WRITES {
            if let Some(c) = registry::find(name) {
                assert!(c.writes, "{name} changes things but says `reads`");
            }
        }
        for name in [
            "search",
            "search:context",
            "files",
            "read",
            "outline",
            "tasks",
            "graph:backlinks",
            "graph:neighbors",
            "properties",
            "property:read",
            "tags",
            "base:query",
            "dql",
            "status",
            "active",
        ] {
            if let Some(c) = registry::find(name) {
                assert!(!c.writes, "{name} only reads but says `writes`");
            }
        }
        let all = tools();
        let read = |n: &str| all.iter().find(|t| t.name == n).map(|t| !t.writes);
        assert_eq!(read("search"), Some(true));
        assert_eq!(read("create"), Some(false));
        assert_eq!(read("mcp"), None);
        let f = Fixture::new();
        let tools = f.request("tools/list", Value::Null)["result"]["tools"].clone();
        let by = |n: &str| {
            tools
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["name"] == n)
                .unwrap()
                .clone()
        };
        assert_eq!(by("create")["annotations"]["readOnlyHint"], false);
        assert_eq!(by("create")["annotations"]["destructiveHint"], true);
        assert_eq!(by("search")["annotations"]["readOnlyHint"], true);
        assert!(by("search")["annotations"].get("destructiveHint").is_none());
    }

    #[test]
    fn a_tool_call_runs_the_command_and_returns_its_output() {
        let f = Fixture::new();
        let r = f.call("search", json!({"query": "Needle"}));
        assert_eq!(r["isError"], false);
        assert!(text_of(&r).contains("Beta"), "{r}");
        let r = f.call("files", json!({"total": true}));
        assert_eq!(text_of(&r).trim(), "2");
        let r = f.call("files", json!({"total": false, "ext": "md"}));
        assert!(text_of(&r).contains("Home.md"));
        // a number is taken as its text; the vault is the server's, never an argument
        let r = f.call("files", json!({"ext": "md", "folder": null}));
        assert_eq!(r["isError"], false);
    }

    #[test]
    fn values_are_taken_as_they_are_not_as_command_line_text() {
        let f = Fixture::new();
        let r = f.call(
            "create",
            json!({"name": "Fresh", "content": "a\nb \\n \"q\" c=d"}),
        );
        assert_eq!(r["isError"], false, "{r}");
        let text = std::fs::read_to_string(f.vault.path().join("Fresh.md")).unwrap();
        assert!(text.starts_with("a\nb \\n \"q\" c=d"), "{text:?}");
    }

    #[test]
    fn a_failing_command_is_an_error_result_with_its_message() {
        let f = Fixture::new();
        let r = f.call("read", json!({"file": "Nothing Here"}));
        assert_eq!(r["isError"], true);
        let t = text_of(&r);
        assert!(
            t.contains("file not found") && !t.starts_with("writer:"),
            "{t}"
        );
        // bad arguments are results the model can read and fix, not protocol errors
        for args in [
            json!({"nope": "1"}),
            json!({"file": ["a"]}),
            json!({"file": "Home", "inline": "yes"}),
            json!({"vault": "/elsewhere"}),
            json!({}),
        ] {
            let tool = if args.get("inline").is_some() {
                "append"
            } else {
                "read"
            };
            let r = f.call(tool, args.clone());
            assert_eq!(r["isError"], true, "{args}");
        }
    }

    #[test]
    fn unknown_tools_methods_and_params_are_json_rpc_errors() {
        let f = Fixture::new();
        let r = f.request("tools/call", json!({"name": "help"}));
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
        let r = f.request("tools/call", json!({"name": "mcp"}));
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
        let r = f.request("tools/call", json!({"name": "no_such_tool"}));
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
        let r = f.request("tools/call", json!({}));
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
        let r = f.request("tools/call", json!({"name": "search", "arguments": "x"}));
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
        let r = f.request("resources/list", Value::Null);
        assert_eq!(r["error"]["code"], METHOD_NOT_FOUND);
        assert_eq!(r["id"], 1);
    }

    #[test]
    fn malformed_input_gets_an_error_and_the_loop_goes_on() {
        let f = Fixture::new();
        let ping = br#"{"jsonrpc":"2.0","id":7,"method":"ping"}"#;
        let mut input = Vec::new();
        input.extend_from_slice(b"{not json\n");
        input.extend_from_slice(b"\n   \n");
        input.extend_from_slice(b"[1,2]\n");
        input.extend_from_slice(b"\"text\"\n");
        input.extend_from_slice(&[0xff, 0xfe, b'\n']);
        input.extend_from_slice(br#"{"jsonrpc":"2.0","id":9,"result":{}}"#);
        input.push(b'\n');
        input.extend_from_slice(ping); // no trailing newline: still answered
        let replies = f.exchange(&input, MAX_MESSAGE_BYTES);
        let codes: Vec<_> = replies
            .iter()
            .map(|r| r["error"]["code"].as_i64())
            .collect();
        assert_eq!(
            codes,
            [
                Some(PARSE_ERROR),
                Some(INVALID_REQUEST),
                Some(INVALID_REQUEST),
                Some(PARSE_ERROR),
                Some(INVALID_REQUEST),
                None
            ]
        );
        assert_eq!(replies[0]["id"], Value::Null);
        assert_eq!(replies[5]["id"], 7);
        assert_eq!(replies[5]["result"], json!({}));
    }

    #[test]
    fn a_message_over_the_cap_is_dropped_whole_and_the_next_one_is_served() {
        let f = Fixture::new();
        let big = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"params\":{{\"pad\":\"{}\"}}}}\n",
            "x".repeat(500)
        );
        let ok = "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n";
        let replies = f.exchange(format!("{big}{ok}{big}").as_bytes(), 100);
        assert_eq!(replies.len(), 3);
        assert_eq!(replies[0]["error"]["code"], INVALID_REQUEST);
        assert!(replies[0]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("100"));
        assert_eq!(replies[1]["id"], 2);
        assert_eq!(
            replies[2]["error"]["code"], INVALID_REQUEST,
            "an unterminated big tail too"
        );
    }

    #[test]
    fn read_line_never_buffers_more_than_the_cap() {
        let mut r = Cursor::new(b"abc\nabcdefghij\nlast".to_vec());
        assert_eq!(read_line(&mut r, 5).unwrap(), Line::Text(b"abc".to_vec()));
        assert_eq!(read_line(&mut r, 5).unwrap(), Line::TooLong(10));
        assert_eq!(read_line(&mut r, 5).unwrap(), Line::Text(b"last".to_vec()));
        assert_eq!(read_line(&mut r, 5).unwrap(), Line::Eof);
        // a line of exactly the cap fits
        let mut r = Cursor::new(b"12345\n".to_vec());
        assert_eq!(read_line(&mut r, 5).unwrap(), Line::Text(b"12345".to_vec()));
    }

    #[test]
    fn a_tool_result_is_cut_at_the_cap_on_a_character_boundary() {
        let text = "é".repeat(MAX_RESULT_BYTES);
        let cut = capped(text);
        assert!(cut.len() < MAX_RESULT_BYTES + 100);
        assert!(cut.ends_with("narrow the query]\n"));
        assert_eq!(capped("short".into()), "short");
    }

    #[test]
    fn a_feature_that_is_off_hides_its_tools_and_refuses_the_call() {
        let f = Fixture::new();
        f.write("tasks.base", "views:\n  - type: table\n    name: All\n");
        let names = |f: &Fixture| -> Vec<String> {
            f.request("tools/list", Value::Null)["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["name"].as_str().unwrap().to_string())
                .collect()
        };
        assert!(names(&f).contains(&"base_query".to_string()));
        std::fs::write(
            f.data.path().join("config"),
            "features.bases.enabled = false\n",
        )
        .unwrap();
        let after = names(&f);
        assert!(!after.contains(&"base_query".to_string()));
        assert!(!after.contains(&"bases".to_string()));
        assert!(after.contains(&"search".to_string()));
        let r = f.request(
            "tools/call",
            json!({"name": "base_query", "arguments": {"file": "tasks"}}),
        );
        assert_eq!(r["error"]["code"], INVALID_PARAMS);
    }

    #[test]
    fn the_mcp_command_refuses_to_start_without_a_vault() {
        let f = Fixture::new();
        let env = f.env();
        let out = crate::cli::execute(
            &["vault=/no/such/folder".to_string(), "mcp".to_string()],
            f.vault.path(),
            &env,
        );
        assert_ne!(out.code, EXIT_OK);
        assert!(out.stdout.is_empty(), "stdout is for the protocol only");
        assert!(out.stderr.contains("cannot open vault"), "{}", out.stderr);
    }
}
