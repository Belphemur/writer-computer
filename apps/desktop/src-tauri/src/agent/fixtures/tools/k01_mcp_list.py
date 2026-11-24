"""K1 (native-agent-spec 7.1): what `claude mcp list` prints, for names with `.`, a space and `:`, and what the health check costs.
The temp user config (never the real one) holds the servers; no model is involved. Records the raw lines (paths scrubbed),
whether `claude mcp add` accepts such names, and the wall time for N healthy servers, for failing ones and for a dead remote.
`claude mcp list` spawns every stdio server of the config to check it: the marker files say so."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from k_common import *

def lines_of(out, d):
    return [l.replace(SRV, "<server>").replace(d["root"], "<run>") for l in out.splitlines() if l.strip()]

R = {"question": "K1: claude mcp list names and cost", "claude_version": subprocess.run([BIN, "--version"], capture_output=True, text=True).stdout.strip()}

# 1 names the CLI accepts to add
d = fresh("k1-add")
acc = {}
for name in ("plain", "with-dash_and_Under2", "my.srv", "my srv", "my:srv"):
    p, _ = run(["mcp", "add", "--scope", "user", name, "--", NODE, SRV, "--name", "x"], d)
    acc[name] = {"exit": p.returncode, "message": (p.stdout + p.stderr).strip().replace(SRV, "<server>").replace(d["root"], "<run>").splitlines()[0][:140]}
R["claude_mcp_add_accepts"] = acc

# 2 names written by hand into the user config (the way a connector, a plugin or a hand edit can produce them)
d = fresh("k1-names")
marks_ = {n: os.path.join(d["root"], f"{i}.mark") for i, n in enumerate(("plain", "my.srv", "my srv", "my:srv", "UPPER_case-1", "a: b"))}
write_user_servers(d, {n: stdio(n, m) for n, m in marks_.items()})
p, secs = run(["mcp", "list"], d)
R["hand_written_names"] = {"exit": p.returncode, "seconds": secs, "stdout_lines": lines_of(p.stdout, d), "stderr_lines": lines_of(p.stderr, d), "spawned_by_the_check": sorted(n for n, m in marks_.items() if any(x["event"] == "spawn" for x in marks(m)))}
print("names", json.dumps(R["hand_written_names"]["stdout_lines"], indent=0))

# 3 project .mcp.json servers
d = fresh("k1-project")
json.dump({"mcpServers": {"proj.srv": stdio("proj.srv"), "proj-ok": stdio("proj-ok")}}, open(os.path.join(d["cwd"], ".mcp.json"), "w"))
p, secs = run(["mcp", "list"], d)
R["project_mcp_json"] = {"seconds": secs, "stdout_lines": lines_of(p.stdout, d)}

# 4 timing
def timing(label, healthy, failing, dead_remote=False):
    d = fresh("k1-time")
    servers = {f"ok{i}": stdio(f"ok{i}") for i in range(healthy)}
    servers.update({f"bad{i}": stdio("bad", fail=True) for i in range(failing)})
    if dead_remote:
        servers["dead-remote"] = {"type": "http", "url": "http://127.0.0.1:9/mcp"}
    write_user_servers(d, servers)
    p, secs = run(["mcp", "list"], d)
    ls = lines_of(p.stdout, d)
    st = {"connected": sum("Connected" in l for l in ls), "failed": sum("Failed" in l for l in ls)}
    print(label, secs, st)
    return {"case": label, "healthy": healthy, "failing": failing, "dead_remote": dead_remote, "seconds": secs, "counts": st, "exit": p.returncode}
R["timing"] = [timing("1 healthy", 1, 0), timing("5 healthy", 5, 0), timing("10 healthy", 10, 0), timing("5 healthy, 3 failing", 5, 3), timing("5 healthy, 1 dead remote", 5, 0, True), timing("30 healthy", 30, 0)]
R["not_captured"] = "claude.ai connectors (names such as `claude.ai Atlassian`, tool prefix `mcp__claude_ai_Atlassian__`) need a login: not reproducible with a temp config and a dummy key"
save("k01-mcp-list", R)
