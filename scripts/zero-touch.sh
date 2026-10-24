#!/bin/sh
# Opt-in, owner only: switch an installed Mac runner to zero-touch (approve auto, access full).
# New runners start safe (dialog approval, worktree access, push never, requireSignedAuto on); this script is the one way
# out of that, and it keeps signing on: only tasks signed by a dispatcher key you trusted auto-run, anything else still asks you.
# Run it after the runner is installed (curl -fsSL <kitebook>/install.sh | sh -s -- <invite>, or runner.ts init + install):
#   ./scripts/zero-touch.sh [runner.json]   (default: the config the launchd job runs, else ~/.kitebook/runner.json)
# Undo: bun ~/.kitebook/client/runner.ts set <runner.json> approve dialog && ... set <runner.json> access worktree
set -eu
# RELAY_* (the names from before the rename to Kitebook) still work: each fills its unset KITEBOOK_* twin
for _v in $(env | sed -n 's/^RELAY_\([A-Za-z0-9_]*\)=.*/\1/p'); do eval "[ -n \"\${KITEBOOK_$_v+x}\" ] || export KITEBOOK_$_v=\"\$RELAY_$_v\""; done
PL=~/Library/LaunchAgents/dev.kitebook.runner.plist
ARGS=$([ -f "$PL" ] && /usr/libexec/PlistBuddy -c "Print :ProgramArguments" "$PL" 2>/dev/null || true)
CFG=${1:-$(echo "$ARGS" | grep -m1 '\.json' | xargs || true)}; CFG=${CFG:-$HOME/.kitebook/runner.json}
RT=$(echo "$ARGS" | grep -m1 'runner\.ts' | xargs || true); RT=${RT:-$HOME/.kitebook/client/runner.ts}
[ -f "$CFG" ] || { echo "no runner config at $CFG. Install the runner first: open <kitebook>/start, Connect your Mac."; exit 1; }
[ -f "$RT" ] || { echo "runner not found at $RT. Reinstall it from <kitebook>/start, Connect your Mac."; exit 1; }
echo "runner config: $CFG"
# Refuse without a trusted signer: approve auto without signatures would trust whatever the server says.
if ! bun "$RT" trust list "$CFG" | grep -q 'ed25519:'; then
  echo "No trusted dispatcher key yet, so nothing could auto-run safely. First, on each dispatcher: kitebook keygen (prints ed25519:...)."
  echo "Then here: bun $RT trust add \"$CFG\" <peer> ed25519:...   and run this script again."
  exit 1
fi
bun "$RT" set "$CFG" requireSignedAuto true
bun "$RT" set "$CFG" approve auto
bun "$RT" set "$CFG" access full
bun "$RT" doctor "$CFG" || true   # a running runner picks the changes up within seconds; doctor shows what's left to fix
echo "Zero-touch on: signed tasks from trusted keys run without asking; protections (bun $RT protect \"$CFG\") stay on."
