"""12b/12c: the agent's shell sees OPENCODE_SERVER_PASSWORD (s30, 12a). Two ways to keep it from the agent:
 12b a wrapper as `SHELL` that unsets the OPENCODE_* variables before it execs the real shell: does the shell tool use $SHELL?
 12c can a same-user command read the server's environment from the process table (`ps -E`) anyway?
Only counts are printed, never a value."""
import os, sys, json, time, stat
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, WORK
import importlib.util
spec = importlib.util.spec_from_file_location("h", os.path.join(os.path.dirname(os.path.abspath(__file__)), "s29_helpers.py"))
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
r, turn = h.r, h.turn
RESULTS = {}

wrapper = os.path.join(WORK, "writer-shell")
os.makedirs(WORK, exist_ok=True)
open(wrapper, "w").write('#!/bin/sh\nunset OPENCODE_SERVER_PASSWORD OPENCODE_CONFIG XDG_CONFIG_HOME OPENCODE_DISABLE_PROJECT_CONFIG OPENCODE_DISABLE_CLAUDE_CODE OPENCODE_DISABLE_AUTOUPDATE\nexec "${WRITER_REAL_SHELL:-/bin/sh}" "$@"\n')
os.chmod(wrapper, 0o755)

COUNT = "env | grep -c -E '^(OPENCODE_SERVER_PASSWORD|OPENCODE_CONFIG|XDG_CONFIG_HOME)='"
PS = "ps -E -o command= -p $PPID | tr ' ' '\\n' | grep -c -E '^OPENCODE_SERVER_PASSWORD='"

def probe(s, text, cmd_ok):
    a = s.session(perms=[])
    seen = []
    def decide(e):
        c = " ".join(e["data"].get("resources", []))
        seen.append(c)
        return "once" if cmd_ok(c) else "reject"
    n = turn(s, a, text, decide=decide, timeout=80)
    out = ""
    for e in s.events[n:]:
        if e["type"] == "session.tool.success" and e["data"].get("sessionID") == a:
            out += json.dumps(e["data"].get("content"))
    return seen, out[:300], a, n

CFG = {"permissions": [r("*", "ask"), r("read", "allow")]}
with Server("s31b", cfg=CFG, files={"a.txt": "x\n"}, env={"SHELL": wrapper, "WRITER_REAL_SHELL": os.environ.get("SHELL", "/bin/sh")}) as s:
    seen, out, a, n = probe(s, "Run exactly this command with your shell tool and show me its output, nothing else: " + COUNT, lambda c: c.startswith("env ") and "grep -c" in c)
    RESULTS["12b wrapper as SHELL: names left in the shell's env"] = {"commands": seen, "output": out}
    print("12b", seen, out)
    s.save_events("s31b", [a], start=n)
with Server("s31c", cfg=CFG, files={"a.txt": "x\n"}) as s:
    seen, out, a, n = probe(s, "Run exactly this command with your shell tool and show me its output, nothing else: " + PS, lambda c: c.startswith("ps ") and "grep -c" in c)
    RESULTS["12c ps -E of the parent: OPENCODE_SERVER_PASSWORD count"] = {"commands": seen, "output": out}
    print("12c", seen, out)
    s.save_events("s31c", [a], start=n)
json.dump(RESULTS, open(os.path.join(RAW, "s31-results.json"), "w"), indent=1)
