// Trivial MCP server for the captures: read-only tools, JSON-RPC.
//   node mcp_server.cjs                          stdio, newline-delimited JSON-RPC (the default)
//   node mcp_server.cjs --marker FILE            also append one JSON line per event: spawn, initialize, tools/list, tools/call
//   node mcp_server.cjs --name NAME              serverInfo.name (default fake-writer)
//   node mcp_server.cjs --remote PORT            streamable HTTP on 127.0.0.1:PORT (POST /mcp, one JSON reply per request;
//                                                no SSE, no OAuth) instead of stdio; PORT 0 picks a free one and prints "listening <port>"
// The marker records what the capture needs to prove "spawned / connected": the pid, the time, the mode and the
// server name. It never records tool arguments or headers.
const fs = require("fs");
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const marker = opt("--marker");
const name = opt("--name") || "fake-writer";
const remote = opt("--remote");
const mark = (event, extra) => { if (marker) fs.appendFileSync(marker, JSON.stringify({ event, name, pid: process.pid, mode: remote !== undefined ? "remote" : "stdio", t: Date.now(), ...extra }) + "\n"); };
const tool = (n, d) => ({ name: n, description: d, inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } });
const TOOLS = [tool("note_count", "Returns how many notes the fake vault holds. Read only."), tool("note_fail", "Always fails (to see how a failed call shows). Read only."), tool("note_denied", "A tool a permission rule denies. Read only.")];

// One JSON-RPC message in, the reply (or null) out.
function handle(m) {
  if (m.method === "initialize") {
    mark("initialize");
    return { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "0.0.1" } } };
  } else if (m.method === "tools/list") {
    mark("tools/list");
    return { jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } };
  } else if (m.method === "tools/call") {
    mark("tools/call", { tool: m.params && m.params.name });
    if (m.params && m.params.name === "note_fail") return { jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "The fake vault is unreadable." }] } };
    return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "The fake vault holds 42 notes." }] } };
  } else if (m.id !== undefined && m.method) {
    return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } };
  }
  return null;
}

mark("spawn", { argc: args.length });
if (remote !== undefined) {
  const http = require("http");
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let m; try { m = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const out = Array.isArray(m) ? m.map(handle).filter(Boolean) : handle(m);
      if (out === null || (Array.isArray(out) && !out.length)) { res.writeHead(202).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    });
  });
  srv.listen(Number(remote), "127.0.0.1", () => { mark("listening", { port: srv.address().port }); console.log("listening " + srv.address().port); });
} else {
  const rl = require("readline").createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    const out = handle(m);
    if (out) process.stdout.write(JSON.stringify(out) + "\n");
  });
  rl.on("close", () => mark("stdin-closed"));
}
