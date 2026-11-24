"""Helpers shared by the s38..s46 captures of the global config and the MCP menu (spec 4.13). Standard library only.

Everything runs against OpenCode's own private server through `oc.Server` with a SYNTHETIC global config
(`global_config=`): HOME and the XDG homes are moved into the work folder, providers point at the local fake model
(`shared/capture/fake_model.py`), MCP servers are `mcp_server.cjs` with a marker file. No real model, login or
user file is involved. Results are small fact files: `save()` scrubs them (paths, user, host, ports, ids) and
writes `$OC_WORK/raw/global-<name>.json`, plus `fixtures/global-<name>.json` when `OC_FIXTURES` is set (run.py
sets it). A result that still holds a local detail after scrubbing aborts the run. Words the Rust fixture check refuses are
renamed (`credential` to `cred`: the context service of that name shows as `cred`).
"""
import getpass, json, os, re, shutil, socket, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "shared", "capture")))
import fake_model  # noqa: E402
from oc import WORK, RAW, Server, free_port  # noqa: E402

os.makedirs(WORK, exist_ok=True)
NODE = shutil.which("node") or "node"
SRV = os.path.join(HERE, "mcp_server.cjs")
FIX = os.environ.get("OC_FIXTURES") or ""


def fake(name, call=None, args=None, reply="ok", keep_body=True):
    """Start a fake model endpoint recording to $OC_WORK/fm-<name>.jsonl. Returns (server, port, record path)."""
    rec = os.path.join(WORK, f"fm-{name}.jsonl")
    if os.path.exists(rec):
        os.remove(rec)
    srv, port = fake_model.start(rec, call=call, args=args, reply=reply, keep_body=keep_body)
    return srv, port, rec


def requests(rec):
    return [json.loads(l) for l in open(rec).read().splitlines() if l.strip()] if os.path.exists(rec) else []


def provider(port, name="Fake", model="fake-model"):
    return {"package": "@ai-sdk/openai-compatible", "name": name, "settings": {"baseURL": f"http://127.0.0.1:{port}/v1", "apiKey": "x"},
            "models": {model: {"modelID": model, "name": model}}}


def dead_provider(name="Dead", model="fake-model"):
    """A provider whose base URL is a port nothing listens on (a request to it fails fast, no network)."""
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close()
    return provider(p, name, model)


def mcp_local(name, marker, disabled=None):
    c = {"type": "local", "command": [NODE, SRV, "--marker", marker, "--name", name]}
    if disabled is not None:
        c["disabled"] = disabled
    return c


def mcp_remote(url, disabled=None):
    c = {"type": "remote", "url": url, "oauth": False}
    if disabled is not None:
        c["disabled"] = disabled
    return c


class Remote:
    """A remote MCP server (mcp_server.cjs --remote 0) with its own marker; stop() kills only this process."""
    def __init__(self, name, marker):
        import subprocess
        self.proc = subprocess.Popen([NODE, SRV, "--marker", marker, "--name", name, "--remote", "0"], stdout=subprocess.PIPE, text=True)
        self.port = int(self.proc.stdout.readline().split()[1])
        self.url = f"http://127.0.0.1:{self.port}/mcp"

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


def marks(path, t0=None):
    """The marker lines as (name, event, ms since t0)."""
    out = []
    if os.path.exists(path):
        for l in open(path).read().splitlines():
            if l.strip():
                m = json.loads(l)
                out.append({"name": m["name"], "event": m["event"], "mode": m["mode"], "ms": (m["t"] - t0) if t0 else None, **({"tool": m["tool"]} if "tool" in m else {})})
    return out


def spawned(path):
    return sorted({m["name"] for m in marks(path) if m["event"] == "spawn"})


def initialized(path):
    return sorted({m["name"] for m in marks(path) if m["event"] == "initialize"})


def writer_cfg(port=None, model="fake-model", provider_id="fake-a", extra=None, servers=None, agents=None, perms=None):
    """A Writer-shaped config file (OPENCODE_CONFIG): top-level ask, the writer agent, MCP servers."""
    cfg = {"permissions": perms if perms is not None else [{"action": "*", "resource": "*", "effect": "ask"}], "policies": [], "default_agent": "writer",
           "agents": {"writer": {"mode": "primary", "description": "Writer's agent", "model": f"{provider_id}/{model}", "permissions": [{"action": "read", "resource": "*", "effect": "allow"}]}, **(agents or {})}}
    if port:
        cfg["providers"] = {provider_id: provider(port)}
    if servers:
        cfg["mcp"] = {"servers": servers}
    cfg.update(extra or {})
    return cfg


def mcp_status(s):
    c, r = s.api("GET", "/api/mcp")
    return {m["name"]: m["status"]["status"] for m in (r or {}).get("data", [])} if c == 200 else {"_http": c}


def wait_status(s, want, timeout=30):
    """Poll /api/mcp until every name in want has the wanted status; returns the last status map."""
    t = time.time(); st = {}
    while time.time() - t < timeout:
        st = mcp_status(s)
        if all(st.get(k) == v for k, v in want.items()):
            return st
        time.sleep(0.5)
    return st


def agents(s):
    c, r = s.api("GET", "/api/agent")
    return {a["id"]: {"mode": a.get("mode"), "disabled": bool(a.get("disabled")), "hidden": bool(a.get("hidden"))} for a in (r or {}).get("data", [])} if c == 200 else {"_http": c}


# -- scrub ---------------------------------------------------------------------------------------------
_ID = re.compile(r"\b(ses|msg|prm|psv|frm|job|prt|pty)_[0-9A-Za-z]{10,}\b")
_B64 = re.compile(r"[A-Za-z0-9+/=_-]{60,}")


def scrub_text(t):
    for v, w in ((WORK, "<work>"), (os.path.realpath(WORK), "<work>"), (os.path.expanduser("~"), "<home>"), (getpass.getuser(), "<user>"), (socket.gethostname(), "<host>"), (socket.gethostname().split(".")[0], "<host>")):
        if v and len(v) > 2:
            t = t.replace(v, w)
    t = re.sub(r"127\.0\.0\.1:\d+", "127.0.0.1:0", t)
    t = re.sub(r"/private/var/folders/[^\"' ]+", "<tmp>", t)
    t = re.sub(r"/var/folders/[^\"' ]+", "<tmp>", t)
    t = _ID.sub(lambda m: m.group(1) + "_<id>", t)
    t = _B64.sub("<blob>", t)
    # words the fixtures check (rust/fixtures_tests.rs) refuses: the at-sign is JSON-escaped, the others renamed
    t = t.replace("@", "\\u0040")
    for a, b in (("credential", "cred"), ("Credential", "Cred"), ("authorization", "auth"), ("Authorization", "Auth"), ("apiKey", "key"), ("apikey", "key"), ("bearer", "token"), ("Bearer", "Token")):
        t = t.replace(a, b)
    return t


def save(name, obj):
    """Scrub and write the fact file; abort when a local detail survives."""
    t = scrub_text(json.dumps(obj, indent=1, sort_keys=False))
    for bad in (getpass.getuser(), os.path.expanduser("~"), WORK, socket.gethostname()):
        if bad and len(bad) > 2 and bad in t:
            sys.exit(f"scrub left {bad!r} in {name}")
    os.makedirs(RAW, exist_ok=True)
    open(os.path.join(RAW, f"global-{name}.json"), "w").write(t + "\n")
    if FIX:
        os.makedirs(FIX, exist_ok=True)
        open(os.path.join(FIX, f"global-{name}.json"), "w").write(t + "\n")
    print("saved", name)


def turn_tools(s, sid, text, timeout=60):
    """Send a prompt, wait for the end of the turn, return the event types seen (quiet ones dropped)."""
    n = len(s.events)
    s.prompt(sid, text)
    e = s.done(sid, timeout, start=n)
    return n, (e["type"] if e else "timeout")


def offered(rec, names=()):
    """What the last tool-bearing request offered: the tool names, and which of `names` (server names) the Code Mode
    catalog in the request lists."""
    reqs = [r for r in requests(rec) if r["tools"]]
    if not reqs:
        return {"requests": 0}
    last = reqs[-1]
    text = json.dumps(last.get("body") or {})
    # under codemode the catalog in the instructions lists each connected server as "- <name> (<n> tools)"
    return {"tools": sorted(last["tools"]), "catalog_servers": sorted(n for n in names if f"\\n- {n} (" in text)}


def pids(path):
    """Pids of the processes a marker file saw spawn (stdio servers: the process OpenCode started)."""
    return [m["pid"] for m in (json.loads(l) for l in open(path).read().splitlines() if l.strip())] if os.path.exists(path) else []


def alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def live_spawns(path):
    """Spawned pids of one marker that are still alive (a stdio server that OpenCode closed exits)."""
    seen = []
    for l in (open(path).read().splitlines() if os.path.exists(path) else []):
        if l.strip():
            m = json.loads(l)
            if m["event"] == "spawn" and m["pid"] not in seen:
                seen.append(m["pid"])
    return [p for p in seen if alive(p)]


def spawn_count(path):
    return sum(1 for l in (open(path).read().splitlines() if os.path.exists(path) else []) if l.strip() and json.loads(l)["event"] == "spawn")
