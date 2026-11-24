"""Titles: does `agents.title.disabled` stop OpenCode's own `session.renamed`, and what does
`POST /api/session/{id}/generate` return? One free-model prompt plus one generate call.
Saves $OC_WORK/raw/s13-rest.json (merged into rest.json by scrub.py)."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW

CFG = {"agents": {"title": {"disabled": True}}}
with Server("s13", cfg=CFG) as s:
    sid = s.session()
    n0 = len(s.events)
    s.prompt(sid, "Reply with the single word: ready.")
    s.done(sid, 120, n0)
    time.sleep(3)
    renamed = [e for e in s.events[n0:] if e["type"] == "session.renamed"]
    c, info = s.api("GET", f"/api/session/{sid}")
    print("session.renamed events:", len(renamed), "| title:", info["data"].get("title"), "| cost:", info["data"].get("cost"))
    t0 = time.time()
    c, r = s.api("POST", f"/api/session/{sid}/generate", {"prompt": "Give a title of at most 4 words for this chat. Reply with the title only."}, timeout=90)
    print("generate", c, round(time.time() - t0, 1), "s", json.dumps(r)[:300])
    c2, info2 = s.api("GET", f"/api/session/{sid}")
    print("cost after generate:", info2["data"].get("cost"), "tokens:", info2["data"].get("tokens"))
    print("events after generate:", sorted({e["type"] for e in s.events[n0:] if sid in json.dumps(e)} - {"session.reasoning.delta", "session.text.delta"}))
    json.dump({"generate": {"method": "POST", "path": f"/api/session/{sid}/generate", "status": c, "body": r}}, open(os.path.join(RAW, "s13-rest.json"), "w"), indent=1)
