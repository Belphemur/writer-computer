"""P2 capture: a sub-agent whose model fails (no route) and how the parent hears it."""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW

CFG = {
    "permissions": [{"action": "*", "resource": "*", "effect": "ask"}, {"action": "read", "resource": "*", "effect": "allow"}, {"action": "subagent", "resource": "*", "effect": "allow"}],
    "agents": {"writer-broken": {"mode": "subagent", "description": "A helper whose model is not available.", "system": "You help.", "model": "fakeprovider/fakemodel"}},
}
with Server("s19", cfg=CFG, files={"notes.md": "# Pets\n"}) as s:
    a = s.session()
    n = len(s.events)
    print(s.prompt(a, "Delegate to your writer-broken sub-agent: have it read notes.md. Then tell me what happened.")[0])
    s.drive(a, lambda e: "reject" if e["data"]["action"] == "shell" else "once", timeout=60, start=n)
    kids = [e["data"]["sessionID"] for e in s.events[n:] if e["type"] == "session.created" and e["data"].get("parentID") == a]
    print("children", kids)
    t0 = time.time()
    end = lambda sess: (lambda e: e["type"].startswith("session.execution.") and e["type"] != "session.execution.started" and e["data"].get("sessionID") == sess)
    first = len([e for e in s.events if end(a)(e)])
    while time.time() - t0 < 60 and len([e for e in s.events if end(a)(e)]) <= first:
        time.sleep(0.5)
    time.sleep(3)
    s.brief([a] + kids, start=n, width=700, skip=("session.reasoning.delta", "session.text.delta", "session.instructions.updated", "session.tool.input.delta", "session.step.streamed", "session.step.first-token", "session.usage.updated", "session.reasoning.started", "session.reasoning.ended"))
    s.save_events("s19-subagent-failed", [a] + kids, start=n)
    s.dump("s19-subagent-failed-parent", a)
