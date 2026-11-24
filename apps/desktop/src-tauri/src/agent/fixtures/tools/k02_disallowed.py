"""K2 (native-agent-spec 7.1): does `--disallowedTools 'mcp__<server>__*'` keep a server's tools from the model, does the server
still START, what name does Claude give a server called `my.srv`, does a denied tool still run when the model calls it anyway,
and does a sub-agent see the tools. The model is the local fake (`shared/capture/fake_model.py`, the Anthropic wire), the key a
dummy, HOME and CLAUDE_CONFIG_DIR temp folders: no real model call. Claude 2.1.x defers MCP tools: their names reach the model
in a system reminder that lists the deferred tools (the `tools` array holds a ToolSearch tool), so "offered" here means: the
`mcp__<server>__<tool>` names found in the request body, and in the `tools` array. Facts only; the prompts are never saved."""
import json, os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from k_common import *

MCP_NAME = re.compile(r"mcp__[A-Za-z0-9_-]+__note_count")
AGENT_ARGS = {"description": "probe", "prompt": "say hi", "subagent_type": "general-purpose"}

def run_variant(label, servers, flags, call=None, call_args=None, user_servers=None, force=False):
    d = fresh("k2")
    marks_ = {n: os.path.join(d["root"], f"{n}.mark") for n in servers}
    mcp = {"mcpServers": {n: stdio(n, marks_[n]) for n in servers}}
    mcp_path = os.path.join(d["root"], "mcp.json")
    json.dump(mcp, open(mcp_path, "w"))
    if user_servers:
        umarks = {n: os.path.join(d["root"], f"u-{n}.mark") for n in user_servers}
        write_user_servers(d, {n: stdio(n, umarks[n]) for n in user_servers})
        marks_.update(umarks)
    rec = os.path.join(d["root"], "fm.jsonl")
    srv, port = fake_model.start(rec, call=call, args=call_args, reply="done", keep_body=True, force=force)
    args = ["-p", "go", "--output-format", "json"] + (["--mcp-config", mcp_path] if servers else []) + flags
    try:
        p, secs = run(args, d, base_url=f"http://127.0.0.1:{port}", timeout=120)
    finally:
        srv.shutdown()
    reqs = requests(rec)
    per = []
    for r in reqs:
        body = json.dumps(r.get("body") or {})
        msgs = (r.get("body") or {}).get("messages") or []
        last = msgs[-1].get("content") if msgs else None
        tr = None
        if isinstance(last, list):
            for blk in last:
                if isinstance(blk, dict) and blk.get("type") == "tool_result":
                    c = blk.get("content")
                    tr = (c if isinstance(c, str) else json.dumps(c))[:160]
        per.append({"last_tool_result": tr, "n": r["n"], "n_messages": r["n_messages"], "tools_array_mcp": [t for t in r["tools"] if t.startswith("mcp__")], "mcp_names_in_body": sorted(set(MCP_NAME.findall(body))), "has_agent_tool": "Agent" in r["tools"], "fired": r["fired"]})
    try:
        res = json.loads(p.stdout) if p.stdout.strip().startswith("{") else {}
    except ValueError:
        res = {}
    out = {"variant": label, "flags": flags, "exit": p.returncode, "seconds": secs,
           "spawned": sorted(n for n, m in marks_.items() if any(x["event"] == "spawn" for x in marks(m))),
           "initialized": sorted(n for n, m in marks_.items() if any(x["event"] == "initialize" for x in marks(m))),
           "tools_called_on_server": {n: [x.get("tool") for x in marks(m) if x["event"] == "tools/call"] for n, m in marks_.items() if any(x["event"] == "tools/call" for x in marks(m))},
           "requests": per, "permission_denials": [{"tool": x.get("tool_name"), "has_input": bool(x.get("tool_input"))} for x in res.get("permission_denials", [])], "is_error": res.get("is_error")}
    print(label, "->", json.dumps({k: out[k] for k in ("spawned", "tools_called_on_server", "permission_denials")}), [(q["n"], q["mcp_names_in_body"]) for q in per])
    return out

R = {"question": "K2: --disallowedTools on an MCP server", "claude_version": subprocess.run([BIN, "--version"], capture_output=True, text=True).stdout.strip(), "variants": []}
V = R["variants"]
V.append(run_variant("A baseline: --mcp-config probe", ["probe"], []))
V.append(run_variant("B --disallowedTools 'mcp__probe__*'", ["probe"], ["--disallowedTools", "mcp__probe__*"]))
V.append(run_variant("C --disallowedTools mcp__probe (server form)", ["probe"], ["--disallowedTools", "mcp__probe"]))
V.append(run_variant("D --disallowedTools mcp__probe__note_count (one tool)", ["probe"], ["--disallowedTools", "mcp__probe__note_count"]))
V.append(run_variant("E --strict-mcp-config with an empty --mcp-config, the server only in the user config", [], ["--strict-mcp-config", "--mcp-config", "{}"], user_servers=["usr"]))
V.append(run_variant("U server in the user config, --disallowedTools 'mcp__usr__*'", [], ["--disallowedTools", "mcp__usr__*"], user_servers=["usr"]))
V.append(run_variant("U0 server in the user config, no flag", [], [], user_servers=["usr"]))
V.append(run_variant("F the model calls the tool anyway, allowed by --allowedTools", ["probe"], ["--allowedTools", "mcp__probe__*"], call="mcp__probe__note_count", call_args={}, force=True))
V.append(run_variant("G the model calls the tool anyway, allowed AND disallowed (deny vs allow)", ["probe"], ["--allowedTools", "mcp__probe__*", "--disallowedTools", "mcp__probe__*"], call="mcp__probe__note_count", call_args={}, force=True))
V.append(run_variant("H0 sub-agent launched, no deny", ["probe"], ["--allowedTools", "Agent"], call="Agent", call_args=AGENT_ARGS, force=True))
V.append(run_variant("H1 sub-agent launched, --disallowedTools 'mcp__probe__*'", ["probe"], ["--allowedTools", "Agent", "--disallowedTools", "mcp__probe__*"], call="Agent", call_args=AGENT_ARGS, force=True))
# names Claude derives from server names (only the note_count tool of each is looked for)
names = ["my.srv", "my srv", "my:srv", "UPPER_case-1", "claude.ai Atlassian"]
d_names = run_variant("N names: servers called " + ", ".join(names), names, [])
R["names"] = d_names
V.append(d_names)
V.append(run_variant("N2 --disallowedTools 'mcp__my_srv__*' against my.srv, my srv and my:srv (the normalised prefix)", names, ["--disallowedTools", "mcp__my_srv__*"]))
V.append(run_variant("N3 --disallowedTools 'mcp__my.srv__*' (the raw name)", names, ["--disallowedTools", "mcp__my.srv__*"]))
save("k02-disallowed", R)
