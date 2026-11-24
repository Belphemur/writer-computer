"""C8 (spec 4.13): MCP server names with `.`, a space and `:`. One server per run, named so, defined in Writer's file.
Per name: what GET /api/mcp calls it; with `codemode: false` the tool name the model is offered and the permission action
of a scripted call; with codemode on (Writer's way) the namespace the Code Mode catalog gives the server's tools and the
permission action of a scripted `execute` call that uses exactly that namespace."""
import json, os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gc_helpers import *

NAMES = ["my-srv", "my.srv", "my srv", "my:srv", "My_Srv2"]

def run(name, codemode, code=None):
    mk = os.path.join(WORK, "c8.mark")
    if os.path.exists(mk): os.remove(mk)
    srv, port, rec = fake("c8", call="note_count" if not codemode else "execute", args={} if not codemode else {"code": code or "return 1"}, reply="done")
    srv_cfg = mcp_local(name, mk)
    srv_cfg["codemode"] = codemode
    wcfg = writer_cfg(port=port, servers={name: srv_cfg})
    out = {}
    try:
        with Server("c8", cfg=wcfg, global_config={}) as s:
            time.sleep(1)
            c, r = s.api("GET", "/api/mcp")
            out["mcp_names"] = [m["name"] for m in r["data"]]
            out["mcp_status"] = [m["status"]["status"] for m in r["data"] if m["name"] == name]
            sid = s.session(model="fake-model", provider="fake-a", agent="writer", perms=[])
            n = len(s.events)
            s.prompt(sid, "go")
            asked = []
            def decide(e):
                asked.append({"action": e["data"]["action"], "resources": e["data"].get("resources")})
                return "once"
            end = s.drive(sid, decide, timeout=40, start=n)
            time.sleep(1)
            reqs = [q for q in requests(rec) if q["tools"]]
            out["offered_tools_with_note_count"] = [t for t in (reqs[0]["tools"] if reqs else []) if "note_count" in t]
            body = json.dumps(reqs[0].get("body") or {}) if reqs else ""
            m = re.search(r"\\n- (.{0,40}?) \(3 tools\)\\n  - (tools[^(]{0,80})\(\)", body.replace("\\\\n", "\\n"))
            out["catalog_entry"] = {"server_line": m.group(1), "first_tool": m.group(2)} if m else None
            out["asked"] = asked
            out["tool_results"] = [e["data"].get("content") for e in s.events[n:] if e["type"] == "session.tool.success" and e["data"].get("sessionID") == sid][:2]
            out["turn"] = end["type"] if end else "timeout"
            out["marker_tools_called"] = [m["tool"] for m in marks(mk) if m["event"] == "tools/call"]
    finally:
        srv.shutdown()
    return out

R = {"question": "C8: server names with `.`, space and `:`", "names": []}
for name in NAMES:
    direct = run(name, False)
    cat = run(name, True)  # first pass to read the namespace
    ns = (cat.get("catalog_entry") or {}).get("first_tool")
    code = f"const r = await {ns}(); return r;" if ns else "return 1"
    scripted = run(name, True, code)
    R["names"].append({"server": name, "codemode_false": direct, "codemode_catalog": {"mcp_names": cat["mcp_names"], "catalog_entry": cat["catalog_entry"]}, "codemode_scripted_call": {"code": code, **{k: scripted[k] for k in ("asked", "tool_results", "marker_tools_called", "turn")}}})
    print(name, "->", json.dumps({"mcp": direct["mcp_names"], "direct_tools": direct["offered_tools_with_note_count"], "direct_asked": direct["asked"], "catalog": cat["catalog_entry"], "code_asked": scripted["asked"], "called": scripted["marker_tools_called"]}))
save("c8-names", R)
