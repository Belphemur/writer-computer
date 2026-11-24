"""Run the recording scenarios against OpenCode's own private server (stdlib only, run with `python3 -I`).

  python3 -I run.py --work DIR [--bin opencode] [--model provider/model] [--image-model provider/model]
                    [--nologin-model provider/model] [--scenarios s01_text,s02_edit | all] [--list]

Each scenario starts its own `opencode serve` on 127.0.0.1 (free port, random password, empty Writer-owned
XDG_CONFIG_HOME under --work, never the user's background service or port 4096), records the event stream and
the REST replies under DIR/raw, and always stops the server. Scenarios send a few short prompts to --model
(use a free model). The real HOME stays in place so the user's own login resolves; nothing in it is read.
"""
import argparse, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCENARIOS = [
    "s01_text", "s02_edit", "s03_shell", "s04_question", "s05_subagent", "s06_interrupt_steer_queue",
    "s07_mcp", "s07b_mcp_direct", "s08_errors", "s09_extras", "s11_control", "s11b_instructions", "s12_rest", "s13_title", "s14_auth", "s15_project_config",
]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--work", help="output folder (raw captures, configs, logs)")
    p.add_argument("--bin", default="opencode")
    p.add_argument("--model", default="opencode/beam-free", help="provider/model of the chat model")
    p.add_argument("--image-model", default="opencode/hy4-flash-free", help="a model that accepts images")
    p.add_argument("--nologin-model", default="", help="provider/model of a configured provider with no login (optional)")
    p.add_argument("--openapi", default="", help="the pinned openapi-<version>.json, to check the served one against")
    p.add_argument("--scenarios", default="all")
    p.add_argument("--list", action="store_true")
    a = p.parse_args()
    if a.list:
        print("\n".join(SCENARIOS))
        return 0
    if not a.work:
        p.error("--work is required")
    names = SCENARIOS if a.scenarios == "all" else a.scenarios.split(",")
    env = dict(os.environ, OC_WORK=os.path.abspath(a.work), OC_BIN=a.bin, OC_MODEL=a.model, OC_IMAGE_MODEL=a.image_model,
               OC_NOLOGIN_MODEL=a.nologin_model, OC_OPENAPI=a.openapi)
    failed = []
    for n in names:
        if n not in SCENARIOS:
            p.error(f"unknown scenario {n}")
        print(f"== {n}", flush=True)
        r = subprocess.run([sys.executable, "-I", os.path.join(HERE, n + ".py")], env=env)
        if r.returncode:
            failed.append(n)
    print("failed:", failed or "none")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
