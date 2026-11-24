"""C7 (spec 4.13): the provider lever. Two synthetic providers (`fake-a`, `fake-b`, each its own recorder, so a request
that reached the provider is a recorded line) next to OpenCode's built-in ones, and Writer's file applying one lever per
variant. Per variant: GET /api/provider (id, activation), GET /api/model (per provider: ids, enabled, status), and a turn on
each synthetic provider: did the session end in failure, with which error type, and did a request reach the recorder.
Also what `auto` means: providers with an `env` list, the variable unset and set. No real provider is ever called (the
built-in providers are only listed, never prompted)."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gc_helpers import *

def P(a, r, e): return {"action": a, "resource": r, "effect": e}

def turn_on(s, rec, provider_id, label):
    out = {}
    try:
        sid = s.session(model="fake-model", provider=provider_id, agent="writer")
    except AssertionError as e:
        return {"session": "refused at create: " + str(e)[:160]}
    n = len(s.events)
    c, r = s.prompt(sid, "hello")
    out["prompt_http"] = c
    e = s.done(sid, 25, start=n)
    out["end"] = e["type"] if e else "timeout"
    err = next((x for x in s.events[n:] if x["type"] in ("session.execution.failed", "session.step.failed") and x["data"].get("sessionID") == sid), None)
    out["error_type"] = (err["data"].get("error") or {}).get("type") if err else None
    time.sleep(0.5)
    out["requests_reached_recorder"] = len([q for q in requests(rec) if q["tools"] or q["path"].endswith("completions")])
    return out

def variant(label, writer_extra=None, with_env=False):
    sa, pa, ra = fake("c7a", reply="from a", keep_body=False)
    sb, pb, rb = fake("c7b", reply="from b", keep_body=False)
    glob = {"providers": {"fake-a": provider(pa, "Fake A"), "fake-b": provider(pb, "Fake B")}}
    if with_env:
        glob["providers"]["fake-c"] = {**provider(pb, "Fake C (env, unset)"), "env": ["C7_UNSET_KEY_VAR"]}
        glob["providers"]["fake-c"]["settings"].pop("apiKey")
        glob["providers"]["fake-d"] = {**provider(pb, "Fake D (env, set)"), "env": ["C7_SET_KEY_VAR"]}
        glob["providers"]["fake-d"]["settings"].pop("apiKey")
    wcfg = writer_cfg(extra=writer_extra)
    wcfg["agents"]["writer"]["model"] = "fake-a/fake-model"
    out = {"variant": label, "writer_config_extra": writer_extra}
    try:
        with Server("c7", cfg=wcfg, global_config=glob, env={"C7_SET_KEY_VAR": "dummy"}) as s:
            time.sleep(1)
            c, r = s.api("GET", "/api/provider")
            out["providers"] = {p["id"]: p["activation"] for p in r["data"]} if c == 200 else str(r)[:200]
            c, r = s.api("GET", "/api/model")
            models = {}
            for m in (r or {}).get("data", []):
                models.setdefault(m["providerID"], []).append({"id": m["modelID"], "enabled": m.get("enabled"), "status": m.get("status")})
            out["models"] = {k: (v if k.startswith("fake") else {"count": len(v), "enabled": sum(1 for x in v if x["enabled"]), "disabled": sum(1 for x in v if not x["enabled"])}) for k, v in models.items()}
            out["turn_on_fake-a"] = turn_on(s, ra, "fake-a", "a")
            out["turn_on_fake-b"] = turn_on(s, rb, "fake-b", "b")
            c, r = s.api("GET", "/api/model/default")
            out["model_default_http"] = c
    finally:
        sa.shutdown(); sb.shutdown()
    print(label, "->", json.dumps({k: out.get(k) for k in ("providers", "turn_on_fake-b")}))
    return out

V = [
    variant("P0 baseline: no lever"),
    variant("P1 policies [provider.use fake-b deny]", {"policies": [P("provider.use", "fake-b", "deny")]}),
    variant("P2 policies [provider.use * deny, provider.use fake-a allow]", {"policies": [P("provider.use", "*", "deny"), P("provider.use", "fake-a", "allow")]}),
    variant("P3 partial providers.fake-b.models.fake-model.disabled:true", {"providers": {"fake-b": {"models": {"fake-model": {"disabled": True}}}}}),
    variant("P4 `auto`: providers with an env list, variable unset (fake-c) and set (fake-d)", with_env=True),
]
save("c7-providers", {"question": "C7: the provider lever and `auto`", "variants": V})
