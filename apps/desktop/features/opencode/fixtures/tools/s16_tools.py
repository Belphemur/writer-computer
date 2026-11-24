"""P2 capture: the tools Writer had not seen (write, glob, grep, webfetch, websearch, apply_patch, todowrite):
their names, inputs, permission actions and results, one small prompt each on a free model. Every action asks
(`*` base rule), each request is answered `once`."""
import os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW

CFG = {"permissions": [{"action": "*", "resource": "*", "effect": "ask"}]}
FILES = {"notes.md": "# Pets\n\nI have a cat named Tom.\n", "docs/todo.md": "- cat food\n"}
PROMPTS = [
    ("write", "Use your write tool to create the new file named plan.md with the single line `- water the plants`. Then say done."),
    ("search", "Use your glob tool to list the markdown files, then your grep tool to find the word cat in them. Then say done."),
    ("patch", "Use your apply_patch tool (not edit) to change the word cat to dog in notes.md. Then say done."),
    ("todo", "Use your todowrite tool to record a todo list of two items: buy milk, call Sam. Then say done."),
    ("web", "Use your webfetch tool to fetch https://example.com and tell me the page title in a few words."),
    ("websearch", "Use your websearch tool to search for `rust programming language` and name one result. Then say done."),
]
with Server("s16", cfg=CFG, files=FILES) as s:
    only = sys.argv[1:]  # optional: run just these prompts
    for name, text in PROMPTS:
        if only and name not in only:
            continue
        n = len(s.events)
        sid = s.session()
        c, r = s.prompt(sid, text)
        print(f"== {name}", c)
        e = s.drive(sid, lambda e: "reject" if e["data"]["action"] == "shell" else "once", timeout=100, start=n)
        print("end", e and e["type"])
        s.brief([sid], start=n)
        s.save_events("s16-" + name, [sid], start=n)
        s.dump("s16-" + name, sid)
