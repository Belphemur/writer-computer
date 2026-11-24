# Recording and scrub tools

Python, standard library only, run with `python3 -I`. They record OpenCode's real protocol into raw captures, scrub those into the fixtures one level up, and refresh the pinned contract. No absolute path, user name, host, id or account detail is written in them: everything is an argument or an environment variable.

Safety, applied by default (`oc.py`): each scenario starts its own `opencode serve` on `127.0.0.1` with a free port (never 4096) and a random password, an empty Writer-owned `XDG_CONFIG_HOME` under the work folder and `OPENCODE_CONFIG` pointing at a file there, with `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_AUTOUPDATE=1` and `OPENCODE_DISABLE_PROJECT_CONFIG=1` (a vault's own `opencode.json` is ignored; scenario `s15` shows it), after stripping every inherited `OPENCODE_*` variable and recreating the config home empty; it never runs `opencode service`, never calls an auth or credential endpoint, never reads OpenCode's config or data files, and always stops the server (and deletes the sessions and saved permission rules it created, only those). The real `HOME` stays so the user's own login resolves for the model.

Files: `oc.py` (the helper: server, event stream, calls), `run.py` (runs scenarios), `s01_text.py` ... `s12_rest.py` (one scenario each), `mcp_server.cjs` (a trivial stdio MCP server), `refresh_contract.py`, `used.json` (the routes and events Writer uses; interim, phase 2 derives it from `features/opencode/rust/opencode_api.rs`), `scrub.py`.

## After an OpenCode upgrade

1. Refresh the contract and read the diff of what Writer uses:
   `python3 -I refresh_contract.py --out ../../contract --previous ../../contract/openapi-<old>.json` (add `--bin <path>` for a non-default binary). It writes `openapi-<new>.json` and prints added and removed routes and events and, for those in `used.json`, which request, parameter or response fields changed. Exit code 1 means something Writer uses changed.
2. Re-record the scenarios into a scratch folder (`--work`, default a fresh temp folder; `oc.py` refuses one inside a git checkout, and `refresh_contract.py` takes `--work` too), using a free model:
   `python3 -I run.py --work <scratch> --model <provider/model> [--image-model ...] [--nologin-model ...] [--openapi ../../contract/openapi-<new>.json] [--scenarios all]` (`--list` shows the names; a scenario sends a few short prompts).
3. Scrub into the fixtures (the only way they enter the repo), passing words that must never appear (your employer, an account name) with `--deny` or `OC_SCRUB_DENY`:
   `python3 -I scrub.py --raw <scratch>/raw --out .. --deny word,word`. It ends with the check and exits 1 if anything is left.
4. Update the pinned version (`minVersion`, the contract file name) and run the contract test and the mapper golden tests (`WRITER_UPDATE_GOLDEN=1 cargo test golden` regenerates the goldens deliberately).
5. Review the whole diff of `fixtures/` and the goldens by eye before committing: a changed event order or field is a protocol change, not noise.

Raw captures and the work folder hold unscrubbed local paths: keep them outside the repo and delete them after step 3.
