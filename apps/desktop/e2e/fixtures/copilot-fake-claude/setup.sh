#!/bin/sh
# Builds a scratch vault for the Copilot + fake-claude e2e and seeds the e2e
# app's data dir. Prints `KEY=value` lines (VAULT, EXTRA_PATH, LOG) on stdout;
# everything else goes to stderr.
#
# Copilot's code is NOT in this repo (AGPL-3.0): main.js/manifest.json/styles.css
# are downloaded from the official GitHub release into a gitignored cache.
#
# Usage: setup.sh [vault-dir]    (default: a fresh mktemp dir)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd -P)
E2E=$(cd "$HERE/../.." && pwd -P)
VERSION=4.0.20
CACHE="$E2E/.cache/copilot-$VERSION"
BASE="https://github.com/logancyang/obsidian-copilot/releases/download/$VERSION"
DATA="$HOME/Library/Application Support/com.writer-computer.e2e"

mkdir -p "$CACHE"
for f in main.js manifest.json styles.css; do
  if [ ! -s "$CACHE/$f" ]; then
    echo "downloading $f" >&2
    curl -fsSL --retry 2 -o "$CACHE/$f.part" "$BASE/$f" || { rm -f "$CACHE/$f.part"; echo "download failed: $f" >&2; exit 2; }
    mv "$CACHE/$f.part" "$CACHE/$f"
  fi
done
grep -q '"id": *"copilot"' "$CACHE/manifest.json" && grep -q "\"version\": *\"$VERSION\"" "$CACHE/manifest.json" \
  || { echo "cached manifest is not copilot $VERSION" >&2; exit 2; }

NODE=$(command -v node) || { echo "node not found" >&2; exit 2; }
NODE=$(cd "$(dirname "$NODE")" && pwd -P)/$(basename "$NODE")

VAULT=${1:-$(mktemp -d "${TMPDIR:-/tmp}/writer-copilot-e2e.XXXXXX")}
mkdir -p "$VAULT/.obsidian/plugins/copilot" "$VAULT/.bin"
VAULT=$(cd "$VAULT" && pwd -P)
for f in main.js manifest.json styles.css; do cp "$CACHE/$f" "$VAULT/.obsidian/plugins/copilot/$f"; done
rm -f "$VAULT/.obsidian/plugins/copilot/data.json"
printf '["copilot"]' > "$VAULT/.obsidian/community-plugins.json"
printf '# Alpha\n\nHello from the alpha note.\n' > "$VAULT/alpha.md"

# The fake is a sh wrapper with the ABSOLUTE node path baked in, so it does not
# depend on the PATH the app hands to the child.
cp "$HERE/fake-claude.js" "$VAULT/.bin/fake-claude.js"
rm -f "$VAULT/.bin/claude-invocations.log"
cat > "$VAULT/.bin/claude" <<WRAP
#!/bin/sh
exec "$NODE" "\$(dirname "\$0")/fake-claude.js" "\$@"
WRAP
chmod +x "$VAULT/.bin/claude"

# Seed ONLY these three files in the e2e app's data dir.
mkdir -p "$DATA"
rm -f "$DATA/recent_workspaces.json" "$DATA/plugins_trust.json" "$DATA/plugins_proc_consent.json"
printf '["%s"]' "$VAULT" > "$DATA/recent_workspaces.json"
printf '{"%s": true}' "$VAULT" > "$DATA/plugins_trust.json"
# Format: { vault: { plugin id: [absolute program] } } (src-tauri/src/plugin_consent.rs)
printf '{"%s": {"copilot": ["%s/.bin/claude"]}}' "$VAULT" "$VAULT" > "$DATA/plugins_proc_consent.json"

echo "VAULT=$VAULT"
echo "EXTRA_PATH=$VAULT/.bin"
echo "LOG=$VAULT/.bin/claude-invocations.log"
