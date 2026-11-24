"""Run the recording scenarios against OpenCode's own private server (stdlib only, run with `python3 -I`).

  python3 -I run.py --work DIR [--bin opencode] [--model provider/model] [--image-model provider/model]
                    [--nologin-model provider/model] [--scenarios s01_text,s02_edit | all | global] [--fixtures DIR] [--list]

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
    "s16_tools", "s17_questions", "s18_child_permissions", "s19_subagent_failed", "s20_steer_now", "s21_reject_message", "s22_codemode_failures", "s23_ids_files_skills", "s24_saved_and_vault_rules", "s25_config_paths_and_agent_deny", "s26_config_abs_paths", "s27_skills_paths", "s28_vault_skills",
]
# The global-config and MCP-menu captures (spec 4.13). They need no model and no login: a synthetic global config in the work
# folder, the local fake model (`shared/capture/fake_model.py`), `node` for the MCP servers. They are not part of `all`.
GLOBAL_SCENARIOS = [
    "s38_global_mcp_timing", "s39_mcp_off_levers", "s40_mcp_runtime_switch", "s41_global_agents", "s42_permission_merge",
    "s43_pinned_scalars", "s44_provider_switch", "s45_server_names", "s46_global_plugin",
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
    p.add_argument("--fixtures", default="", help="where the global-config scenarios (s38 to s46, `--scenarios global`) write their scrubbed fact files")
    p.add_argument("--list", action="store_true")
    a = p.parse_args()
    if a.list:
        print("\n".join(SCENARIOS + GLOBAL_SCENARIOS))
        return 0
    if not a.work:
        p.error("--work is required")
    names = SCENARIOS if a.scenarios == "all" else GLOBAL_SCENARIOS if a.scenarios == "global" else a.scenarios.split(",")
    env = dict(os.environ, OC_WORK=os.path.abspath(a.work), OC_BIN=a.bin, OC_MODEL=a.model, OC_IMAGE_MODEL=a.image_model,
               OC_NOLOGIN_MODEL=a.nologin_model, OC_OPENAPI=a.openapi, OC_FIXTURES=os.path.abspath(a.fixtures) if a.fixtures else "")
    failed = []
    for n in names:
        if n not in SCENARIOS + GLOBAL_SCENARIOS:
            p.error(f"unknown scenario {n}")
        print(f"== {n}", flush=True)
        r = subprocess.run([sys.executable, "-I", os.path.join(HERE, n + ".py")], env=env)
        if r.returncode:
            failed.append(n)
    print("failed:", failed or "none")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
