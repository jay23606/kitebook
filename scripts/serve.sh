#!/usr/bin/env bash
# Kitebook's production server on one machine (scripts/mac-host.sh runs it at login): the built Worker on plain workerd (selfhost/config.capnp).
# Never `cf dev`: Vite is a development server and serves the project folder itself (sources, ?raw, /@fs), which a public tunnel must never
# reach. workerd answers with the Worker only, and its data lives outside this folder ($KITEBOOK_DATA, default ~/.kitebook-server, mode 700).
#   scripts/serve.sh          build if the bundle is missing or older than the sources, then serve on 127.0.0.1:$PORT (default 7820, local:
#                             this computer) and 127.0.0.1:$KITEBOOK_EDGE_PORT (default PORT+1, the public edge a tunnel points at; src/ingress.ts)
#   scripts/serve.sh build    only (re)build when needed
# The recovery code / admin token comes from .dev.vars (mode 600) into workerd's environment, never argv or the launchd plist.
set -euo pipefail
# RELAY_* (the names from before the rename to Kitebook) still work: each fills its unset KITEBOOK_* twin
for _v in $(env | sed -n 's/^RELAY_\([A-Za-z0-9_]*\)=.*/\1/p'); do eval "[ -n \"\${KITEBOOK_$_v+x}\" ] || export KITEBOOK_$_v=\"\$RELAY_$_v\""; done
cd "$(dirname "$0")/.."
PORT=${PORT:-7820}; EDGE_PORT=${KITEBOOK_EDGE_PORT:-$((PORT + 1))}; DATA=${KITEBOOK_DATA:-$HOME/.kitebook-server}
BUNDLE=.cloudflare/output/v0/workers/default/bundle/index.js
stale() { [ ! -f "$BUNDLE" ] || [ -n "$(find src client cloudflare.config.ts vite.config.ts package-lock.json selfhost -newer "$BUNDLE" -type f -print -quit 2>/dev/null)" ]; }
# a server folder without .git (copied from a checkout: client/host-upgrade.ts serverSync) says which commit it holds in .kitebook-commit,
# so a rebuild here still bakes the right commit in (/health?build=1, describe.server)
[ -d .git ] || [ -n "${KITEBOOK_BUILD_COMMIT:-}" ] || { [ -f .kitebook-commit ] && export KITEBOOK_BUILD_COMMIT=$(head -c 40 .kitebook-commit); }
if stale; then
  echo "building the kitebook bundle (cf build)"
  node_modules/.bin/cf build > "${TMPDIR:-/tmp}/kitebook-build.log" 2>&1 || { echo "cf build failed (see ${TMPDIR:-/tmp}/kitebook-build.log)"; [ -f "$BUNDLE" ] || exit 1; echo "serving the previous bundle"; }
fi
[ "${1:-}" = build ] && exit 0
T=$(sed -n 's/^ADMIN_TOKEN=//p' .dev.vars 2>/dev/null || true); [ -n "$T" ] || { echo "no ADMIN_TOKEN in $PWD/.dev.vars"; exit 1; }
mkdir -p "$DATA/do" "$DATA/blobs"; chmod 700 "$DATA"
export KITEBOOK_ADMIN_TOKEN=$T
exec node_modules/.bin/workerd serve selfhost/config.capnp --experimental --directory-path relay-do="$DATA/do" --directory-path relay-blobs="$DATA/blobs" --socket-addr http=127.0.0.1:"$PORT" --socket-addr edge=127.0.0.1:"$EDGE_PORT"
