#!/usr/bin/env bash
# Kitebook in one step, on a Mac or a Linux computer (Windows: scripts/get.ps1). Paste this one line into a terminal and press Return:
#   curl -fsSL https://raw.githubusercontent.com/um1b/kitebook/main/scripts/get.sh | bash
# It asks one thing: a master password for Kitebook on this computer (hidden, typed twice; it never leaves it). Run by an agent or a
# script (no terminal), it asks nothing and finishes LOCKED, printing a one-time local link where the person types the password later.
# Run it again any time: it keeps what's there and repairs what's missing.
#   1. git (macOS's developer tools: if they're missing, macOS shows its own Install button; this waits for it), bun (from bun.sh) and
#      Node 22 (a private copy in ~/.kitebook-node, sha256-checked against nodejs.org's list) when they're missing
#   2. the Kitebook code: a git clone of the stable branch (main) in ~/.kitebook-app (updates move it forward; nothing is built from your files)
#   3. the server: scripts/mac-host.sh with public access OFF (workerd on 127.0.0.1:7820, data in ~/.kitebook-server, starts at login; the
#      built-in tunnel's helper is installed but idle: Settings -> Connection -> Turn on public access gives the Mac a public address;
#      on Linux the server and the helper run as services: systemd --user, else Kitebook's supervisor)
#   4. the runner on this same Mac (a one-time invite made with the server's own key, never shown), the coding agents found here
#      (Pi, Codex, Claude Code, ...) connected to it without questions, and "Install updates automatically" on (stable, when idle,
#      back to the version before if the new one doesn't start)
#   5. the `kitebook` command in ~/.local/bin, added to PATH for zsh and bash
#   6. your browser opened on Kitebook, signed in (no token to copy; the recovery code stays in ~/.kitebook-app/.dev.vars, mode 600)
# Log: ~/Library/Logs/kitebook-install.log. Env (advanced): KITEBOOK_APP (~/.kitebook-app), PORT (7820), KITEBOOK_REPO, KITEBOOK_BRANCH (main),
#   KITEBOOK_NO_OPEN=1, KITEBOOK_BIN_DIR (~/.local/bin), KITEBOOK_AGENTS=0 (don't connect coding agents), KITEBOOK_NO_TTY=1 (never ask: finish locked
#   with the one-time setup link), KITEBOOK_PASSWORD_STEP=0 (skip the master-password step entirely).
set -euo pipefail
# RELAY_* (the names from before the rename to Kitebook) still work: each fills its unset KITEBOOK_* twin
for _v in $(env | sed -n 's/^RELAY_\([A-Za-z0-9_]*\)=.*/\1/p'); do eval "[ -n \"\${KITEBOOK_$_v+x}\" ] || export KITEBOOK_$_v=\"\$RELAY_$_v\""; done
CLI=kitebook # the command's name, in one place (client/brand.ts has the same)
# an install from before the rename (Relay -> Kitebook): its folders take the new names, each old name left as a link to the new one
# (client/rebrand.ts does the rest once the new code is here: runner.json, the service jobs, the relay command)
for _p in ".relay-runner:.kitebook" ".relay-server:.kitebook-server" ".relay-app:.kitebook-app" ".relay-node:.kitebook-node" ".relay:.kitebook-kb"; do
  _o=$HOME/${_p%%:*}; _n=$HOME/${_p#*:}; if [ -d "$_o" ] && [ ! -L "$_o" ] && [ ! -e "$_n" ]; then mv "$_o" "$_n" && { ln -s "$_n" "$_o" || mv "$_n" "$_o"; }; fi; done
REPO=${KITEBOOK_REPO:-https://github.com/um1b/kitebook}; BRANCH=${KITEBOOK_BRANCH:-main}
APP=${KITEBOOK_APP:-$HOME/.kitebook-app}; PORT=${PORT:-7820}; URL=http://127.0.0.1:$PORT
BIN=${KITEBOOK_BIN_DIR:-$HOME/.local/bin}; CFG=$HOME/.kitebook/runner.json
OS=${KITEBOOK_OS:-$(uname -s)} # KITEBOOK_OS: smoke.sh's fake Mac
# logs: ~/Library/Logs on macOS, $XDG_STATE_HOME/kitebook (~/.local/state/kitebook) on Linux, next to the server's and runner's own
if [ "$OS" = Darwin ]; then LD=$HOME/Library/Logs; else LD=${XDG_STATE_HOME:-$HOME/.local/state}/kitebook; fi
mkdir -p "$LD"; LOG=$LD/kitebook-install.log; : > "$LOG"; chmod 600 "$LOG"
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1" no_proxy="${no_proxy:+$no_proxy,}localhost,127.0.0.1"
say(){ printf '%s\n' "$*"; printf '%s\n' "$*" >> "$LOG"; }
die(){ say "Kitebook couldn't finish: $*"; say "Details: $LOG. Running the same line again picks up where it stopped."; exit 1; }
quiet(){ "$@" >> "$LOG" 2>&1; }
case "$OS" in Darwin) WHERE="this Mac";; Linux) WHERE="this computer";; *) die "this one-step install is for macOS and Linux. On Windows, in PowerShell: irm https://raw.githubusercontent.com/um1b/kitebook/main/scripts/get.ps1 | iex";; esac
say "Installing Kitebook on $WHERE. This takes a few minutes; at the end it asks you for a master password."

# 1. tools
if ! git --version >/dev/null 2>&1 && [ "$OS" = Linux ]; then die "git isn't installed. Install it with your package manager (for example: sudo apt install git), then run the same line again."; fi
if ! git --version >/dev/null 2>&1; then
  xcode-select --install >/dev/null 2>&1 || true
  say "  macOS is asking to install its developer tools (Kitebook needs git): press Install in that window. This waits for it."
  for i in $(seq 1 360); do git --version >/dev/null 2>&1 && break; sleep 5; done
  git --version >/dev/null 2>&1 || die "git isn't installed yet. Press Install in the macOS window, then run the same line again."
fi
BUN=$(command -v bun 2>/dev/null || true); [ -n "$BUN" ] || { [ -x "$HOME/.bun/bin/bun" ] && BUN=$HOME/.bun/bin/bun; } || true
if [ -z "$BUN" ]; then say "  getting bun (from bun.sh)"; curl -fsSL https://bun.sh/install | quiet bash || die "bun didn't install"; BUN=$HOME/.bun/bin/bun; [ -x "$BUN" ] || die "bun didn't install"; fi
# Node 22.18+ builds the server (cloudflare.config.ts). An older or missing node gets a private copy, checked against nodejs.org's sums.
nodeok(){ "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null; }
NODE=$(command -v node 2>/dev/null || true)
if [ -z "$NODE" ] || ! nodeok "$NODE"; then
  NODE=$HOME/.kitebook-node/bin/node
  if ! { [ -x "$NODE" ] && nodeok "$NODE"; }; then
    say "  getting Node 22 (a private copy for Kitebook in ~/.kitebook-node)"
    A=$(uname -m); case "$A" in arm64|aarch64) A=arm64;; *) A=x64;; esac; NOS=$(echo "$OS" | tr A-Z a-z); D=https://nodejs.org/dist/latest-v22.x; T=$(mktemp -d)
    curl -fsSL "$D/SHASUMS256.txt" -o "$T/sums" || die "couldn't reach nodejs.org"
    F=$(grep -o "node-v22[0-9.]*-$NOS-$A.tar.gz" "$T/sums" | head -n 1); [ -n "$F" ] || die "no Node 22 for $WHERE on nodejs.org"
    curl -fsSL "$D/$F" -o "$T/$F" || die "couldn't download Node"
    [ "$({ sha256sum "$T/$F" 2>/dev/null || shasum -a 256 "$T/$F"; } | cut -d' ' -f1)" = "$(grep " $F\$" "$T/sums" | cut -d' ' -f1)" ] || die "the Node download didn't match nodejs.org's checksum; nothing was installed"
    rm -rf "$HOME/.kitebook-node"; mkdir -p "$HOME/.kitebook-node"; tar -xzf "$T/$F" -C "$HOME/.kitebook-node" --strip-components 1; rm -rf "$T"
  fi
fi
if [ "$OS" = Darwin ]; then OPENER=$(command -v open 2>/dev/null || echo open) # macOS's open (found before node's folder goes first on PATH)
elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then OPENER=$(command -v xdg-open 2>/dev/null || true); else OPENER=; fi # no desktop: the link is printed
export PATH="$(dirname "$NODE"):$(dirname "$BUN"):$PATH"

# 2. the code (the stable branch; a second run fast-forwards it, like an update you asked for)
# a runner already running from this checkout watches it for a `git pull` (client/git-pull.ts); this move is ours, so it stays out of it
own(){ [ -f "$APP/client/git-pull.ts" ] && quiet "$BUN" "$APP/client/git-pull.ts" own "$1" "$APP" || true; }
[ -d "$APP/.git" ] && { own start; trap 'own done' EXIT; }
PREV=""; if [ -d "$APP/.git" ]; then PREV=$(git -C "$APP" rev-parse HEAD 2>/dev/null || true); quiet git -C "$APP" fetch -q origin "$BRANCH" && quiet git -C "$APP" merge --ff-only -q "origin/$BRANCH" || say "  (kept the Kitebook code as it is: $APP has changes of its own)"
else say "  getting Kitebook"; quiet git clone -q -b "$BRANCH" "$REPO" "$APP" || die "couldn't download Kitebook from $REPO"; fi
cd "$APP"
quiet "$BUN" client/rebrand.ts "$CFG" || true # the rest of the rename for an older install (jobs, runner.json, the relay command); nothing for a new one
[ -z "${KITEBOOK_NODE_MODULES:-}" ] || [ -e node_modules ] || ln -s "$KITEBOOK_NODE_MODULES" node_modules # smoke.sh: reuse its install
if [ ! -d node_modules ]; then say "  installing its parts (npm, once)"; quiet npm install --no-audit --no-fund || die "npm install failed"; fi

# 3. the server, public access off (one switch in Settings -> Connection turns it on)
say "  starting the server"
if [ "$OS" = Darwin ]; then host(){ KITEBOOK_TUNNEL=${KITEBOOK_TUNNEL:-off} KITEBOOK_NO_OPEN=1 PORT=$PORT quiet bash scripts/mac-host.sh < /dev/null; }
else host(){ # Linux: workerd (scripts/serve.ts) as the kitebook-server service; data in ~/.kitebook-server; a recovery code in .dev.vars (mode 600)
  [ -f .dev.vars ] && grep -q "^ADMIN_TOKEN=" .dev.vars || { (umask 077; echo "ADMIN_TOKEN=$("$BUN" -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')" > .dev.vars); }
  quiet "$BUN" scripts/serve.ts build || return 1
  KITEBOOK_RUNNER_CONFIG=$CFG quiet "$BUN" client/jobs.ts install kitebook-server --cwd "$APP" --env "PORT=$PORT" --env "KITEBOOK_DATA=${KITEBOOK_DATA:-$HOME/.kitebook-server}" --env "PATH=$PATH" -- "$BUN" "$APP/scripts/serve.ts" || return 1
  for i in $(seq 1 60); do curl -sf "$URL/health" >/dev/null && return 0; sleep 1; done; return 1; }; fi
# a second run that moved the code forward and then can't start the server goes back to the version that ran before (the same rule
# as an automatic update: a stable commit that doesn't start, e.g. one the updater already rolled back, is never left running)
if ! host; then
  [ -n "$PREV" ] && [ "$(git rev-parse HEAD)" != "$PREV" ] && quiet git reset -q --keep "$PREV" || die "the server didn't start"
  say "  the newest Kitebook didn't start, so $WHERE stays on the version it had (${PREV:0:7})"; host || die "the server didn't start"
fi
curl -sf "$URL/health" >/dev/null || die "the server isn't answering on $URL"
own done # the commit the server runs now is the one later pulls are compared against (before the runner restarts on it)

# 4. this Mac as its runner (the invite is made with the server's own key from .dev.vars; it's never printed)
NEWRUN=
if [ -f "$CFG" ] && grep -q "\"url\": *\"$URL\"" "$CFG"; then :
else
  [ ! -f "$CFG" ] || { mv "$CFG" "$CFG.before-$(date +%Y%m%d-%H%M%S)"; say "  (set your earlier runner settings aside next to $CFG)"; }
  say "  connecting $WHERE"
  ADM=$(sed -n 's/^ADMIN_TOKEN=//p' .dev.vars | head -n 1)
  INV=$(KITEBOOK_URL=$URL KITEBOOK_ADMIN_TOKEN=$ADM "$BUN" client/admin.ts invite main runner read,write,delete,dispatch 'tasks/**' 'shared/**' 'repos/**' 'kb/**' 2>>"$LOG" | sed 's#.*/join/##'); ADM=
  case "$INV" in inv_*) ;; *) die "couldn't make the runner's invite";; esac
  quiet "$BUN" client/runner.ts init "$URL" "$INV" --out "$CFG" --no-install --installer || die "couldn't connect $WHERE to its server"; INV=; NEWRUN=1
fi
# where updates come from and go to: this checkout runs both the server and the runner, and updates itself (stable, when idle)
"$BUN" -e '
const fs = require("fs"), [f, app, url, auto, lc] = process.argv.slice(1), c = JSON.parse(fs.readFileSync(f, "utf8"));
c.source = app; c.server = { ...(c.server ?? {}), dir: app, health: url + "/health" };
if (auto === "1" && c.autoUpdate == null) c.autoUpdate = true; // the owner can turn it off in Settings -> Updates; a later run keeps that
if (lc) c.launchctl = lc; if (process.env.KITEBOOK_SUPERVISE === "1") c.supervise = true; if (process.env.KITEBOOK_SYSTEMCTL) c.systemctl = process.env.KITEBOOK_SYSTEMCTL;
fs.writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 }); fs.chmodSync(f, 0o600);
const G = await import(app + "/client/guard.ts"); G.stampOwnerEdit(f);' "$CFG" "$APP" "$URL" "${NEWRUN:-0}" "${KITEBOOK_LAUNCHCTL:-}" >> "$LOG" 2>&1 || die "couldn't save the runner's settings"
AG=; if [ "${KITEBOOK_AGENTS:-}" != 0 ]; then AG=$(KITEBOOK_RUNNER_CONFIG=$CFG "$BUN" client/runner.ts connect "$CFG" --installer 2>>"$LOG" | tail -n 1 || true); fi
quiet "$BUN" client/runner.ts install "$CFG" || die "the runner didn't start"
# Linux: the built-in tunnel's helper as a service too, public access off (macOS: mac-host.sh above already set it up); not fatal
if [ "$OS" = Linux ]; then KITEBOOK_RUNNER_CONFIG=$CFG quiet "$BUN" client/tunnel.ts install --port "$PORT" --server-dir "$APP" || say "  (public access isn't set up yet: $CLI tunnel on does it later)"; fi

# 5. the kitebook command, on PATH for new Terminal windows (zsh and bash)
mkdir -p "$BIN"
if [ -e "$BIN/$CLI" ] && ! grep -q '^# Kitebook CLI' "$BIN/$CLI" 2>/dev/null; then say "  (left $BIN/$CLI alone: it isn't Kitebook's)"
else printf '#!/bin/sh\n# Kitebook CLI, installed by %s/install.sh (scripts/get.sh): %s help\nexport KITEBOOK_RUNNER_CONFIG="${KITEBOOK_RUNNER_CONFIG:-%s}"\nexec "%s" "%s/client/cli.ts" "$@"\n' "$URL" "$CLI" "$CFG" "$BUN" "$APP" > "$BIN/$CLI.tmp" && chmod 755 "$BIN/$CLI.tmp" && mv "$BIN/$CLI.tmp" "$BIN/$CLI"; fi
LINE="export PATH=\"$BIN:\$PATH\" # added by Kitebook"
for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do grep -qsF "$BIN:" "$rc" || printf '\n%s\n' "$LINE" >> "$rc"; done
# ...and check it: a fresh login shell must find kitebook (client/cli-path.ts: repairs the PATH block once, else one line with the exact fix)
{ KITEBOOK_BIN_DIR=$BIN "$BUN" "$APP/client/cli-path.ts" verify "$CFG" 2>&1 >/dev/null | grep "^kitebook isn't on your PATH" >&2; } || true

# 5b. the master password (client/password.ts): the person at this terminal types it (hidden, twice; argon2id-wrapped on this computer,
#     the server only ever sees a public key). No terminal (an agent or a script ran this line): Kitebook stays LOCKED, so nothing can be
#     approved from here, and the summary shows a one-time local setup link (15 minutes, once) for the person. The installer never picks it.
PWOUT=; if [ "${KITEBOOK_PASSWORD_STEP:-}" != 0 ]; then PWOUT=$(KITEBOOK_RUNNER_CONFIG=$CFG "$BUN" client/cli.ts password set --installer --wait 2>>"$LOG" || true); fi

# 6. the browser, signed in (the runner makes the one-time link: device-signed /open#t=…&n=…, 60 s, once; `kitebook open` does the same later
#    and opens it through a loopback redirect instead, so the link isn't in a process's arguments)
OPENED=
if [ "${KITEBOOK_NO_OPEN:-}" != 1 ]; then
  for i in 1 2 3 4; do # the runner answers once it's connected (a few seconds after it starts)
    L=$("$BUN" client/cli.ts open --print 2>>"$LOG" | grep -Eo 'http[^ ]*(#login=|/open#t=)[^ ]*' | tail -n 1 || true); [ -z "$L" ] || break; sleep 2; done
  [ -n "$L" ] && [ -n "$OPENER" ] && "$OPENER" "$L" >/dev/null 2>&1 && OPENED=1
fi
say ""
say "✓ Kitebook is installed and running on $WHERE (it starts by itself at login and keeps itself up to date)."
case "$AG" in "✓ "*) say "${AG%%:*}.";; esac
if [ -n "$OPENED" ]; then say "✓ Opened Kitebook in your browser, signed in."; else say "Open Kitebook any time with: $CLI open"; fi
[ -z "$PWOUT" ] || say "$PWOUT"
say "Next: to use Claude.ai or ChatGPT, turn on public access in Kitebook's Settings -> Connection. Type $CLI in a new Terminal window for help."
