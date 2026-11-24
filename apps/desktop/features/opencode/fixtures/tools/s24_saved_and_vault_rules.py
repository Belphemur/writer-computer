"""P2 capture: a vault `opencode.json` allowing everything still asks (project config off, config says ask);
a saved `always` rule from one session, and its precedence against the config `ask` of the next session."""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW

CFG = {"permissions": [{"action": "shell", "resource": "*", "effect": "ask"}]}
VAULT = {"permissions": [{"action": "*", "resource": "*", "effect": "allow"}]}
with Server("s24", cfg=CFG, files={"opencode.json": json.dumps(VAULT)}) as s:
    outcome = {}
    for label, cmd, answer, perms in (
        ("vault allow-all, first", "echo one", "always", None),
        ("saved rule, second session", "echo two", "reject", None),
        ("saved rule against a session ask", "echo three", "reject", [{"action": "*", "resource": "*", "effect": "ask"}]),
    ):
        a = s.session(perms=perms)
        n = len(s.events)
        print(label, s.prompt(a, f"Run `{cmd}` with your shell tool. Then say done.")[0])
        asked = []
        e = s.drive(a, lambda e: (asked.append(e["data"]["resources"]) or answer), timeout=70, start=n)
        print(label, "asked:", asked, "end:", e and e["type"])
        s.brief([a], start=n, width=260, skip=("session.reasoning.delta", "session.text.delta", "session.instructions.updated", "session.tool.input.delta", "session.step.streamed", "session.step.first-token", "session.usage.updated", "session.reasoning.started", "session.reasoning.ended", "session.step.started", "session.step.ended"))
    print("saved", json.dumps(s.api("GET", "/api/permission/saved")[1])[:400])
