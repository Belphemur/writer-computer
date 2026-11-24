"""C3 (spec 4.13): the runtime switch. Rewrite Writer's config file and POST /api/location/reload: does it start a
server that was switched on and stop one that was switched off (the process is gone, not just the status)? And the
explicit routes POST /api/experimental/mcp/{server}/connect and /disconnect: do they work on a server a policy denies,
or one with a per-server disabled placeholder? Markers and pids are the proof, statuses only the label."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gc_helpers import *

NAMES = ("g-a", "g-b", "writer")
def P(a, r, e): return {"action": a, "resource": r, "effect": e}
def snap(s, mk):
    return {"status": mcp_status(s), "live_processes": {n: len(live_spawns(mk[n])) for n in NAMES}, "spawn_events": {n: spawn_count(mk[n]) for n in NAMES}}

def run(label, mode):
    mk = {n: os.path.join(WORK, f"c3-{n}.mark") for n in NAMES}
    for p in mk.values():
        if os.path.exists(p): os.remove(p)
    srv, port, rec = fake("c3")
    glob = {"providers": {"fake-a": provider(port)}, "mcp": {"servers": {"g-a": mcp_local("g-a", mk["g-a"]), "g-b": mcp_local("g-b", mk["g-b"])}}}
    def cfg(on):
        """The Writer file with the given global names on; the rest off by `mode`."""
        extra = {}
        servers = {"writer": mcp_local("writer", mk["writer"])}
        if mode == "policies":
            extra["policies"] = [P("mcp.use", "*", "deny"), P("mcp.use", "writer", "allow")] + [P("mcp.use", n, "allow") for n in on]
        else:  # per-server placeholders
            for n in ("g-a", "g-b"):
                if n not in on:
                    servers[n] = {"type": "local", "command": ["true"], "disabled": True}
        return writer_cfg(servers=servers, extra=extra)
    out = {"mode": mode, "steps": []}
    def step(name, fn=None, wait=3):
        r = fn() if fn else None
        time.sleep(wait)
        out["steps"].append({"step": name, **({"result": r} if r is not None else {}), **snap(s, mk)})
        print(mode, name, json.dumps(out["steps"][-1]))
    def rewrite(on):
        json.dump(cfg(on), open(s.cfg_path, "w"), indent=2)
    try:
        with Server("c3", cfg=cfg(set()), global_config=glob) as s:
            sid = s.session(model="fake-model", provider="fake-a", agent="writer")
            step("start: both global servers off", None, wait=3)
            rewrite({"g-a"}); step("rewrite: g-a on, POST /api/location/reload", lambda: s.api("POST", "/api/location/reload")[0], wait=4)
            rewrite({"g-a", "g-b"}); step("rewrite: g-a and g-b on, reload", lambda: s.api("POST", "/api/location/reload")[0], wait=4)
            rewrite({"g-b"}); step("rewrite: g-a off again, reload", lambda: s.api("POST", "/api/location/reload")[0], wait=4)
            out["session_survives_reload"] = s.api("GET", f"/api/session/{sid}")[0] == 200
            rewrite(set()); step("rewrite: both off, reload", lambda: s.api("POST", "/api/location/reload")[0], wait=4)
            # explicit routes, config unchanged (both off by the lever)
            step("POST /api/experimental/mcp/g-a/connect on a switched-off server", lambda: s.api("POST", "/api/experimental/mcp/g-a/connect")[0], wait=3)
            step("POST /api/experimental/mcp/g-a/disconnect", lambda: s.api("POST", "/api/experimental/mcp/g-a/disconnect")[0], wait=3)
            step("reload after the explicit connect/disconnect (does the lever come back?)", lambda: s.api("POST", "/api/location/reload")[0], wait=4)
            n, end = turn_tools(s, sid, "hello")
            out["turn_after_all"] = end
            out["offered_catalog_servers"] = offered(rec, NAMES).get("catalog_servers")
    finally:
        srv.shutdown()
    return out

R = {"question": "C3: does rewrite + /api/location/reload start and stop servers? and /connect, /disconnect?", "runs": [run("policies", "policies"), run("placeholders", "placeholders")]}
save("c3-switch", R)
