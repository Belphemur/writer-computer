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
printf '# Beta\n\nHello from the beta note.\n' > "$VAULT/beta.md"

# The fake is a sh wrapper with the ABSOLUTE node path baked in, so it does not
# depend on the PATH the app hands to the child.
cp "$HERE/fake-claude.js" "$VAULT/.bin/fake-claude.js"
rm -f "$VAULT/.bin/claude-invocations.log"
cat > "$VAULT/.bin/claude" <<WRAP
#!/bin/sh
exec "$NODE" "\$(dirname "\$0")/fake-claude.js" "\$@"
WRAP
chmod +x "$VAULT/.bin/claude"

# Fake codex-acp / opencode (Copilot Agent Mode's other agents) for specs/copilot-agents-config.spec.js.
# They live OUTSIDE the vault (like a real install): "$VAULT-agents". agents/path is put on the
# login PATH by run.sh for that spec only; agents/typed is NOT on PATH (the "type a custom path"
# flow). Each folder also has a provenance.json: Copilot's Codex check reads it next to the adapter.
AGENTS="$VAULT-agents"
rm -rf "$AGENTS"
ARCH=$(uname -m); [ "$ARCH" = x86_64 ] && ARCH=x64
for d in path typed; do
  mkdir -p "$AGENTS/$d/bin"
  for n in codex-acp opencode; do
    cp "$HERE/fake-agent.sh" "$AGENTS/$d/bin/$n"
    chmod +x "$AGENTS/$d/bin/$n"
  done
  printf '{"acpVersion":"2.1.0","packagingRevision":1,"target":"darwin-%s"}' "$ARCH" > "$AGENTS/$d/bin/provenance.json"
done
rm -f "$AGENTS/agents-invocations.log"

# Seed ONLY these three files in the e2e app's data dir.
mkdir -p "$DATA"
rm -f "$DATA/recent_workspaces.json" "$DATA/plugins_trust.json" "$DATA/plugins_proc_consent.json"
printf '["%s"]' "$VAULT" > "$DATA/recent_workspaces.json"
printf '{"%s": true}' "$VAULT" > "$DATA/plugins_trust.json"
# Format: { vault: { plugin id: ["*" or absolute programs] } } (src-tauri/src/plugin_consent.rs)
printf '{"%s": {"copilot": ["*"]}}' "$VAULT" > "$DATA/plugins_proc_consent.json"

echo "VAULT=$VAULT"
echo "EXTRA_PATH=$VAULT/.bin"
echo "LOG=$VAULT/.bin/claude-invocations.log"
echo "AGENTS=$AGENTS"
echo "OPEN_LOG=$VAULT/.bin/open-requests.log"
