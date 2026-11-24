import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, HERE

CFG = {"permissions": [{"action": "edit", "resource": "*", "effect": "ask"}, {"action": "shell", "resource": "*", "effect": "ask"}]}
FILES = {"notes.md": "# Pets\n\nI have a cat named Tom.\nThe cat sleeps all day.\n"}
with Server("s02", cfg=CFG, files=FILES) as s:
    sid = s.session()
    mid = {}
    def on_ask(e):
        print("ASKED", json.dumps(e)[:900])
        code, r = s.api("GET", f"/api/session/{sid}/permission"); mid["perm"] = r; print("perm list", code, json.dumps(r)[:700])
        code, r = s.api("GET", f"/api/session/{sid}/diff"); mid["diff"] = r; print("diff mid", code, json.dumps(r)[:700])
    print(s.prompt(sid, "In notes.md replace the word cat with dog (both places), using your edit tool. Then reply 'done'.")[0])
    print(s.drive(sid, lambda e: "once", on_ask=on_ask)["type"])
    code, r = s.api("GET", f"/api/session/{sid}/diff"); print("diff after", code, json.dumps(r)[:1500])
    json.dump({"permission_list_mid": mid.get("perm"), "diff_mid": mid.get("diff"), "diff_after": r}, open(os.path.join(RAW, "s02-edit.rest.json"), "w"), indent=1)
    s.save_events("s02-edit", [sid])
    s.dump("s02-edit", sid)
    print(open(os.path.join(s.cwd, "notes.md")).read())
    keep = [e for e in s.events if sid in json.dumps(e) and "tool" in e["type"] or "permission" in e["type"]]
    for e in keep: print(json.dumps({k:v for k,v in e.items() if k!="location"})[:1200])
