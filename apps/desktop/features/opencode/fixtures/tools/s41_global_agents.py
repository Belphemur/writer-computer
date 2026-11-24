"""C4 (spec 4.13): global agents and Writer's overrides. A synthetic global config defines a primary agent `g-prim` and
a sub-agent `g-sub` in JSON and a sub-agent `md-sub` as a markdown file in the global `agents/` folder. Writer's file
(a) says nothing, (b) disables them with a PARTIAL `{disabled:true}`, (c) with a full definition plus disabled.
Per variant: GET /api/agent (id, mode, disabled, hidden), whether the model's request names them (the subagent tool
lists the agents it may launch), and whether a session can be started on a disabled primary agent."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gc_helpers import *

MD = "---\ndescription: A markdown sub-agent from the global folder\nmode: subagent\n---\nYou are md-sub.\n"
GA = {"g-prim": {"mode": "primary", "description": "Global primary agent", "system": "You are g-prim.", "model": "fake-a/fake-model"},
      "g-sub": {"mode": "subagent", "description": "Global sub-agent", "system": "You are g-sub.", "model": "fake-a/fake-model"}}
FOREIGN = ("g-prim", "g-sub", "md-sub")
BUILTIN = ("build", "plan", "general", "explore", "title")

def variant(label, writer_agents):
    srv, port, rec = fake("c4")
    glob = {"providers": {"fake-a": provider(port)}, "agents": GA}
    wcfg = writer_cfg(agents=writer_agents)
    out = {"variant": label}
    try:
        with Server("c4", cfg=wcfg, global_config=glob, global_files={"agents/md-sub.md": MD}) as s:
            time.sleep(1)
            c, r = s.api("GET", "/api/agent")
            out["agents"] = {a["id"]: {"mode": a.get("mode"), "disabled": bool(a.get("disabled")), "hidden": bool(a.get("hidden"))} for a in (r or {}).get("data", [])} if c == 200 else str(r)[:200]
            out["foreign_listed_and_enabled"] = sorted(n for n in FOREIGN if isinstance(out["agents"], dict) and n in out["agents"] and not out["agents"][n]["disabled"])
            out["builtin_enabled"] = sorted(n for n in BUILTIN if isinstance(out["agents"], dict) and n in out["agents"] and not out["agents"][n]["disabled"])
            sid = s.session(model="fake-model", provider="fake-a", agent="writer")
            n, end = turn_tools(s, sid, "hello")
            text = json.dumps([r.get("body") for r in requests(rec) if r["tools"]][-1:])
            out["names_in_model_request"] = sorted(a for a in FOREIGN + ("writer",) if f"{a}" in text and (f"- {a}" in text or f"\\n{a}" in text or f"`{a}`" in text or f'"{a}"' in text))
            # a session pinned to the disabled primary agent
            try:
                sid2 = s.session(model="fake-model", provider="fake-a", agent="g-prim")
                n2, end2 = turn_tools(s, sid2, "hello again", timeout=30)
                out["session_on_g-prim"] = {"created": True, "turn": end2, "system_mentions_g-prim": "You are g-prim." in json.dumps([r.get("body") for r in requests(rec)][-2:])}
            except AssertionError as e:
                out["session_on_g-prim"] = {"created": False, "error": str(e)[:160]}
    finally:
        srv.shutdown()
    print(label, "->", json.dumps({k: out.get(k) for k in ("foreign_listed_and_enabled", "names_in_model_request", "session_on_g-prim")}))
    return out

R = {"question": "C4: do Writer's agent overrides switch global agents off?", "variants": [
    variant("baseline: Writer's file leaves global agents alone", {}),
    variant("partial {disabled:true} for g-prim, g-sub, md-sub", {n: {"disabled": True} for n in FOREIGN}),
    variant("full definition + disabled:true", {"g-prim": {**GA["g-prim"], "disabled": True}, "g-sub": {**GA["g-sub"], "disabled": True}, "md-sub": {"mode": "subagent", "description": "x", "disabled": True}}),
    variant("built-ins disabled too (as Writer does today), partial for foreign", {**{n: {"disabled": True} for n in BUILTIN}, **{n: {"disabled": True} for n in FOREIGN}}),
]}
save("c4-agents", R)
