"""Shared helper for the OpenCode spike. Standard library only.

Starts OUR OWN `opencode serve` (free port, random password, temp cwd, Writer-style env: Writer's own config file and an empty config home, project config off, no inherited OPENCODE_*), records the
`/api/event` SSE stream to a file, does Basic-auth HTTP calls, and always stops the server.
Never touches the user's `opencode service` or port 4096, never reads OpenCode's auth/config files and
never calls /api/credential or /api/integration/*/connect/*.
"""
import base64, http.client, json, os, re, secrets, shutil, signal, socket, subprocess, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
def _inside_git_checkout(path):
    p = os.path.abspath(path)
    while True:
        if os.path.exists(os.path.join(p, ".git")):
            return True
        if os.path.dirname(p) == p:
            return False
        p = os.path.dirname(p)


# Everything the recorder writes (raw captures, configs, server logs, the empty config home) goes under
# OC_WORK, default a fresh temporary directory. A folder inside a git checkout is refused: raw captures
# hold unscrubbed local paths and must never be committed by accident.
WORK = os.path.abspath(os.environ.get("OC_WORK") or tempfile.mkdtemp(prefix="oc-work-"))
if _inside_git_checkout(WORK):
    sys.exit(f"refusing OC_WORK inside a git checkout: {WORK}")
RAW = os.path.join(WORK, "raw")
# Everything environment-specific is an env var (run.py sets them from its arguments).
BIN = os.environ.get("OC_BIN") or "opencode"
MODEL = os.environ.get("OC_MODEL") or "opencode/beam-free"  # provider/model of the chat model
IMAGE_MODEL = os.environ.get("OC_IMAGE_MODEL") or "opencode/hy4-flash-free"  # a model that takes images
NOLOGIN_MODEL = os.environ.get("OC_NOLOGIN_MODEL") or ""  # optional: provider/model of a provider with no login
PROVIDER, MODEL_ID = MODEL.split("/", 1)
FORBIDDEN_PATHS = ("/api/credential", "/connect/")
BASE_CFG = {
    "permissions": [],
    "policies": [],
}


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    assert p != 4096
    return p


class Server:
    def __init__(self, name, cfg=None, files=None, env=None, debug=False, port0=False):
        self.name = name
        os.makedirs(WORK, exist_ok=True)
        self.cwd = os.path.join(WORK, "cwd-" + name)
        shutil.rmtree(self.cwd, ignore_errors=True)
        os.makedirs(self.cwd)
        for rel, text in (files or {}).items():
            p = os.path.join(self.cwd, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "w").write(text)
        self.cfg_path = os.path.join(WORK, f"cfg-{name}.json")
        json.dump(cfg if cfg is not None else BASE_CFG, open(self.cfg_path, "w"), indent=2)
        # port0: the server picks its own port (`--port 0`) and the ready line says which
        self.port0 = port0
        self.port = free_port()
        self.pw = secrets.token_hex(16)
        self.env_extra = env or {}
        self.debug = debug
        self.events = []
        self.sse_path = os.path.join(RAW, name + ".sse")
        self.log_path = os.path.join(WORK, f"server-{name}.log")
        self.proc = None
        self._stop = False

    # -- lifecycle -------------------------------------------------------------------------
    def build_env(self):
        """The server's environment: no inherited OPENCODE_* variable (a stray OPENCODE_CONFIG_CONTENT or
        OPENCODE_CONFIG_DIR would bring the user's own setup back), then Writer's own, with the project
        config (`opencode.json`, `.opencode/` in the working directory) switched off. The real HOME stays so
        the login resolves; the config home is empty and recreated empty on every start."""
        env = {k: v for k, v in os.environ.items() if not k.startswith("OPENCODE_")}
        xdg = os.path.join(WORK, "xdg-config")
        shutil.rmtree(xdg, ignore_errors=True)
        os.makedirs(xdg)
        env.update(
            OPENCODE_SERVER_PASSWORD=self.pw,
            OPENCODE_CONFIG=self.cfg_path,
            OPENCODE_DISABLE_PROJECT_CONFIG="1",
            OPENCODE_DISABLE_CLAUDE_CODE="1",
            OPENCODE_DISABLE_AUTOUPDATE="1",
            XDG_CONFIG_HOME=xdg,
        )
        for k, v in self.env_extra.items():  # a scenario may override; None removes the variable
            if v is None:
                env.pop(k, None)
            else:
                env[k] = v
        return env

    def __enter__(self):
        os.makedirs(RAW, exist_ok=True)
        env = self.build_env()
        cmd = [BIN, "serve", "--hostname", "127.0.0.1", "--port", "0" if self.port0 else str(self.port)]
        assert "service" not in cmd and self.port != 4096  # never the user's background service or its port
        if self.debug:
            cmd += ["--log-level", "debug", "--print-logs"]
        log = open(self.log_path, "w")
        self.proc = subprocess.Popen(cmd, cwd=self.cwd, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:  # anything failing from here on must not leave the server running
            t = time.time()
            while time.time() - t < 60:
                if "server listening" in open(self.log_path).read():
                    if self.port0:
                        self.port = int(re.search(r"server listening on http://127\.0\.0\.1:(\d+)", open(self.log_path).read()).group(1))
                        assert self.port != 0
                    break
                if self.proc.poll() is not None:
                    raise RuntimeError("server exited: " + open(self.log_path).read()[-500:])
                time.sleep(0.2)
            else:
                raise RuntimeError("server did not start")
            threading.Thread(target=self._sse, daemon=True).start()
            time.sleep(0.5)
            code, r = self.api("GET", "/api/permission/saved", timeout=10)
            self.saved_before = {x["id"] for x in (r or {}).get("data", [])}
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *a):
        self._stop = True
        try:  # remove only what THIS run created: its sessions and the saved rules that appeared during it
            for sid in getattr(self, "created", []):
                self.api("DELETE", f"/api/session/{sid}", timeout=10)
            code, r = self.api("GET", "/api/permission/saved", timeout=10)
            for x in (r or {}).get("data", []):
                if x["id"] not in getattr(self, "saved_before", {x["id"] for x in r["data"]}):
                    self.api("DELETE", f"/api/permission/saved/{x['id']}", timeout=10)
        except Exception as e:
            print("cleanup failed", repr(e)[:80])
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
                self.proc.wait(timeout=25)
            except Exception:
                os.killpg(self.proc.pid, signal.SIGKILL)
        print("server stopped:", self.proc.poll() is not None)

    # -- http ------------------------------------------------------------------------------
    def _hdr(self):
        return {"Authorization": "Basic " + base64.b64encode(f"opencode:{self.pw}".encode()).decode()}

    def api(self, method, path, body=None, timeout=60, raw=False):
        assert not any(f in path for f in FORBIDDEN_PATHS), path
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        h = self._hdr()
        data = None
        if body is not None:
            data = json.dumps(body)
            h["content-type"] = "application/json"
        conn.request(method, path, body=data, headers=h)
        r = conn.getresponse()
        t = r.read().decode()
        conn.close()
        if raw:
            return r.status, t
        try:
            return r.status, (json.loads(t) if t else None)
        except ValueError:
            return r.status, t

    # -- sse -------------------------------------------------------------------------------
    def _sse(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3600)
        conn.request("GET", "/api/event", headers=self._hdr())
        r = conn.getresponse()
        with open(self.sse_path, "w") as f:
            while not self._stop:
                line = r.fp.readline()
                if not line:
                    break
                line = line.decode()
                f.write(line)
                f.flush()
                if line.startswith("data: "):
                    try:
                        self.events.append(json.loads(line[6:]))
                    except ValueError:
                        pass

    def wait(self, pred, timeout=120, start=0):
        t = time.time()
        while time.time() - t < timeout:
            for i, e in enumerate(list(self.events)[start:], start):
                if pred(e):
                    return e
            time.sleep(0.3)
        return None

    def types(self, sid=None, start=0):
        return [e["type"] for e in self.events[start:] if sid is None or sid in json.dumps(e)]

    # -- session helpers ---------------------------------------------------------------------
    def session(self, model=None, provider=None, agent=None, perms=None, parent=None, variant=None, extra=None):
        m = {"id": model or MODEL_ID, "providerID": provider or PROVIDER}
        if variant:
            m["variant"] = variant
        b = {"location": {"directory": self.cwd}, "model": m}
        if agent:
            b["agent"] = agent
        if perms is not None:
            b["permissions"] = perms
        if parent:
            b["parentID"] = parent
        if extra:
            b.update(extra)
        code, r = self.api("POST", "/api/session", b)
        assert code == 200, (code, r)
        self.created = getattr(self, "created", []) + [r["data"]["id"]]
        return r["data"]["id"]

    def prompt(self, sid, text, delivery=None, timeout=60, **kw):
        b = {"text": text, **kw}
        if delivery:
            b["delivery"] = delivery
        return self.api("POST", f"/api/session/{sid}/prompt", b, timeout=timeout)

    def done(self, sid, timeout=150, start=0):
        return self.wait(
            lambda e: e["type"] in ("session.execution.succeeded", "session.execution.failed", "session.execution.interrupted")
            and e.get("data", {}).get("sessionID") == sid,
            timeout,
            start,
        )

    def show(self, sid=None, start=0, width=260, skip=("plugin.updated",)):
        for e in self.events[start:]:
            if e["type"] in skip:
                continue
            if sid is None or sid in json.dumps(e):
                print(json.dumps({k: v for k, v in e.items() if k not in ("location",)})[:width])

    def brief(self, sids, start=0, width=420, skip=("session.reasoning.delta", "session.text.delta", "session.instructions.updated", "plugin.updated", "session.tool.input.delta")):
        """One line per event of the given sessions (what the scenarios print to read a run)."""
        for e in self.events[start:]:
            if e["type"] in skip or not any(x in json.dumps(e) for x in sids):
                continue
            d = e.get("data", {})
            rest = {k: v for k, v in d.items() if k not in ("sessionID", "assistantMessageID", "tokens", "native")}
            print(e["type"], str(d.get("sessionID", ""))[-5:], json.dumps(rest)[:width])

    def dump(self, name, sid):
        """Save the session's messages and its events to raw/<name>.*"""
        code, r = self.api("GET", f"/api/session/{sid}/message")
        json.dump(r, open(os.path.join(RAW, name + ".messages.json"), "w"), indent=1)
        return r

    def save_events(self, name, sids, start=0):
        keep = [e for e in self.events[start:] if any(s in json.dumps(e) for s in sids)]
        with open(os.path.join(RAW, name + ".events.jsonl"), "w") as f:
            for e in keep:
                f.write(json.dumps(e) + "\n")
        return keep

    def drive(self, sid, decide, timeout=150, on_ask=None, start=0):
        """Wait for the turn to end, answering each permission.asked with decide(event) (None: leave it)."""
        seen = set()
        t = time.time()
        while time.time() - t < timeout:
            for e in list(self.events)[start:]:
                if e["type"] == "permission.asked" and e["data"].get("sessionID") == sid:
                    rid = e["data"].get("requestID") or e["data"].get("id")
                    if rid in seen:
                        continue
                    seen.add(rid)
                    if on_ask:
                        on_ask(e)
                    d = decide(e)
                    if d:
                        code, r = self.api("POST", f"/api/session/{sid}/permission/{rid}/reply", {"decision": d})
                        print("reply", d, code, str(r)[:200])
                if e["type"] in ("session.execution.succeeded", "session.execution.failed", "session.execution.interrupted") and e["data"].get("sessionID") == sid:
                    return e
            time.sleep(0.3)
        print("TIMEOUT")
