import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, HERE, MODEL

CFG = {
    "permissions": [{"action": "edit", "resource": "*", "effect": "ask"}, {"action": "shell", "resource": "*", "effect": "ask"}],
    "agents": {
        "writer-explorer": {
            "mode": "subagent",
            "description": "Read-only helper that reads notes and reports what they contain.",
            "system": "You read notes for another agent and report briefly. Never edit.",
            "model": MODEL,
            "permissions": [{"action": "edit", "resource": "*", "effect": "deny"}],
        }
    },
}
with Server("s05", cfg=CFG, files={"notes.md": "# Pets\n\nI have a cat named Tom.\n"}) as s:
    code, r = s.api("GET", "/api/agent")
    print("agents", [(a["id"], a["mode"], a.get("model")) for a in r["data"]])
    sid = s.session()
    print(s.prompt(sid, "Delegate to your writer-explorer sub-agent: have it read notes.md and report the first heading. Then tell me what it reported.")[0])
    print(s.drive(sid, lambda e: "once")["type"])
    kids = [e["data"]["sessionID"] for e in s.events if e["type"] == "session.created" and e["data"].get("parentID") == sid]
    print("children", kids)
    # the sub-agent runs in the background: wait for the child to finish and for the parent to be woken
    def ended(sess):
        return lambda e: e["type"].startswith("session.execution.") and e["type"] != "session.execution.started" and e["data"].get("sessionID") == sess
    n_first = len([e for e in s.events if ended(sid)(e)])
    print("child done:", (s.wait(ended(kids[0]), 120) or {}).get("type"))
    t0 = __import__("time").time()
    while __import__("time").time() - t0 < 90 and len([e for e in s.events if ended(sid)(e)]) <= n_first:
        for e in list(s.events):
            if e["type"] == "permission.asked": pass
        __import__("time").sleep(0.5)
    print("parent woke:", len([e for e in s.events if ended(sid)(e)]) - n_first)
    __import__("time").sleep(2)
    s.save_events("s05-subagent", [sid] + kids)
    s.dump("s05-subagent-parent", sid)
    for k in kids: s.dump("s05-subagent-child", k)
    for e in s.events:
        if any(x in json.dumps(e) for x in [sid] + kids) and e["type"] not in ("session.reasoning.delta", "session.text.delta", "session.instructions.updated"):
            print(json.dumps({k: v for k, v in e.items() if k not in ("location", "durable", "id", "created")})[:520])
