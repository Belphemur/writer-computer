"""Record the REST replies the fake OpenCode server replays (no model call except the one interrupt run).

Saves $OC_WORK/raw/s12-rest.json: {key: {method, path, status, body}}. Provider, model and skill replies are
reduced at the source to what Writer reads (provider: id, name, activation; models: the chat model's provider
without headers; skills: fake names, no path or content). Set OC_OPENAPI to the pinned contract file to check
that the server's own OpenAPI document is the same one.
"""
import hashlib, json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, HERE, PROVIDER, MODEL_ID

NODE = __import__("shutil").which("node") or "node"
SRV = os.path.join(HERE, "mcp_server.cjs")
CFG = {
    "permissions": [{"action": "*", "resource": "*", "effect": "ask"}],
    "mcp": {"servers": {"writer": {"type": "local", "command": [NODE, SRV]}}},
}
R = {}


def rec(s, key, method, path, body=None, timeout=60):
    code, r = s.api(method, path, body, timeout=timeout)
    R[key] = {"method": method, "path": path, "status": code, "body": r}
    if body is not None:
        R[key]["request"] = body
    return r


with Server("s12", cfg=CFG, files={"notes.md": "# Pets\n\nI have a cat named Tom.\n"}) as s:
    rec(s, "info", "GET", "/api/info")
    time.sleep(3)
    rec(s, "mcp", "GET", "/api/mcp")
    r = rec(s, "session-create", "POST", "/api/session", {"location": {"directory": s.cwd}, "model": {"id": MODEL_ID, "providerID": PROVIDER}})
    sid = r["data"]["id"]
    s.created = [sid]
    rec(s, "prompt-admitted", "POST", f"/api/session/{sid}/prompt", {"text": "hi", "resume": False})
    rec(s, "interrupt-idle", "POST", f"/api/session/{sid}/interrupt")
    rec(s, "permission-reply-404", "POST", f"/api/session/{sid}/permission/per_doesnotexist/reply", {"decision": "once"})
    rec(s, "form-reply-404", "POST", f"/api/session/{sid}/form/frm_doesnotexist/reply", {"answer": {"q0": "x"}})
    rec(s, "mcp-put-400", "PUT", "/api/experimental/mcp/other", {"type": "local", "command": [NODE, SRV]})
    rec(s, "mcp-put-204", "PUT", "/api/experimental/mcp/other", {"config": {"type": "local", "command": [NODE, SRV]}})
    rec(s, "mcp-delete-204", "DELETE", "/api/experimental/mcp/other")
    rec(s, "session-get-404", "GET", "/api/session/ses_doesnotexist")
    # reduced at the source
    code, r = s.api("GET", "/api/provider")
    R["provider"] = {"method": "GET", "path": "/api/provider", "status": code,
                     "body": {"data": [{k: p.get(k) for k in ("id", "name", "activation")} for p in r["data"] if p["id"] == PROVIDER]}}
    for _ in range(20):  # the first snapshot can be empty
        code, r = s.api("GET", "/api/model")
        if r["data"]:
            break
        time.sleep(1)
    models = [{k: v for k, v in m.items() if k != "headers"} for m in r["data"] if m["providerID"] == PROVIDER]
    R["models"] = {"method": "GET", "path": "/api/model", "status": code, "body": {"data": models}}
    code, r = s.api("GET", "/api/skill")
    R["skills"] = {"method": "GET", "path": "/api/skill", "status": code,
                   "body": {"data": [{"id": f"fake-skill-{i}", "name": f"fake-skill-{i}", "autoinvoke": x.get("autoinvoke")} for i, x in enumerate(r["data"], 1)]}}
    rec(s, "commands", "GET", "/api/command")
    # which route serves the OpenAPI document, and is it the pinned one?
    pinned = os.environ.get("OC_OPENAPI")
    for route in ("/doc", "/docs/openapi.json", "/openapi.json", "/api/openapi.json"):
        code, txt = s.api("GET", route, raw=True, timeout=10)
        if code == 200 and txt.lstrip().startswith("{") and '"openapi"' in txt[:200]:
            same = pinned and hashlib.sha256(json.dumps(json.loads(txt), sort_keys=True).encode()).hexdigest() == hashlib.sha256(json.dumps(json.load(open(pinned)), sort_keys=True).encode()).hexdigest()
            print("openapi route", route, "same as pinned:", same)
            R["openapi-route"] = route
            break
    else:
        print("no openapi route found")
    # interrupt of a running turn (one free-model prompt)
    n0 = len(s.events)
    sid2 = s.session()
    s.prompt(sid2, "Run the shell command `sleep 20` with your shell tool, then reply done.")
    s.wait(lambda e: e["type"] == "session.tool.called" and e["data"]["sessionID"] == sid2, 90, n0)
    time.sleep(1)
    rec(s, "interrupt-running", "POST", f"/api/session/{sid2}/interrupt")
    s.done(sid2, 30, n0)
    json.dump(R, open(os.path.join(RAW, "s12-rest.json"), "w"), indent=1)
    print({k: v["status"] if isinstance(v, dict) else v for k, v in R.items()})
