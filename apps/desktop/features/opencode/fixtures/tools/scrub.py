"""The only way captures enter the repo: scrub raw recordings into fixtures, then check them (stdlib only).

  python3 -I scrub.py --raw DIR --out DIR [--only name,name] [--deny word,word]     scrub, then check
  python3 -I scrub.py --check DIR [--deny word,word]             check only (what the cargo test also asserts)

Scrubbing (applied to every string, including inside base64 values and cursors):
- the home directory becomes /home/user; a recorder work folder's `cwd-<name>` becomes /vault; OS temp paths
  become /tmp/opencode; the user name, host name and ports are faked;
- every session, message, event, permission, form, saved-rule, shell, MCP-integration and tool-call id, the
  project id and every 64-hex instruction hash becomes a stable fake (`ses_fake0001`, `call-fake-0001`, ...),
  numbered in arrival order per file, so relations survive;
- base64 `cursor` values are decoded, scrubbed and re-encoded;
- keys credential, auth, headers, apiKey, token, password, email, account, org and orgID are dropped;
- a provider id that is not `opencode` (the user's setup) becomes `fake-provider` and its model id `fake-model`;
- a provider auth error message is replaced; the at-sign is JSON-escaped (so an e-mail grep finds nothing).
The check fails (exit 1) on: the user name, home path, host name, `--deny` words (also from OC_SCRUB_DENY, e.g.
an employer name), an at-sign, bearer or authorization strings, org ids, temp-path prefixes, a port other than 0,
and any id without `fake` in it, in the text and in every base64 value that decodes to text.
"""
import argparse, base64, json, os, re, socket, sys

HOME = os.path.expanduser("~")
USER = os.path.basename(HOME)
HOST = socket.gethostname().split(".")[0]
ALLOWED_PROVIDERS = {"opencode", "fake-provider"}

# fixture name -> (raw events file stem, {key: raw file}, raw run stem for the server.connected frame)
FIXTURES = {
    "text": ("s01-text", {"messages": "s01-text.messages.json"}, "s01"),
    "edit": ("s02-edit", {"messages": "s02-edit.messages.json", "rest": "s02-edit.rest.json"}, "s02"),
    "shell-reject": ("s03-shell-reject", {"messages": "s03-shell-reject.messages.json"}, "s03"),
    "shell-always": ("s03-shell-always", {"messages": "s03-shell-always.messages.json", "rest": "s03-shell.rest.json"}, "s03"),
    "question": ("s04-question", {"messages": "s04-question.messages.json"}, "s04"),
    "subagent": ("s05-subagent", {"parent": "s05-subagent-parent.messages.json", "child": "s05-subagent-child.messages.json"}, "s05"),
    "steer-queue": ("s06-steer-queue", {"messages": "s06-steer-queue.messages.json", "log-resync": "s10-log-after-mid.sse"}, "s06"),
    "interrupt": ("s06-interrupt", {"messages": "s06-interrupt.messages.json"}, "s06"),
    "mcp-codemode": ("s07-mcp", {"messages": "s07-mcp.messages.json"}, "s07"),
    "mcp-direct": ("s07b-mcp-direct", {"messages": "s07b-mcp-direct.messages.json"}, "s07b"),
    "error-unknown-model": ("s08-unknown-model", {"messages": "s08-unknown-model.messages.json"}, "s08"),
    "error-unknown-provider": ("s08-unknown-provider", {"messages": "s08-unknown-provider.messages.json"}, "s08"),
    "error-provider-auth": ("s08-provider-without-login", {"messages": "s08-provider-without-login.messages.json"}, "s08"),
    "files-mention": ("s09-files-mention", {"messages": "s09-files-mention.messages.json"}, "s09"),
    # phase 2 captures
    "tool-write": ("s16-write", {"messages": "s16-write.messages.json"}, "s16"),
    "tool-search": ("s16-search", {"messages": "s16-search.messages.json"}, "s16"),
    "question-multi": ("s17-multi", {"messages": "s17-multi.messages.json"}, "s17"),
    "question-skip": ("s17-skip", {"messages": "s17-skip.messages.json"}, "s17"),
    "subagent-child-edit": ("s18-child-edit", {"parent": "s18-child-edit-parent.messages.json", "child": "s18-child-edit-child.messages.json"}, "s18b"),
    "subagent-failed": ("s19-subagent-failed", {"parent": "s19-subagent-failed-parent.messages.json"}, "s19"),
    # permission model captures (s29 to s31, spec 10.9)
    "perm-parent-deny-child-edit": ("s29a", {}, "s29a"),
    "perm-session-allow-agent-deny": ("s29a2", {}, "s29a2"),
    "perm-agent-deny-empty-session": ("s29b-w-deny", {}, "s29b"),
    "perm-agent-ask-empty-session": ("s29b-w-ask", {}, "s29b"),
    "perm-child-own-rules": ("s29d-kid-ask", {}, "s29d-kid-ask"),
    "perm-child-config-rules": ("s29d-kid-plain", {}, "s29d-kid-plain"),
    "perm-saved-vs-agent-deny": ("s29e", {}, "s29e"),
    "perm-switch-deny-to-allow": ("s30c-w-deny-to-w-allow", {}, "s30c-w-deny"),
    "perm-switch-allow-to-deny": ("s30c-w-allow-to-w-deny", {}, "s30c-w-allow"),
    "perm-env-shell-probe": ("s30f", {}, "s30f"),
    "perm-env-shell-wrapper": ("s31b", {}, "s31b"),
    "perm-env-ps-probe": ("s31c", {}, "s31c"),
    "perm-plan-deny-vs-saved": ("s32g", {}, "s32g"),
    "perm-session-deny-vs-child-allow": ("s32h", {}, "s32h"),
    "perm-subagent-deny-by-resource": ("s30g", {}, "s30g"),
    # phase 3 captures (config load, rule shape and order, the base of a relative memory path)
    "config-rule-order-reads-allowed": ("s36-w", {"results": "s36-results.json"}, "s36"),
    "config-rule-order-ask-then-deny": ("s36-w-order", {}, "s36"),
    "config-rule-order-deny-then-read": ("s36-w-role", {}, "s36"),
    "memory-base-no-git": ("s37-1-no-git-dir-is-root", {"results": "s37-results.json"}, "s371-no-git-dir-is-root"),
    "memory-base-git-dir-below": ("s37-2-git-dir-below", {}, "s372-git-dir-below"),
    "memory-base-git-dir-is-root": ("s37-3-git-dir-is-root", {}, "s373-git-dir-is-root"),
    "steer-now": ("s20-steer-now", {"messages": "s20-steer-now.messages.json"}, "s20"),
    "reject-message": ("s21-reject", {"messages": "s21-reject.messages.json"}, "s21"),
    "codemode-failures": ("s22-codemode-failures", {"messages": "s22-codemode-failures.messages.json"}, "s22"),
}
NOISE = {"plugin.updated", "config.updated", "integration.updated", "provider.updated", "model.updated", "agent.updated", "command.updated",
         "skill.updated", "artifact.updated", "websearch.updated", "reference.updated", "project.updated"}
DROP_KEYS = {"credential", "auth", "headers", "apiKey", "token", "password", "email", "account", "org", "orgID"}
ID_RE = re.compile(r"\b(?:ses|msg|evt|per|frm|psv|sh|mcp)_[0-9A-Za-z]{10,}|call-[0-9a-f]{8}-[0-9a-f-]{27}|\b[0-9a-f]{64}\b|\b[0-9a-f]{40}\b")
B64_RE = re.compile(r"[A-Za-z0-9+/_-]{20,}={0,2}")


def b64decode(s):
    for fn in (base64.b64decode, base64.urlsafe_b64decode):
        try:
            return fn(s + "=" * (-len(s) % 4))
        except Exception:
            pass
    return None


class Scrubber:
    def __init__(self):
        self.ids, self.count = {}, {}

    def ident(self, m):
        s = m.group(0)
        if s not in self.ids:
            kind = "call" if s.startswith("call-") else "hash" if re.fullmatch(r"[0-9a-f]{64}", s) else "prj" if re.fullmatch(r"[0-9a-f]{40}", s) else s.split("_")[0]
            self.count[kind] = self.count.get(kind, 0) + 1
            n = self.count[kind]
            self.ids[s] = f"call-fake-{n:04d}" if kind == "call" else f"{kind}_fake{n:04d}"
        return self.ids[s]

    def text(self, t):
        t = re.sub(r"(file://)?/[^\s\"\\:]*?/cwd-[A-Za-z0-9]+", lambda m: (m.group(1) or "") + "/vault", t)
        t = re.sub(r"(?:/private)?/var/folders/[^\s\"\\]*|/private/tmp/[^\s\"\\]*", "/tmp/opencode", t)
        if HOME and HOME != "/":
            t = t.replace(HOME, "/home/user")
        if len(USER) >= 4 and USER not in ("user", "root"):
            t = re.sub(re.escape(USER), "user", t, flags=re.I)
        if HOST and len(HOST) >= 4:
            t = re.sub(re.escape(HOST), "fake-host", t, flags=re.I)
        t = re.sub(r"127\.0\.0\.1:\d+", "127.0.0.1:0", t)
        return ID_RE.sub(self.ident, t)

    def cursor(self, s):
        raw = b64decode(s)
        try:
            obj = json.loads(raw)
        except Exception:
            return "ZmFrZQ"
        return base64.urlsafe_b64encode(json.dumps(self.value(obj), separators=(",", ":")).encode()).decode().rstrip("=")

    def value(self, v, key=None):
        if isinstance(v, dict):
            out = {}
            for k, x in v.items():
                if k in DROP_KEYS:
                    continue
                if k == "cursor" and isinstance(x, dict):
                    out[k] = {a: (self.cursor(b) if isinstance(b, str) else b) for a, b in x.items()}
                elif k == "hostname":
                    out[k] = "fake-host"
                elif k == "pid" and isinstance(x, int):
                    out[k] = 1
                else:
                    out[k] = self.value(x, k)
            if isinstance(out.get("providerID"), str) and out["providerID"] not in ALLOWED_PROVIDERS:
                out["providerID"] = "fake-provider"
                for mk in ("id", "modelID"):
                    if mk in out:
                        out[mk] = "fake-model"
            if isinstance(out.get("error"), dict) and str(out["error"].get("type", "")).startswith("provider.auth"):
                out["error"]["message"] = "Not signed in to this provider."
            return out
        if isinstance(v, list):
            return [self.value(x) for x in v]
        if isinstance(v, str):
            return self.text(v)
        return v


def dumps(o, **kw):
    return json.dumps(o, ensure_ascii=True, **kw).replace("@", "\\u0040")  # no literal at-sign in the fixtures


def first_frame(raw_dir, run):
    p = os.path.join(raw_dir, run + ".sse")
    for line in open(p):
        if line.startswith("data: ") and '"server.connected"' in line:
            return json.loads(line[6:])
    raise SystemExit(f"{p}: no server.connected frame")


def scrub(raw, out, only=()):
    os.makedirs(out, exist_ok=True)
    for name, (ev, files, run) in FIXTURES.items():
        if only and name not in only:
            continue
        sc = Scrubber()
        evs = [json.loads(l) for l in open(os.path.join(raw, ev + ".events.jsonl"))]
        evs = [first_frame(raw, run)] + [e for e in evs if e["type"] not in NOISE]
        with open(os.path.join(out, name + ".sse"), "w") as f:
            for e in evs:
                f.write("data: " + dumps(sc.value(e), separators=(",", ":")) + "\n\n")
        bundle = {}
        for key, rf in files.items():
            p = os.path.join(raw, rf)
            bundle[key] = sc.text(open(p).read()) if rf.endswith(".sse") else sc.value(json.load(open(p)))
        with open(os.path.join(out, name + ".json"), "w") as f:
            f.write(dumps(bundle, indent=1) + "\n")
    scrub_results(raw, out, only)
    rest = {}
    for fn in ("s12-rest.json", "s13-rest.json", "s14-rest.json"):  # reply collections recorded without a scenario
        if os.path.exists(os.path.join(raw, fn)):
            rest.update(json.load(open(os.path.join(raw, fn))))
    if rest and not only:
        with open(os.path.join(out, "rest.json"), "w") as f:
            f.write(dumps(Scrubber().value(rest), indent=1) + "\n")


# fixtures that are one captured reply, no event stream: name -> raw file
RESULTS_ONLY = {"config-load": "s35-results.json"}


def scrub_results(raw, out, only=()):
    for name, rf in RESULTS_ONLY.items():
        if only and name not in only:
            continue
        with open(os.path.join(out, name + ".json"), "w") as f:
            f.write(dumps(Scrubber().value(json.load(open(os.path.join(raw, rf)))), indent=1) + "\n")


def check(root, deny):
    words = [w for w in [USER if len(USER) >= 4 and USER not in ("user", "root") else "", HOST if len(HOST) >= 4 else "", "Users/", "Bearer", "wrk_", "Authorization", "/private/", "/var/folders", "apiKey", "credential", "@"] + deny if w]
    id_bad = re.compile(r"\b(?:ses|msg|evt|per|frm|psv|sh|mcp)_(?!fake)[0-9A-Za-z]{10,}|call-(?!fake)[0-9a-f]{8}-|\b[0-9a-f]{40,64}\b")
    bad = []

    def scan(fn, t, where):
        low = t.lower()
        for w in words:
            if w.lower() in low:
                bad.append((fn, where, w))
        if id_bad.search(t):
            bad.append((fn, where, "unfaked id/hash " + id_bad.search(t).group(0)[:12]))
        for m in re.finditer(r"127\.0\.0\.1:(\d+)", t):
            if m.group(1) != "0":
                bad.append((fn, where, "port " + m.group(1)))
        if re.search(r"/home/(?!user\b)", t) or "/Users/" in t:
            bad.append((fn, where, "foreign home path"))

    for fn in sorted(os.listdir(root)):
        if not fn.endswith((".sse", ".json")):
            continue
        t = open(os.path.join(root, fn)).read()
        scan(fn, t, "text")
        for m in B64_RE.finditer(t):
            raw = b64decode(m.group(0))
            if raw:
                try:
                    scan(fn, raw.decode("utf-8"), "base64")
                except UnicodeDecodeError:
                    pass
    if bad:
        print("SCRUB CHECK FAILED:", bad[:20])
        sys.exit(1)
    print("scrub check ok:", len([f for f in os.listdir(root) if f.endswith((".sse", ".json"))]), "files")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--raw")
    p.add_argument("--out")
    p.add_argument("--check")
    p.add_argument("--only", default="", help="comma-separated fixture names to (re)scrub, when the raw captures of the others are gone")
    p.add_argument("--deny", default="", help="comma-separated extra words that must not appear (also OC_SCRUB_DENY)")
    a = p.parse_args()
    deny = [w for w in (a.deny + "," + os.environ.get("OC_SCRUB_DENY", "")).split(",") if w]
    if a.check:
        check(a.check, deny)
    elif a.raw and a.out:
        scrub(a.raw, a.out, [n for n in a.only.split(',') if n])
        check(a.out, deny)
    else:
        p.error("give --raw and --out, or --check")


if __name__ == "__main__":
    main()
