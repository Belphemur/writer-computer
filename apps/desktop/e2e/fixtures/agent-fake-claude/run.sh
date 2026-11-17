#!/bin/sh
# Runs specs/agent-*.spec.js against the fake claude (setup.sh builds the vault).
#
#   sh fixtures/agent-fake-claude/run.sh                       (from apps/desktop/e2e)
#   SPEC=agent-history.spec.js sh fixtures/agent-fake-claude/run.sh
#
# Requires the e2e app already built (see e2e/README.md) and Node 22 for wdio (NODE22_BIN).
# No network, no real claude. Afterwards no fake claude may outlive the app.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
E2E=$(cd "$HERE/../.." && pwd -P)
[ -n "${NODE22_BIN:-}" ] && PATH="$NODE22_BIN:$PATH"
PATH="$HOME/.cargo/bin:$PATH" # tauri-webdriver (cargo install tauri-webdriver --locked)
export PATH

OUT=$(sh "$HERE/setup.sh")
for kv in $OUT; do
  case "$kv" in
    VAULT=*) export WRITER_E2E_AGENT_VAULT="${kv#VAULT=}" ;;
    EXTRA_PATH=*) export WRITER_E2E_EXTRA_PATH="${kv#EXTRA_PATH=}" ;;
    LOG=*) export WRITER_E2E_FAKE_CLAUDE_LOG="${kv#LOG=}" ;;
  esac
done
echo "vault: $WRITER_E2E_AGENT_VAULT"
cd "$E2E"
status=0
pnpm exec wdio run ./wdio.conf.js --spec "$E2E/specs/${SPEC:-agent-fake-claude.spec.js}" || status=$?

sleep 2
if pgrep -f "$WRITER_E2E_AGENT_VAULT/.bin/fake-claude.cjs" >/dev/null; then
  echo "FAIL: orphan fake claude process(es) after the app quit:" >&2
  pgrep -fl "$WRITER_E2E_AGENT_VAULT/.bin/fake-claude.cjs" >&2
  pkill -f "$WRITER_E2E_AGENT_VAULT/.bin/fake-claude.cjs" || true
  status=1
else
  echo "OK: no fake claude process left after the app quit"
fi
exit $status
