#!/bin/sh
# The Docker image's start command (Dockerfile): workerd serving the built Worker, its data under $KITEBOOK_DATA (the /data volume).
# Inside the container it listens on 0.0.0.0:$PORT (local: the dashboard) and 0.0.0.0:$KITEBOOK_EDGE_PORT (default PORT+1, the public edge:
# point a tunnel or reverse proxy there, never at $PORT; src/ingress.ts); docker-compose.yml publishes both on 127.0.0.1 only.
# WORKERD / KITEBOOK_APP let the smoke run this same script outside a container.
set -eu
# RELAY_* (the names from before the rename to Kitebook) still work: each fills its unset KITEBOOK_* twin
for _v in $(env | sed -n 's/^RELAY_\([A-Za-z0-9_]*\)=.*/\1/p'); do eval "[ -n \"\${KITEBOOK_$_v+x}\" ] || export KITEBOOK_$_v=\"\$RELAY_$_v\""; done
DATA=${KITEBOOK_DATA:-/data}; APP=${KITEBOOK_APP:-/app}; WORKERD=${WORKERD:-workerd}; ADDR=${KITEBOOK_LISTEN:-0.0.0.0}:${PORT:-7820}; EDGE=${KITEBOOK_LISTEN:-0.0.0.0}:${KITEBOOK_EDGE_PORT:-$(( ${PORT:-7820} + 1 ))}
mkdir -p "$DATA/do" "$DATA/blobs"; chmod 700 "$DATA" 2>/dev/null || true
if [ -z "${KITEBOOK_ADMIN_TOKEN:-}" ]; then
  if [ -n "${KITEBOOK_ADMIN_TOKEN_FILE:-}" ]; then KITEBOOK_ADMIN_TOKEN=$(cat "$KITEBOOK_ADMIN_TOKEN_FILE")
  else
    f="$DATA/admin-token"
    if [ ! -s "$f" ]; then (umask 077; od -An -N24 -tx1 /dev/urandom | tr -d ' \n' > "$f"); echo "kitebook: made an admin token (recovery code) in $f inside the data volume; read it with: docker compose exec kitebook cat $f"; fi
    KITEBOOK_ADMIN_TOKEN=$(cat "$f")
  fi
fi
export KITEBOOK_ADMIN_TOKEN
exec "$WORKERD" serve "$APP/selfhost/config.capnp" --experimental --directory-path relay-do="$DATA/do" --directory-path relay-blobs="$DATA/blobs" --socket-addr http="$ADDR" --socket-addr edge="$EDGE"
