import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oc import Server, RAW, HERE

CFG = {"permissions": [{"action": "edit", "resource": "*", "effect": "ask"}]}

def brief(evs, sids):
    for e in evs:
        if e["type"] in ("session.reasoning.delta", "session.text.delta", "session.instructions.updated", "plugin.updated"): continue
        if any(x in json.dumps(e) for x in sids):
            d = e.get("data", {})
            print(e["type"], d.get("sessionID", "")[-5:], json.dumps({k: v for k, v in d.items() if k not in ("sessionID", "assistantMessageID", "tokens", "native")})[:330])

with Server("s06", cfg=CFG) as s:
    # ---- A: steer, queue, cancel a queued one, send-now a queued one, then resync probes ----
    a = s.session()
    n0 = len(s.events)
    print("prompt A", s.prompt(a, "Run the shell command `sleep 6` with your shell tool, then reply with the single word: done.")[0])
    called = s.wait(lambda e: e["type"] == "session.tool.called" and e["data"]["sessionID"] == a, 60, n0)
    print("tool called:", bool(called))
    r1 = s.prompt(a, "STEER: when you answer, write it in ALL CAPS.", delivery="steer")[1]["data"]["id"]
    r2 = s.prompt(a, "QUEUED-1: afterwards say the word apple.", delivery="queue")[1]["data"]["id"]
    r3 = s.prompt(a, "QUEUED-2: afterwards say the word banana.", delivery="queue")[1]["data"]["id"]
    print("inbox", s.api("GET", f"/api/session/{a}/inbox")[1])
    print("cancel r3", s.api("DELETE", f"/api/session/{a}/inbox/{r3}"))
    print("inbox after cancel", json.dumps(s.api("GET", f"/api/session/{a}/inbox")[1])[:600])
    # wait for the queue to drain: the turn ends, queued-1 runs as its own turn
    time.sleep(8)
    t0 = time.time()
    while time.time() - t0 < 120:
        ends = [e for e in s.events[n0:] if e["type"] == "session.execution.succeeded" and e["data"]["sessionID"] == a]
        if len(ends) >= 1 and time.time() - t0 > 20: break
        time.sleep(1)
    time.sleep(3)
    brief(s.events[n0:], [a])
    s.save_events("s06-steer-queue", [a], start=n0)
    s.dump("s06-steer-queue", a)
    # ---- resync probes on A (no model call) ----
    seqs = [e["durable"]["seq"] for e in s.events if e.get("durable", {}).get("aggregateID") == a]
    print("durable seqs", seqs[:6], "...", seqs[-3:], "count", len(seqs), "gaps", [(x, y) for x, y in zip(seqs, seqs[1:]) if y != x + 1])
    mid = seqs[len(seqs) // 2]
    code, txt = s.api("GET", f"/api/experimental/session/{a}/log?after={mid}&follow=false", raw=True, timeout=20)
    print("log after", mid, code, len(txt), txt[:600].replace("\n", "\\n"))
    open(os.path.join(RAW, "s10-log-after-mid.sse"), "w").write(txt)
    code, txt = s.api("GET", f"/api/experimental/session/{a}/log?after=0&follow=false", raw=True, timeout=20)
    print("log after 0", code, len(txt), txt.count("\n\n"))
    code, txt = s.api("GET", f"/api/experimental/session/{a}/log?follow=false", raw=True, timeout=20)
    print("log no after", code, len(txt))
    code, txt = s.api("GET", f"/api/experimental/session/{a}/log?after=99999&follow=false", raw=True, timeout=20)
    print("log after future", code, len(txt), txt[:300])
    # ---- B: interrupt mid-tool ----
    b = s.session()
    nb = len(s.events)
    print("prompt B", s.prompt(b, "Run the shell command `sleep 30` with your shell tool, then reply done.")[0])
    s.wait(lambda e: e["type"] == "session.tool.called" and e["data"]["sessionID"] == b, 60, nb)
    time.sleep(1)
    print("interrupt", s.api("POST", f"/api/session/{b}/interrupt"))
    print("end:", (s.done(b, 30, nb) or {}).get("type"))
    time.sleep(2)
    print("interrupt idle", s.api("POST", f"/api/session/{b}/interrupt"))
    brief(s.events[nb:], [b])
    s.save_events("s06-interrupt", [b], start=nb)
    s.dump("s06-interrupt", b)
