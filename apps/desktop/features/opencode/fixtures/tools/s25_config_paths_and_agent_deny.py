"""P2 capture: an agent-level `deny` against a session-level `allow` (a read-only role under acceptEdits): does the
child's edit run? The session also allows read, glob and grep (inherited by the child), so only the edit decides."""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, MODEL

CFG_B = {
    "permissions": [{"action": "*", "resource": "*", "effect": "ask"}],
    "agents": {"writer-explorer": {"mode": "subagent", "description": "Read-only helper.", "system": "You read notes for another agent. Never edit.", "model": MODEL,
                                   "permissions": [{"action": "edit", "resource": "*", "effect": "deny"}]}},
}
SESSION_RULES = [{"action": "*", "resource": "*", "effect": "ask"}, {"action": "read", "resource": "*", "effect": "allow"}, {"action": "glob", "resource": "*", "effect": "allow"}, {"action": "grep", "resource": "*", "effect": "allow"}, {"action": "edit", "resource": "*", "effect": "allow"}, {"action": "subagent", "resource": "*", "effect": "allow"}]
with Server("s25b", cfg=CFG_B, files={"b.txt": "beta\n"}) as s:
    b = s.session(perms=SESSION_RULES)
    n = len(s.events)
    print(s.prompt(b, "Delegate to your writer-explorer sub-agent: have it use its edit tool (it must try) to replace beta by delta in b.txt. Then tell me what it reported.")[0])
    s.drive(b, lambda e: "reject" if e["data"]["action"] == "shell" else "once", timeout=40, start=n)
    kids = [e["data"]["sessionID"] for e in s.events[n:] if e["type"] == "session.created" and e["data"].get("parentID") == b]
    end = lambda sess: (lambda e: e["type"].startswith("session.execution.") and e["type"] != "session.execution.started" and e["data"].get("sessionID") == sess)
    t0 = time.time()
    answered = set()
    while kids and time.time() - t0 < 80 and not any(end(kids[0])(e) for e in s.events[n:]):
        for e in list(s.events)[n:]:
            if e["type"] == "permission.asked" and e["data"]["sessionID"] in kids and e["data"]["id"] not in answered:
                answered.add(e["data"]["id"]); print("CHILD ASKED", e["data"]["action"], e["data"]["resources"])
                s.api("POST", f"/api/session/{e['data']['sessionID']}/permission/{e['data']['id']}/reply", {"decision": "reject" if e["data"]["action"] == "shell" else "once", "message": "no"})
        time.sleep(0.4)
    time.sleep(3)
    print("b.txt:", open(os.path.join(s.cwd, "b.txt")).read().strip())
    s.brief(kids, start=n, width=380, skip=("session.reasoning.delta", "session.text.delta", "session.instructions.updated", "session.tool.input.delta", "session.step.started", "session.step.ended", "session.step.streamed", "session.step.first-token", "session.usage.updated", "session.reasoning.started", "session.reasoning.ended"))
