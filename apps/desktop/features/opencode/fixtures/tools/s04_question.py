import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, HERE

CFG = {"permissions": [{"action": "edit", "resource": "*", "effect": "ask"}, {"action": "shell", "resource": "*", "effect": "ask"}]}
with Server("s04", cfg=CFG) as s:
    sid = s.session()
    print(s.prompt(sid, "Use your question tool to ask me which fruit I prefer: apple or pear (give both as options, one with a description). Then tell me what I answered.")[0])
    e = s.wait(lambda e: e["type"] == "form.created", 90)
    print("FORM", json.dumps(e)[:2500])
    if e:
        form = e["data"]["form"]; fid = form["id"]
        code, r = s.api("GET", f"/api/session/{sid}/form"); print("list", code, json.dumps(r)[:1500])
        code, r = s.api("GET", f"/api/session/{sid}/form/{fid}"); print("get", code, json.dumps(r)[:1500])
        fields = form["fields"]
        print("fields", json.dumps(fields)[:1200])
        key = fields[0]["key"] if fields else "answer"
        code, r = s.api("POST", f"/api/session/{sid}/form/{fid}/reply", {"answer": {key: "pear"}}); print("reply", code, r)
    print(s.done(sid)["type"])
    s.show(sid, width=500)
    s.save_events("s04-question", [sid]); s.dump("s04-question", sid)
    print(json.dumps(json.load(open(os.path.join(RAW, "s04-question.messages.json"))))[:3000])
