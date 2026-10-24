#!/usr/bin/env bash
# Run a command holding K of this machine's N smoke slots: a counting semaphore made of mkdir locks (atomic on any filesystem, including
# ones where flock is a no-op), so several people or agents sharing a box never run more smokes at once than its memory holds.
#   scripts/smoke-slot.sh [-n N] [-k K] [--lock PREFIX] [--note TEXT] [--status] -- command [args...]
#   e.g. scripts/smoke-slot.sh -- env SKIP_NTFY=1 ./smoke.sh > smoke.log 2>&1
#        scripts/smoke-slot.sh -k 2 -- scripts/smoke-par.sh -j 2        (a split run is K smokes: hold K slots)
#   -n N       slots on this machine (default $KITEBOOK_SMOKE_SLOTS or 2: a smoke peaks around 1.5 GB, so 2 on an 8 GB box with no swap)
#   -k K       slots this command needs (default 1). All K are taken at once or none, so two waiters never deadlock holding one each
#   --lock P   slot names: P.lockdir is slot 1 and P.slot<i>.lockdir slot i (default $KITEBOOK_SMOKE_LOCK or ${TMPDIR:-/tmp}/kitebook-smoke).
#              Slot 1 is the very directory an older single lock (`until mkdir P.lockdir; do sleep 15; done ... rmdir`) takes, and it is
#              tried first, so a script that only knows the single lock still counts as one smoke and waits while this one runs
#   --status   print each slot's holder (or free) and exit
# The exit code is the command's. Slots are released when the command ends, on Ctrl-C or SIGTERM/SIGHUP (passed on to the command).
# A slot left behind is taken over: its owner file names a pid that's gone, or a boot before this one (a reboot kills every smoke but
# leaves the directories); a slot with no owner file (made by an older single-lock script) once it predates this boot or is older than
# $KITEBOOK_SMOKE_STALE seconds (default 1200), and only while no smoke.sh runs on the machine and no file matching
# $KITEBOOK_SMOKE_ACTIVITY (globs of builders' logs, optional) changed in that time.
set -u
N=${KITEBOOK_SMOKE_SLOTS:-2}; K=1; P=${KITEBOOK_SMOKE_LOCK:-${TMPDIR:-/tmp}/kitebook-smoke}; NOTE=""; STATUS=0
while [ $# -gt 0 ]; do case $1 in
  -n) N=${2:?-n needs a number}; shift;; -k) K=${2:?-k needs a number}; shift;; --lock) P=${2:?}; shift;; --lock=*) P=${1#*=};;
  --note) NOTE=${2:-}; shift;; --status) STATUS=1;; --) shift; break;;
  -h|--help) sed -n '2,/^set -u/p' "$0" | grep '^#' | cut -c3-; exit 0;;
  -*) echo "smoke-slot.sh: unknown option $1 (see --help)" >&2; exit 2;; *) break;; esac; shift; done
[ "$N" -ge 1 ] 2>/dev/null && [ "$K" -ge 1 ] 2>/dev/null && [ "$K" -le "$N" ] || { echo "smoke-slot.sh: need 1 <= K <= N (K=$K N=$N)" >&2; exit 2; }
[ $STATUS = 1 ] || [ $# -gt 0 ] || { echo "smoke-slot.sh: no command (see --help)" >&2; exit 2; }
mkdir -p "$(dirname "$P")"
slot(){ [ "$1" = 1 ] && echo "$P.lockdir" || echo "$P.slot$1.lockdir"; }
BOOT=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)
BOOTED=$(( $(date +%s) - $(cut -d. -f1 /proc/uptime 2>/dev/null || echo 0) ))   # when this boot started (epoch s)
STALE=${KITEBOOK_SMOKE_STALE:-1200}
# a smoke actually running: a process whose program or script (argv[0] or argv[1]) is smoke.sh or an isolated run's smoke.run.sh; a
# waiter's `bash -c 'until mkdir ...; bash smoke.sh'` only mentions it and doesn't count
smoke_running(){ local d a; for d in /proc/[0-9]*; do a=$(tr '\0' '\n' < $d/cmdline 2>/dev/null | head -2 | sed 's|.*/||')
  grep -qxE 'smoke(\.run)?\.sh' <<< "$a" && return 0; done; return 1; }
recent_activity(){ [ -n "${KITEBOOK_SMOKE_ACTIVITY:-}" ] || return 1; local f; for f in $KITEBOOK_SMOKE_ACTIVITY; do
  [ -e "$f" ] && [ $(( $(date +%s) - $(stat -c %Y "$f") )) -lt "$STALE" ] && return 0; done; return 1; }
# why slot $1 is stale (printed), or nothing when it's held by something alive
stale(){ local d o pid boot mt age; case $1 in [0-9]*) d=$(slot "$1");; *) d=$1;; esac; o="$d/owner"
  mt=$(stat -c %Y "$d" 2>/dev/null) || return 1; age=$(( $(date +%s) - mt ))   # gone meanwhile: nothing to free
  if [ -s "$o" ]; then
    boot=$(sed -n 's/^boot=//p' "$o" 2>/dev/null | head -1); pid=$(grep -oE 'pid[= ][0-9]+' "$o" 2>/dev/null | head -1 | grep -oE '[0-9]+')
    if [ -n "$boot" ] && [ "$boot" != "$BOOT" ]; then echo "owner from an earlier boot"; return 0; fi
    if [ -z "$boot" ] && [ "$mt" -lt "$BOOTED" ]; then echo "made before this boot"; return 0; fi
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then echo "owner pid $pid is gone"; return 0; fi
    return 1; fi
  # no owner file: an older single-lock script, or a holder that hasn't written it yet (give it a moment)
  # (an agent may take the lock in one step and start its smoke in the next, so even a lock from before a reboot waits for quiet)
  { [ "$mt" -lt "$BOOTED" ] || [ "$age" -ge "$STALE" ]; } && ! smoke_running && ! recent_activity \
    && { echo "no owner for ${age}s$([ "$mt" -lt "$BOOTED" ] && echo ', from before this boot'), no smoke running, no builder log moving"; return 0; }
  return 1; }
if [ $STATUS = 1 ]; then [ -d "$P.reserve.lockdir" ] && echo "reserved for a multi-slot run:$(why=$(stale "$P.reserve.lockdir") && echo " [stale: $why]") $({ tr '\n' ' ' < "$P.reserve.lockdir/owner"; } 2>/dev/null)"
  for i in $(seq 1 "$N"); do d=$(slot $i)
  if [ -d "$d" ]; then why=$(stale $i); echo "slot $i ($d):${why:+ [stale: $why]} $({ tr '\n' ' ' < "$d/owner"; } 2>/dev/null || echo '(no owner file)')"; else echo "slot $i ($d): free"; fi; done; exit 0; fi
HELD=()
release(){ local d; for d in "${HELD[@]}"; do [ "$(sed -n 's/^pid=//p' "$d/owner" 2>/dev/null)" = $$ ] && rm -rf "$d"; done; HELD=(); }
take(){ local d c; case $1 in [0-9]*) d=$(slot "$1");; *) d=$1;; esac; shift; mkdir "$d" 2>/dev/null || return 1; c=$(tr '\n' ' ' <<< "$*"); [ ${#c} -gt 160 ] && c="${c:0:157}..."
  printf 'pid=%s\nboot=%s\nsince=%(%Y-%m-%dT%H:%M:%S%z)T\nnote=%s\ncmd=%s\n' $$ "$BOOT" -1 "$NOTE" "$c" > "$d/owner"; HELD+=("$d"); }
reap(){ local i why d; for i in $(seq 1 "$N") "$RES"; do why=$(stale $i) || continue; case $i in [0-9]*) d=$(slot $i);; *) d=$i;; esac
  # rename first: of two waiters that both found it stale only one rename succeeds, so a fresh holder's slot is never removed
  mv "$d" "$d.stale.$$" 2>/dev/null && { rm -rf "$d.stale.$$"; echo "smoke-slot: freed slot $i ($why)" >&2; }; done; }
CHILD=""
# starvation guard: a run that needs K > 1 slots and has waited KITEBOOK_SMOKE_RESERVE seconds (default 300) takes the reservation
# ($P.reserve.lockdir, one at a time) and from then keeps each slot it gets until it has K; while a reservation is held, other waiters
# using this script don't take slots (an old single-lock script still may, but it only ever takes slot 1 and the reserver keeps it once
# it has it). One reserver at a time, so two multi-slot runs never deadlock half-holding.
RES="$P.reserve.lockdir"; RSV=${KITEBOOK_SMOKE_RESERVE:-300}; MINE_RES=0
unreserve(){ [ $MINE_RES = 1 ] && [ "$(sed -n 's/^pid=//p' "$RES/owner" 2>/dev/null)" = $$ ] && rm -rf "$RES"; MINE_RES=0; }
cleanup(){ unreserve; release; }
trap cleanup EXIT
trap '[ -n "$CHILD" ] && kill -TERM $CHILD 2>/dev/null; exit 143' TERM
trap '[ -n "$CHILD" ] && kill -INT $CHILD 2>/dev/null; exit 130' INT
trap '[ -n "$CHILD" ] && kill -HUP $CHILD 2>/dev/null; exit 129' HUP
W0=$SECONDS; said=0
while :; do
  reap
  if [ $MINE_RES = 0 ] && [ "$K" -gt 1 ] && [ $((SECONDS - W0)) -ge "$RSV" ]; then
    H0=("${HELD[@]}"); HELD=(); take "$RES" "reserve for: $*" && { MINE_RES=1; echo "smoke-slot: waited $((SECONDS - W0))s, reserved: keeping slots as they free" >&2; }; HELD=("${H0[@]}"); fi
  if [ $MINE_RES = 1 ] || [ ! -d "$RES" ]; then
    for i in $(seq 1 "$N"); do [ ${#HELD[@]} -ge "$K" ] && break; [ -d "$(slot $i)" ] || take $i "$@"; done; fi
  [ ${#HELD[@]} -ge "$K" ] && { unreserve; break; }
  [ $MINE_RES = 1 ] || release   # all or nothing, unless reserved
  [ $said = 0 ] && { echo "smoke-slot: all $N slots busy, waiting ($P.*)" >&2; said=1; }
  # reserved: poll fast, so a freed slot 1 isn't lost to an old single-lock loop (they poll every few seconds and ignore reservations)
  [ $MINE_RES = 1 ] && sleep 0.3 || sleep $(( 2 + RANDOM % 3 ))
done
[ $said = 1 ] && echo "smoke-slot: got $K slot(s) after $((SECONDS - W0))s" >&2
"$@" & CHILD=$!
wait $CHILD; RC=$?
# a signal interrupts wait before the child is done: wait again for its real exit code
while kill -0 $CHILD 2>/dev/null; do wait $CHILD; RC=$?; done
exit $RC
