#!/bin/sh
# Kitebook quick start: one command from a fresh clone to a local Kitebook you're signed in to, with this computer connected as its runner.
#   ./scripts/quickstart.sh            (Mac or Linux; needs node + npm and bun: brew install node oven-sh/bun/bun)
# What it does, in order (each step is skipped when it's already done, so running it again is safe):
#   1. npm install (first run only)
#   2. ADMIN_TOKEN: a random one in .dev.vars (0600) unless you have one. It's the server's master key and your recovery code.
#   3. starts the server (npx cf dev) in the background on http://127.0.0.1:$PORT (default 5173); log .kitebook-quickstart.log, pid .kitebook-quickstart.pid
#   4. connects this computer: a one-time runner invite, then the server's own installer (curl <kitebook>/install.sh | sh -s -- <invite>).
#      On a Mac the runner starts at login; on Linux this script starts it in the background (log .kitebook-quickstart-runner.log).
#   5. signs your browser in (bun client/admin.ts open: a single-use 5-minute link) and prints how long it all took.
# The server runs only while this computer is on and only this computer can reach it: cloud assistants (Claude.ai, ChatGPT, Hark) need a
# public address, so for them use ./scripts/mac-host.sh (No server / domain) or npx cf deploy. Stop it: ./scripts/quickstart.sh stop
# Env: PORT (5173), KITEBOOK_QS_NO_RUNNER=1 (skip step 4), KITEBOOK_QS_NO_OPEN=1 (print the sign-in link instead of opening it),
#      KITEBOOK_QS_YES=1 (answer the installer's questions with their defaults; set by itself when there's no terminal).
set -eu
# RELAY_* (the names from before the rename to Kitebook) still work: each fills its unset KITEBOOK_* twin
for _v in $(env | sed -n 's/^RELAY_\([A-Za-z0-9_]*\)=.*/\1/p'); do eval "[ -n \"\${KITEBOOK_$_v+x}\" ] || export KITEBOOK_$_v=\"\$RELAY_$_v\""; done
cd "$(dirname "$0")/.."
DIR=$(pwd); PORT=${PORT:-5173}; URL=http://127.0.0.1:$PORT; T0=$(date +%s)
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1" no_proxy="${no_proxy:+$no_proxy,}localhost,127.0.0.1"
say(){ printf '%s\n' "$*"; }; die(){ say "quickstart: $*" >&2; exit 1; }
BUN=$(command -v bun || true); [ -n "$BUN" ] || { [ -x "$HOME/.bun/bin/bun" ] && BUN=$HOME/.bun/bin/bun; } || true
if [ "${1:-}" = stop ]; then
  # the runner (Linux) and the server itself (npx -> cf -> vite -> workerd), started by this script from this folder
  killtree(){ for c in $(pgrep -P "$1" 2>/dev/null); do killtree "$c"; done; kill "$1" 2>/dev/null || true; }
  for f in .kitebook-quickstart-runner.pid .kitebook-quickstart.pid; do [ -f $f ] && killtree "$(cat $f)"; done
  rm -f .kitebook-quickstart.pid .kitebook-quickstart-runner.pid; say "Stopped the quick-start Kitebook (its data stays in .relay-data/)."; exit 0
fi
command -v npm >/dev/null || die "needs node and npm first (Mac: brew install node)"
[ -n "$BUN" ] || die "needs bun first (Mac: brew install oven-sh/bun/bun; elsewhere: https://bun.sh)"

# 1. dependencies
[ -d node_modules ] || { say "Installing dependencies (npm install, once)…"; npm install --no-audit --no-fund >/dev/null 2>&1 || die "npm install failed; run it by hand to see why"; }
# 2. the master key
if ! grep -q '^ADMIN_TOKEN=.' .dev.vars 2>/dev/null; then
  TOK=$(openssl rand -hex 24 2>/dev/null || "$BUN" -e 'console.log(crypto.randomUUID().replace(/-/g,"")+crypto.randomUUID().replace(/-/g,""))')
  printf 'ADMIN_TOKEN=%s\n' "$TOK" >> .dev.vars; chmod 600 .dev.vars
  say "✓ Made your ADMIN_TOKEN (the server's master key and your recovery code) in $DIR/.dev.vars"
fi
ADMIN=$(sed -n 's/^ADMIN_TOKEN=//p' .dev.vars | head -n 1)
# 3. the server
if curl -sf "$URL/health" >/dev/null 2>&1; then say "✓ A Kitebook server already answers on $URL"
else
  nohup npx cf dev > .kitebook-quickstart.log 2>&1 < /dev/null & echo $! > .kitebook-quickstart.pid
  i=0; until curl -sf "$URL/health" >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 120 ] || die "the server didn't start in 2 minutes; see $DIR/.kitebook-quickstart.log"; sleep 1; done
  say "✓ Kitebook running on $URL (log: .kitebook-quickstart.log; stop: ./scripts/quickstart.sh stop)"
fi
export KITEBOOK_URL=$URL KITEBOOK_ADMIN_TOKEN=$ADMIN
# 4. this computer as the runner (signing in first makes workspace main; the invite is single use, 24 h)
if [ "${KITEBOOK_QS_NO_RUNNER:-}" = 1 ]; then :
elif [ -f "$HOME/.kitebook/runner.json" ] && grep -q "\"url\": *\"$URL\"" "$HOME/.kitebook/runner.json"; then say "✓ This computer is already connected to $URL"
else
  INV=$("$BUN" client/admin.ts invite main runner read,write,delete,dispatch 'tasks/**' 'shared/**' 'repos/**' 'kb/**' | sed 's#.*/join/##') || die "couldn't make a runner invite"
  [ -t 0 ] || KITEBOOK_QS_YES=1
  curl -fsSL "$URL/install.sh" -o .kitebook-quickstart-install.sh || die "couldn't download $URL/install.sh"
  if [ "${KITEBOOK_QS_YES:-}" = 1 ]; then KITEBOOK_NO_OPEN=1 KITEBOOK_YES=1 sh .kitebook-quickstart-install.sh "$INV" < /dev/null || die "the installer failed (see above)"
  else KITEBOOK_NO_OPEN=1 sh .kitebook-quickstart-install.sh "$INV" || die "the installer failed (see above)"; fi
  rm -f .kitebook-quickstart-install.sh; [ -f "$HOME/.kitebook/runner.json" ] || die "the installer didn't write ~/.kitebook/runner.json (see above)"
  if [ "$(uname -s)" != Darwin ] && [ -f "$HOME/.kitebook/runner.json" ]; then # no launchd: run it in the background like the server
    nohup "$BUN" "$HOME/.kitebook/current/runner.ts" "$HOME/.kitebook/runner.json" > .kitebook-quickstart-runner.log 2>&1 < /dev/null & echo $! > .kitebook-quickstart-runner.pid
    say "✓ Runner started in the background (log: .kitebook-quickstart-runner.log)"
  fi
fi
# 5. sign the browser in
if [ "${KITEBOOK_QS_NO_OPEN:-}" = 1 ]; then "$BUN" client/admin.ts open --print; else "$BUN" client/admin.ts open; fi
say "✓ Done in $(( $(date +%s) - T0 )) s. Next: connect a coding agent on this computer (claude mcp add --transport http kitebook $URL/mcp -s user, then /mcp -> Authenticate),"
say "  keep the recommended 'Read everything, save to shared memory, send tasks', ask it for a task and approve it on $URL/start. For Claude.ai / ChatGPT you need a public address: ./scripts/mac-host.sh"
