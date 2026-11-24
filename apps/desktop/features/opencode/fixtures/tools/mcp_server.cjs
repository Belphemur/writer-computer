// Trivial stdio MCP server for the spike: one read-only tool, newline-delimited JSON-RPC.
const rl = require("readline").createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-writer", version: "0.0.1" } } });
  } else if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "note_count", description: "Returns how many notes the fake vault holds. Read only.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }] } });
  } else if (m.method === "tools/call") {
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "The fake vault holds 42 notes." }] } });
  } else if (m.id !== undefined && m.method) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } });
  }
});
