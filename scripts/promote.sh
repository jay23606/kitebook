#!/usr/bin/env bash
# Promote dev -> main: fast-forward main to origin/dev, only when CI passed on exactly that dev commit and the owner says it ran on a
# real Mac. main is what people install and what `kitebook update` follows, so it never gets a merge commit or an untested sha.
#   scripts/promote.sh --mac-ok [--dry-run] [sha]   sha: a dev commit to promote (default: origin/dev's tip; must be on dev)
# CI status comes from GitHub's check runs for that sha: `gh api` when gh is signed in, else curl with $GITHUB_TOKEN / $GH_TOKEN
# (a public repo also answers without a token, rate-limited). Every check run must be completed and success/neutral/skipped, and the
# CI workflow's "check" job must be among them. Nothing here changes repo settings; it only pushes main.
set -euo pipefail
MAC=0 DRY=0 SHA=""
for a in "$@"; do case "$a" in --mac-ok) MAC=1 ;; --dry-run) DRY=1 ;; -h|--help) sed -n 2,7p "$0"; exit 0 ;; *) SHA="$a" ;; esac; done
die() { echo "promote: $*" >&2; exit 1; }
git fetch -q --tags origin main dev || die "couldn't fetch origin main, dev and tags"
DEV=$(git rev-parse origin/dev) MAIN=$(git rev-parse origin/main)
SHA=$(git rev-parse --verify -q "${SHA:-$DEV}^{commit}") || die "no such commit"
git merge-base --is-ancestor "$SHA" "$DEV" || die "${SHA:0:7} isn't on dev"
[ "$SHA" = "$MAIN" ] && { echo "promote: main is already at ${SHA:0:7}"; exit 0; }
git merge-base --is-ancestor "$MAIN" "$SHA" || die "main (${MAIN:0:7}) isn't an ancestor of ${SHA:0:7}: main moved on its own; bring that into dev first"
REPO=$(git remote get-url origin | sed -E 's#^(git@github.com:|https://([^@/]*@)?github.com/)##; s#\.git$##')
api() { if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then gh api "$1"; else
  local t="${GITHUB_TOKEN:-${GH_TOKEN:-}}"; curl -fsS -H "accept: application/vnd.github+json" ${t:+-H "authorization: Bearer $t"} "https://api.github.com/$1"; fi; }
RUNS=$(api "repos/$REPO/commits/$SHA/check-runs?per_page=100") || die "couldn't read CI status for ${SHA:0:7} from GitHub"
echo "$RUNS" | jq -r '.check_runs[] | "  \(.name): \(.status) \(.conclusion // "")"'
echo "$RUNS" | jq -e '[.check_runs[] | select(.name == "check")] | length > 0' >/dev/null || die "CI hasn't run on ${SHA:0:7} (no 'check' job yet)"
echo "$RUNS" | jq -e 'all(.check_runs[]; .status == "completed" and (.conclusion | IN("success", "neutral", "skipped")))' >/dev/null \
  || die "CI isn't green on ${SHA:0:7} (above); fix dev first"
[ $MAC = 1 ] || die "CI is green on ${SHA:0:7}. Run it on a real Mac (Settings -> Updates -> Update to dev now), then rerun with --mac-ok"
TAG=$(bun scripts/release-tag.ts)
[ $DRY = 1 ] && { echo "promote: would fast-forward main ${MAIN:0:7} -> ${SHA:0:7} and tag $TAG (UTC)"; exit 0; }
git rev-parse --verify -q "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists; fetch tags and retry"
git tag -a "$TAG" "$SHA" -m "Kitebook $TAG (UTC)"
# Atomic: either the checked main commit and its date tag both publish, or neither does. Never force either ref.
git push --atomic origin "$SHA:refs/heads/main" "refs/tags/$TAG"
echo "promote: main ${MAIN:0:7} -> ${SHA:0:7}, tagged $TAG (UTC)"
