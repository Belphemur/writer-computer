"""Plan mode as session-level DENIES (spec 10.9): do they hold against a saved `always` rule (13g) and against a
child whose own agent ALLOWS edit (13h)? Free model, one small prompt each; the saved rule is synthetic, in the temp
project only, and removed by the server wrapper's cleanup."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, MODEL
import importlib.util
spec = importlib.util.spec_from_file_location("h", os.path.join(os.path.dirname(os.path.abspath(__file__)), "s29_helpers.py"))
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
r, turn, outcome, wait_children, read = h.r, h.turn, h.outcome, h.wait_children, h.read
EDIT = "Use your edit tool, not shell, to replace alpha by gamma in a.txt. Then say done."
RESULTS = {}

CFG = {"permissions": [r("*", "ask"), r("read", "allow"), r("glob", "allow"), r("grep", "allow")]}
with Server("s32g", cfg=CFG, files={"a.txt": "alpha\n"}) as s:
    a = s.session(perms=[])
    n = turn(s, a, EDIT, decide=lambda e: "always" if e["data"]["action"] == "edit" else h.decide_once(e))
    RESULTS["13g-save"] = {"a.txt": read(s, "a.txt"), **outcome(s, [a], n, "13g saving the rule")}
    open(os.path.join(s.cwd, "a.txt"), "w").write("alpha\n")
    d = s.session(perms=[r("edit", "deny")])
    n = turn(s, d, EDIT)
    RESULTS["13g-plan-deny-vs-saved"] = {"a.txt": read(s, "a.txt"), **outcome(s, [d], n, "13g session deny vs the saved always rule")}
    s.save_events("s32g", [a, d], start=0)

CFG_H = {"permissions": [r("*", "ask"), r("read", "allow"), r("glob", "allow"), r("grep", "allow")],
         "agents": {"kid-allow": {"mode": "subagent", "description": "child whose own agent allows edit", "system": "You edit notes as asked.", "model": MODEL, "permissions": [r("edit", "allow")]}}}
with Server("s32h", cfg=CFG_H, files={"b.txt": "beta\n"}) as s:
    b = s.session(perms=[r("edit", "deny"), r("subagent", "allow")])
    n = turn(s, b, h.DELEGATE.format(agent="kid-allow"), timeout=50)
    kids = wait_children(s, b, n)
    RESULTS["13h-session-deny-vs-child-agent-allow"] = {"children": len(kids), "b.txt": read(s, "b.txt"), **outcome(s, [b] + kids, n, "13h")}
    s.save_events("s32h", [b] + kids, start=n)
json.dump(RESULTS, open(os.path.join(RAW, "s32-results.json"), "w"), indent=1)
print("RESULTS", json.dumps(RESULTS, indent=1)[:3000])
