"""P2 capture: `reply.message` of a reject (does the model see it) and whether one reject rejects every pending
request of the session (two `echo` commands in one step)."""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW

CFG = {"permissions": [{"action": "*", "resource": "*", "effect": "ask"}]}
with Server("s21", cfg=CFG) as s:
    a = s.session()
    n = len(s.events)
    print(s.prompt(a, "Run `echo one` with your shell tool and `echo two` with your shell tool, both in the same step. Then say what happened.")[0])
    e = s.wait(lambda e: e["type"] == "permission.asked", 60, n)
    time.sleep(2)
    print("pending", json.dumps(s.api("GET", f"/api/session/{a}/permission")[1])[:600])
    rid = e["data"]["id"]
    c, r = s.api("POST", f"/api/session/{a}/permission/{rid}/reply", {"decision": "reject", "message": "Writer says: ask the user in plain words first"})
    print("reject", c, r)
    end = s.done(a, 90, n)
    print("end", end and end["type"], json.dumps((end or {}).get("data"))[:300])
    time.sleep(1)
    s.brief([a], start=n, width=400, skip=("session.reasoning.delta", "session.text.delta", "session.instructions.updated", "session.tool.input.delta", "session.step.streamed", "session.step.first-token", "session.usage.updated", "session.reasoning.started", "session.reasoning.ended"))
    s.save_events("s21-reject", [a], start=n); s.dump("s21-reject", a)
    print("pending after", json.dumps(s.api("GET", f"/api/session/{a}/permission")[1])[:300])
    # does the turn continue with a follow-up prompt?
    n2 = len(s.events)
    print(s.prompt(a, "Reply with the word: ok")[0]); print(s.done(a, 60, n2)["type"])
