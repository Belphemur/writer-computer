"""Helpers shared by k01 and k02 (spec native-agent-spec 7.1: captures of Claude's MCP list and --disallowedTools).
Standard library only, run with `python3 -I`.

Safety, applied here and nowhere optional: the real `claude` runs only in a fresh folder under K_WORK (refused inside a git
checkout), with HOME and CLAUDE_CONFIG_DIR both inside K_WORK (so neither `~/.claude` nor `~/.claude.json` can be read),
a dummy API key, and ANTHROPIC_BASE_URL on the local fake model (`shared/capture/fake_model.py`): no real model call, no
login, no network but 127.0.0.1. MCP servers are `mcp_server.cjs` (the OpenCode tools' trivial server) with a marker file.
Results are small fact files; `save()` scrubs them and writes `$K_WORK/raw/k-<name>.json` and, with K_FIXTURES set,
`<K_FIXTURES>/k-<name>.json`."""
import getpass, json, os, re, shutil, socket, subprocess, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
DESKTOP = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", ".."))
sys.path.insert(0, os.path.join(DESKTOP, "shared", "capture"))
import fake_model  # noqa: E402

SRV = os.path.join(DESKTOP, "features", "opencode", "fixtures", "tools", "mcp_server.cjs")
NODE = shutil.which("node") or "node"
BIN = os.environ.get("CLAUDE_BIN") or "claude"


def _inside_git(path):
    p = os.path.abspath(path)
    while True:
        if os.path.exists(os.path.join(p, ".git")):
            return True
        if os.path.dirname(p) == p:
            return False
        p = os.path.dirname(p)


WORK = os.path.abspath(os.environ.get("K_WORK") or tempfile.mkdtemp(prefix="k-work-"))
if _inside_git(WORK):
    sys.exit(f"refusing K_WORK inside a git checkout: {WORK}")
os.makedirs(WORK, exist_ok=True)
RAW = os.path.join(WORK, "raw")
FIX = os.environ.get("K_FIXTURES") or ""


def fresh(name):
    """A fresh run folder: cwd, HOME and CLAUDE_CONFIG_DIR, all inside WORK."""
    root = os.path.join(WORK, name)
    shutil.rmtree(root, ignore_errors=True)
    d = {k: os.path.join(root, k) for k in ("cwd", "home", "cfg")}
    for p in d.values():
        os.makedirs(p)
    d["root"] = root
    return d


def env(d, base_url=None):
    """No inherited ANTHROPIC_*/CLAUDE_* variable (a stray token or config dir would bring the user's setup back)."""
    e = {k: v for k, v in os.environ.items() if not (k.startswith("ANTHROPIC_") or k.startswith("CLAUDE_") or k in ("AWS_PROFILE",))}
    e.update(HOME=d["home"], CLAUDE_CONFIG_DIR=d["cfg"], ANTHROPIC_API_KEY="dummy-key-not-real", DISABLE_TELEMETRY="1", DISABLE_AUTOUPDATER="1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1")
    if base_url:
        e["ANTHROPIC_BASE_URL"] = base_url
    return e


def write_user_servers(d, servers):
    """Hand-write the synthetic user config of the temp CLAUDE_CONFIG_DIR (`claude mcp add` refuses names with a dot, a space or a colon)."""
    json.dump({"mcpServers": servers}, open(os.path.join(d["cfg"], ".claude.json"), "w"))


def stdio(name, marker=None, fail=False):
    if fail:
        return {"command": NODE, "args": ["-e", "process.exit(1)"]}
    args = [SRV, "--name", name] + (["--marker", marker] if marker else [])
    return {"command": NODE, "args": args}


def run(args, d, base_url=None, timeout=120):
    t = time.time()
    p = subprocess.run([BIN] + args, cwd=d["cwd"], env=env(d, base_url), capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    return p, round(time.time() - t, 2)


def requests(rec):
    return [json.loads(l) for l in open(rec).read().splitlines() if l.strip()] if os.path.exists(rec) else []


def marks(path):
    return [json.loads(l) for l in open(path).read().splitlines() if l.strip()] if os.path.exists(path) else []


_ID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")


def scrub_text(t):
    for v, w in ((WORK, "<work>"), (os.path.realpath(WORK), "<work>"), (DESKTOP, "<repo>"), (os.path.realpath(DESKTOP), "<repo>"), (os.path.expanduser("~"), "<home>"), (getpass.getuser(), "<user>"), (socket.gethostname(), "<host>"), (socket.gethostname().split(".")[0], "<host>")):
        if v and len(v) > 2:
            t = t.replace(v, w)
    t = re.sub(r"127\.0\.0\.1:\d+", "127.0.0.1:0", t)
    t = _ID.sub("<uuid>", t)
    t = re.sub(r"/private/var/folders/[^\"' ]+|/var/folders/[^\"' ]+", "<tmp>", t)
    t = t.replace("@", "\\u0040")
    for a, b in (("credential", "cred"), ("Authorization", "Auth"), ("authorization", "auth"), ("apikey", "key"), ("bearer", "token")):
        t = t.replace(a, b)
    return t


def save(name, obj):
    t = scrub_text(json.dumps(obj, indent=1))
    for bad in (getpass.getuser(), os.path.expanduser("~"), WORK, socket.gethostname()):
        if bad and len(bad) > 2 and bad in t:
            sys.exit(f"scrub left {bad!r} in {name}")
    os.makedirs(RAW, exist_ok=True)
    open(os.path.join(RAW, f"k-{name}.json"), "w").write(t + "\n")
    if FIX:
        os.makedirs(FIX, exist_ok=True)
        open(os.path.join(FIX, f"k-{name}.json"), "w").write(t + "\n")
    print("saved", name)
