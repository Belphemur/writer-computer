import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, HERE

NODE = __import__("shutil").which("node") or "node"
SRV = os.path.join(HERE, "mcp_server.cjs")
CFG = {
    "permissions": [{"action": "*", "resource": "*", "effect": "ask"}],
    "mcp": {"servers": {"writer": {"type": "local", "command": [NODE, SRV]}}},
}
with Server("s07", cfg=CFG) as s:
    time.sleep(3)
    print("mcp list", json.dumps(s.api("GET", "/api/mcp")[1])[:900])
    sid = s.session()  # a session boots the location, which connects the MCP servers
    time.sleep(4)
    print("mcp list after session", json.dumps(s.api("GET", "/api/mcp")[1])[:900])
    print("mcp resource", json.dumps(s.api("GET", "/api/mcp/resource")[1])[:300])
    n0 = len(s.events)
    print("prompt", s.prompt(sid, "Call your note_count tool from the writer MCP server and tell me the number it returns.")[0])
    asked = []
    print(s.drive(sid, lambda e: "once", on_ask=lambda e: print("ASKED", json.dumps(e["data"])[:700]))["type"])
    for e in s.events[n0:]:
        if e["type"].startswith("session.tool.") or e["type"].startswith("mcp") or e["type"].startswith("permission"):
            print(json.dumps({k: v for k, v in e.items() if k not in ("location", "id", "created")})[:600])
    s.save_events("s07-mcp", [sid], start=0)
    s.dump("s07-mcp", sid)
    # runtime MCP: add a second server with PUT, see it connect, then remove it
    body = {"type": "local", "command": [NODE, SRV]}
    c, r = s.api("PUT", "/api/experimental/mcp/writer2", body); print("PUT writer2", c, str(r)[:300])
    time.sleep(3)
    print("mcp list after PUT", json.dumps(s.api("GET", "/api/mcp")[1])[:900])
    c, r = s.api("PUT", "/api/experimental/mcp/writer2", {"type": "local", "command": [NODE, SRV], "environment": {"X": "1"}}); print("PUT writer2 again", c, str(r)[:200])
    c, r = s.api("POST", "/api/experimental/mcp/writer2/disconnect"); print("disconnect", c, str(r)[:200])
    c, r = s.api("DELETE", "/api/experimental/mcp/writer2"); print("DELETE writer2", c, str(r)[:200])
    print("mcp list end", json.dumps(s.api("GET", "/api/mcp")[1])[:700])
