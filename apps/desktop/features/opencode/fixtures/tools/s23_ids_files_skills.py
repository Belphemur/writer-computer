"""P2 capture, no or one model call: duplicate and client-chosen prompt ids; PDF and folder attachments; which
instruction and skill folders the server loads from the vault; `POST /api/location/reload`."""
import os, sys, json, time, base64
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW

PDF = b"%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
FILES = {
    "AGENTS.md": "Vault rule: always answer in French.\n",
    "CLAUDE.md": "Claude rule: always answer in German.\n",
    ".agents/skills/demo-agents/SKILL.md": "---\nname: demo-agents\ndescription: A demo skill from .agents\n---\nBody A\n",
    ".claude/skills/demo-claude/SKILL.md": "---\nname: demo-claude\ndescription: A demo skill from .claude\n---\nBody B\n",
    ".opencode/skills/demo-opencode/SKILL.md": "---\nname: demo-opencode\ndescription: A demo skill from .opencode\n---\nBody C\n",
    "docs/readme.md": "# docs\n",
}
with Server("s23", cfg={"permissions": [{"action": "*", "resource": "*", "effect": "ask"}]}, files=FILES) as s:
    os.makedirs(os.path.join(s.cwd, "sub"), exist_ok=True)
    open(os.path.join(s.cwd, "doc.pdf"), "wb").write(PDF)
    a = s.session()
    print("skills", [(x["name"], x.get("autoinvoke")) for x in s.api("GET", "/api/skill")[1]["data"]])
    print("agents", [(x["id"], x["mode"]) for x in s.api("GET", "/api/agent")[1]["data"]])
    # ids: resume=false admits without a model call
    ids = ["msg_clientchosen000000000001", "msg_clientchosen000000000001", "client-id-no-prefix", "msg_0"]
    for i in ids:
        c, r = s.api("POST", f"/api/session/{a}/prompt", {"id": i, "text": "hello " + i, "resume": False})
        print("prompt id", i, c, json.dumps(r)[:300])
    print("inbox", json.dumps(s.api("GET", f"/api/session/{a}/inbox")[1])[:900])
    # attachments, no model call
    for name, uri, src in (("pdf", "file://" + os.path.join(s.cwd, "doc.pdf"), "uri"), ("folder", "file://" + os.path.join(s.cwd, "docs"), "uri"), ("missing", "file://" + os.path.join(s.cwd, "nope.md"), "uri")):
        c, r = s.api("POST", f"/api/session/{a}/prompt", {"text": "see attachment " + name, "resume": False, "files": [{"uri": uri, "name": name, "source": {"type": "uri", "uri": uri}}]})
        print("attach", name, c, json.dumps(r)[:600])
    print("inbox after attach", json.dumps(s.api("GET", f"/api/session/{a}/inbox")[1])[:1500])
    # one real turn: which entries and skills did the server load from the vault
    b = s.session()
    n = len(s.events)
    print(s.prompt(b, "Reply with one word: hello")[0])
    print(s.done(b, 90, n)["type"])
    for e in s.events[n:]:
        if e["type"] == "session.instructions.updated":
            print("instructions.updated", json.dumps(e["data"])[:600])
    print("entries", json.dumps(s.api("GET", f"/api/experimental/session/{b}/instructions/entries")[1])[:1500])
    print("reload", s.api("POST", "/api/location/reload", {"location": {"directory": s.cwd}}))
    print("reload bare", s.api("POST", "/api/location/reload"))
    s.save_events("s23-instructions", [b], start=n)
