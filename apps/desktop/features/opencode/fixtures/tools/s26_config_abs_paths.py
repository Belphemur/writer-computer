"""P2 capture: config `skills` and `instructions` with ABSOLUTE paths (relative ones loaded nothing, s25): does the
server then list the vault's skill and use its AGENTS.md? Writer writes absolute paths in its config file."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, WORK

FILES = {
    "AGENTS.md": "Vault rule: always answer in French.\n",
    ".agents/skills/demo-agents/SKILL.md": "---\nname: demo-agents\ndescription: A demo skill from .agents\n---\nBody A\n",
}
cwd = os.path.join(WORK, "cwd-s26")
CFG = {"permissions": [{"action": "*", "resource": "*", "effect": "ask"}], "skills": [os.path.join(cwd, ".agents", "skills")], "instructions": [os.path.join(cwd, "AGENTS.md")]}
with Server("s26", cfg=CFG, files=FILES) as s:
    a = s.session()
    print("skills", [(x["name"], x.get("autoinvoke")) for x in s.api("GET", "/api/skill")[1]["data"]])
    n = len(s.events)
    print(s.prompt(a, "Say hello in one word.")[0]); print((s.done(a, 90, n) or {}).get("type"))
    for e in s.events[n:]:
        if e["type"] == "session.instructions.updated": print("instructions.updated keys", sorted(e["data"]["delta"].keys()))
    print("entries", json.dumps(s.api("GET", f"/api/experimental/session/{a}/instructions/entries")[1])[:300])
    print("text", [e["data"]["text"] for e in s.events[n:] if e["type"] == "session.text.ended"])
