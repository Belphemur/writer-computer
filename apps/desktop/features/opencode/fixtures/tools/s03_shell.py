import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, HERE

CFG = {"permissions": [{"action": "edit", "resource": "*", "effect": "ask"}, {"action": "shell", "resource": "*", "effect": "ask"}]}
with Server("s03", cfg=CFG, files={"a.txt": "x\n"}) as s:
    out = {}
    a = s.session()
    print(s.prompt(a, "Run the shell command `echo hello` using your shell tool and tell me its output.")[0])
    print(s.drive(a, lambda e: "reject")["type"])
    s.save_events("s03-shell-reject", [a]); s.dump("s03-shell-reject", a)
    n = len(s.events)
    b = s.session()
    print(s.prompt(b, "Run `echo one` with your shell tool, then run `echo two` with your shell tool. Then say done.")[0])
    asks = []
    print(s.drive(b, lambda e: "always", start=n)["type"])
    s.save_events("s03-shell-always", [b], start=n); s.dump("s03-shell-always", b)
    code, r = s.api("GET", "/api/permission/saved"); out["saved"] = r; print("saved", code, json.dumps(r)[:800])
    code, r = s.api("GET", "/api/permission/request"); out["pending"] = r; print("pending", code, json.dumps(r)[:300])
    json.dump(out, open(os.path.join(RAW, "s03-shell.rest.json"), "w"), indent=1)
    for e in s.events:
        if e["type"].startswith("permission") or e["type"] in ("session.tool.failed","session.shell.started","session.shell.ended"):
            print(json.dumps({k:v for k,v in e.items() if k!="location"})[:700])
    print(json.dumps(json.load(open(os.path.join(RAW, "s03-shell-reject.messages.json"))))[:2500])
