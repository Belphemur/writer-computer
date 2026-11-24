"""P2 capture, no model call: which skill folders of the vault the server lists on its own (project config off),
read after the lazy load settled (a list read right after the first session is incomplete)."""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server

def skill(name, where):
    return f"---\nname: {name}\ndescription: A demo skill from {where}\n---\nBody\n"
FILES = {
    ".agents/skills/demo-agents/SKILL.md": skill("demo-agents", ".agents"),
    ".claude/skills/demo-claude/SKILL.md": skill("demo-claude", ".claude"),
    ".opencode/skills/demo-opencode/SKILL.md": skill("demo-opencode", ".opencode"),
}
with Server("s28", cfg={}, files=FILES) as s:
    a = s.session()
    for wait in (0, 3):
        time.sleep(wait)
        print(f"after {wait}s", [x["name"] for x in s.api("GET", "/api/skill")[1]["data"]])
with Server("s28b", cfg={}, files={}) as s:  # the same without any vault skill: what comes from outside the vault
    a = s.session(); time.sleep(3)
    print("no vault skills", [x["name"] for x in s.api("GET", "/api/skill")[1]["data"]])
