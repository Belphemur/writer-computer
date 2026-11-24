"""Auth: what the server answers without credentials and with a wrong password (no model call).
Saves $OC_WORK/raw/s14-rest.json (merged into rest.json by scrub.py)."""
import base64, http.client, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW

R = {}
with Server("s14", cfg={}) as s:
    for key, hdr in (("unauthorized-none", {}), ("unauthorized-wrong", {"Authorization": "Basic " + base64.b64encode(b"opencode:wrong").decode()})):
        conn = http.client.HTTPConnection("127.0.0.1", s.port, timeout=10)
        conn.request("GET", "/api/info", headers=hdr)
        r = conn.getresponse()
        body = r.read().decode()
        try:
            body = json.loads(body)
        except ValueError:
            pass
        print(key, r.status, str(body)[:200])
        R[key] = {"method": "GET", "path": "/api/info", "status": r.status, "body": body}
        conn.close()
    json.dump(R, open(os.path.join(RAW, "s14-rest.json"), "w"), indent=1)
