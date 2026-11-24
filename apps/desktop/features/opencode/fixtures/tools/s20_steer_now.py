"""P2 capture: "steer now" (steer, then interrupt with resume=true): does the steer run right after the cut?
Only `sleep` runs without asking; every other shell command is rejected."""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW

CFG = {"permissions": [{"action": "*", "resource": "*", "effect": "ask"}, {"action": "shell", "resource": "sleep *", "effect": "allow"}]}
with Server("s20", cfg=CFG) as s:
    a = s.session()
    n = len(s.events)
    print(s.prompt(a, "Run the shell command `sleep 20` with your shell tool, then reply with the single word: done.")[0])
    s.wait(lambda e: e["type"] == "session.tool.called" and e["data"]["sessionID"] == a, 60, n)
    time.sleep(1)
    c, r = s.prompt(a, "NEW INSTRUCTION: forget the command, just reply with the single word: pivot.", delivery="steer")
    print("steer", c, json.dumps(r)[:200])
    c, r = s.api("POST", f"/api/session/{a}/interrupt?resume=true"); print("interrupt resume", c, r)
    t0 = time.time()
    while time.time() - t0 < 60:
        ends = [e for e in s.events[n:] if e["type"].startswith("session.execution.") and e["data"].get("sessionID") == a and e["type"] != "session.execution.started"]
        if any(e["type"] == "session.execution.succeeded" for e in ends):
            break
        time.sleep(0.5)
    time.sleep(2)
    s.brief([a], start=n, width=300, skip=("session.reasoning.delta", "session.text.delta", "session.instructions.updated", "session.tool.input.delta", "session.step.streamed", "session.step.first-token", "session.usage.updated", "session.reasoning.started", "session.reasoning.ended"))
    s.save_events("s20-steer-now", [a], start=n); s.dump("s20-steer-now", a)
    print("inbox", s.api("GET", f"/api/session/{a}/inbox")[1])
