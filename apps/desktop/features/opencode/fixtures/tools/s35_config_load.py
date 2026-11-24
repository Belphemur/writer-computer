"""Phase 3: does opencode load Writer's generated config (goldens/config/file.json), and what does the server say of it?
No prompt is sent, so no model is called. Prints: the agents (immediately after a session is created and a few seconds
later), the MCP servers, the skills, the default agent of a session created with no `agent`, and a rewrite + reload."""
import json, os, sys, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from oc import Server, WORK, RAW
GOLD = os.path.join(HERE, "..", "..", "goldens", "config", "file.json")
cfg = json.load(open(GOLD))
probe = os.path.join(WORK, "cwd-s35")
cfg = json.loads(json.dumps(cfg).replace("/vault", probe))
cfg["mcp"]["servers"]["writer"]["command"] = ["node", os.path.join(HERE, "mcp_server.cjs")]
files = {"AGENTS.md": "x\n", ".agents/skills/demo/SKILL.md": "---\nname: demo\ndescription: demo skill\n---\nbody\n"}

def state(s):
    ag = {a["id"]: (a.get("mode"), bool(a.get("hidden")), bool(a.get("disabled")), (a.get("model") or {}).get("id")) for a in s.api("GET", "/api/agent")[1]["data"]}
    mcp = [(m["name"], m["status"]["status"]) for m in s.api("GET", "/api/mcp")[1]["data"]]
    return ag, mcp

RES = {}

with Server("s35", cfg=cfg, files=files) as s:
    loc = {"directory": s.cwd}
    r = s.api("POST", "/api/session", {"location": loc, "model": {"id": "fake", "providerID": "fake"}})[1]["data"]
    print("session with no agent ->", r.get("agent"))
    RES["session_default_agent"] = r.get("agent")
    RES["immediately"] = state(s)
    print("immediately:", RES["immediately"])
    # what `ready` does before it looks: the agent and the rules go on the session; then poll
    s.api("POST", f"/api/session/{r['id']}/agent", {"agent": "writer"})
    s.api("PATCH", f"/api/session/{r['id']}", {"permissions": []})
    t0 = time.time()
    while time.time() - t0 < 20 and "writer" not in state(s)[0]:
        time.sleep(0.25)
    print("the config is in force after %.1f s of polling" % (time.time() - t0))
    time.sleep(1)
    RES["later"] = state(s)
    RES["skills"] = [x["name"] for x in s.api("GET", "/api/skill")[1]["data"]]
    print("later:", RES["later"])
    print("skills:", RES["skills"])
    cfg["agents"]["writer-explorer"]["model"] = "fake/other-model"
    del cfg["mcp"]["servers"]["writer"]
    json.dump(cfg, open(s.cfg_path, "w"))
    print("reload", s.api("POST", "/api/location/reload")[0])
    time.sleep(3)
    RES["after_reload"] = state(s)
    RES["session_survives_reload"] = s.api("GET", "/api/session/" + r["id"])[0] == 200
    print("after reload:", RES["after_reload"])
    print("session still there:", RES["session_survives_reload"])
    s.api("DELETE", "/api/session/" + r["id"])
json.dump(RES, open(os.path.join(RAW, "s35-results.json"), "w"), indent=1)
