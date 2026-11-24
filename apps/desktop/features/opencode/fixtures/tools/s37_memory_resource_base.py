"""Phase 3: what is the base of a RELATIVE path in a write permission's `resources`: the session's directory, or the
worktree (git root)? Three sessions, one tiny prompt each, every request rejected (nothing is written):
 1  no `.git` anywhere above, directory = the vault root
 2  a `.git` at the vault root, directory = a folder below it
 3  a `.git` at the vault root, directory = the root
Prints the action and resources of each write's permission request. Needs OC_MODEL=<provider/model>."""
import os, sys, json, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, MODEL
import importlib.util
spec = importlib.util.spec_from_file_location("h", os.path.join(os.path.dirname(os.path.abspath(__file__)), "s29_helpers.py"))
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
r, turn = h.r, h.turn
CFG = {"permissions": [r("*", "ask")], "agents": {"w": {"mode": "primary", "description": "writer", "model": MODEL, "permissions": [r("read", "allow")]}}}
PROMPT = "Use your write tool to create the file .memory/note.md containing the word hello. Then say done."
RES = {}
def asked(s, sid, n):
    return [(e["data"]["action"], e["data"]["resources"], (e["data"].get("metadata") or {}).get("files", [{}])[0].get("file")) for e in s.events[n:]
            if e["type"] == "permission.asked" and e["data"].get("sessionID") == sid]
def run(label, git, sub):
    with Server("s37" + label, cfg=CFG, files={"sub/dir/keep.txt": "x\n"}) as s:
        if git:
            subprocess.run(["git", "init", "-q", s.cwd], check=True)
        directory = os.path.join(s.cwd, sub) if sub else s.cwd
        sid = s.session(agent="w", perms=[], extra={"location": {"directory": directory}})
        n = turn(s, sid, PROMPT, decide=lambda e: "reject", timeout=70)
        # the vault root and the directory are replaced by words so the output names no path
        out = json.loads(json.dumps(asked(s, sid, n)).replace(s.cwd, "<root>"))
        RES[label] = out
        print(label, out)
        s.save_events("s37-" + label, [sid], start=n)
run("1-no-git-dir-is-root", False, None)
run("2-git-dir-below", True, "sub/dir")
run("3-git-dir-is-root", True, None)
json.dump(RES, open(os.path.join(RAW, "s37-results.json"), "w"), indent=1)
