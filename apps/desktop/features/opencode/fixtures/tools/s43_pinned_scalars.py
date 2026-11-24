"""C6 (spec 4.13): which side wins for the scalars and arrays Writer pins. GLOBAL config sets `default_agent`, `model`,
`automations: true`, `share: auto`, `update: auto`, `instructions` (a file with GLOBALMARK) and `skills` (a folder with a
`g-skill`); Writer's file either says nothing (what the user's config does alone) or pins its own (`default_agent:
writer`, `model`, `automations: false`, `instructions` with WRITERMARK, `skills` with `w-skill`). Observed through
effects only: the agent of a session created with none, GET /api/model/default, the automation route, the fake model's
request (instruction marks), GET /api/skill. `share` and `update` have no observable route in the 2.4.0 contract (no
session-share route; auto-update is off by OPENCODE_DISABLE_AUTOUPDATE); `share: auto` is never exercised against a
session, nothing could be shared."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gc_helpers import *

GSK = "---\nname: g-skill\ndescription: a global skill\n---\nbody\n"
WSK = "---\nname: w-skill\ndescription: a writer skill\n---\nbody\n"

def variant(label, pin):
    srv, port, rec = fake("c6")
    gdir = os.path.join(WORK, "c6-global-extra"); wdir = os.path.join(WORK, "c6-writer-extra")
    for d, nm, sk in ((gdir, "GLOBALMARK", GSK), (wdir, "WRITERMARK", WSK)):
        os.makedirs(os.path.join(d, "skills", nm.lower()), exist_ok=True)
        open(os.path.join(d, "ins.md"), "w").write(f"Always mention {nm}.\n")
        open(os.path.join(d, "skills", nm.lower(), "SKILL.md"), "w").write(sk)
    glob = {"providers": {"fake-a": provider(port), "fake-b": provider(port, "B", "other")}, "default_agent": "g-prim", "model": "fake-a/fake-model", "automations": True, "share": "auto", "update": "auto",
            "instructions": [os.path.join(gdir, "ins.md")], "skills": [os.path.join(gdir, "skills")],
            "agents": {"g-prim": {"mode": "primary", "description": "Global primary", "system": "You are g-prim."}}}
    wcfg = writer_cfg()
    del wcfg["default_agent"]
    if pin:
        wcfg.update({"default_agent": "writer", "model": "fake-b/other", "automations": False, "share": "disabled", "update": "disable",
                     "instructions": [os.path.join(wdir, "ins.md")], "skills": [os.path.join(wdir, "skills")]})
    out = {"variant": label}
    try:
        with Server("c6", cfg=wcfg, global_config=glob) as s:
            time.sleep(1)
            c, r = s.api("POST", "/api/session", {"location": {"directory": s.cwd}, "model": {"id": "fake-model", "providerID": "fake-a"}})
            s.created = [r["data"]["id"]]
            n0 = len(s.events)
            s.prompt(r["data"]["id"], "hello")
            s.done(r["data"]["id"], 40, start=n0)
            out["agent_of_session_created_with_none"] = next((e["data"].get("agent") for e in s.events[n0:] if e["type"] == "session.step.started" and e["data"].get("sessionID") == r["data"]["id"]), None)
            out["model_default"] = s.api("GET", "/api/model/default")[1]
            if isinstance(out["model_default"], dict):
                d = out["model_default"].get("data") or {}
                out["model_default"] = {"id": d.get("id") or d.get("modelID"), "providerID": d.get("providerID")} if isinstance(d, dict) else d
            out["automation_list_http"] = s.api("GET", "/api/experimental/automation")[0]
            out["skills"] = sorted(x["name"] for x in s.api("GET", "/api/skill")[1]["data"] if x["name"] in ("g-skill", "w-skill"))
            sid = s.session(model="fake-model", provider="fake-a", agent="writer")
            turn_tools(s, sid, "hello")
            text = json.dumps([r.get("body") for r in requests(rec) if r["tools"]][-1:])
            out["automation_namespace_in_catalog"] = "tools.automation" in text
            out["instruction_marks_in_request"] = [m for m in ("GLOBALMARK", "WRITERMARK") if m in text]
    finally:
        srv.shutdown()
    print(label, "->", json.dumps(out))
    return out

R = {"question": "C6: global scalars and arrays against Writer's pins", "variants": [variant("global config alone (Writer pins nothing)", False), variant("Writer pins its scalars and arrays", True)]}
save("c6-pinned-scalars", R)
