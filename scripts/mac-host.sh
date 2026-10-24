#!/usr/bin/env bash
# Self-host Kitebook on an always-on Mac, with a public URL (free, no server, no domain). It asks how assistants should reach the Mac:
#   1) No server / domain (recommended for one Mac, and the default without a terminal): Kitebook's built-in tunnel (client/tunnel.ts), a free
#      Cloudflare quick tunnel; cloudflared is downloaded once and sha256-checked, no Cloudflare account. Its address can change when it
#      restarts: Settings -> Connection shows the new one with a Copy button (or add a Cloudflare tunnel token there for a fixed address).
#   2) Tailscale Funnel: a fixed https://<mac>.<tailnet>.ts.net address (some cloud sandboxes, Hark's included, can't reach *.ts.net).
#   3) ngrok: NGROK_DOMAIN=<your-free-static>.ngrok-free.app ./scripts/mac-host.sh
#   Skip the question: KITEBOOK_TUNNEL=quick|tailscale|ngrok (remembered in .kitebook-tunnel for the next run).
#   KITEBOOK_TUNNEL=off: the built-in tunnel's helper is installed with public access OFF (only this Mac reaches Kitebook); one switch in
#      Settings -> Connection (or `kitebook tunnel on`) turns it on later. This is how scripts/get.sh, the one-step install, runs it.
#   KITEBOOK_NO_OPEN=1: don't open the browser at the end (get.sh signs it in itself once the runner is connected).
#   ./scripts/mac-host.sh            install: start the server at login and keep it alive, then funnel it
#   ./scripts/mac-host.sh status     show the URL and whether the server is up
#   ./scripts/mac-host.sh uninstall  stop the server and the funnel
# After it's live it opens <url>/start in your browser, signed in (a single-use 5-minute link, no key to copy); run the "Connect your Mac" line it gives you
# (curl <url>/install.sh | sh: claims a runner invite, writes ~/.kitebook/runner.json with safe defaults, starts at login).
# The server is the built Worker on plain workerd (scripts/serve.sh, selfhost/config.capnp), never `cf dev`: Vite would also serve this folder
# (sources, ?raw, /@fs) to anyone who has the tunnel address. Data (spaces, files, tasks, big files) lives OUTSIDE this folder, in
# ~/.kitebook-server (mode 700; KITEBOOK_DATA overrides): do/ (Durable Object SQLite) and blobs/<sha256>. An older install's cf dev state
# (.relay-data/ or .cloudflare/state here) is copied over once by scripts/migrate-cfdev.ts; its original folder stays in place.
# No backup folders are created. Nothing leaves the Mac unless you configure S3. Back up manually while the server
# is stopped, or with admin.ts export. The admin token is in .dev.vars (mode 600).
set -euo pipefail
# RELAY_* (the names from before the rename to Kitebook) still work: each fills its unset KITEBOOK_* twin
for _v in $(env | sed -n 's/^RELAY_\([A-Za-z0-9_]*\)=.*/\1/p'); do eval "[ -n \"\${KITEBOOK_$_v+x}\" ] || export KITEBOOK_$_v=\"\$RELAY_$_v\""; done
cd "$(dirname "$0")/.."
DIR=$PWD; PORT=${PORT:-7820}; EDGE_PORT=${KITEBOOK_EDGE_PORT:-$((PORT + 1))}; LABEL=dev.kitebook.server
DATA=${KITEBOOK_DATA:-$HOME/.kitebook-server}; case "$DATA" in /*) ;; *) DATA=$DIR/$DATA;; esac
PLIST=~/Library/LaunchAgents/$LABEL.plist; LOG=~/Library/Logs/kitebook-server.log
NPLIST=~/Library/LaunchAgents/dev.kitebook.ngrok.plist
TPLIST=~/Library/LaunchAgents/dev.kitebook.tunnel.plist; TLOG=~/Library/Logs/kitebook-tunnel.log
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun")
TS=$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)

# the first sign-in: a single-use 5-minute link from the server itself (admin op login_link, authorized by the ADMIN_TOKEN this script
# wrote to .dev.vars), opened in the browser, so nobody opens a file or copies a key
signin() { [ "${KITEBOOK_NO_OPEN:-}" = 1 ] && return 0; local t l; t=$(sed -n 's/^ADMIN_TOKEN=//p' "$DIR/.dev.vars" 2>/dev/null)
  for i in $(seq 1 20); do l=$(curl -fsS -X POST "http://127.0.0.1:$PORT/admin/login_link" -H "authorization: Bearer $t" -H 'content-type: application/json' -d '{}' 2>/dev/null | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' || true); [ -n "$l" ] && break; sleep 1; done
  if [ -n "$l" ] && open "${2:-$1}/start#login=$l" 2>/dev/null; then echo "Opened $1/start in your browser, signed in."; else echo "Open $1/start; sign in there with: kitebook open (after Connect your Mac)"; fi; }
url() { "$TS" status --json 2>/dev/null | python3 -c 'import json,sys; print("https://"+json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true; }

case "${1:-install}" in
uninstall)
  launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null || true; rm -f "$PLIST"
  launchctl bootout gui/$(id -u) "$NPLIST" 2>/dev/null || true; rm -f "$NPLIST"
  launchctl bootout gui/$(id -u) "$TPLIST" 2>/dev/null || true; rm -f "$TPLIST"
  for l in server ngrok tunnel; do launchctl bootout gui/$(id -u)/dev.relay.$l 2>/dev/null || true; rm -f ~/Library/LaunchAgents/dev.relay.$l.plist; done # pre-rename names
  "$TS" funnel --https=443 off 2>/dev/null || true
  echo "Stopped. Your data is still in $DATA."; exit 0;;
status)
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && echo "server: up on :$PORT" || echo "server: DOWN (log: $LOG)"
  echo "data: $DATA ($(du -sh "$DATA" 2>/dev/null | cut -f1))"
  grep -q "scripts/serve.sh" "$PLIST" 2>/dev/null || { [ -f "$PLIST" ] && echo "WARNING: the server still runs cf dev (a development server that serves this folder to anyone with its address). Your next update upgrades it (Settings -> Updates -> Update to dev now, or kitebook update); now, by hand: bash scripts/upgrade-mac-host.sh"; }
  if [ -f "$TPLIST" ]; then "$BUN" client/tunnel.ts status || true; else echo "public URL: $(url)"; "$TS" funnel status 2>/dev/null || true; fi; exit 0;;
install) ;;
*) echo "usage: $0 [install|status|uninstall]"; exit 1;;
esac
# an install from before the rename (Relay -> Kitebook): its folders and jobs move to the new names first (client/rebrand.ts), so an old
# dev.relay.server job never holds the port the new one needs
"$BUN" client/rebrand.ts >/dev/null 2>&1 || true

command -v node >/dev/null || { echo "Install Node first:  brew install node"; exit 1; }
# How assistants reach this Mac: asked once (remembered in .kitebook-tunnel); KITEBOOK_TUNNEL / NGROK_DOMAIN answer it ahead of time. Without a
# terminal the built-in tunnel is the default, unless Tailscale Funnel already serves this port (an older install keeps its address).
MODE=${KITEBOOK_TUNNEL:-}; [ -z "$MODE" ] && [ -n "${NGROK_DOMAIN:-}" ] && MODE=ngrok; [ -z "$MODE" ] && [ -f .kitebook-tunnel ] && MODE=$(cat .kitebook-tunnel); [ -z "$MODE" ] && [ -f .relay-tunnel ] && MODE=$(cat .relay-tunnel)
if [ -z "$MODE" ]; then
  if [ -t 0 ]; then
    echo "How should your assistants (Claude.ai, ChatGPT, Hark) reach this Mac?"
    echo "  1) No server / domain (recommended for one Mac): a free tunnel, nothing to sign up for. Its address can change when it restarts;"
    echo "     Settings -> Connection always shows the current one with a Copy button."
    echo "  2) Tailscale Funnel: a fixed https://<mac>.<tailnet>.ts.net address (Tailscale installed and signed in)"
    echo "  3) ngrok: your free static ngrok domain (set NGROK_DOMAIN first)"
    printf "Choose [1]: "; read -r a || a=; case "$a" in 2) MODE=tailscale;; 3) MODE=ngrok;; *) MODE=quick;; esac
  elif "$TS" funnel status 2>/dev/null | grep -qE ":($PORT|$EDGE_PORT)([^0-9]|\$)"; then MODE=tailscale
  else MODE=quick; fi
fi
case "$MODE" in quick|tailscale|ngrok|off) ;; *) echo "KITEBOOK_TUNNEL must be quick, tailscale, ngrok or off (got $MODE)"; exit 1;; esac
echo "$MODE" > .kitebook-tunnel
[ -x "$BUN" ] || { echo "Install bun first:  brew install oven-sh/bun/bun"; exit 1; }
if [ "$MODE" = off ]; then
  echo "Public access: off for now (only this Mac reaches Kitebook; turn it on in Settings -> Connection)"
elif [ "$MODE" = quick ]; then
  echo "Tunnel: No server / domain (Kitebook's built-in tunnel; no account needed)"
elif [ "$MODE" = ngrok ]; then [ -n "${NGROK_DOMAIN:-}" ] || { echo "Set NGROK_DOMAIN=<your-free-static>.ngrok-free.app first (or choose 1, no server / domain)."; exit 1; }
else [ -x "$TS" ] || command -v tailscale >/dev/null || { echo "Install Tailscale first (https://tailscale.com/download/mac) and sign in (or choose 1, no server / domain)."; exit 1; }; fi
[ -d node_modules ] || npm install
if [ ! -f .dev.vars ]; then
  echo "ADMIN_TOKEN=$(openssl rand -hex 24)" > .dev.vars; chmod 600 .dev.vars
  echo "Created admin token in $DIR/.dev.vars (keep it private)."
fi

mkdir -p ~/Library/LaunchAgents ~/Library/Logs
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$DIR/scripts/serve.sh</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key><string>$PORT</string>
    <key>KITEBOOK_DATA</key><string>$DATA</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string><key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PL
launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null || true
# Older installs ran cf dev with state inside this folder (.relay-data/, or .cloudflare/state before that; or a KITEBOOK_DATA folder with the
# cf dev layout v3/). With the server stopped, copy it into workerd's layout once; leave the original data in place.
mkdir -p "$DATA"; chmod 700 "$DATA"
if [ -z "$(ls -A "$DATA/do" 2>/dev/null)" ]; then
  OLD=""; for o in "$DATA" "$DIR/.relay-data" "$DIR/.cloudflare/state"; do [ -d "$o/v3/do" ] && { OLD=$o; break; }; done
  if [ -n "$OLD" ]; then
    "$BUN" scripts/migrate-cfdev.ts "$OLD" "$DATA" || { echo "Couldn't copy your data from $OLD (nothing was changed there). See above."; exit 1; }
    echo "Migrated your data from $OLD to $DATA (the original data stays in place; no backup folder was created)."
  fi
fi
"$DIR/scripts/serve.sh" build || { echo "Couldn't build the kitebook bundle."; exit 1; }
launchctl bootstrap gui/$(id -u) "$PLIST"
printf "Starting server"; for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; printf .; sleep 1; done; echo
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "Server didn't start. See $LOG"; exit 1; }

if [ "$MODE" = off ] && [ ! -f "$HOME/.kitebook/tunnel.json" ]; then # a first install: the helper starts with public access off (a later run keeps the owner's choice)
  mkdir -p "$HOME/.kitebook"; chmod 700 "$HOME/.kitebook"; printf '{"mode":"off","port":%s}\n' "$PORT" > "$HOME/.kitebook/tunnel.json"; chmod 600 "$HOME/.kitebook/tunnel.json"
fi
if [ "$MODE" = quick ] || [ "$MODE" = off ]; then
  # the tunnel helper (client/tunnel.ts run): starts cloudflared (downloads and checks it the first time), restarts it if it stops,
  # reports its address to this server for Settings -> Connection. kitebook status / kitebook restart tunnel / kitebook logs tunnel manage it.
  cat > "$TPLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.kitebook.tunnel</string>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>ProgramArguments</key><array><string>$BUN</string><string>$DIR/client/tunnel.ts</string><string>run</string><string>--port</string><string>$PORT</string><string>--server-dir</string><string>$DIR</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$TLOG</string><key>StandardErrorPath</key><string>$TLOG</string>
</dict></plist>
PL
  launchctl bootout gui/$(id -u) "$TPLIST" 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) "$TPLIST"
  if [ "$MODE" = off ]; then echo; echo "Kitebook runs at http://127.0.0.1:$PORT (public access off: Settings -> Connection turns it on)"; signin "http://127.0.0.1:$PORT"; exit 0; fi
  printf "Starting the tunnel"; U=$("$BUN" client/tunnel.ts url --wait 90 2>/dev/null || true); echo
  echo
  if [ -n "$U" ]; then echo "Kitebook is live:  $U   (local: http://127.0.0.1:$PORT)"
  else echo "Kitebook runs at http://127.0.0.1:$PORT, but the tunnel isn't up yet. Check it with: kitebook tunnel   (log: $TLOG)"; fi
  echo "Its address can change when the tunnel restarts: Settings -> Connection always shows the current one (Copy), and your Mac's runner uses the local address, so it never breaks."
  echo "Next:"
  # signed in on the local address: the Connect your Mac line it gives then points the runner at http://127.0.0.1:$PORT, which never changes
  signin "${U:-http://127.0.0.1:$PORT}" "http://127.0.0.1:$PORT"
  echo "  1. On that page, choose Connect your Mac and run its line here. Connect Claude.ai or ChatGPT with the link in Settings -> Connection."
  echo "  2. Check it any time: kitebook status   (also: kitebook tunnel, kitebook restart tunnel, kitebook logs tunnel)"
  echo "  Want an address that never changes? Settings -> Connection -> Keep the same address (a Cloudflare tunnel token), or rerun with KITEBOOK_TUNNEL=tailscale."
  exit 0
fi

if [ "$MODE" = ngrok ]; then
  NG=$(command -v ngrok) || { echo "Install ngrok: brew install ngrok && ngrok config add-authtoken <token>"; exit 1; }
  cat > "$NPLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.kitebook.ngrok</string>
  <key>ProgramArguments</key><array><string>$NG</string><string>http</string><string>--url=$NGROK_DOMAIN</string><string>--log=stdout</string><string>$EDGE_PORT</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/kitebook-ngrok.log</string><key>StandardErrorPath</key><string>$HOME/Library/Logs/kitebook-ngrok.log</string>
</dict></plist>
PL
  launchctl bootout gui/$(id -u) "$NPLIST" 2>/dev/null || true
  launchctl bootstrap gui/$(id -u) "$NPLIST"
  echo; echo "Kitebook is live:  https://$NGROK_DOMAIN   (local: http://127.0.0.1:$PORT)"
  signin "https://$NGROK_DOMAIN" "http://127.0.0.1:$PORT"; echo "Next: run the \"Connect your Mac\" line from that page here."; exit 0
fi

# Funnel only exposes this one port over HTTPS; it persists across reboots. First time, Tailscale may print a link to enable Funnel.
"$TS" funnel --bg "$EDGE_PORT" # the public edge listener only (src/ingress.ts); the dashboard stays on the local port
U=$(url)
echo
echo "Kitebook is live:  $U   (local: http://127.0.0.1:$PORT)"
echo "Next:"
signin "$U" "http://127.0.0.1:$PORT"
echo "  1. On that page (open it again any time with: kitebook open), choose Connect your Mac."
echo "  2. Connect your clients from there, and on this Mac run the \"Connect your Mac\" line (curl -fsSL $U/install.sh | sh -s -- <invite>)."
echo "     It writes ~/.kitebook/runner.json with safe defaults (dialog approval, worktree access, push never, requireSignedAuto)."
echo "  3. Check it any time: kitebook status   (also: kitebook restart server|runner, kitebook logs server, kitebook doctor)"
echo "Keep the Mac awake: System Settings > Energy > Prevent automatic sleeping (or the runner's keepAwake)."
