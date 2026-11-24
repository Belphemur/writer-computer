import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, HERE

CFG = {"permissions": [{"action": "edit", "resource": "*", "effect": "ask"}, {"action": "shell", "resource": "*", "effect": "ask"}]}
with Server("s01", cfg=CFG) as s:
    sid = s.session()
    print(s.prompt(sid, "What is 17*23? Think it through briefly, then answer in one short sentence."))
    print(s.done(sid)["type"])
    s.show(sid, width=420)
    s.save_events("s01-text", [sid])
    m = s.dump("s01-text", sid)
    print(json.dumps(m)[:3000])
    print(s.api("GET", f"/api/session/{sid}")[1])
