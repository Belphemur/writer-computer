"""Does OPENCODE_DISABLE_PROJECT_CONFIG=1 keep a vault's own `opencode.json` out? No model call.

Records which MCP servers `GET /api/mcp` lists for a working directory holding an `opencode.json` that adds
one (`projmcp`), with the variable set (Writer's default) and with it removed."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, HERE

NODE = __import__("shutil").which("node") or "node"
SRV = os.path.join(HERE, "mcp_server.cjs")
VAULT_CFG = {"mcp": {"servers": {"projmcp": {"type": "local", "command": [NODE, SRV]}}}}
for label, extra in (("disabled (Writer's default)", {}), ("enabled (variable removed)", {"OPENCODE_DISABLE_PROJECT_CONFIG": None})):
    with Server("s15", cfg={}, files={"opencode.json": json.dumps(VAULT_CFG)}, env=extra) as s:
        sid = s.session()
        time.sleep(4)
        c, r = s.api("GET", "/api/mcp")
        print(label, "->", sorted(x["name"] for x in r["data"]))
