"""R4 capture, no model call: is a client-chosen prompt `msg_` id global or per session? The same id is posted
(resume=false: admitted, never run) into two sessions, then again into the first. Writes `ids-across-sessions.json`:
status codes and, per session, the ids and texts waiting in the inbox (the ids are the fixed test id)."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW

ID = "msg_clientchosen000000000001"
with Server("s33", cfg={"permissions": [{"action": "*", "resource": "*", "effect": "ask"}]}) as s:
    a, b = s.session(), s.session()
    out = {}
    for label, sid, text in (("first-in-a", a, "text A"), ("same-id-in-b", b, "text B"), ("again-in-a", a, "text A again")):
        c, r = s.api("POST", f"/api/session/{sid}/prompt", {"id": ID, "text": text, "resume": False})
        out[label] = {"status": c, "reply": r if c != 200 else "ok"}
        print(label, c, json.dumps(r)[:300])
    for label, sid in (("inbox-a", a), ("inbox-b", b)):
        c, r = s.api("GET", f"/api/session/{sid}/inbox")
        items = [{"id": i.get("id"), "text": (i.get("payload") or {}).get("text")} for i in (r or {}).get("data", [])]
        out[label] = {"status": c, "items": items}
        print(label, c, items)
    path = os.path.join(RAW, "s33-ids-across-sessions.json")
    json.dump(out, open(path, "w"), indent=1)
    print("saved", path)
