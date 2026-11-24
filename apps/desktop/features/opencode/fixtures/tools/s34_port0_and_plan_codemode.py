"""Final phase-2 captures. (a) `--port 0` through the launcher: does the real server accept it and say its port in the
ready line? No model call. (b) codemode under Plan's rules: a session with `*: deny` plus `writer_note_count: allow`;
does the model still see and run `execute`, and does the inner `writer_note_count` pass? One small prompt, free model."""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, HERE

NODE = __import__("shutil").which("node") or "node"
SRV = os.path.join(HERE, "mcp_server.cjs")
OUT = {}

with Server("s34a", port0=True) as s:
    c, r = s.api("GET", "/api/info")
    OUT["port0"] = {"accepted": True, "info_status": c, "port_is_nonzero": s.port != 0}
    print("port0", OUT["port0"])

CFG = {
    "permissions": [{"action": "*", "resource": "*", "effect": "ask"}],
    "mcp": {"servers": {"writer": {"type": "local", "command": [NODE, SRV]}}},
}
PLAN = [{"action": "*", "resource": "*", "effect": "deny"}, {"action": "writer_note_count", "resource": "*", "effect": "allow"}]
with Server("s34b", cfg=CFG) as s:
    time.sleep(3)
    a = s.session(perms=PLAN, model=os.environ.get("S34_MODEL"))  # a free model (beam-free had hit its limit)
    time.sleep(3)
    n = len(s.events)
    print(s.prompt(a, "In ONE code execution call, call tools.writer.note_count() from the writer MCP server and return its number. Then tell me the number.")[0])
    end = s.drive(a, lambda e: None, timeout=90, start=n)
    names, results, asked = {}, [], []
    for e in s.events[n:]:
        d = e.get("data", {})
        if d.get("sessionID") != a:
            continue
        t = e["type"]
        if t == "session.tool.input.started":
            names[d["id"]] = d["name"]
        elif t == "permission.asked":
            asked.append(d["action"])
        elif t == "session.tool.success":
            results.append((names.get(d["id"]), "ok", d.get("metadata")))
        elif t == "session.tool.failed":
            results.append((names.get(d["id"]), "failed:" + d["error"]["type"], None))
    OUT["plan_codemode"] = {"end": (end or {}).get("type"), "tools_started": list(names.values()), "asked": asked, "results": [(a_, b_) for a_, b_, _ in results]}
    print("OUTCOME", json.dumps(OUT["plan_codemode"]))
    for a_, b_, m in results:
        print("meta", a_, json.dumps(m)[:600])
    s.brief([a], start=n, width=500, skip=("session.reasoning.delta", "session.text.delta", "session.instructions.updated", "session.tool.input.delta", "session.step.streamed", "session.step.first-token", "session.usage.updated", "session.reasoning.started", "session.reasoning.ended"))
    s.save_events("s34-plan-codemode", [a], start=n); s.dump("s34-plan-codemode", a)
json.dump(OUT, open(os.path.join(RAW, "s34-results.json"), "w"), indent=1)
