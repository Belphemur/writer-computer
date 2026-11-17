#!/bin/sh
# sh fixtures/editor-plugin-isolation/run.sh "fx-good,fx-throw-update"   (from apps/desktop/e2e)
# Requires the e2e app already built. Screenshots go to $WRITER_E2E_SHOTS if set.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
E2E=$(cd "$HERE/../.." && pwd -P)
PATH="$HOME/.cargo/bin:$PATH"; export PATH
IDS=${1:-none}
VAULT=$(node "$HERE/setup.mjs" "${TMPDIR:-/tmp}/writer-iso-vault" "$IDS")
echo "vault: $VAULT plugins: $IDS"
export WRITER_E2E_ISO_PLUGINS="$IDS"
cd "$E2E"
exec pnpm exec wdio run ./wdio.conf.js --spec "$E2E/specs/editor-plugin-isolation.spec.js"
