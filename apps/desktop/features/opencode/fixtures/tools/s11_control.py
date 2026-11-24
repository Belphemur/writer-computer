import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, HERE, PROVIDER, MODEL_ID

with Server("s11", cfg={}) as s:
    rules = [{"action": "edit", "resource": "*", "effect": "ask"}]
    sid = s.session(perms=rules)
    c, r = s.api("GET", f"/api/session/{sid}"); print("create with permissions ->", {k: r["data"].get(k) for k in ("permissions", "agent", "model")})
    c, r = s.api("PATCH", f"/api/session/{sid}", {"permissions": [{"action": "shell", "resource": "*", "effect": "deny"}]}); print("PATCH permissions", c, r)
    c, r = s.api("GET", f"/api/session/{sid}"); print("after PATCH ->", r["data"].get("permissions"))
    c, r = s.api("PUT", f"/api/experimental/session/{sid}/instructions/entries/writer", {"text": "Writer test block."}); print("PUT instructions", c, str(r)[:300])
    c, r = s.api("PUT", f"/api/experimental/session/{sid}/instructions/entries/writer", {"content": "Writer test block."}); print("PUT instructions (content)", c, str(r)[:300])
    c, r = s.api("GET", f"/api/experimental/session/{sid}/instructions/entries"); print("GET entries", c, json.dumps(r)[:400])
    c, r = s.api("POST", f"/api/session/{sid}/model", {"model": {"id": MODEL_ID, "providerID": PROVIDER, "variant": "high"}}); print("POST model variant", c, r)
    c, r = s.api("POST", f"/api/session/{sid}/agent", {"agent": "plan"}); print("POST agent plan", c, r)
    c, r = s.api("GET", "/api/agent/plan"); print("plan agent perms", json.dumps(r["data"].get("permissions"))[:700])
    c, r = s.api("GET", f"/api/session/{sid}"); print("final", {k: r["data"].get(k) for k in ("agent", "model", "permissions")})
    c, r = s.api("GET", "/api/info"); print("info keys", sorted(r))
    s.show(sid)
