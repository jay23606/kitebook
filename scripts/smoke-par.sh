#!/usr/bin/env bash
# The smoke, split: its sections spread over N concurrent smoke.sh runs (each fully isolated: own temp dir, HOME, ports, processes; see the
# top of smoke.sh), then one merged result: "ALL PASSED (N checks)" or "FAIL ...", exit 0/1.
#   scripts/smoke-par.sh [-j N] [--groups "a,b;c,d"] [--keep]
#   -j N        number of concurrent runs (default 3). The sections are cut into N runs of consecutive sections; a run also executes the
#               earlier sections its own lean on (their variables and helpers; scripts/smoke-plan.py finds them), uncounted, and the cuts
#               make the slowest run as fast as possible, using how long each section took last time (else its length in lines)
#   --groups    the runs spelled out: section keys (smoke.sh --list), "," within a run, ";" between runs
#   --keep      keep the per-run logs even when everything passed
# Every run repeats the setup + core checks; they and any prerequisite section are counted once, so a green split run reports the serial
# run's count. Sections lean on each other a lot (most late ones need getting-started, the upgrade chain needs each other), so the gain is
# bounded by the longest chain, and on a 2-CPU box concurrent runs mostly share the CPU; the point of splitting is a faster answer on a big box.
# Per-run logs and results: $SMOKE_PAR_DIR (default a temp dir; printed). Each run counts as one smoke for any concurrency cap you keep:
# on a shared machine hold N slots of scripts/smoke-slot.sh for -j N (scripts/smoke-slot.sh -k 2 -- scripts/smoke-par.sh -j 2).
set -eu
cd "$(dirname "$0")/.."
J=3; GROUPS_ARG=""; KEEP=0
while [ $# -gt 0 ]; do case $1 in
  -j) J=${2:?-j needs a number}; shift;; -j*) J=${1#-j};; --groups) GROUPS_ARG=${2:?}; shift;; --groups=*) GROUPS_ARG=${1#*=};; --keep) KEEP=1;;
  -h|--help) sed -n '2,/^set -eu/p' "$0" | grep '^#' | cut -c3-; exit 0;;
  *) echo "smoke-par.sh: unknown argument $1 (see --help)" >&2; exit 2;; esac; shift; done
[ "$J" -ge 1 ] 2>/dev/null || { echo "smoke-par.sh: -j wants a number >= 1" >&2; exit 2; }
D=${SMOKE_PAR_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/kbsmoke-par.XXXXXXXX")}; mkdir -p "$D"
TIMES=${SMOKE_TIMES:-${XDG_CACHE_HOME:-$HOME/.cache}/kitebook-smoke-times.tsv}   # key <tab> seconds, from the last split run
# the plan: one line per run, "<sections it owns>\t<sections it executes>" (owned + the earlier sections they lean on; scripts/smoke-plan.py)
if [ -n "$GROUPS_ARG" ]; then tr ';' '\n' <<< "$GROUPS_ARG" | sed '/^$/d' | awk '{ print $0 "\t" $0 }' > "$D/plan.tsv"
else python3 scripts/smoke-plan.py smoke.sh "$J" "$TIMES" > "$D/plan.tsv"; fi
mapfile -t G < <(cut -f1 "$D/plan.tsv"); mapfile -t X < <(cut -f2 "$D/plan.tsv")
echo "smoke-par: ${#G[@]} concurrent runs, logs in $D"
PIDS=()
stop(){ trap - TERM INT; for p in "${PIDS[@]}"; do kill -TERM $p 2>/dev/null; done; wait; exit 143; }
trap stop TERM INT
T0=$SECONDS
for i in "${!G[@]}"; do
  sel=$(tr ',' '\n' <<< "${X[$i]}" | sed '/^$/d; s/^=*/=/' | paste -sd, -)
  echo "  run $((i + 1)): ${G[$i]}$([ "${X[$i]}" != "${G[$i]}" ] && echo " (also runs, uncounted: $(comm -13 <(tr , '\n' <<< "${G[$i]}" | sort) <(tr , '\n' <<< "${X[$i]}" | sort) | paste -sd, -))")"
  SMOKE_RESULT="$D/run$((i + 1)).result" bash smoke.sh --sections "$sel" > "$D/run$((i + 1)).log" 2>&1 & PIDS+=($!)
done
RC=0; for p in "${PIDS[@]}"; do wait $p || RC=1; done
# merge: core once (the first run's), every other section from the run that had it; failures named with their run's log
TOTAL=0; FAILS=""; CORE=""; : > "$D/times.tsv"
for i in "${!G[@]}"; do r="$D/run$((i + 1)).result"; l="$D/run$((i + 1)).log"
  if [ ! -f "$r" ] || ! grep -q '^status=pass' "$r"; then FAILS="$FAILS\n  run $((i + 1)) ($l): $(grep -m1 '^FAIL' "$l" 2>/dev/null || tail -1 "$l" 2>/dev/null)"; fi
  [ -f "$r" ] || continue
  # count core once (the first run's) and every other section in the run that owns it (the auth-e2e suite belongs to the sign-in section);
  # a section's seconds: its last check's time minus the previous executed section's (core's time is shared by every run)
  own=",${G[$i]},"; case "$own" in *,app-sign-in-on-better-auth,*) own="$own,auth-e2e,";; esac
  awk -F'\t' '$1 == "section" { print $2 "\t" $3 "\t" $4 }' "$r" > "$D/run$((i + 1)).sections"
  c=$(awk -F'\t' '$1 == "core" { print $2 }' "$D/run$((i + 1)).sections"); [ -z "$CORE" ] && CORE=${c:-0}
  TOTAL=$((TOTAL + $(awk -F'\t' -v own="$own" 'index(own, "," $1 ",") { s += $2 } END { print s + 0 }' "$D/run$((i + 1)).sections")))
  awk -F'\t' -v own="$own" '{ if ($1 != "auth-e2e") { if (index(own, "," $1 ",")) print $1 "\t" ($3 - prev); prev = $3 } }' "$D/run$((i + 1)).sections" >> "$D/times.tsv"
done
TOTAL=$((TOTAL + ${CORE:-0}))
[ -n "$FAILS" ] && RC=1
if [ $RC = 0 ]; then mkdir -p "$(dirname "$TIMES")" && cp "$D/times.tsv" "$TIMES" 2>/dev/null || true; fi
echo "smoke-par: $((SECONDS - T0))s wall for ${#G[@]} runs"
if [ $RC = 0 ]; then [ $KEEP = 1 ] || [ -n "${SMOKE_PAR_DIR:-}" ] || rm -rf "$D"; echo "ALL PASSED ($TOTAL checks)"; exit 0; fi
printf "FAIL (logs kept in %s):%b\n" "$D" "$FAILS"; exit 1
