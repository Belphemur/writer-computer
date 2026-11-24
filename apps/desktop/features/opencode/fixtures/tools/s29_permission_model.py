"""Security captures for phase 3's permission model (spec 10.9): who decides, session rules or agent rules?

13a a parent session that DENIES edit and a read-only explorer (agent-level deny edit) that tries an edit
13b empty session rules: does a config primary agent's own rule (deny edit / ask edit) take effect?
13c does POST .../agent on a live session switch enforcement?
13d empty parent ruleset: which rules does a child get (its own agent's, the parent agent's, config's)?
13e does a saved `always` rule (psv_) beat an agent-level deny? (a synthetic rule in the temp setup only)
12a is OPENCODE_SERVER_PASSWORD (or XDG_CONFIG_HOME) visible to a command the agent runs? (names only, values redacted)
18b the earlier child-edit run again, this time keeping the message lists of the parent and the child.
Free model, one small prompt each. Shell is only ever allowed for the one redacted `env` probe."""
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, MODEL

QUIET = ("session.reasoning.delta", "session.text.delta", "session.instructions.updated", "session.tool.input.delta", "session.step.started", "session.step.ended", "session.step.streamed", "session.step.first-token", "session.usage.updated", "session.reasoning.started", "session.reasoning.ended", "session.inbox.enqueued", "session.inbox.delivered")
READS = [{"action": "read", "resource": "*", "effect": "allow"}, {"action": "glob", "resource": "*", "effect": "allow"}, {"action": "grep", "resource": "*", "effect": "allow"}, {"action": "subagent", "resource": "*", "effect": "allow"}]
RESULTS = {}

def r(action, effect, resource="*"):
    return {"action": action, "resource": resource, "effect": effect}

def outcome(s, sids, n, label):
    """What each session's tool calls came to: asked actions, tool results, in order."""
    asked, tools = [], []
    calls = {}
    for e in s.events[n:]:
        d = e.get("data", {})
        if d.get("sessionID") not in sids:
            continue
        t = e["type"]
        if t == "session.tool.input.started":
            calls[d["id"]] = d["name"]
        elif t == "permission.asked":
            asked.append((d["sessionID"][-4:], d["action"]))
        elif t == "session.tool.success":
            tools.append((d["sessionID"][-4:], calls.get(d["id"]), "ok"))
        elif t == "session.tool.failed":
            tools.append((d["sessionID"][-4:], calls.get(d["id"]), "failed:" + d["error"]["type"]))
    print("OUTCOME", label, "asked", asked, "tools", tools)
    return {"asked": asked, "tools": tools}

def wait_children(s, parent, n, timeout=80, answer=None):
    t0 = time.time(); answered = set()
    kids = []
    while time.time() - t0 < timeout:
        kids = [e["data"]["sessionID"] for e in s.events[n:] if e["type"] == "session.created" and e["data"].get("parentID") == parent]
        for e in list(s.events)[n:]:
            if e["type"] == "permission.asked" and e["data"]["sessionID"] in kids and e["data"]["id"] not in answered:
                answered.add(e["data"]["id"])
                s.api("POST", f"/api/session/{e['data']['sessionID']}/permission/{e['data']['id']}/reply", {"decision": "reject" if e["data"]["action"] == "shell" else "once", "message": "no"})
        if kids and any(x["type"].startswith("session.execution.") and x["type"] != "session.execution.started" and x["data"].get("sessionID") == kids[0] for x in s.events[n:]):
            break
        time.sleep(0.4)
    time.sleep(3)
    return kids

def decide_once(e):
    return "reject" if e["data"]["action"] == "shell" else "once"

def turn(s, sid, text, decide=decide_once, timeout=70):
    n = len(s.events)
    print(s.prompt(sid, text)[0])
    s.drive(sid, decide, timeout=timeout, start=n)
    time.sleep(2)
    return n

EDIT_A = "Use your edit tool to replace alpha by gamma in a.txt. Then say done."
DELEGATE = "Delegate to your {agent} sub-agent: have it use its edit tool (it must try) to replace beta by delta in b.txt. Then tell me what it reported."
def read(s, f):
    return open(os.path.join(s.cwd, f)).read().strip()

EXPLORER = {"mode": "subagent", "description": "Read-only helper.", "system": "You read notes for another agent. Never edit.", "model": MODEL, "permissions": [r("edit", "deny")]}

# 13a: the parent session denies edit; the explorer has an agent-level deny
CFG = {"permissions": [r("*", "ask")], "agents": {"writer-explorer": EXPLORER}}
with Server("s29a", cfg=CFG, files={"b.txt": "beta\n"}) as s:
    b = s.session(perms=[r("*", "ask"), r("edit", "deny")] + READS)
    n = turn(s, b, DELEGATE.format(agent="writer-explorer"), timeout=40)
    kids = wait_children(s, b, n)
    RESULTS["13a"] = {"children": len(kids), "b.txt": read(s, "b.txt"), **outcome(s, [b] + kids, n, "13a parent denies edit")}
    s.save_events("s29a", [b] + kids, start=n)

# 13a2: for contrast, the parent session ALLOWS edit and the explorer has the agent-level deny (s25b again, now saved)
with Server("s29a2", cfg=CFG, files={"b.txt": "beta\n"}) as s:
    b = s.session(perms=[r("*", "ask"), r("edit", "allow")] + READS)
    n = turn(s, b, DELEGATE.format(agent="writer-explorer"), timeout=40)
    kids = wait_children(s, b, n)
    RESULTS["13a2"] = {"children": len(kids), "b.txt": read(s, "b.txt"), **outcome(s, [b] + kids, n, "13a2 parent allows edit")}
    s.save_events("s29a2", [b] + kids, start=n)

# 13b + 13c: empty session rules, primary agents carrying the rules; then a live switch with POST .../agent
CFG_B = {"permissions": [r("*", "ask"), r("read", "allow"), r("glob", "allow"), r("grep", "allow")],
         "agents": {"w-deny": {"mode": "primary", "description": "edit denied", "model": MODEL, "permissions": [r("edit", "deny")]},
                    "w-ask": {"mode": "primary", "description": "edit asks", "model": MODEL, "permissions": [r("edit", "ask")]},
                    "w-allow": {"mode": "primary", "description": "edit allowed", "model": MODEL, "permissions": [r("edit", "allow")]}}}
with Server("s29b", cfg=CFG_B, files={"a.txt": "alpha\n"}) as s:
    for agent in ("w-deny", "w-ask"):
        a = s.session(agent=agent, perms=[])
        n = turn(s, a, EDIT_A)
        RESULTS["13b-" + agent] = {"a.txt": read(s, "a.txt"), **outcome(s, [a], n, "13b " + agent)}
        open(os.path.join(s.cwd, "a.txt"), "w").write("alpha\n")
        s.save_events("s29b-" + agent, [a], start=n)
    # 13c: one session, switched live
    c = s.session(agent="w-deny", perms=[])
    n = turn(s, c, EDIT_A)
    RESULTS["13c-first(deny)"] = {"a.txt": read(s, "a.txt"), **outcome(s, [c], n, "13c as w-deny")}
    code, resp = s.api("POST", f"/api/session/{c}/agent", {"agent": "w-ask"})
    print("switch to w-ask", code, str(resp)[:160])
    n2 = turn(s, c, EDIT_A)
    RESULTS["13c-after(ask)"] = {"switch": code, "a.txt": read(s, "a.txt"), **outcome(s, [c], n2, "13c after switch to w-ask")}
    code, resp = s.api("POST", f"/api/session/{c}/agent", {"agent": "w-deny"})
    open(os.path.join(s.cwd, "a.txt"), "w").write("alpha\n")
    n3 = turn(s, c, EDIT_A)
    RESULTS["13c-back(deny)"] = {"switch": code, "a.txt": read(s, "a.txt"), **outcome(s, [c], n3, "13c back to w-deny")}
    s.save_events("s29c", [c], start=n)

# 13d: empty parent session ruleset; which rules does a child get?
CFG_D = {"permissions": [r("*", "ask"), r("read", "allow"), r("glob", "allow"), r("grep", "allow"), r("edit", "allow")],
         "agents": {"p-deny": {"mode": "primary", "description": "parent, edit denied", "model": MODEL, "permissions": [r("edit", "deny"), r("subagent", "allow")]},
                    "kid-ask": {"mode": "subagent", "description": "child with its own ask", "system": "You edit notes as asked.", "model": MODEL, "permissions": [r("edit", "ask")]},
                    "kid-plain": {"mode": "subagent", "description": "child with no rules of its own", "system": "You edit notes as asked.", "model": MODEL}}}
for kid in ("kid-ask", "kid-plain"):
    with Server("s29d-" + kid, cfg=CFG_D, files={"b.txt": "beta\n"}) as s:
        b = s.session(agent="p-deny", perms=[])
        n = turn(s, b, DELEGATE.format(agent=kid), timeout=40)
        kids = wait_children(s, b, n)
        RESULTS["13d-" + kid] = {"children": len(kids), "b.txt": read(s, "b.txt"), **outcome(s, [b] + kids, n, "13d " + kid)}
        s.save_events("s29d-" + kid, [b] + kids, start=n)

# 13e: a saved `always` rule against an agent-level deny
CFG_E = {"permissions": [r("*", "ask"), r("read", "allow")],
         "agents": {"e-ask": {"mode": "primary", "description": "edit asks", "model": MODEL, "permissions": [r("edit", "ask")]},
                    "e-deny": {"mode": "primary", "description": "edit denied", "model": MODEL, "permissions": [r("edit", "deny")]}}}
with Server("s29e", cfg=CFG_E, files={"a.txt": "alpha\n"}) as s:
    a = s.session(agent="e-ask", perms=[])
    n = turn(s, a, EDIT_A, decide=lambda e: "always" if e["data"]["action"] == "edit" else decide_once(e))
    RESULTS["13e-save"] = {"a.txt": read(s, "a.txt"), "saved": json.dumps(s.api("GET", "/api/permission/saved")[1])[:300], **outcome(s, [a], n, "13e saving")}
    open(os.path.join(s.cwd, "a.txt"), "w").write("alpha\n")
    d = s.session(agent="e-deny", perms=[])
    n = turn(s, d, EDIT_A)
    RESULTS["13e-against-deny"] = {"a.txt": read(s, "a.txt"), **outcome(s, [d], n, "13e saved always vs agent deny")}
    s.save_events("s29e", [a, d], start=0)

# 12a: the environment of a command the agent runs: names only, values redacted at the source
PROBE = "env | grep -E '^(OPENCODE_|XDG_CONFIG_HOME)' | sed 's/=.*/=<redacted>/' | sort"
with Server("s29f", cfg={"permissions": [r("*", "ask"), r("read", "allow")]}, files={"a.txt": "x\n"}) as s:
    a = s.session(perms=[])
    seen = []
    def only_probe(e):
        cmd = " ".join(e["data"].get("resources", []))
        seen.append(cmd)
        return "once" if cmd.strip() == PROBE else "reject"
    n = turn(s, a, "Run exactly this command with your shell tool and show me its output, nothing else: " + PROBE, decide=only_probe)
    out = ""
    for e in s.events[n:]:
        if e["type"] == "session.tool.success" and e["data"].get("sessionID") == a:
            out += json.dumps(e["data"].get("content"))
    RESULTS["12a"] = {"commands": seen, "output": out[:600]}
    print("12a output:", out[:600])
    assert not any(e.get("data", {}).get("content") and "OPENCODE_SERVER_PASSWORD=" in json.dumps(e) and "<redacted>" not in json.dumps(e) for e in s.events[n:])
    s.save_events("s29f", [a], start=n)

# 18b: child edit again with the message lists kept
CFG18 = {"permissions": [r("*", "ask")], "agents": {"writer-worker": {"mode": "subagent", "description": "Makes small edits to notes on request.", "system": "You edit notes as asked, briefly.", "model": MODEL}}}
with Server("s18b", cfg=CFG18, files={"a.txt": "alpha\n", "b.txt": "beta\n"}) as s:
    b = s.session(perms=[r("*", "ask"), r("read", "allow"), r("edit", "allow"), r("subagent", "allow")])
    n = turn(s, b, DELEGATE.format(agent="writer-worker"), timeout=40)
    kids = wait_children(s, b, n)
    RESULTS["18b"] = {"children": len(kids), "b.txt": read(s, "b.txt"), **outcome(s, [b] + kids, n, "18b")}
    s.save_events("s18-child-edit", [b] + kids, start=n)
    s.dump("s18-child-edit-parent", b)
    if kids:
        s.dump("s18-child-edit-child", kids[0])

json.dump(RESULTS, open(os.path.join(RAW, "s29-results.json"), "w"), indent=1)
print("RESULTS", json.dumps(RESULTS, indent=1)[:6000])
