"""C2 (spec 4.13): the levers that keep a GLOBAL MCP server from starting. Each variant is a fresh server with the same
synthetic global config (`g-a`, `g-b` local, `g-r` remote, all enabled) and a Writer file (`writer` server) that applies
one lever. Per variant: GET /api/mcp (names and statuses), the markers (who spawned, who initialized: a spawn is the
test, a status is not), what the fake model was offered after one prompt, and the config validity."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gc_helpers import *

NAMES = ("g-a", "g-b", "g-r", "writer")
def P(a, r, e): return {"action": a, "resource": r, "effect": e}

def variant(label, writer_extra=None, global_extra=None, global_servers=None, writer_servers=None, env=None, config_first=False):
    mk = {n: os.path.join(WORK, f"c2-{n}.mark") for n in NAMES}
    for p in mk.values():
        if os.path.exists(p): os.remove(p)
    srv, port, rec = fake("c2")
    remote = Remote("g-r", mk["g-r"])
    gs = {"g-a": mcp_local("g-a", mk["g-a"]), "g-b": mcp_local("g-b", mk["g-b"]), "g-r": mcp_remote(remote.url)}
    gs.update(global_servers or {})
    glob = {"providers": {"fake-a": provider(port)}, "mcp": {"servers": gs}, **(global_extra or {})}
    ws = {"writer": mcp_local("writer", mk["writer"])}
    ws.update(writer_servers or {})
    wcfg = writer_cfg(servers=ws, extra=writer_extra)
    out = {"variant": label, "writer_config_extra": writer_extra, "writer_servers_override": {k: v for k, v in (writer_servers or {}).items()}, "global_extra": global_extra}
    try:
        with Server("c2", cfg=wcfg, global_config=glob, env=env, attach=not config_first) as s:
            time.sleep(1)
            if config_first:  # the names step: GET /api/config is the very first location-scoped call
                c, r = s.api("GET", "/api/config")
                docs = r if isinstance(r, list) else []
                out["config_http"] = c
                def info(d):
                    return d.get("info") if isinstance(d.get("info"), dict) else {}
                out["config_documents"] = [{"type": d.get("type"), "info_keys": sorted(info(d).keys()), "mcp_server_names": sorted(((info(d).get("mcp") or {}).get("servers") or {}).keys()), "policies": info(d).get("policies")} for d in docs if isinstance(d, dict)]
                out["spawned_right_after_config"] = [n for n in NAMES if n != "g-r" and spawned(mk[n])]
                out["remote_initialized_right_after_config"] = bool(initialized(mk["g-r"]))
                time.sleep(3)
                out["spawned_3s_after_config"] = [n for n in NAMES if n != "g-r" and spawned(mk[n])]
                s.attach()
            c, r = s.api("GET", "/api/mcp")
            out["mcp_http"] = c
            out["mcp_after_boot"] = mcp_status(s) if c == 200 else str(r)[:300]
            time.sleep(3)
            out["mcp_settled"] = mcp_status(s)
            out["agents_ok"] = "writer" in agents(s)
            try:
                sid = s.session(model="fake-model", provider="fake-a", agent="writer")
                n, end = turn_tools(s, sid, "hello")
                out["turn"] = end
            except AssertionError as e:
                out["turn"] = "session failed: " + str(e)[:200]
            time.sleep(1)
            out["spawned"] = [n for n in NAMES if n != "g-r" and spawned(mk[n])]
            out["remote_initialized"] = bool(initialized(mk["g-r"]))
            out["initialized"] = [n for n in NAMES if n != "g-r" and initialized(mk[n])]
            out["offered_to_model"] = offered(rec, NAMES)
    finally:
        srv.shutdown(); remote.stop()
    print(label, "->", json.dumps({k: out.get(k) for k in ("mcp_settled", "spawned", "remote_initialized", "turn")}))
    return out

R = {"question": "C2: which lever keeps a global MCP server from starting?", "variants": []}
V = R["variants"]
V.append(variant("baseline: no lever"))
V.append(variant("L1a partial per-server {disabled:true} in Writer's file for g-a", writer_servers={"g-a": {"disabled": True}}))
V.append(variant("L1b full per-server {type,command,disabled:true} in Writer's file for g-a", writer_servers={"g-a": {"type": "local", "command": [NODE, SRV, "--name", "g-a"], "disabled": True}}))
V.append(variant("L2a policies [mcp.use * deny, mcp.use writer allow]", writer_extra={"policies": [P("mcp.use", "*", "deny"), P("mcp.use", "writer", "allow")]}))
V.append(variant("L2b policies [mcp.use writer allow, mcp.use * deny] (reverse order)", writer_extra={"policies": [P("mcp.use", "writer", "allow"), P("mcp.use", "*", "deny")]}))
V.append(variant("L2c policies [deny *, allow writer, allow g-a] (one switched on)", writer_extra={"policies": [P("mcp.use", "*", "deny"), P("mcp.use", "writer", "allow"), P("mcp.use", "g-a", "allow")]}))
V.append(variant("L2d policies [mcp.use g-a deny] only (named deny)", writer_extra={"policies": [P("mcp.use", "g-a", "deny")]}))
V.append(variant("X1 Writer deny * ; GLOBAL policies allow g-b", writer_extra={"policies": [P("mcp.use", "*", "deny"), P("mcp.use", "writer", "allow")]}, global_extra={"policies": [P("mcp.use", "g-b", "allow")]}))
V.append(variant("X2 Writer disabled:true for g-a ; GLOBAL g-a has disabled:false", writer_servers={"g-a": {"type": "local", "command": [NODE, SRV, "--name", "g-a"], "disabled": True}}, global_servers={"g-a": {**mcp_local("g-a", os.path.join(WORK, "c2-g-a.mark")), "disabled": False}}))
V.append(variant("X3 GLOBAL g-b disabled:true ; Writer sets g-b disabled:false (partial)", global_servers={"g-b": {**mcp_local("g-b", os.path.join(WORK, "c2-g-b.mark")), "disabled": True}}, writer_servers={"g-b": {"disabled": False}}))
V.append(variant("X4 GLOBAL policies deny * ; Writer policies allow g-a", global_extra={"policies": [P("mcp.use", "*", "deny")]}, writer_extra={"policies": [P("mcp.use", "g-a", "allow"), P("mcp.use", "writer", "allow")]}))
V.append(variant("L1c placeholder per-server {type:local,command:[true],disabled:true} (name-only, no real command)", writer_servers={"g-a": {"type": "local", "command": ["true"], "disabled": True}}))
V.append(variant("N1 names step: deny-all policies, GET /api/config as the first call", writer_extra={"policies": [P("mcp.use", "*", "deny"), P("mcp.use", "writer", "allow")]}, config_first=True))
V.append(variant("N0 names step baseline (no lever): GET /api/config first", config_first=True))
CONTENT = lambda pol: json.dumps({"policies": pol})
V.append(variant("X5 policies from OPENCODE_CONFIG_CONTENT [deny *, allow writer] ; GLOBAL policies allow g-b", global_extra={"policies": [P("mcp.use", "g-b", "allow")]}, env={"OPENCODE_CONFIG_CONTENT": CONTENT([P("mcp.use", "*", "deny"), P("mcp.use", "writer", "allow")])}))
V.append(variant("X6 policies from OPENCODE_CONFIG_CONTENT [deny *, allow writer] ; GLOBAL policies deny *", global_extra={"policies": [P("mcp.use", "*", "deny")]}, env={"OPENCODE_CONFIG_CONTENT": CONTENT([P("mcp.use", "*", "deny"), P("mcp.use", "writer", "allow")])}))
V.append(variant("X7 per-server placeholders for every global name in Writer's file ; GLOBAL policies allow g-a", writer_servers={n: {"type": "local", "command": ["true"], "disabled": True} for n in ("g-a", "g-b", "g-r")}, global_extra={"policies": [P("mcp.use", "g-a", "allow")]}))

def scale(label, n, deny):
    """Risk 10.1 of the spec: a large global config stalled the first prompt. n stdio servers in the global config; time from the
    first location-scoped call to the end of the first turn on the fake model, with the servers switched on or denied."""
    srv, port, rec = fake("c2s")
    mk = os.path.join(WORK, "c2s.mark")
    if os.path.exists(mk): os.remove(mk)
    gs = {f"g{i:02d}": mcp_local(f"g{i:02d}", mk) for i in range(n)}
    glob = {"providers": {"fake-a": provider(port)}, "mcp": {"servers": gs}}
    extra = {"policies": [P("mcp.use", "*", "deny"), P("mcp.use", "writer", "allow")]} if deny else None
    out = {"variant": label, "global_servers": n, "denied_by_policy": deny}
    try:
        with Server("c2s", cfg=writer_cfg(servers={"writer": mcp_local("writer", mk)}, extra=extra), global_config=glob, attach=False) as s:
            t = time.time()
            s.attach()
            sid = s.session(model="fake-model", provider="fake-a", agent="writer")
            n0, end = turn_tools(s, sid, "hello", timeout=120)
            out["first_turn_s"] = round(time.time() - t, 1)
            out["turn"] = end
            time.sleep(2)
            out["spawn_events"] = spawn_count(mk)
            out["status_counts"] = {k: sum(1 for v in mcp_status(s).values() if v == k) for k in ("connected", "failed", "pending", "disabled")}
    finally:
        srv.shutdown()
    print(label, json.dumps(out))
    return out
R["scale"] = [scale("S0 one global server, allowed", 1, False), scale("S1 30 global servers, all allowed", 30, False), scale("S2 30 global servers, denied by policy", 30, True)]
save("c2-levers", R)
