"""P2 capture, no model call: which config `skills` forms list a skill (a folder of skills, a SKILL.md file, a glob)."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, WORK

FILES = {".agents/skills/demo-agents/SKILL.md": "---\nname: demo-agents\ndescription: A demo skill from .agents\n---\nBody A\n"}
for i, form in enumerate(("dir-parent", "skill-dir", "skill-file", "glob")):
    name = f"s27{i}"
    cwd = os.path.join(WORK, "cwd-" + name)
    base = os.path.join(cwd, ".agents", "skills")
    path = {"dir-parent": base, "skill-dir": os.path.join(base, "demo-agents"), "skill-file": os.path.join(base, "demo-agents", "SKILL.md"), "glob": os.path.join(base, "*", "SKILL.md")}[form]
    with Server(name, cfg={"skills": [path]}, files=FILES) as s:
        a = s.session()
        import time; time.sleep(2)
        print(form, [(x["name"]) for x in s.api("GET", "/api/skill")[1]["data"]])
