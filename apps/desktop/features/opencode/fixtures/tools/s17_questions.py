"""P2 capture: a multi-select question, and a skipped one (does the agent receive the message?)."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW

CFG = {"permissions": [{"action": "*", "resource": "*", "effect": "ask"}, {"action": "question", "resource": "*", "effect": "allow"}]}
with Server("s17", cfg=CFG) as s:
    a = s.session()
    n = len(s.events)
    print(s.prompt(a, "Use your question tool to ask me which fruits I like: allow several answers (multiple choice), options apple, pear, plum. Then tell me exactly what I answered.")[0])
    e = s.wait(lambda e: e["type"] == "form.created", 90, n)
    print("FORM", json.dumps(e["data"]["form"])[:1800] if e else None)
    if e:
        form = e["data"]["form"]
        key = form["fields"][0]["key"]
        c, r = s.api("POST", f"/api/session/{a}/form/{form['id']}/reply", {"answer": {key: ["apple", "plum"]}})
        print("reply array", c, r)
        if c >= 400:
            c, r = s.api("POST", f"/api/session/{a}/form/{form['id']}/reply", {"answer": {key: "apple, plum"}}); print("reply string", c, r)
    print(s.done(a, 100, n)["type"])
    s.brief([a], start=n, width=700)
    s.save_events("s17-multi", [a], start=n); s.dump("s17-multi", a)
    b = s.session()
    n = len(s.events)
    print(s.prompt(b, "Use your question tool to ask me whether to use tabs or spaces (options tabs, spaces). Then tell me exactly what the tool returned to you.")[0])
    e = s.wait(lambda e: e["type"] == "form.created", 90, n)
    if e:
        fid = e["data"]["form"]["id"]
        c, r = s.api("DELETE", f"/api/session/{b}/form/{fid}?message=" + "The+user+prefers+not+to+answer", raw=True); print("skip", c, r)
    print(s.done(b, 100, n)["type"])
    s.brief([b], start=n, width=700)
    s.save_events("s17-skip", [b], start=n); s.dump("s17-skip", b)
