import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, HERE, NOLOGIN_MODEL, PROVIDER

with Server("s08", cfg={}) as s:
    for label, model, prov in [("unknown model", "no-such-model-xyz", PROVIDER), ("unknown provider", "x", "no-such-provider")] + ([("provider without login", NOLOGIN_MODEL.split("/", 1)[1], NOLOGIN_MODEL.split("/", 1)[0])] if NOLOGIN_MODEL else []):
        n0 = len(s.events)
        c, r = s.api("POST", "/api/session", {"location": {"directory": s.cwd}, "model": {"id": model, "providerID": prov}})
        print("==", label, "create", c, str(r)[:300])
        if c != 200:
            continue
        sid = r["data"]["id"]; s.created = getattr(s, "created", []) + [sid]
        c, r = s.prompt(sid, "hi", timeout=40)
        print("prompt", c, str(r)[:200])
        e = s.done(sid, 40, n0)
        print("end", e and e["type"], json.dumps(e)[:400])
        for ev in s.events[n0:]:
            if sid in json.dumps(ev) and ev["type"] in ("session.step.failed", "session.execution.failed", "session.retry.scheduled", "session.execution.started") :
                print(json.dumps({k: v for k, v in ev.items() if k not in ("location", "id", "created")})[:700])
        s.save_events("s08-" + label.replace(" ", "-"), [sid], start=n0)
        s.dump("s08-" + label.replace(" ", "-"), sid)
    # provider activation field (names only, no settings/headers)
    c, r = s.api("GET", "/api/provider")
    print("providers", [(p["id"], p.get("activation")) for p in r["data"]])
    c, r = s.api("GET", "/api/model/default"); print("default", {k: v for k, v in r["data"].items() if k in ("id", "providerID", "name")})
