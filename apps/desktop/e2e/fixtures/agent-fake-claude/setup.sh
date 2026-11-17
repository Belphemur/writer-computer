#!/bin/sh
# Scratch vault + fake `claude` for the native agent pane e2e. Prints KEY=value lines (VAULT,
# EXTRA_PATH, LOG) on stdout; everything else goes to stderr. Seeds ONLY recent_workspaces.json,
# plugins_trust.json and plugins_proc_consent.json (pseudo plugin id `writer-agent`) in the e2e
# app's data dir: a native dialog cannot be driven.
#
# Usage: setup.sh [vault-dir]    (default: a fresh mktemp dir)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
E2E=$(cd "$HERE/../.." && pwd -P)
FIXTURES=$(cd "$E2E/../src-tauri/src/agent/fixtures" && pwd -P)
DATA="$HOME/Library/Application Support/com.writer-computer.e2e"

NODE=$(command -v node) || { echo "node not found" >&2; exit 2; }
NODE=$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")

VAULT=${1:-$(mktemp -d "${TMPDIR:-/tmp}/writer-agent-e2e.XXXXXX")}
mkdir -p "$VAULT/.bin/scenarios" "$VAULT/Projects/Demo"
VAULT=$(cd "$VAULT" && pwd -P)
printf '# Alpha\n\nHello from the alpha note.\n' > "$VAULT/alpha.md"
printf '# Demo project\n' > "$VAULT/Projects/Demo/Overview.md"

cp "$HERE/fake-claude.cjs" "$VAULT/.bin/fake-claude.cjs"
cp "$FIXTURES"/*.jsonl "$VAULT/.bin/scenarios/"
rm -f "$VAULT/.bin/claude-invocations.log"
rm -rf "$VAULT/.bin/sessions"
# A sh wrapper with the ABSOLUTE node path baked in, so it does not depend on the PATH the app
# hands to the child. Sessions persist in the vault's .bin (resume works across app restarts).
cat > "$VAULT/.bin/claude" <<WRAP
#!/bin/sh
FAKE_CLAUDE_HOME="$VAULT/.bin/sessions" FAKE_CLAUDE_LOG="$VAULT/.bin/claude-invocations.log" exec "$NODE" "\$(dirname "\$0")/fake-claude.cjs" "\$@"
WRAP
chmod +x "$VAULT/.bin/claude"

mkdir -p "$DATA"
rm -f "$DATA/recent_workspaces.json" "$DATA/plugins_trust.json" "$DATA/plugins_proc_consent.json"
printf '["%s"]' "$VAULT" > "$DATA/recent_workspaces.json"
printf '{"%s": true}' "$VAULT" > "$DATA/plugins_trust.json"
# Format: { vault: { plugin id: ["*" or absolute programs] } } (src-tauri/src/plugin_consent.rs)
printf '{"%s": {"writer-agent": ["*"]}}' "$VAULT" > "$DATA/plugins_proc_consent.json"

echo "VAULT=$VAULT"
echo "EXTRA_PATH=$VAULT/.bin"
echo "LOG=$VAULT/.bin/claude-invocations.log"
