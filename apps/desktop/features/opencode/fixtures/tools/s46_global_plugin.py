"""C10 (spec 4.13): what a GLOBAL local plugin can reach under Writer's `*: ask`, and what it costs at start. A plugin file
in the synthetic config home's `plugins/` folder, or named in the config's `plugins` array, in the 2.4.0 definition shape
(`export default {id, setup(ctx)}`: the server answers a plain function with `Plugin must export a default definition with an
id and an effect or setup function`). The plugin writes a marker when its setup runs, records the surface of the context it is
handed (service and method names, never values), registers a `permission.hook` and an `event.subscribe` that try to answer a
permission request, and the fake model scripts one `edit` call under `*: ask`. Per variant: when setup ran (before any API
call or at the first location-scoped one), the plugin's state in GET /api/plugin, whether the hooks were invoked, whether the
edit was asked and whether the file changed. A plugin runs inside the OpenCode server process with the user's rights: nothing
here limits it. The auto-answer attempts are a best effort from the public name list: a hook that never fires is NOT proof
that a plugin cannot answer a request (see the spec)."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gc_helpers import *

PLUGIN = r'''
import { appendFileSync } from "node:fs"
const log = (o) => appendFileSync(process.env.C10_MARKER, JSON.stringify({ t: Date.now(), ...o }) + "\n")
export default {
  id: "c10-plug",
  setup: async (ctx) => {
    log({ event: "setup", surface: Object.fromEntries(Object.keys(ctx).map((k) => [k, ctx[k] && typeof ctx[k] === "object" ? Object.keys(ctx[k]) : typeof ctx[k]])) })
    await ctx.permission.hook(async (...args) => { log({ event: "permission.hook invoked", argc: args.length }); return undefined })
    await ctx.event.subscribe(async (ev) => { if (ev && String(ev.type).startsWith("permission")) log({ event: "event seen", type: ev.type }) })
    return {}
  },
}
'''
EDIT = {"path": "a.txt", "oldString": "alpha", "newString": "gamma"}

def events(marker):
    return [json.loads(l) for l in open(marker).read().splitlines() if l.strip()] if os.path.exists(marker) else []

def variant(label, how):
    marker = os.path.join(WORK, "c10.mark")
    if os.path.exists(marker): os.remove(marker)
    srv, port, rec = fake("c10", call="edit", args=EDIT, reply="done")
    glob = {"providers": {"fake-a": provider(port)}}
    if how == "config":
        glob["plugins"] = [os.path.join(WORK, "xdg-c10", "opencode", "plugins", "plug.js")]
    out = {"variant": label, "how": how}
    try:
        with Server("c10", cfg=writer_cfg(), global_config=glob, global_files={"plugins/plug.js": PLUGIN}, env={"C10_MARKER": marker}, files={"a.txt": "alpha\n"}, attach=False) as s:
            t0 = s.t_ready
            time.sleep(4)
            out["setup_ran_before_any_api_call"] = any(e["event"] == "setup" for e in events(marker))
            s.api("GET", "/api/info"); s.attach()
            time.sleep(2)
            t = time.time()
            c, r = s.api("GET", "/api/plugin")
            ours = [p for p in (r or {}).get("data", []) if (p.get("source") or {}).get("type") == "local"]
            out["plugin_list"] = {"http": c, "entries": len((r or {}).get("data", [])), "ours": [{"source_type": (p.get("source") or {}).get("type"), "state": (p.get("state") or {}).get("status"), "features": p.get("features")} for p in ours], "ms": int((time.time() - t) * 1000)}
            setup = next((e for e in events(marker) if e["event"] == "setup"), None)
            out["setup_ran"] = bool(setup)
            out["setup_ms_after_ready"] = (setup["t"] - t0) if setup else None
            out["context_surface"] = setup["surface"] if setup else None
            sid = s.session(model="fake-model", provider="fake-a", agent="writer", perms=[])
            n = len(s.events)
            s.prompt(sid, "edit a.txt")
            asked = []
            end = s.drive(sid, lambda e: (asked.append(e["data"]["action"]), "reject")[1], timeout=40, start=n)
            time.sleep(1)
            out["edit_asked"] = "edit" in asked
            out["a.txt_after"] = open(os.path.join(s.cwd, "a.txt")).read().strip()
            out["permission_hook_invoked"] = any(e["event"] == "permission.hook invoked" for e in events(marker))
            out["event_subscription_saw_permission"] = [e["type"] for e in events(marker) if e["event"] == "event seen"]
            out["turn"] = end["type"] if end else "timeout"
    finally:
        srv.shutdown()
    print(label, "->", json.dumps({k: out.get(k) for k in ("setup_ran_before_any_api_call", "setup_ran", "setup_ms_after_ready", "plugin_list", "edit_asked", "permission_hook_invoked")}))
    return out

R = {"question": "C10: what can a global plugin reach, and when does it load?", "variants": [
    variant("plugin in the global plugins/ folder", "folder"),
    variant("plugin named in the global config `plugins` array", "config"),
]}
save("c10-plugin", R)
