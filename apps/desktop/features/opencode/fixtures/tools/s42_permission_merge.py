"""C5 (spec 4.13): how GLOBAL permissions combine with Writer's. The synthetic global config carries top-level
`permissions` and (in one variant) a global agent with Writer's own id `writer`; Writer's file has `permissions: [*: ask]`
and a `writer` agent. Per variant: the resolved ruleset GET /api/agent returns for `writer` (order kept), and what a
scripted `edit` call from the fake model does (asked or run), proving the effective form, not the listing."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gc_helpers import *

def R_(a, e, r="*"): return {"action": a, "resource": r, "effect": e}
EDIT = {"path": "a.txt", "oldString": "alpha", "newString": "gamma"}

def variant(label, glob_extra, writer_perms=None, writer_agent_perms=None, global_agents=None):
    srv, port, rec = fake("c5", call="edit", args=EDIT, reply="done")
    glob = {"providers": {"fake-a": provider(port)}, **glob_extra}
    if global_agents:
        glob["agents"] = global_agents
    wcfg = writer_cfg(perms=writer_perms)
    if writer_agent_perms is not None:
        wcfg["agents"]["writer"]["permissions"] = writer_agent_perms
    out = {"variant": label, "global": {k: v for k, v in glob_extra.items()}, "global_agents": global_agents, "writer_permissions": wcfg["permissions"], "writer_agent_permissions": wcfg["agents"]["writer"]["permissions"]}
    try:
        with Server("c5", cfg=wcfg, global_config=glob, files={"a.txt": "alpha\n"}) as s:
            time.sleep(1)
            c, r = s.api("GET", "/api/agent/writer")
            if c != 200:
                c, r = s.api("GET", "/api/agent")
                ag = next((a for a in r["data"] if a["id"] == "writer"), None) if c == 200 else None
            else:
                ag = r.get("data", r)
            out["resolved_writer_permissions"] = [f'{x["action"]}:{x["resource"]}:{x["effect"]}' for x in (ag or {}).get("permissions", [])]
            sid = s.session(model="fake-model", provider="fake-a", agent="writer", perms=[])
            n = len(s.events)
            s.prompt(sid, "Edit a.txt.")
            asked = []
            def decide(e):
                asked.append(e["data"]["action"])
                return "reject"
            end = s.drive(sid, decide, timeout=40, start=n)
            time.sleep(1)
            out["edit_asked"] = "edit" in asked
            out["asked_actions"] = asked
            out["a.txt_after"] = open(os.path.join(s.cwd, "a.txt")).read().strip()
            out["turn"] = end["type"] if end else "timeout"
    finally:
        srv.shutdown()
    print(label, "->", json.dumps({k: out[k] for k in ("resolved_writer_permissions", "edit_asked", "a.txt_after")}))
    return out

GP = {"permissions": [R_("edit", "allow"), R_("shell", "allow")]}
R = {"question": "C5: how do global permissions combine with Writer's?", "variants": [
    variant("V0 no global permissions", {}),
    variant("V1 global permissions [edit allow, shell allow]", GP),
    variant("V2 global permissions as V1 + global agent `writer` permissions [edit allow]", GP, global_agents={"writer": {"mode": "primary", "description": "global writer", "permissions": [R_("edit", "allow")]}}),
    variant("V3 as V1, Writer's agent list starts with *:ask", GP, writer_agent_perms=[R_("*", "ask"), R_("read", "allow")]),
    variant("V6 as V2, but Writer's agent list starts with *:ask (the design's form)", GP, writer_agent_perms=[R_("*", "ask"), R_("read", "allow")], global_agents={"writer": {"mode": "primary", "description": "global writer", "permissions": [R_("edit", "allow")]}}),
    variant("V4 global permissions [* allow]", {"permissions": [R_("*", "allow")]}),
    variant("V5 global permissions [edit deny] (a user deny), Writer's agent allows edit", {"permissions": [R_("edit", "deny")]}, writer_agent_perms=[R_("edit", "allow"), R_("read", "allow")]),
]}
save("c5-permissions", R)
