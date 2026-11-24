"""Refresh the pinned OpenAPI contract from a private OpenCode server and print what changed (stdlib only).

  python3 -I refresh_contract.py --out DIR [--bin opencode] [--previous DIR/openapi-<old>.json] [--work DIR]

--work holds the private server's config and logs (default: a fresh temporary directory, never inside a git
checkout).

Starts its own server (same safety rules as run.py), reads `GET /api/info` for the version and `GET /openapi.json`,
writes DIR/openapi-<version>.json, and, with --previous, prints the added and removed routes and events, and the
changes (request, parameters, responses; $refs resolved) in the routes and events listed in used.json.
Exit code 1 when something Writer uses changed, so an upgrade does not slip through.
"""
import argparse, json, os, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

HERE = os.path.dirname(os.path.abspath(__file__))


def resolve(node, schemas, depth=0, seen=()):
    if isinstance(node, dict):
        if "$ref" in node:
            name = node["$ref"].split("/")[-1]
            if name in seen or depth > 12:
                return "<" + name + ">"
            return resolve(schemas.get(name, {}), schemas, depth + 1, seen + (name,))
        return {k: resolve(v, schemas, depth, seen) for k, v in node.items() if k not in ("description", "title", "examples")}
    if isinstance(node, list):
        return [resolve(x, schemas, depth, seen) for x in node]
    return node


def routes(doc):
    out = {}
    schemas = doc.get("components", {}).get("schemas", {})
    for path, ops in doc.get("paths", {}).items():
        for method, op in ops.items():
            if isinstance(op, dict):
                out[f"{method.upper()} {path}"] = resolve({k: op.get(k) for k in ("parameters", "requestBody", "responses")}, schemas)
    return out


def events(doc):
    schemas = doc.get("components", {}).get("schemas", {})
    out = {}
    for name, sch in schemas.items():
        props = sch.get("properties", {}) if isinstance(sch, dict) else {}
        t = props.get("type", {}).get("enum") if isinstance(props.get("type"), dict) else None
        if t and len(t) == 1 and "data" in props and ("id" in props or "created" in props):
            out[t[0]] = resolve(sch, schemas)
    return out


def flat(node, prefix=""):
    if isinstance(node, dict):
        for k, v in node.items():
            yield from flat(v, f"{prefix}.{k}" if prefix else k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from flat(v, f"{prefix}[{i}]")
    else:
        yield prefix, node


def compare(label, old, new, used):
    changed = False
    print(f"{label}: {len(new)} now, {len(old)} before; added {sorted(set(new) - set(old))}; removed {sorted(set(old) - set(new))}")
    for key in sorted(used):
        if key not in new:
            print(f"  USED {key}: missing in the new contract")
            changed = True
        elif key in old and old[key] != new[key]:
            a, b = dict(flat(old[key])), dict(flat(new[key]))
            diff = sorted(k for k in set(a) | set(b) if a.get(k) != b.get(k))
            print(f"  USED {key}: changed at {diff[:12]}{' ...' if len(diff) > 12 else ''}")
            changed = True
    return changed


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--bin", default=None)
    p.add_argument("--previous", default="")
    p.add_argument("--work", default="", help="folder for the private server's config and logs (default: a temp dir)")
    a = p.parse_args()
    work = os.path.abspath(a.work) if a.work else tempfile.mkdtemp(prefix="oc-contract-")
    os.environ["OC_WORK"] = work  # before oc is imported: it reads its folders at import time
    if a.bin:
        os.environ["OC_BIN"] = a.bin
    from oc import Server
    with Server("contract", cfg={}) as s:
        code, info = s.api("GET", "/api/info")
        version = info["version"]
        code, doc = s.api("GET", "/openapi.json")
        assert code == 200 and "openapi" in doc, code
    os.makedirs(a.out, exist_ok=True)
    out = os.path.join(a.out, f"openapi-{version}.json")
    json.dump(doc, open(out, "w"), indent=1, sort_keys=False)
    print("wrote", os.path.basename(out), "for OpenCode", version)
    if not a.previous:
        return 0
    prev = json.load(open(a.previous))
    used = json.load(open(os.path.join(HERE, "used.json")))
    bad = compare("routes", routes(prev), routes(doc), used["routes"])
    bad = compare("events", events(prev), events(doc), used["events"]) or bad
    print("Writer-used contract changed" if bad else "Nothing Writer uses changed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
