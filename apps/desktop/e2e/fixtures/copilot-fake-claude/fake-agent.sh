#!/bin/sh
# Stand-in for the other agent CLIs Copilot Agent Mode drives (codex-acp, opencode): just enough
# to prove detection and configuration. Installed under several names by setup.sh; every
# invocation appends `<name>\t<args>` to agents-invocations.log next to this file.
name=$(basename "$0")
here=$(cd "$(dirname "$0")" && pwd -P)
printf '%s\t%s\n' "$name" "$*" >> "$here/../../agents-invocations.log"
case "$name:$1" in
  opencode:--version) echo "2.2.7" ;;
  codex-acp:--version) echo "codex-acp 2.1.0" ;;
  *:cli) echo "Open https://example.com/codex-login to continue" ;;
  *) cat >/dev/null ;; # an ACP session: stay up reading stdin (no EPIPE for the plugin), exit at EOF
esac
