"""P2 capture: how a failed and a denied inner call of a codemode `execute` show in `metadata.toolCalls`."""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, HERE

NODE = __import__("shutil").which("node") or "node"
SRV = os.path.join(HERE, "mcp_server.cjs")
CFG = {
    "permissions": [
        {"action": "*", "resource": "*", "effect": "ask"},
        {"action": "writer_note_count", "resource": "*", "effect": "allow"},
        {"action": "writer_note_fail", "resource": "*", "effect": "allow"},
        {"action": "writer_note_denied", "resource": "*", "effect": "deny"},
    ],
    "mcp": {"servers": {"writer": {"type": "local", "command": [NODE, SRV]}}},
}
with Server("s22", cfg=CFG) as s:
    time.sleep(3)
    a = s.session()
    time.sleep(3)
    n = len(s.events)
    print(s.prompt(a, "In ONE code execution call, call tools.writer.note_count(), tools.writer.note_denied() and tools.writer.note_fail() from the writer MCP server, wrapping each in try/catch, and return an array with each outcome. Then tell me each outcome.")[0])
    print((s.drive(a, lambda e: "reject" if e["data"]["action"] == "shell" else "once", timeout=100, start=n) or {}).get("type"))
    s.brief([a], start=n, width=900, skip=("session.reasoning.delta", "session.text.delta", "session.instructions.updated", "session.tool.input.delta", "session.step.streamed", "session.step.first-token", "session.usage.updated", "session.reasoning.started", "session.reasoning.ended"))
    s.save_events("s22-codemode-failures", [a], start=n); s.dump("s22-codemode-failures", a)
