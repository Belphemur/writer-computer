"""Phase 3: the config shape Writer writes, with a real model (a tiny prompt each, the cheapest included model).
 a  top-level `*: ask` + a primary agent whose list only allows reads: is a read quiet and an edit asked?
 b  one list `[*: ask, edit: deny]`: does the later rule win (the edit never asked) or the first (asked)?
 c  a role-shaped list `[*: deny, read: allow]`: does the read go through?
Only what each session's tool calls came to is printed. Needs OC_MODEL=<provider/model>."""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, MODEL
import importlib.util
spec = importlib.util.spec_from_file_location("h", os.path.join(os.path.dirname(os.path.abspath(__file__)), "s29_helpers.py"))
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
r, turn, outcome, read = h.r, h.turn, h.outcome, h.read
ASK_EDIT = "First read a.txt with your read tool, then use your edit tool to replace alpha by gamma in a.txt. Then say done."
CFG = {"permissions": [r("*", "ask")],
       "agents": {"w": {"mode": "primary", "description": "reads allowed", "model": MODEL, "permissions": [r("read", "allow"), r("glob", "allow"), r("grep", "allow")]},
                  "w-order": {"mode": "primary", "description": "ask then deny edit in one list", "model": MODEL, "permissions": [r("*", "ask"), r("edit", "deny")]},
                  "w-role": {"mode": "primary", "description": "deny then allow read", "model": MODEL, "permissions": [r("*", "deny"), r("read", "allow")]}}}
def reject_all(e):
    return "reject"
RES = {}
with Server("s36", cfg=CFG, files={"a.txt": "alpha\n"}) as s:
    for agent, text in (("w", ASK_EDIT), ("w-order", "Use your edit tool (try it) to replace alpha by gamma in a.txt. Then say done."), ("w-role", "Read a.txt with your read tool and tell me what it says.")):
        sid = s.session(agent=agent, perms=[])
        n = turn(s, sid, text, decide=reject_all, timeout=70)
        RES[agent] = outcome(s, [sid], n, agent)
        RES[agent]["a.txt"] = read(s, "a.txt")
        s.save_events("s36-" + agent, [sid], start=n)
json.dump(RES, open(os.path.join(RAW, "s36-results.json"), "w"), indent=1)
print(json.dumps(RES, indent=1))
