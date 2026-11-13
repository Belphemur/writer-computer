"use strict";
// A tiny stand-in for the `claude` CLI (Claude Code), just enough protocol for
// Copilot's Agent Mode (Claude Agent SDK 0.3.x, stream-json) to complete a turn.
// Run via the `claude` sh wrapper that setup.sh generates (absolute node path).
//
// Every invocation appends JSON lines to claude-invocations.log next to this
// file: {event:"start",pid,ts,mode,argv,cwd} and {event:"exit",pid,ts,code}.
// A process killed with SIGKILL leaves a "start" without an "exit".
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const crypto = require("node:crypto");

const argv = process.argv.slice(2);
const env = process.env;
const VERSION = env.FAKE_CLAUDE_VERSION || "2.1.300";
const LOG = env.FAKE_CLAUDE_LOG || path.join(__dirname, "claude-invocations.log");

function log(o) {
  try {
    fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, ts: Date.now(), ...o }) + "\n");
  } catch {
    /* logging must never break the protocol */
  }
}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const rid = () => crypto.randomUUID();
const flag = (n) => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${n}`) return argv[i + 1] === undefined ? true : argv[i + 1];
    if (argv[i].startsWith(`--${n}=`)) return argv[i].slice(n.length + 3);
  }
};

const mode =
  argv[0] === "--version"
    ? "version"
    : argv[0] === "auth"
      ? "auth"
      : argv.includes("--input-format") && argv.includes("stream-json")
        ? "stream"
        : "other";
log({ event: "start", mode, argv, cwd: process.cwd() });
process.on("exit", (code) => log({ event: "exit", code }));
process.on("SIGTERM", () => {
  log({ event: "signal", signal: "SIGTERM" });
  if (!env.FAKE_CLAUDE_IGNORE_TERM) process.exit(143);
});
process.on("SIGINT", () => process.exit(130));
process.stdout.on("error", () => {}); // reader went away (EPIPE): exit via stdin EOF

function main() {
  if (mode === "version") return console.log(`${VERSION} (Claude Code)`);
  if (mode === "auth") {
    if (argv[1] === "status")
      return console.log(
        JSON.stringify(
          env.FAKE_CLAUDE_SIGNED_OUT
            ? { loggedIn: false }
            : {
                loggedIn: true,
                email: "fake@example.com",
                subscriptionType: "max",
                authMethod: "claude.ai",
              },
        ),
      );
    return console.log("Open https://example.com/oauth?fake=1 to continue");
  }
  if (mode !== "stream") return console.log("fake claude: unsupported invocation");

  const sessionId = flag("session-id") || flag("resume") || rid();
  let model = flag("model") || "claude-fake-1";
  let permMode = flag("permission-mode") || "default";
  let interrupted = false;
  const waiting = new Map();
  const ok = (request_id, response = {}) =>
    out({ type: "control_response", response: { subtype: "success", request_id, response } });
  const models = [
    {
      value: "claude-fake-1",
      displayName: "Fake 1",
      description: "fake",
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high"],
    },
  ];
  function control({ request_id, request: r }) {
    log({ event: "control", subtype: r.subtype });
    switch (r.subtype) {
      case "initialize":
        return ok(request_id, {
          commands: [],
          agents: [],
          output_style: "default",
          available_output_styles: ["default"],
          models,
          account: { email: "fake@example.com" },
          claude_code_version: VERSION,
        });
      case "interrupt":
        interrupted = true;
        return ok(request_id);
      case "set_permission_mode":
        permMode = r.mode;
        return ok(request_id);
      case "set_model":
        model = r.model;
        return ok(request_id);
      case "cancel_async_message":
        return ok(request_id, { cancelled: false });
      case "get_usage":
        return ok(request_id, { rate_limits_available: false });
      default:
        return ok(request_id);
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function turn(msg) {
    interrupted = false;
    const text =
      typeof msg.message.content === "string"
        ? msg.message.content
        : JSON.stringify(msg.message.content);
    log({ event: "turn", text });
    const base = () => ({ session_id: sessionId, uuid: rid() });
    out({ type: "system", subtype: "session_state_changed", state: "running", ...base() });
    out({
      type: "system",
      subtype: "init",
      cwd: process.cwd(),
      model,
      permissionMode: permMode,
      tools: [],
      claude_code_version: VERSION,
      ...base(),
    });
    out({
      type: "user",
      message: msg.message,
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: msg.uuid,
      timestamp: new Date().toISOString(),
      isReplay: true,
    });
    const reply = `FAKE-CLAUDE-REPLY: ${text}`;
    const msgId = "msg_" + rid().slice(0, 8);
    const ev = (event) => out({ type: "stream_event", event, parent_tool_use_id: null, ...base() });
    ev({
      type: "message_start",
      message: { id: msgId, type: "message", role: "assistant", model, content: [] },
    });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    for (const chunk of reply.match(/.{1,8}/gs) || [""]) {
      if (env.FAKE_CLAUDE_SLOW) await sleep(Number(env.FAKE_CLAUDE_SLOW));
      if (interrupted) break;
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } });
    }
    ev({ type: "content_block_stop", index: 0 });
    ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
    ev({ type: "message_stop" });
    out({
      type: "assistant",
      message: {
        id: msgId,
        type: "message",
        role: "assistant",
        model,
        stop_reason: "end_turn",
        content: [{ type: "text", text: reply }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
      parent_tool_use_id: null,
      ...base(),
    });
    out({
      type: "result",
      subtype: interrupted ? "error_during_execution" : "success",
      is_error: interrupted,
      ...(interrupted ? { errors: ["interrupted"] } : { result: reply }),
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {},
      modelUsage: {},
      permission_denials: [],
      session_id: sessionId,
      uuid: rid(),
    });
    out({ type: "system", subtype: "session_state_changed", state: "idle", ...base() });
  }
  let chain = Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.type === "control_request") control(m);
    else if (m.type === "control_response") {
      const w = waiting.get(m.response.request_id);
      if (w) {
        waiting.delete(m.response.request_id);
        w(m.response);
      }
    } else if (m.type === "user")
      chain = chain.then(() => turn(m)).catch((e) => process.stderr.write(String(e) + "\n"));
  });
  rl.on("close", () => {
    log({ event: "stdin-eof" });
    void chain.then(() => process.exit(0));
  });
}
main();
