import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, HERE
with Server("s11b", cfg={}) as s:
    sid = s.session()
    c, r = s.api("PUT", f"/api/experimental/session/{sid}/instructions/entries/writer", {"value": "Writer test block."}); print("PUT", c, str(r)[:200])
    c, r = s.api("GET", f"/api/experimental/session/{sid}/instructions/entries"); print("GET", c, json.dumps(r)[:400])
    c, r = s.api("PUT", f"/api/experimental/session/{sid}/instructions/entries/writer", {"value": "x" * 70000}); print("PUT big", c, str(r)[:300])
    c, r = s.api("DELETE", f"/api/experimental/session/{sid}/instructions/entries/writer"); print("DELETE", c)
