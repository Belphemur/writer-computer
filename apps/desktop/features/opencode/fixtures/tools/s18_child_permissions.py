"""P2 capture: does a sub-agent inherit the session-level ruleset, and config against session precedence.

Config: everything asks, and a `writer-worker` sub-agent (no rules of its own). The session allows `edit`.
 (1) the main agent edits a.txt: does it ask? (a session `allow` against the config `ask`)
 (2) the main agent has writer-worker edit b.txt: does the CHILD ask? (inheritance of the session ruleset)
Shell is rejected whenever it is asked, never allowed."""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, MODEL

CFG = {
    "permissions": [{"action": "*", "resource": "*", "effect": "ask"}],
    "agents": {"writer-worker": {"mode": "subagent", "description": "Makes small edits to notes on request.", "system": "You edit notes as asked, briefly.", "model": MODEL}},
}
SESSION_RULES = [{"action": "*", "resource": "*", "effect": "ask"}, {"action": "read", "resource": "*", "effect": "allow"}, {"action": "edit", "resource": "*", "effect": "allow"}, {"action": "subagent", "resource": "*", "effect": "allow"}]

def decide(e):
    return "reject" if e["data"]["action"] == "shell" else "once"

with Server("s18", cfg=CFG, files={"a.txt": "alpha\n", "b.txt": "beta\n"}) as s:
    a = s.session(perms=SESSION_RULES)
    n = len(s.events)
    print(s.prompt(a, "Use your edit tool to replace alpha by gamma in a.txt. Then say done.")[0])
    print(s.drive(a, decide, timeout=100, start=n)["type"])
    s.brief([a], start=n, width=300, skip=("session.reasoning.delta", "session.text.delta", "session.instructions.updated", "session.tool.input.delta", "session.step.started", "session.step.ended", "session.step.streamed", "session.step.first-token", "session.usage.updated", "session.reasoning.started", "session.reasoning.ended"))
    s.save_events("s18-parent-edit", [a], start=n)
    b = s.session(perms=SESSION_RULES)
    n = len(s.events)
    print(s.prompt(b, "Delegate to your writer-worker sub-agent: have it use its edit tool to replace beta by delta in b.txt. Then wait for its report and tell me what it said.")[0])
    asked = []
    def decide2(e):
        asked.append((e["data"]["sessionID"][-5:], e["data"]["action"])); return decide(e)
    s.drive(b, decide2, timeout=60, start=n)
    kids = [e["data"]["sessionID"] for e in s.events[n:] if e["type"] == "session.created" and e["data"].get("parentID") == b]
    print("children", kids)
    end = lambda sess: (lambda e: e["type"].startswith("session.execution.") and e["type"] != "session.execution.started" and e["data"].get("sessionID") == sess)
    t0 = time.time()
    while kids and time.time() - t0 < 100 and not any(end(kids[0])(e) for e in s.events[n:]):
        for e in list(s.events)[n:]:
            if e["type"] == "permission.asked" and e["data"]["sessionID"] in kids and e["data"]["id"] not in [x for x in asked]:
                rid = e["data"]["id"]; asked.append(rid)
                print("CHILD ASKED", json.dumps(e["data"])[:400])
                s.api("POST", f"/api/session/{e['data']['sessionID']}/permission/{rid}/reply", {"decision": decide(e)})
        time.sleep(0.4)
    time.sleep(4)
    print("asked", asked)
    print("b.txt:", open(os.path.join(s.cwd, "b.txt")).read().strip())
    s.brief([b] + kids, start=n, width=300, skip=("session.reasoning.delta", "session.text.delta", "session.instructions.updated", "session.tool.input.delta", "session.step.started", "session.step.ended", "session.step.streamed", "session.step.first-token", "session.usage.updated", "session.reasoning.started", "session.reasoning.ended"))
    s.save_events("s18-child-edit", [b] + kids, start=n)
    for k in kids:
        print("child session", json.dumps(s.api("GET", f"/api/session/{k}")[1])[:600])
