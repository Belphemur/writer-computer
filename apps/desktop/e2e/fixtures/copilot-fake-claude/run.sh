#!/bin/sh
# Runs specs/copilot-fake-claude.spec.js: builds the scratch vault + fake claude
# (setup.sh), then launches wdio with the environment the spec and the e2e app need.
#
#   sh fixtures/copilot-fake-claude/run.sh          (from apps/desktop/e2e)
#   SPEC=copilot-settings-tab.spec.js sh fixtures/copilot-fake-claude/run.sh   (another spec, same fixture)
#
# Requires: the e2e app already built (see e2e/README.md), network on first run
# (downloads Copilot 4.0.20 from its GitHub release into e2e/.cache), and Node 22
# for wdio. Set NODE22_BIN to a Node 22 bin dir if your default node is newer.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
E2E=$(cd "$HERE/../.." && pwd -P)
[ -n "${NODE22_BIN:-}" ] && PATH="$NODE22_BIN:$PATH"
PATH="$HOME/.cargo/bin:$PATH" # tauri-webdriver (cargo install tauri-webdriver --locked)
export PATH

OUT=$(sh "$HERE/setup.sh")
for kv in $OUT; do
  case "$kv" in
    VAULT=*) export WRITER_E2E_COPILOT_VAULT="${kv#VAULT=}" ;;
    EXTRA_PATH=*) export WRITER_E2E_EXTRA_PATH="${kv#EXTRA_PATH=}" ;;
    LOG=*) export WRITER_E2E_FAKE_CLAUDE_LOG="${kv#LOG=}" ;;
    AGENTS=*) export WRITER_E2E_AGENTS_DIR="${kv#AGENTS=}" ;;
    OPEN_LOG=*) export WRITER_E2E_OPEN_LOG="${kv#OPEN_LOG=}" ;; # e2e app builds only (Rust e2e feature)
  esac
done
# The agents-config spec wants fake codex-acp/opencode findable on PATH (Auto-detect).
case "${SPEC:-}" in
  copilot-agents-config*) export WRITER_E2E_EXTRA_PATH="$WRITER_E2E_EXTRA_PATH:$WRITER_E2E_AGENTS_DIR/path/bin" ;;
esac
echo "vault: $WRITER_E2E_COPILOT_VAULT"
cd "$E2E"
status=0
pnpm exec wdio run ./wdio.conf.js --spec "$E2E/specs/${SPEC:-copilot-fake-claude.spec.js}" || status=$?

# Phase E: the wdio session is over, the app has quit; no fake claude may outlive it.
sleep 2
if pgrep -f "$WRITER_E2E_COPILOT_VAULT/.bin/fake-claude.js" >/dev/null; then
  echo "FAIL: orphan fake claude process(es) after the app quit:" >&2
  pgrep -fl "$WRITER_E2E_COPILOT_VAULT/.bin/fake-claude.js" >&2
  pkill -f "$WRITER_E2E_COPILOT_VAULT/.bin/fake-claude.js" || true
  status=1
else
  echo "OK: no fake claude process left after the app quit"
fi
exit $status
