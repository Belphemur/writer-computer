import os, sys, json, time, base64, struct, zlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, HERE, IMAGE_MODEL

def png(w=8, h=8, rgb=(220, 30, 30)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")

with Server("s09", cfg={}, files={"notes.md": "# Garden Plan\n\nPlant tomatoes in May.\n"}) as s:
    c, r = s.api("GET", "/api/command"); print("commands", c, [x["name"] for x in r["data"]][:30])
    c, r = s.api("GET", "/api/skill"); print("skills", c, [(x["name"], x.get("autoinvoke")) for x in r["data"]][:10])
    c, r = s.api("GET", "/api/model")
    img_provider, img_id = IMAGE_MODEL.split("/", 1)
    m = [x for x in r["data"] if x["id"] == img_id and x["providerID"] == img_provider][0]
    print("model", {k: m[k] for k in ("id", "name", "limit", "capabilities", "variants") if k in m})
    sid = s.session(model=img_id, provider=img_provider, variant=(m.get("variants") or [{}])[0].get("id"))
    uri = "data:image/png;base64," + base64.b64encode(png()).decode()
    notes = "file://" + os.path.join(s.cwd, "notes.md")
    text = "What colour is the attached image, and what is the heading in @notes.md? Answer in one short line."
    start = text.index("@notes.md")
    n0 = len(s.events)
    body = {"text": text, "files": [
        {"uri": uri, "name": "red.png", "source": {"type": "inline"}},
        {"uri": notes, "name": "notes.md", "source": {"type": "uri", "uri": notes}, "mention": {"start": start, "end": start + 9, "text": "@notes.md"}},
    ]}
    c, r = s.api("POST", f"/api/session/{sid}/prompt", body); print("prompt", c, json.dumps(r)[:600])
    print(s.done(sid, 120, n0)["type"])
    for e in s.events[n0:]:
        if sid in json.dumps(e) and e["type"] in ("session.text.ended", "session.tool.called", "session.execution.failed", "session.step.ended", "session.renamed", "session.inbox.enqueued"):
            print(json.dumps({k: v for k, v in e.items() if k not in ("location", "id", "created")})[:700])
    s.save_events("s09-files-mention", [sid], start=n0)
    m = s.dump("s09-files-mention", sid)
    print(json.dumps(m)[:1800])
    c, r = s.api("GET", f"/api/session/{sid}/context"); print("context", c, json.dumps(r)[:600])
    c, r = s.api("GET", f"/api/session/{sid}"); print("session", json.dumps(r["data"].get("tokens")), r["data"].get("title"))
    # resync probes on a durable log
    seqs = [e["durable"]["seq"] for e in s.events if e.get("durable", {}).get("aggregateID") == sid]
    print("seqs", seqs[:3], seqs[-3:])
    for q in (f"after={seqs[1]}&follow=false", "after=0&follow=false", f"after={seqs[1]}"):
        try:
            c, txt = s.api("GET", f"/api/experimental/session/{sid}/log?{q}", raw=True, timeout=6)
            print("log", q, c, len(txt), txt[:400].replace("\n", "\\n"))
        except Exception as e:
            print("log", q, "ERR", repr(e)[:60])
