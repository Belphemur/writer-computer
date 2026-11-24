"""C1 (spec 4.13): when is a GLOBAL local or remote MCP server spawned or connected, relative to process start and to
each API call? Synthetic global config with a local server (`g-local`) and a remote one (`g-remote`), Writer's own file
with `writer`. After the ready line NO call is made for a while; then each route of the start sequence is called in
turn and the markers (spawn / initialize) are diffed after each. The turn goes to the fake model (no real model)."""
import json, os, sys, threading, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gc_helpers import *

mk = {n: os.path.join(WORK, f"c1-{n}.mark") for n in ("writer", "g-local", "g-remote", "g-off")}
for p in mk.values():
    open(p, "w").close(); os.remove(p)
srv, port, rec = fake("c1", reply="hi")
remote = Remote("g-remote", mk["g-remote"])
glob = {"providers": {"fake-a": provider(port)}, "mcp": {"servers": {"g-local": mcp_local("g-local", mk["g-local"]), "g-off": mcp_local("g-off", mk["g-off"], disabled=True), "g-remote": mcp_remote(remote.url)}}}
wcfg = writer_cfg(servers={"writer": mcp_local("writer", mk["writer"])})
FIRST = {
    "GET /api/info": lambda s: s.api("GET", "/api/info")[0],
    "GET /api/event (stream only)": lambda s: threading.Thread(target=s._sse, daemon=True).start(),
    "GET /api/permission/saved": lambda s: s.api("GET", "/api/permission/saved")[0],
    "GET /api/config": lambda s: s.api("GET", "/api/config")[0],
    "GET /api/agent": lambda s: s.api("GET", "/api/agent")[0],
    "GET /api/model": lambda s: s.api("GET", "/api/model")[0],
    "GET /api/provider": lambda s: s.api("GET", "/api/provider")[0],
    "GET /api/mcp": lambda s: s.api("GET", "/api/mcp")[0],
    "POST /api/session": lambda s: s.api("POST", "/api/session", {"location": {"directory": s.cwd}, "model": {"id": "fake-model", "providerID": "fake-a"}})[0],
}
MATRIX = {}
for label, fn in FIRST.items():
    for p in mk.values():
        if os.path.exists(p): os.remove(p)
    with Server("c1m", cfg=wcfg, global_config=glob, attach=False) as s:
        time.sleep(1)
        code = fn(s)
        time.sleep(6)
        MATRIX[label] = {"http": code if isinstance(code, int) else None, "spawned_within_6s": sorted(n for n in mk if marks(mk[n]) and n != "g-remote"), "remote_initialized": bool(marks(mk["g-remote"]))}
        if label == "POST /api/session":  # the session alone booted nothing: does the first prompt?
            sess = s.api("GET", "/api/session")[1]
            sid0 = None
            c, r = s.api("POST", "/api/session", {"location": {"directory": s.cwd}, "model": {"id": "fake-model", "providerID": "fake-a"}})
            sid0 = r["data"]["id"]; s.created = [sid0]
            s.api("POST", f"/api/session/{sid0}/prompt", {"text": "hello"})
            time.sleep(8)
            MATRIX[label]["spawned_within_8s_of_first_prompt"] = sorted(n for n in mk if marks(mk[n]) and n != "g-remote")
        print("first touch", label, MATRIX[label])
        s._stop = True
for p in mk.values():
    if os.path.exists(p): os.remove(p)
R = {"question": "C1: when does a global server spawn or connect?", "steps": []}

def seen():
    out = {}
    for n, p in mk.items():
        if n == "g-remote":  # the remote server process is ours and already running; only its initialize says "connected"
            out[n] = [m["event"] for m in marks(p, s.t_launch) if m["event"] in ("initialize", "tools/list")]
        else:
            out[n] = [m["event"] for m in marks(p, s.t_launch)]
    return out

def step(label, fn=None, wait=1.5):
    r = fn() if fn else None
    time.sleep(wait)
    R["steps"].append({"after": label, "ms_since_launch": int(time.time() * 1000) - s.t_launch, "markers": seen(), **({"result": r} if r is not None else {})})
    print(label, R["steps"][-1]["markers"])

try:
    with Server("c1", cfg=wcfg, global_config=glob, attach=False) as s:
        R["ready_ms"] = s.t_ready - s.t_launch

        step("ready line (no API call yet), settled 8 s", None, wait=8)
        step("GET /api/info", lambda: (R.__setitem__("api_info_version", s.api("GET", "/api/info")[1].get("version")), 200)[1])
        step("GET /api/event (stream open only)", lambda: threading.Thread(target=s._sse, daemon=True).start(), wait=3)
        R["permission_saved_called_at_ms"] = int(time.time() * 1000) - s.t_launch
        step("GET /api/permission/saved", lambda: s.api("GET", "/api/permission/saved")[0], wait=3)
        R["initialize_at_ms"] = {n: [m["ms"] for m in marks(p, s.t_launch) if m["event"] == "initialize"] for n, p in mk.items()}
        s.saved_before = set()
        def cfg_keys():
            c, r = s.api("GET", "/api/config")
            return {"http": c, "documents": len(r) if isinstance(r, list) else None, "top_level_keys": sorted({k for d in (r if isinstance(r, list) else []) for k in (d.get("data", d) if isinstance(d, dict) else {}).keys()})[:40]}
        step("GET /api/config", cfg_keys)
        step("GET /api/agent", lambda: sorted(agents(s)))
        step("GET /api/model", lambda: s.api("GET", "/api/model")[0])
        step("GET /api/provider", lambda: [p["id"] for p in s.api("GET", "/api/provider")[1]["data"]])
        t = time.time()
        step("GET /api/mcp", lambda: {"status": mcp_status(s), "ms": int((time.time() - t) * 1000)}, wait=3)
        sid = {}
        def mk_session():
            sid["id"] = s.session(model="fake-model", provider="fake-a", agent="writer")
            return "created"
        step("POST /api/session", mk_session, wait=4)
        R["mcp_after_session"] = mcp_status(s)
        t = time.time()
        n, end = turn_tools(s, sid["id"], "hello")
        R["first_prompt"] = {"end": end, "s": round(time.time() - t, 1)}
        step("first prompt answered by the fake model", None, wait=1)
        R["mcp_after_prompt"] = mcp_status(s)
        reqs = [r for r in requests(rec) if r["tools"]]
        R["offered_tools_main_request"] = sorted(reqs[-1]["tools"]) if reqs else None
        R["offered_has_codemode_execute"] = bool(reqs and "execute" in reqs[-1]["tools"])
finally:
    srv.shutdown(); remote.stop()
import subprocess
from oc import BIN
_home = os.path.join(WORK, "home-c9"); os.makedirs(_home, exist_ok=True)
_env = {k: v for k, v in os.environ.items() if not k.startswith("OPENCODE_")}
_env.update(HOME=_home, XDG_CONFIG_HOME=os.path.join(_home, "c"), XDG_DATA_HOME=os.path.join(_home, "d"), XDG_CACHE_HOME=os.path.join(_home, "k"), XDG_STATE_HOME=os.path.join(_home, "s"))
_v = subprocess.run([BIN, "--version"], env=_env, capture_output=True, text=True, timeout=30)
R["c9_version"] = {"argv": "opencode --version", "exit": _v.returncode, "stdout": _v.stdout, "stderr_empty": not _v.stderr.strip(), "api_info_version": R.get("api_info_version")}
R["first_touch"] = MATRIX
save("c1-timing", R)
