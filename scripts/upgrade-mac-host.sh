#!/usr/bin/env bash
# Upgrade an EXISTING Mac-hosted Kitebook that still runs the old `cf dev` server (launchd job dev.kitebook.server) to the production server
# (scripts/serve.sh: the built Worker on plain workerd), in one command with no questions. The owner runs, in Terminal:
#   cd ~/code/relay && git pull --ff-only && bash scripts/upgrade-mac-host.sh
# Why: `cf dev` is Vite, and Vite also serves the project folder (sources, ?raw, /@fs/<any path>), so anyone with the tunnel address could
# read runner.json (the runner's token), .dev.vars (the admin token) and the data folder. This script:
#   1. finds the old job and its port, the port the existing tunnel sends traffic to (cloudflared's config; the tunnel itself is left alone),
#      the admin token (.dev.vars) and the old cf dev data (.relay-data, .cloudflare/state, or the job's KITEBOOK_DATA)
#   2. prepares the in-place update without creating backup folders
#   3. stops the old server (that alone closes the leak), copies the code from this checkout into the server folder (never .git,
#      node_modules, .dev.vars, data, runner.json), npm install, builds the bundle
#   4. copies the data into ~/.kitebook-server with scripts/migrate-cfdev.ts (the old data is never changed), replaces the admin token
#      (it was readable too), writes the launchd job to run scripts/serve.sh on the port the tunnel uses, starts it
#   5. health check on 127.0.0.1 (and the public address when it can tell it) for up to 3 minutes, and checks runner.json, sources and
#      package.json are no longer served; if anything fails it stops the failed server and reports how to retry
#   6. replaces the runner's token on the server, writes it into runner.json (600; never shown), restarts the runner, waits until it's back
#   7. looks through the old logs for outside requests to /@fs, runner.json, ?raw or the data folder
#   8. prints a short summary. Every step also goes to ~/Library/Logs/kitebook-upgrade.log. No token is ever printed or logged.
# Safe to run again: a finished upgrade just updates the code and checks everything; a run that stopped halfway carries on.
#   bash scripts/upgrade-mac-host.sh --dry-run    only look: what it found, what it would do, and whether the server leaks right now
# Overrides (normally not needed): KITEBOOK_SERVER_DIR (default ~/relay-cf), KITEBOOK_DATA (~/.kitebook-server), KITEBOOK_PORT (the new server's
# port), KITEBOOK_PUBLIC_URL, KITEBOOK_RUNNER_CONFIG (default <server dir>/runner.json), KITEBOOK_KEEP_ADMIN_TOKEN=1, KITEBOOK_ROTATE=1 (rotate the
# runner token again on a rerun), KITEBOOK_UPGRADE_HEALTH_SEC (180). Tests: KITEBOOK_UPGRADE_NPM (install command), KITEBOOK_UPGRADE_FAIL=health|npm.
# RELAY_* (the names from before the rename to Kitebook) still work: each fills its unset KITEBOOK_* twin
for _v in $(env | sed -n 's/^RELAY_\([A-Za-z0-9_]*\)=.*/\1/p'); do eval "[ -n \"\${KITEBOOK_$_v+x}\" ] || export KITEBOOK_$_v=\"\$RELAY_$_v\""; done
set -uo pipefail
CLONE=$(cd "$(dirname "$0")/.." && pwd -P)
SRV=${KITEBOOK_SERVER_DIR:-$HOME/relay-cf}; SRV=${SRV%/}
DATA=${KITEBOOK_DATA:-$HOME/.kitebook-server}; case "$DATA" in /*) ;; *) DATA=$HOME/$DATA;; esac
LABEL=dev.kitebook.server; LA=$HOME/Library/LaunchAgents; PLIST=$LA/$LABEL.plist; RPLIST=$LA/dev.kitebook.runner.plist
# a job from before the rename (Relay -> Kitebook) is still dev.relay.server: that's the one to upgrade, and the new job gets the new name
OLABEL=$LABEL; [ -f "$PLIST" ] || { [ -f "$LA/dev.relay.server.plist" ] && OLABEL=dev.relay.server; }; OPLIST=$LA/$OLABEL.plist
[ -f "$RPLIST" ] || { [ -f "$LA/dev.relay.runner.plist" ] && RPLIST=$LA/dev.relay.runner.plist; }
LOGD=$HOME/Library/Logs; ULOG=$LOGD/kitebook-upgrade.log; SLOG=$LOGD/kitebook-server.log
HSEC=${KITEBOOK_UPGRADE_HEALTH_SEC:-180}; DRY=0
case "${1:-}" in --dry-run|--check) DRY=1;; "") ;; -h|--help) sed -n '2,26p' "$0"; exit 0;; *) echo "usage: bash scripts/upgrade-mac-host.sh [--dry-run]"; exit 2;; esac
mkdir -p "$LOGD"; umask 077
say() { printf '%s\n' "$*"; printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$ULOG"; }
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$ULOG"; }
q() { log "\$ $*"; "$@" >> "$ULOG" 2>&1; } # a command whose output only goes to the log
die() { say ""; say "STOPPED: $*"; say "Nothing else was changed. Details: $ULOG"; exit 1; }
say "== Kitebook upgrade $(date '+%Y-%m-%d %H:%M') (log: $ULOG) =="
[ "$DRY" = 1 ] && say "(dry run: only looking, nothing is changed)"

# ---- tools ----
BUN=$(command -v bun || echo "$HOME/.bun/bin/bun"); [ -x "$BUN" ] || die "bun isn't installed (brew install oven-sh/bun/bun)."
NODE=$(command -v node) || die "Node isn't installed (brew install node)."
command -v curl >/dev/null || die "curl is missing."
uidn=$(id -u)
# one run at a time
LOCK=${TMPDIR:-/tmp}/kitebook-upgrade.lock
if [ "$DRY" = 0 ]; then
  if ! mkdir "$LOCK" 2>/dev/null; then op=$(cat "$LOCK/pid" 2>/dev/null); if [ -n "$op" ] && kill -0 "$op" 2>/dev/null; then die "another upgrade is running (pid $op)."; fi; rm -rf "$LOCK"; mkdir "$LOCK" || die "can't take $LOCK"; fi
  echo $$ > "$LOCK/pid"; trap 'rm -rf "$LOCK"' EXIT
fi
hcode() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || true; }
healthy() { [ "$(hcode "$1/health")" = 200 ]; }
plistxml() { if command -v plutil >/dev/null 2>&1; then plutil -convert xml1 -o - "$1" 2>/dev/null || cat "$1"; else cat "$1"; fi | tr -d '\n\t' | sed 's/> *</></g'; }
# value of <key>K</key><string>V</string> anywhere in a plist (EnvironmentVariables included)
pkey() { printf '%s' "$1" | sed -n "s#.*<key>$2</key><string>\([^<]*\)</string>.*#\1#p" | head -1; }
copy_tree() { # copy_tree <from> <to> <exclude names...>: rsync when the Mac has it, else tar (both keep times, so a fresh bundle stays fresh)
  local from=$1 to=$2; shift 2; mkdir -p "$to"; set -f # patterns stay patterns
  if command -v rsync >/dev/null 2>&1; then local ex=""; for e in "$@"; do ex="$ex --exclude=$e"; done; rsync -a $ex "$from/" "$to/"
  else local ex=""; for e in "$@"; do ex="$ex --exclude=./$e --exclude=$e"; done; (cd "$from" && tar -cf - $ex .) | (cd "$to" && tar -xpf -); fi; local r=$?; set +f; return $r; }

# ---- 1. preflight: what is there ----
[ -d "$SRV" ] || die "no kitebook server folder at $SRV (set KITEBOOK_SERVER_DIR=<folder> if it's somewhere else)."
SRV=$(cd "$SRV" && pwd -P)
[ -f "$OPLIST" ] || die "no Kitebook server job ($PLIST), so there's no old Mac server to upgrade. A new install is: bash scripts/mac-host.sh"
PX=$(plistxml "$OPLIST")
if printf '%s' "$PX" | grep -q 'scripts/serve\.sh'; then MODE=current; else MODE=cfdev; fi
OLD_PORT=$(pkey "$PX" PORT); [ -n "$OLD_PORT" ] || OLD_PORT=$(printf '%s' "$PX" | sed -n 's#.*<string>--port</string><string>\([0-9]*\)</string>.*#\1#p;s#.*--port[= ]\([0-9][0-9]*\).*#\1#p' | head -1)
[ -n "$OLD_PORT" ] || { [ "$MODE" = cfdev ] && OLD_PORT=5173 || OLD_PORT=7820; } # Vite's default / mac-host.sh's default
OLD_WD=$(pkey "$PX" WorkingDirectory); OLD_RD=$(pkey "$PX" KITEBOOK_DATA); [ -n "$OLD_RD" ] || OLD_RD=$(pkey "$PX" RELAY_DATA)
case "$OLD_RD" in "$HOME/.relay-server"|"$HOME/.relay-server/") [ -d "$HOME/.kitebook-server" ] && OLD_RD=$HOME/.kitebook-server;; esac # moved by the rename (client/rebrand.ts)
OLD_LOGS="$(pkey "$PX" StandardOutPath) $(pkey "$PX" StandardErrorPath)"
# an install already on serve.sh keeps the data folder its job uses
[ "$MODE" = current ] && [ -z "${KITEBOOK_DATA:-}" ] && [ -n "$OLD_RD" ] && DATA=$OLD_RD
[ -n "$OLD_WD" ] && [ "$(cd "$OLD_WD" 2>/dev/null && pwd -P)" != "$SRV" ] && say "Note: the old job runs in $OLD_WD, not $SRV. If that's the real server folder, rerun with KITEBOOK_SERVER_DIR=$OLD_WD."
grep -q '^ADMIN_TOKEN=.' "$SRV/.dev.vars" 2>/dev/null || die "no ADMIN_TOKEN in $SRV/.dev.vars, so the server can't be managed from here."
OLD_UP=no; healthy "http://127.0.0.1:$OLD_PORT" && OLD_UP=yes

# The tunnel the owner set up (cloudflared): its config's ingress says which local port it sends traffic to and the public hostname.
CF_CONFS=""; CF_LOGS=""
for f in ${KITEBOOK_CLOUDFLARED_CONFIG:-} "$HOME/.cloudflared/config.yml" "$HOME/.cloudflared/config.yaml" /etc/cloudflared/config.yml /usr/local/etc/cloudflared/config.yml /opt/homebrew/etc/cloudflared/config.yml; do [ -f "$f" ] && CF_CONFS="$CF_CONFS $f"; done
CF_URLPORTS=""
for p in "$LA"/*.plist /Library/LaunchDaemons/*.plist; do
  [ -f "$p" ] || continue; case "$p" in */dev.kitebook.*) continue;; esac; x=$(plistxml "$p" 2>/dev/null); printf '%s' "$x" | grep -q cloudflared || continue
  c=$(printf '%s' "$x" | sed -n 's#.*<string>--config</string><string>\([^<]*\)</string>.*#\1#p'); [ -n "$c" ] && [ -f "$c" ] && CF_CONFS="$CF_CONFS $c"
  u=$(printf '%s' "$x" | sed -n 's#.*<string>--url</string><string>https*://[^:<]*:\([0-9]*\)[^<]*</string>.*#\1#p'); [ -n "$u" ] && CF_URLPORTS="$CF_URLPORTS $u"
  CF_LOGS="$CF_LOGS $(pkey "$x" StandardOutPath) $(pkey "$x" StandardErrorPath)"
done
INGRESS=""; for c in $CF_CONFS; do
  INGRESS="$INGRESS$(awk '/hostname:/ { h=$NF; gsub(/["'"'"']/, "", h) } /service:/ { s=$NF; gsub(/["'"'"']/, "", s); if (s ~ /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):[0-9]+/) { sub(/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):/, "", s); sub(/[^0-9].*/, "", s); print (h == "" ? "-" : h) " " s }; h="" }' "$c")
"; lf=$(sed -n 's/^logfile: *//p' "$c" | tr -d '"'"'"); [ -n "$lf" ] && CF_LOGS="$CF_LOGS $lf"; done
INGRESS=$(printf '%s' "$INGRESS" | grep -v '^$' || true); for u in $CF_URLPORTS; do INGRESS="$INGRESS
- $u"; done; INGRESS=$(printf '%s' "$INGRESS" | grep -v '^$' || true)
TPORT=""; PUB_HOST=""
if [ -n "$INGRESS" ]; then
  m=$(printf '%s\n' "$INGRESS" | awk -v p="$OLD_PORT" '$2 == p' | head -1)
  if [ -n "$m" ]; then TPORT=$OLD_PORT; PUB_HOST=$(printf '%s\n' "$INGRESS" | awk -v p="$OLD_PORT" '$2 == p && $1 != "-" { print $1; exit }')
  elif [ "$(printf '%s\n' "$INGRESS" | awk '{ print $2 }' | sort -u | wc -l | tr -d ' ')" = 1 ]; then TPORT=$(printf '%s\n' "$INGRESS" | awk 'NR == 1 { print $2 }'); PUB_HOST=$(printf '%s\n' "$INGRESS" | awk '$1 != "-" { print $1; exit }'); fi
fi
NEW_PORT=${KITEBOOK_PORT:-${TPORT:-$OLD_PORT}}
RJ=${KITEBOOK_RUNNER_CONFIG:-}; [ -z "$RJ" ] && for f in "$SRV/runner.json" "$HOME/.kitebook/runner.json"; do [ -f "$f" ] && { RJ=$f; break; }; done
rjget() { [ -n "$RJ" ] && [ -f "$RJ" ] && "$BUN" -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = c[process.argv[2]]; if (typeof v === "string") console.log(v)' "$RJ" "$1" 2>/dev/null || true; }
PUB=${KITEBOOK_PUBLIC_URL:-}; [ -z "$PUB" ] && [ -n "$PUB_HOST" ] && PUB=https://$PUB_HOST
[ -z "$PUB" ] && case "$(rjget url)" in https://*) PUB=$(rjget url);; esac; PUB=${PUB%/}
PUB_UP=no; [ -n "$PUB" ] && healthy "$PUB" && PUB_UP=yes
# the old cf dev data, exactly as the old vite.config.ts chose it: KITEBOOK_DATA, else .relay-data, else .cloudflare/state
OLDDATA=""
if [ "$MODE" = cfdev ]; then
  if [ -n "$OLD_RD" ]; then case "$OLD_RD" in /*) OLDDATA=$OLD_RD;; *) OLDDATA=${OLD_WD:-$SRV}/$OLD_RD;; esac
  elif [ -d "$SRV/.relay-data/v3/do" ]; then OLDDATA=$SRV/.relay-data
  elif [ -d "$SRV/.cloudflare/state/v3/do" ]; then OLDDATA=$SRV/.cloudflare/state; fi
  [ -n "$OLDDATA" ] && [ ! -d "$OLDDATA/v3/do" ] && OLDDATA=""
fi
# what the server serves now that it shouldn't (a body check, not just 200: never prints a body)
leaks() { local base=$1 out="" u c b; b=$(mktemp)
  for u in "/@fs$SRV/runner.json" "/@fs$SRV/.dev.vars" /runner.json "/src/index.ts" "/package.json" "/package.json?raw" "/vite.config.ts?raw"; do
    c=$(curl -s -o "$b" -m 5 -w '%{http_code}' "$base$u" 2>/dev/null || true)
    [ "$c" = 200 ] && grep -qE '"token"|ADMIN_TOKEN=|^import |"dependencies"|"scripts"|export default' "$b" && out="$out $u"; done
  rm -f "$b"; printf '%s' "${out# }"; }
NOWLEAK=""; [ "$OLD_UP" = yes ] && NOWLEAK=$(leaks "http://127.0.0.1:$OLD_PORT")
say "Found:"
say "  server folder   $SRV ($([ "$MODE" = cfdev ] && echo "old cf dev server" || echo "already on the production server"))"
say "  server job      $OLABEL on port $OLD_PORT ($([ "$OLD_UP" = yes ] && echo up || echo "not answering"))"
say "  tunnel          $([ -n "$TPORT" ] && echo "sends traffic to port $TPORT" || echo "its settings aren't on this Mac (Cloudflare dashboard?); keeping port $OLD_PORT")${PUB:+, public address $PUB ($([ "$PUB_UP" = yes ] && echo up || echo "not answering"))}"
say "  data            $([ "$MODE" = cfdev ] && { [ -n "$OLDDATA" ] && echo "$OLDDATA (cf dev) -> $DATA" || echo "no cf dev data found (a new, empty Kitebook data folder in $DATA)"; } || echo "$DATA")"
say "  runner config   ${RJ:-none found}"
[ -n "$NOWLEAK" ] && say "  LEAKING NOW     the server answers these to anyone: $NOWLEAK"
[ "$OLD_UP" = yes ] && [ -z "$NOWLEAK" ] && say "  leak check      nothing served that shouldn't be"
if [ "$DRY" = 1 ]; then
  say ""; say "Would: update $SRV in place without backup folders, stop the old server, copy the code from $CLONE, npm install, build,"
  say "       $([ "$MODE" = cfdev ] && echo "copy the data to $DATA, replace the admin token, ")run the server (workerd) on port $NEW_PORT, check it, then replace the runner's token and restart the runner."
  exit 0
fi

# ---- 2. prepare the in-place update (no backup folders) ----
BUNDLE=.cloudflare/output/v0/workers/default/bundle/index.js
bsum() { [ -f "$SRV/$BUNDLE" ] && cksum < "$SRV/$BUNDLE" || echo none; }; B0=$(bsum)
MIGRATED=""; STOPPED=""

# A data folder that already holds Kitebook data is never overwritten or moved aside, so check it before anything is stopped. A retry
# reuses a completed migration of this same source while the old server stayed stopped (it can't have changed since).
REUSE=""
if [ "$MODE" = cfdev ] && [ -n "$(ls -A "$DATA/do" 2>/dev/null)" ]; then
  if [ "$OLD_UP" = no ] && [ -n "$OLDDATA" ] && [ "$(cat "$DATA/.migrated-from" 2>/dev/null)" = "$OLDDATA" ]; then
    REUSE=1; MIGRATED=1; say "Using the completed copy of your data already in $DATA."
  else die "$DATA already holds Kitebook data (an earlier upgrade try that didn't finish$([ "$OLD_UP" = yes ] && echo ", and the old server has run since, so it may miss newer changes")), and it is never overwritten.
         Your original data${OLDDATA:+ in $OLDDATA} is untouched. If you don't need what's in $DATA, move its do and blobs folders somewhere else, then run this again."; fi
fi

# No old server snapshot is made. Leave the failed version stopped, keep its data where it is, and let the owner retry the update.
# In particular, never bring the old publicly exposed cf dev server back after a failed migration: not now, and not at the next login
# either (its job file stays for the retry, which reads the port and data folder from it, but with RunAtLoad/KeepAlive off).
noautostart() { local f=$1
  if command -v plutil >/dev/null 2>&1; then plutil -replace RunAtLoad -bool NO "$f" && plutil -replace KeepAlive -bool NO "$f"
  else perl -0777 -pi -e 's#(<key>RunAtLoad</key>\s*)<true\s*/>#$1<false/>#g; s#(<key>KeepAlive</key>\s*)(<true\s*/>|<dict>.*?</dict>)#$1<false/>#gs' "$f"; fi; }
upgrade_failed() {
  say ""; say "Upgrade stopped: $1"
  if [ -n "$STOPPED" ]; then
    launchctl bootout "gui/$uidn" "$PLIST" >> "$ULOG" 2>&1 || true
    [ "$OLABEL" = "$LABEL" ] || launchctl bootout "gui/$uidn" "$OPLIST" >> "$ULOG" 2>&1 || true
    say "Kitebook is offline for now: its server is stopped, so your runner and assistants can't reach it until the upgrade finishes."
    if [ "$MODE" = cfdev ] && ! { [ -f "$PLIST" ] && plistxml "$PLIST" | grep -q 'scripts/serve\.sh'; }; then
      noautostart "$OPLIST" >> "$ULOG" 2>&1 || say "(Couldn't turn off its start at login in $OPLIST; until the upgrade finishes, keep it off with: kitebook stop server)"
      say "The old server was not started again on purpose: it showed your runner and admin tokens to anyone with your public address."
      say "It won't start by itself at login either."
    fi
  fi
  say "Your data is safe: ${OLDDATA:-$DATA} was not changed${MIGRATED:+, and the copy in $DATA is kept for the next try}."
  say "To try again once the problem above is fixed: kitebook update   (or: cd $CLONE && bash scripts/upgrade-mac-host.sh)"
  say "Details: $ULOG"; exit 1; }
trap 'say "Interrupted."; upgrade_failed "the upgrade was interrupted"' INT TERM

# ---- 3. stop the old server, copy the code, install, build ----
if [ "$MODE" = cfdev ]; then
  say "Stopping the old cf dev server (this closes the leak)..."
  q launchctl bootout "gui/$uidn" "$OPLIST"; STOPPED=1
  for i in $(seq 1 30); do [ "$(hcode "http://127.0.0.1:$OLD_PORT/")" = 000 ] && break; sleep 1; done
  if [ "$(hcode "http://127.0.0.1:$OLD_PORT/")" != 000 ] && command -v lsof >/dev/null; then # a leftover vite/workerd still holding the port
    for p in $(lsof -nP -t -iTCP:"$OLD_PORT" -sTCP:LISTEN 2>/dev/null); do ps -o command= -p "$p" | grep -qE "vite|workerd|cf dev|$SRV" && { log "stopping leftover pid $p"; kill "$p" 2>/dev/null; }; done; sleep 2; fi
  [ "$(hcode "http://127.0.0.1:$OLD_PORT/")" = 000 ] || upgrade_failed "port $OLD_PORT is still in use after stopping the old server"
fi
if [ "$CLONE" != "$SRV" ]; then
  say "Copying the new code from $CLONE ($(git -C "$CLONE" log -1 --format='%h, %cs' 2>/dev/null || echo '?'))..."
  copy_tree "$CLONE" "$SRV" .git node_modules .dev.vars .relay-data .cloudflare .wrangler runner.json .kitebook-tunnel .kitebook-backup .kitebook-commit '*.log' '.env*' '*.bak-*' >> "$ULOG" 2>&1 \
    || { [ -n "$STOPPED" ] && upgrade_failed "couldn't copy the code"; die "couldn't copy the code into $SRV"; }
  # the checkout's built bundle, when it's newer than every source there, saves a build here (copied with its time, so serve.sh agrees)
  if [ -f "$CLONE/$BUNDLE" ] && [ -z "$(cd "$CLONE" && find src client cloudflare.config.ts vite.config.ts package-lock.json selfhost -newer "$BUNDLE" -type f -print 2>/dev/null | head -1)" ]; then
    mkdir -p "$SRV/.cloudflare" && copy_tree "$CLONE/.cloudflare/output" "$SRV/.cloudflare/output" >> "$ULOG" 2>&1; fi
fi
say "Installing packages (npm install; a minute or two)..."
(cd "$SRV" && log "\$ ${KITEBOOK_UPGRADE_NPM:-npm install --no-audit --no-fund}" && eval "${KITEBOOK_UPGRADE_NPM:-npm install --no-audit --no-fund}" >> "$ULOG" 2>&1) && [ "${KITEBOOK_UPGRADE_FAIL:-}" != npm ] \
  || { [ -n "$STOPPED" ] && upgrade_failed "npm install failed"; die "npm install failed in $SRV (the running server wasn't touched)."; }
# which commit this folder now holds (it has no .git): serve.sh bakes it into the bundle, so /health?build=1 names it and the next update
# (client/host-upgrade.ts serverSync) can tell whether the server runs the checkout's code
[ "$CLONE" != "$SRV" ] && git -C "$CLONE" rev-parse HEAD > "$SRV/.kitebook-commit" 2>/dev/null
say "Building the server..."
(cd "$SRV" && PATH="$(dirname "$NODE"):$PATH" bash scripts/serve.sh build >> "$ULOG" 2>&1) && [ -f "$SRV/$BUNDLE" ] \
  || { [ -n "$STOPPED" ] && upgrade_failed "the server didn't build"; die "the server didn't build (the running server wasn't touched)."; }

# ---- 4. data, admin token, launchd job, start ----
mkdir -p "$DATA"; chmod 700 "$DATA"
if [ "$MODE" = cfdev ]; then
  if [ -n "$OLDDATA" ] && [ -z "$REUSE" ]; then
    say "Copying your data from $OLDDATA to $DATA (the old folder isn't changed)..."
    MIGRATED=1; MOUT=$(cd "$CLONE" && "$BUN" scripts/migrate-cfdev.ts "$OLDDATA" "$DATA" 2>>"$ULOG"); log "migrate: $MOUT"
    printf '%s' "$MOUT" | grep -q '"ok":true' || upgrade_failed "couldn't copy the data ($MOUT)"
    echo "$OLDDATA" > "$DATA/.migrated-from"
    say "  $(printf '%s' "$MOUT" | sed -n 's/.*"durable_objects":\([0-9]*\),"blobs":\([0-9]*\).*/\1 databases, \2 big files/p') copied."
  fi
  if [ "${KITEBOOK_KEEP_ADMIN_TOKEN:-}" != 1 ]; then # the old server served .dev.vars too: a new admin token (sign in again with: kitebook open)
    NT=$(openssl rand -hex 24) && awk -v t="$NT" 'BEGIN { d = 0 } /^ADMIN_TOKEN=/ { print "ADMIN_TOKEN=" t; d = 1; next } { print } END { if (!d) print "ADMIN_TOKEN=" t }' "$SRV/.dev.vars" > "$SRV/.dev.vars.new" \
      && chmod 600 "$SRV/.dev.vars.new" && mv "$SRV/.dev.vars.new" "$SRV/.dev.vars" && ADMIN_ROTATED=1; unset NT
  fi
fi
chmod 600 "$SRV/.dev.vars"
mkdir -p "$LA"
NEWP=$(mktemp); cat > "$NEWP" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$SRV</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$SRV/scripts/serve.sh</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key><string>$NEW_PORT</string>
    <key>KITEBOOK_DATA</key><string>$DATA</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$SLOG</string><key>StandardErrorPath</key><string>$SLOG</string>
</dict></plist>
PL
L="http://127.0.0.1:$NEW_PORT"
# the old logs are read before the new server writes to the same file (step 7 prints what they show)
scan_logs() { local files="" f n=0 first="" lines
  for f in $OLD_LOGS $CF_LOGS "$SLOG" "$LOGD"/*cloudflared*.log "$HOME"/.cloudflared/*.log /opt/homebrew/var/log/cloudflared*.log /usr/local/var/log/cloudflared*.log; do [ -f "$f" ] && case " $files " in *" $f "*) ;; *) files="$files $f";; esac; done
  [ -z "$files" ] && { echo "none|no log files found"; return; }
  # every request line for those paths that names an address other than loopback (one-true-awk safe: no {n} repeats)
  cat $files 2>/dev/null | awk -v files="$files" '/\/@fs|runner\.json|[?&]raw|\.relay-data|\.dev\.vars/ { l = $0; ip = ""
      while (match(l, /[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/)) { c = substr(l, RSTART, RLENGTH); l = substr(l, RSTART + RLENGTH); if (c !~ /^(127\.|0\.0\.0\.0)/) { ip = c; break } }
      if (ip == "") next; t = "unknown time"; if (match($0, /[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9][T ][0-9][0-9]:[0-9][0-9]/)) t = substr($0, RSTART, RLENGTH)
      n++; if (n <= 5) f = f ip " at " t "; " } END { print n + 0 "|" f "|" files }'; }
# A retry after a failed upgrade finds the new job, whose log is the new server's: the old cf dev logs (where any outside /@fs hit is)
# are remembered next to the data until an upgrade finishes, so the retry still reports them.
OLDLOGS_F=$DATA/.cfdev-logs; [ -f "$OLDLOGS_F" ] && OLD_LOGS="$OLD_LOGS $(tr '\n' ' ' < "$OLDLOGS_F")"
EXPO=$(scan_logs); log "log scan: $EXPO"

if [ "$MODE" = current ] && cmp -s "$NEWP" "$PLIST" && [ "$(bsum)" = "$B0" ] && healthy "$L"; then
  say "The server is already current and running on port $NEW_PORT; leaving it running."; rm -f "$NEWP"
else
  say "Starting the new server (workerd) on port $NEW_PORT..."
  q launchctl bootout "gui/$uidn" "$OPLIST"; STOPPED=1
  for i in $(seq 1 20); do [ "$(hcode "$L/")" = 000 ] && break; sleep 1; done
  [ "$MODE" = cfdev ] && printf '%s\n' $OLD_LOGS > "$OLDLOGS_F"
  mv "$NEWP" "$PLIST"; chmod 644 "$PLIST"; [ "$OLABEL" = "$LABEL" ] || rm -f "$OPLIST" # the job's new name
  q launchctl bootstrap "gui/$uidn" "$PLIST" || upgrade_failed "launchd didn't take the new server job"
fi

# ---- 5. health + leak check, else stop ----
say "Checking the server (up to $((HSEC / 60)) minutes)..."
ok=""; for i in $(seq 1 "$HSEC"); do healthy "$L" && { ok=1; break; }; sleep 1; done
[ "${KITEBOOK_UPGRADE_FAIL:-}" = health ] && ok=""
[ -n "$ok" ] || upgrade_failed "the new server didn't answer on $L/health (log: $SLOG)"
say "  local:  $L/health OK"
LEFT=$(leaks "$L"); [ -z "$LEFT" ] || upgrade_failed "the new server still serves:$LEFT"
say "  leak check: runner.json, .dev.vars, sources and package.json are no longer served"
if [ -n "$PUB" ]; then
  pok=""; n=1; [ "$PUB_UP" = yes ] && n=40 # it answered before: give the tunnel up to 2 minutes; it didn't: one look
  for i in $(seq 1 $n); do healthy "$PUB" && { pok=1; break; }; [ $n -gt 1 ] && sleep 3; done
  if [ -n "$pok" ]; then PLEFT=$(leaks "$PUB"); [ -z "$PLEFT" ] || upgrade_failed "$PUB still serves:$PLEFT"; say "  public: $PUB/health OK, nothing leaks there"
  elif [ "$PUB_UP" = yes ]; then upgrade_failed "$PUB answered before the upgrade but not after (does the tunnel send traffic to port $NEW_PORT?)"
  else say "  public: $PUB doesn't answer (it didn't before either), so it isn't checked"; fi
fi
STOPPED=""; ADMIN_NOTE=""; [ -n "${ADMIN_ROTATED:-}" ] && ADMIN_NOTE="replaced (the old one was readable too; sign in again with: kitebook open)"

# ---- 6. rotate the runner token ----
RUNNER="no runner config found"; PEER=""
DONEF=$DATA/.runner-token-rotated
if [ -z "$RJ" ]; then :
elif [ -f "$DONEF" ] && [ "${KITEBOOK_ROTATE:-}" != 1 ] && [ "$MODE" = current ]; then PEER=$(sed -n 's/^peer=//p' "$DONEF"); RUNNER="token${PEER:+ for $PEER} already replaced ($(sed -n 's/^at=//p' "$DONEF"); KITEBOOK_ROTATE=1 replaces it again)"
else
  say "Replacing the runner's token (the old one may have been read)..."
  R=$(cd "$CLONE" && "$BUN" scripts/rotate-runner-token.ts rotate "$RJ" "$L" "$SRV" 2>>"$ULOG"); log "rotate: $R"
  if printf '%s' "$R" | grep -q '"ok":true'; then
    PEER=$(printf '%s' "$R" | sed -n 's/.*"peer":"\([^"]*\)".*/\1/p'); AT=$(printf '%s' "$R" | sed -n 's/.*"at":\([0-9]*\).*/\1/p')
    printf 'at=%s\npeer=%s\n' "$(date '+%Y-%m-%d %H:%M')" "$PEER" > "$DONEF"; RUNNER="token for $PEER replaced and saved in $RJ (600)"
  else RUNNER="token NOT replaced: $(printf '%s' "$R" | sed -n 's/.*"error":"\(.*\)"}.*/\1/p')"; say "  $RUNNER"; fi
fi
ONLINE=""
if [ -n "$RJ" ]; then
  if [ -f "$RPLIST" ] || launchctl print "gui/$uidn/dev.kitebook.runner" >/dev/null 2>&1 || launchctl print "gui/$uidn/dev.relay.runner" >/dev/null 2>&1; then
    say "Restarting the runner..."
    RS=$(cd "$CLONE" && "$BUN" client/runner.ts service "$RJ" restart runner 2>&1); log "runner restart: $RS"
    if printf '%s' "$RS" | grep -qE 'restart failed|not running as a service'; then ONLINE="couldn't be restarted ($(printf '%s' "$RS" | sed -n 's/.*"runner": *"\([^"\\]*\).*/\1/p' | head -1)); restart it with: kitebook restart runner"
    elif [ -n "$PEER" ]; then
      O=$(cd "$CLONE" && "$BUN" scripts/rotate-runner-token.ts online "$L" "$SRV" "$PEER" "${AT:-$(($(date +%s) * 1000))}" 90 2>>"$ULOG"); log "online: $O"
      printf '%s' "$O" | grep -q '"online":true' && ONLINE="online again" || ONLINE="NOT back online after 90s (see: kitebook logs runner)"
    fi
  else ONLINE="isn't a background service here; restart it where it runs so it reads the new token"; fi
fi

# ---- 7 + 8. exposure, summary ----
N=${EXPO%%|*}; R1=${EXPO#*|}; FIRST=${R1%%|*}
VER="$(git -C "$CLONE" log -1 --format='%h (%cs)' 2>/dev/null || echo unknown)"
say ""; say "== Done =="
say "  version        $VER"
say "  server         workerd (scripts/serve.sh) on port $NEW_PORT, healthy${PUB:+, public address $PUB}"
say "  data           $DATA$([ -n "$MIGRATED" ] && echo " (copied from $OLDDATA, which is unchanged)")"
[ -n "$ADMIN_NOTE" ] && say "  admin token    $ADMIN_NOTE"
say "  runner         $RUNNER${ONLINE:+; $ONLINE}"
if [ "$N" = none ]; then say "  exposure       no logs to check. The old server didn't record requests, so assume the old tokens were seen (they're replaced now)."
elif [ "$N" = 0 ]; then say "  exposure       no outside requests for /@fs, runner.json, ?raw or the data folder in the logs. The old server didn't record every request, so the tokens were replaced anyway."
else say "  exposure       POSSIBLE: $N outside request(s) for /@fs, runner.json, ?raw or the data folder in the logs, first: ${FIRST%; }"; fi
say "  update         in place (no backup folders)"
say "  log            $ULOG"
case "$RUNNER" in *"NOT replaced"*) ;; *) rm -f "$OLDLOGS_F";; esac # reported above and the tokens are replaced
case "$RUNNER$ONLINE" in *NOT*|*"couldn't be restarted"*) exit 1;; esac
exit 0
