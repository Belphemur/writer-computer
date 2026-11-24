"""Helpers shared by the s29/s30 permission-model captures."""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, MODEL

QUIET = ("session.reasoning.delta", "session.text.delta", "session.instructions.updated", "session.tool.input.delta", "session.step.started", "session.step.ended", "session.step.streamed", "session.step.first-token", "session.usage.updated", "session.reasoning.started", "session.reasoning.ended", "session.inbox.enqueued", "session.inbox.delivered")
READS = [{"action": "read", "resource": "*", "effect": "allow"}, {"action": "glob", "resource": "*", "effect": "allow"}, {"action": "grep", "resource": "*", "effect": "allow"}, {"action": "subagent", "resource": "*", "effect": "allow"}]
RESULTS = {}

def r(action, effect, resource="*"):
    return {"action": action, "resource": resource, "effect": effect}

def outcome(s, sids, n, label):
    """What each session's tool calls came to: asked actions, tool results, in order."""
    asked, tools = [], []
    calls = {}
    for e in s.events[n:]:
        d = e.get("data", {})
        if d.get("sessionID") not in sids:
            continue
        t = e["type"]
        if t == "session.tool.input.started":
            calls[d["id"]] = d["name"]
        elif t == "permission.asked":
            asked.append((d["sessionID"][-4:], d["action"]))
        elif t == "session.tool.success":
            tools.append((d["sessionID"][-4:], calls.get(d["id"]), "ok"))
        elif t == "session.tool.failed":
            tools.append((d["sessionID"][-4:], calls.get(d["id"]), "failed:" + d["error"]["type"]))
    print("OUTCOME", label, "asked", asked, "tools", tools)
    return {"asked": asked, "tools": tools}

def wait_children(s, parent, n, timeout=80, answer=None):
    t0 = time.time(); answered = set()
    kids = []
    while time.time() - t0 < timeout:
        kids = [e["data"]["sessionID"] for e in s.events[n:] if e["type"] == "session.created" and e["data"].get("parentID") == parent]
        for e in list(s.events)[n:]:
            if e["type"] == "permission.asked" and e["data"]["sessionID"] in kids and e["data"]["id"] not in answered:
                answered.add(e["data"]["id"])
                s.api("POST", f"/api/session/{e['data']['sessionID']}/permission/{e['data']['id']}/reply", {"decision": "reject" if e["data"]["action"] == "shell" else "once", "message": "no"})
        if kids and any(x["type"].startswith("session.execution.") and x["type"] != "session.execution.started" and x["data"].get("sessionID") == kids[0] for x in s.events[n:]):
            break
        time.sleep(0.4)
    time.sleep(3)
    return kids

def decide_once(e):
    return "reject" if e["data"]["action"] == "shell" else "once"

def turn(s, sid, text, decide=decide_once, timeout=70):
    n = len(s.events)
    print(s.prompt(sid, text)[0])
    s.drive(sid, decide, timeout=timeout, start=n)
    time.sleep(2)
    return n

EDIT_A = "Use your edit tool to replace alpha by gamma in a.txt. Then say done."
DELEGATE = "Delegate to your {agent} sub-agent: have it use its edit tool (it must try) to replace beta by delta in b.txt. Then tell me what it reported."
def read(s, f):
    return open(os.path.join(s.cwd, f)).read().strip()

EXPLORER = {"mode": "subagent", "description": "Read-only helper.", "system": "You read notes for another agent. Never edit.", "model": MODEL, "permissions": [r("edit", "deny")]}

