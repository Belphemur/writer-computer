"use strict";
// A stand-in for the `claude` CLI that speaks the stream-json protocol Writer's agent pane uses
// (spec SPECs/native-agent-spec.md, section 12 and appendix A). It replays the anonymised real
// captures in src-tauri/src/agent/fixtures/*.jsonl, so what the app sees is exactly what the real
// CLI sent, with ids made unique per turn and the session id echoed from --session-id/--resume.
//
// Scenario per user message: a `[fake:NAME]` keyword in the prompt, else $FAKE_CLAUDE_SCENARIO,
// else `plain`.
//   plain             one text reply (FAKE-CLAUDE-REPLY: <prompt>)
//   thinking, tool-auto   a tool that needs no permission, a thinking block, then the answer
//   permission-allow  Write then Bash, each waits for a control_response (allow path of the capture);
//                     an allowed Write really creates the file in the cwd (Changes card, Undo)
//   permission-deny   Bash waits for a control_response (deny path of the capture)
//   interrupt         Bash waits; an `interrupt` control_request ends the turn aborted
//   multi-turn        successive prompts play the successive turns of multi-turn-rule.jsonl
//   slow              plain, 250 ms per line, so an interrupt lands mid-stream
//   crash             starts streaming then exits 1 with no result
//   auth-error        an error result with api_error_status 401
//   mcp-search        needs `--mcp-config`: starts the configured server (Writer's `writer mcp`),
//                     speaks MCP to it (initialize, tools/call `search` with the prompt as the
//                     query) and plays the tool-auto capture as a `mcp__writer__search` call whose
//                     result is the server's real answer, so the tool path is the production one
// The capture decides the outcome of a permission turn; the answer only has to arrive. An allow
// answer carrying `updatedPermissions` with addRules/localSettings writes
// <cwd>/.claude/settings.local.json like the real CLI.
//
// Resume: a session exists once started. `--resume <id>` of an unknown id writes
// "No conversation found with session ID: <id>" to stderr and exits 1 before any output (or, with
// FAKE_CLAUDE_RESUME_MISSING=result, answers the first prompt with an error result). Sessions live
// in $FAKE_CLAUDE_HOME (default <tmp>/writer-fake-claude); delete a file there to forget a session.
//
// A user message written while a turn runs is taken after it (the real CLI's no-tool-boundary
// case, fixture steer-deferred), echoed with `isReplay` when `--replay-user-messages` is set.
//
// Env: FAKE_CLAUDE_LOG (JSON lines: spawn, stdin, exit), FAKE_CLAUDE_FIXTURES (capture dir),
// FAKE_CLAUDE_DELAY_MS (ms between lines, default 0), FAKE_CLAUDE_VERSION (default 2.1.325).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const argv = process.argv.slice(2);
const env = process.env;
const VERSION = env.FAKE_CLAUDE_VERSION || "2.1.325";
const FIXTURE_SESSION = "00000000-0000-4000-8000-000000000001";
const HOME = env.FAKE_CLAUDE_HOME || path.join(os.tmpdir(), "writer-fake-claude");

function log(o) {
  if (!env.FAKE_CLAUDE_LOG) return;
  try {
    fs.appendFileSync(
      env.FAKE_CLAUDE_LOG,
      JSON.stringify({ pid: process.pid, ts: Date.now(), ...o }) + "\n",
    );
  } catch {
    /* logging must never break the protocol */
  }
}

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (argv.includes("--version") || argv.includes("-v")) {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}

// One-shot chat-title call (`-p --output-format json`, prompt on stdin, no stream-json input):
// answers one JSON result, starts no session. FAKE_CLAUDE_TITLE overrides the title,
// FAKE_CLAUDE_TITLE_FAIL=1 makes the call fail (exit 1).
if (argv.includes("--output-format") && flag("output-format") === "json" && !flag("input-format")) {
  log({ ev: "title", argv, cwd: process.cwd() });
  if (env.FAKE_CLAUDE_TITLE_FAIL) process.exit(1);
  process.stdin.resume();
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => {
    const title = env.FAKE_CLAUDE_TITLE || "Fake chat title";
    process.stdout.write(
      JSON.stringify({ type: "result", is_error: false, result: title, total_cost_usd: 0 }) + "\n",
    );
    process.exit(0);
  });
  return;
}

const resumeId = flag("resume");
const sessionId = flag("session-id") || resumeId || require("node:crypto").randomUUID();
const model = flag("model") || "claude-sonnet-5-5";
const permissionMode =
  flag("permission-mode") === "manual" ? "default" : flag("permission-mode") || "default";
log({ ev: "spawn", argv, cwd: process.cwd() });

const sessionFile = path.join(HOME, `${sessionId}.json`);
let resumeMissing = false;
if (resumeId && !fs.existsSync(path.join(HOME, `${resumeId}.json`))) {
  if (env.FAKE_CLAUDE_RESUME_MISSING === "result") {
    resumeMissing = true;
  } else {
    process.stderr.write(`No conversation found with session ID: ${resumeId}\n`);
    log({ ev: "exit", code: 1, why: "resume-missing" });
    process.exit(1);
  }
}
fs.mkdirSync(HOME, { recursive: true });
if (!resumeMissing) fs.writeFileSync(sessionFile, JSON.stringify({ started: Date.now() }));

// ---------------------------------------------------------------------------------------------
// Captures

function fixtureDir() {
  const candidates = [
    env.FAKE_CLAUDE_FIXTURES,
    path.join(__dirname, "scenarios"),
    path.join(__dirname, "../../../src-tauri/src/agent/fixtures"),
  ].filter(Boolean);
  const dir = candidates.find((d) => fs.existsSync(path.join(d, "ok-turn.jsonl")));
  if (!dir) throw new Error(`fake claude: no fixtures in ${candidates.join(", ")}`);
  return dir;
}

/** Split a capture into turns (each ends with its `result` line). */
function loadTurns(name) {
  const lines = fs
    .readFileSync(path.join(fixtureDir(), `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const turns = [[]];
  for (const line of lines) {
    turns[turns.length - 1].push(line);
    if (line.type === "result") turns.push([]);
  }
  if (turns[turns.length - 1].length === 0) turns.pop();
  return turns;
}

const SCENARIO_FIXTURE = {
  plain: "ok-turn",
  slow: "ok-turn",
  crash: "ok-turn",
  thinking: "tool-auto-allowed",
  "tool-auto": "tool-auto-allowed",
  "permission-allow": "permission-allow",
  "permission-deny": "permission-deny",
  interrupt: "interrupt",
  "multi-turn": "multi-turn-rule",
  "mcp-search": "tool-auto-allowed",
};

// ---------------------------------------------------------------------------------------------
// MCP client (scenario `mcp-search`): the first server of `--mcp-config` (a JSON string, as Writer
// passes it), driven over its stdio with newline-delimited JSON-RPC.

const MCP_TOOL = "mcp__writer__search";

function mcpServer() {
  const raw = flag("mcp-config");
  if (!raw) throw new Error("fake claude: scenario mcp-search needs --mcp-config");
  const servers = JSON.parse(raw).mcpServers || {};
  const server = servers.writer;
  if (!server) throw new Error("fake claude: no `writer` server in --mcp-config");
  return server;
}

/** Start the server, run `tools/call`, return `{ text, isError, tools }`; kills the server. */
function mcpCall(server, tool, args) {
  const { spawn } = require("node:child_process");
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args || [], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...server.env },
    });
    const replies = new Map();
    let tools = [];
    const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
    const rl2 = readline.createInterface({ input: child.stdout });
    rl2.on("line", (l) => {
      let m;
      try {
        m = JSON.parse(l);
      } catch {
        return reject(new Error(`fake claude: the MCP server said non-JSON on stdout: ${l}`));
      }
      if (m.id === 1) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      } else if (m.id === 2) {
        tools = (m.result?.tools || []).map((t) => t.name);
        send({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: tool, arguments: args },
        });
      } else if (m.id === 3) {
        child.kill();
        if (m.error)
          return reject(new Error(`fake claude: tools/call failed: ${JSON.stringify(m.error)}`));
        const text = (m.result.content || []).map((c) => c.text || "").join("");
        resolve({ text, isError: !!m.result.isError, tools });
      }
      replies.set(m.id, m);
    });
    child.on("error", reject);
    child.on("exit", (code, sig) => {
      if (!replies.has(3))
        reject(new Error(`fake claude: the MCP server exited early (${code ?? sig})`));
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "fake-claude", version: VERSION },
      },
    });
  });
}

/** Turn a captured Bash tool turn into a call of the MCP tool with this input and result. */
function asMcpTurn(line, input, result) {
  if (line.type === "system" && line.subtype === "init") {
    line.mcp_servers = [{ name: "writer", status: "connected" }];
    line.tools = [...(line.tools || []), ...result.tools.map((t) => `mcp__writer__${t}`)];
  }
  const ev = line.type === "stream_event" ? line.event : null;
  if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
    ev.content_block.name = MCP_TOOL;
  }
  if (ev?.delta?.type === "input_json_delta" && ev.delta.partial_json) {
    // the whole input in the first non-empty delta, nothing in the rest
    ev.delta.partial_json = mcpInputSent ? "" : JSON.stringify(input);
    mcpInputSent = true;
  }
  for (const b of line.message?.content || []) {
    if (b.type === "tool_use") {
      b.name = MCP_TOOL;
      b.input = input;
    }
    if (b.type === "tool_result") {
      b.content = result.text;
      b.is_error = result.isError;
    }
  }
  if (line.tool_use_result) line.tool_use_result = [{ type: "text", text: result.text }];
  return line;
}
let mcpInputSent = false;

function walkStrings(value, f) {
  if (typeof value === "string") return f(value);
  if (Array.isArray(value)) return value.map((v) => walkStrings(v, f));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walkStrings(v, f)]));
  }
  return value;
}

/** Make a captured line this process's own: session id, cwd, model, per-turn unique ids. */
function adapt(line, turn, reply) {
  let text = JSON.stringify(line)
    .replaceAll(FIXTURE_SESSION, sessionId)
    .replaceAll("/vault/Projects/Demo", process.cwd().replaceAll("\\", "\\\\"));
  if (turn > 0) {
    text = text
      .replaceAll('"msg_', `"msg_t${turn}_`)
      .replaceAll('"toolu_', `"toolu_t${turn}_`)
      .replace(
        /00000000-0000-4000-8000-(\d{12})/g,
        `${String(turn).padStart(8, "0")}-0000-4000-8000-$1`,
      );
  }
  let out = JSON.parse(text);
  if (reply !== null) out = walkStrings(out, (s) => (s === "ok" ? reply : s));
  if (out.type === "system" && out.subtype === "init") {
    out.model = model;
    out.permissionMode = permissionMode;
    out.claude_code_version = VERSION;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// stdin

const inbox = [];
let wake = null;
let stdinClosed = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (raw) => {
  if (!raw.trim()) return;
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    log({ ev: "stdin", type: "invalid" });
    return;
  }
  log({
    ev: "stdin",
    type: msg.type,
    subtype: msg.request?.subtype ?? msg.response?.subtype,
    behavior: msg.response?.response?.behavior,
  });
  if (msg.type === "control_request" && msg.request?.subtype === "set_model") {
    // Shape recorded from the real CLI: success carries the resolved model id.
    out({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: msg.request_id,
        response: { model: msg.request.model ?? "claude-opus-5-5" },
      },
    });
    return;
  }
  inbox.push(msg);
  wake?.();
});
rl.on("close", () => {
  stdinClosed = true;
  wake?.();
});

function nextEvent(timeoutMs) {
  return new Promise((resolve) => {
    wake = () => {
      wake = null;
      resolve();
    };
    if (inbox.length > 0 || stdinClosed) return wake();
    if (timeoutMs) setTimeout(() => wake?.(), timeoutMs);
  });
}

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isInterrupt = (m) => m.type === "control_request" && m.request?.subtype === "interrupt";

function takeInterrupt() {
  const i = inbox.findIndex(isInterrupt);
  return i >= 0 ? inbox.splice(i, 1)[0] : null;
}

function takeResponse(requestId) {
  const i = inbox.findIndex(
    (m) => m.type === "control_response" && m.response?.request_id === requestId,
  );
  return i >= 0 ? inbox.splice(i, 1)[0] : null;
}

// ---------------------------------------------------------------------------------------------
// Persisted "always allow" (appendix A.5)

function persistRules(response) {
  const updates = response?.response?.response?.updatedPermissions;
  if (!Array.isArray(updates)) return;
  for (const u of updates) {
    if (u.type !== "addRules" || u.destination !== "localSettings") continue;
    const file = path.join(process.cwd(), ".claude", "settings.local.json");
    let json = {};
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* new file */
    }
    json.permissions = json.permissions || {};
    const list = (json.permissions[u.behavior || "allow"] =
      json.permissions[u.behavior || "allow"] || []);
    for (const r of u.rules || []) {
      const content = r.ruleContent
        ? `${r.toolName}(${r.ruleContent.replace(/[()]/g, "\\$&")})`
        : r.toolName;
      if (!list.includes(content)) list.push(content);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(json)}\n`);
  }
}

// ---------------------------------------------------------------------------------------------
// Turns

let turnNo = 0;
let multiTurnIndex = 0;

function abortedResult(reason) {
  return {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: null,
    terminal_reason: reason,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    result: "",
    session_id: sessionId,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    errors: [],
  };
}

function errorResult(text, status) {
  return {
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: status,
    duration_ms: 1,
    duration_api_ms: 0,
    num_turns: 1,
    result: text,
    session_id: sessionId,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    errors: [text],
  };
}

function scenarioFor(prompt) {
  const m = /\[fake:([a-z-]+)\]/.exec(prompt);
  return (m && m[1]) || env.FAKE_CLAUDE_SCENARIO || "plain";
}

async function runTurn(prompt) {
  const turn = turnNo++;
  const scenario = scenarioFor(prompt);
  const delay = scenario === "slow" ? 250 : Number(env.FAKE_CLAUDE_DELAY_MS || 0);
  const reply = `FAKE-CLAUDE-REPLY: ${prompt
    .replace(/\[fake:[a-z-]+\]/g, "")
    .trim()
    .slice(0, 60)}`;

  if (resumeMissing) {
    out(errorResult(`No conversation found with session ID: ${resumeId}`, undefined));
    return false;
  }
  if (scenario === "auth-error") {
    out(
      adapt(
        {
          type: "system",
          subtype: "init",
          cwd: "/vault/Projects/Demo",
          session_id: FIXTURE_SESSION,
          tools: [],
          slash_commands: [],
          uuid: "00000000-0000-4000-8000-000000000002",
        },
        turn,
        null,
      ),
    );
    out(errorResult("Invalid API key · Please run /login", 401));
    return true;
  }
  const fixture = SCENARIO_FIXTURE[scenario];
  if (!fixture) {
    out(errorResult(`fake claude: unknown scenario ${scenario}`, undefined));
    return true;
  }
  const turns = loadTurns(fixture);
  let mcpInput = null;
  let mcpResult = null;
  if (scenario === "mcp-search") {
    mcpInput = { query: prompt.replace(/\[fake:[a-z-]+\]/g, "").trim() };
    mcpInputSent = false;
    mcpResult = await mcpCall(mcpServer(), "search", mcpInput);
  }
  let lines;
  if (scenario === "multi-turn") {
    lines = turns[multiTurnIndex % turns.length];
    multiTurnIndex++;
  } else {
    lines = turns[0];
  }

  let pendingTool = false;
  let interruptRequestId = null;
  for (let i = 0; i < lines.length; i++) {
    const intr = takeInterrupt();
    if (intr) {
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: intr.request_id,
          response: { still_queued: [] },
        },
      });
      out(abortedResult("aborted_streaming"));
      return true;
    }
    const raw = lines[i];
    if (scenario === "crash" && raw.type === "assistant") {
      process.stderr.write("fake claude: crashed mid-turn\n");
      log({ ev: "exit", code: 1, why: "crash" });
      process.exit(1);
    }
    let line = adapt(
      raw,
      turn,
      scenario === "plain" || scenario === "slow" || scenario === "crash" ? reply : null,
    );
    if (mcpResult) line = asMcpTurn(line, mcpInput, mcpResult);
    if (raw.type === "control_response" && interruptRequestId) {
      line = JSON.parse(JSON.stringify(line).replace("req_int_1", interruptRequestId));
    }
    out(line);
    if (line.type === "control_request" && line.request?.subtype === "can_use_tool") {
      pendingTool = true;
      let answer = null;
      while (!answer) {
        answer = takeResponse(line.request_id);
        if (answer) break;
        const intr2 = takeInterrupt();
        if (intr2) {
          if (scenario === "interrupt") {
            // The capture continues with the cancel, the interrupt receipt and the aborted result.
            interruptRequestId = intr2.request_id;
            answer = { interrupted: true };
            break;
          }
          out({ type: "control_cancel_request", request_id: line.request_id });
          out({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: intr2.request_id,
              response: { still_queued: [] },
            },
          });
          out(abortedResult("aborted_tools"));
          return true;
        }
        if (stdinClosed) return false;
        await nextEvent();
      }
      if (!answer.interrupted) persistRules(answer);
      // Like the real CLI, an allowed Write really writes the file (the pane's Changes card
      // reads the vault); the captured path is already this process's cwd (see `adapt`).
      if (
        !answer.interrupted &&
        line.request.tool_name === "Write" &&
        answer.response?.response?.behavior === "allow"
      ) {
        const { file_path: target, content } = line.request.input || {};
        if (target) fs.writeFileSync(target, content ?? "");
      }
      pendingTool = false;
    }
    if (delay) await sleep(delay);
  }
  void pendingTool;
  return true;
}

async function main() {
  for (;;) {
    while (inbox.length === 0 && !stdinClosed) await nextEvent();
    if (inbox.length === 0 && stdinClosed) break;
    const msg = inbox.shift();
    if (msg.type === "user") {
      // `--replay-user-messages`: the receipt that the message was taken. Like the real CLI, a
      // message written mid-turn waits here in the inbox, so its receipt comes when its turn starts.
      if (argv.includes("--replay-user-messages")) {
        out({
          type: "user",
          message: msg.message,
          session_id: sessionId,
          parent_tool_use_id: null,
          uuid: msg.uuid || require("node:crypto").randomUUID(),
          isReplay: true,
        });
      }
      const c = msg.message?.content;
      const prompt = typeof c === "string" ? c : (c || []).map((b) => b.text || "").join("");
      const ok = await runTurn(prompt);
      if (ok === false) break;
    } else if (isInterrupt(msg)) {
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: msg.request_id,
          response: { still_queued: [] },
        },
      });
    } else if (msg.type === "control_request") {
      out({
        type: "control_response",
        response: { subtype: "success", request_id: msg.request_id, response: {} },
      });
    }
  }
  log({ ev: "exit", code: 0 });
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`fake claude: ${e && e.stack ? e.stack : e}\n`);
  process.exit(2);
});
