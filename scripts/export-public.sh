#!/usr/bin/env bash
# Build a fresh one-commit repo from a ref, for publishing Kitebook without its private history (docs/launch/SECRET-SCAN.md
# recommends this over flipping the private repo public: no old author emails, no build-loop commit messages, no SHAs that a
# force-push could leave reachable). It only writes a local folder: it never creates a remote, pushes or changes visibility.
#   scripts/export-public.sh [--force] [--no-check] <ref> <out-dir>      e.g. scripts/export-public.sh origin/main ../kitebook-public
# Author/committer of the one commit (no personal address by default; set your GitHub noreply address if you want it linked):
#   KITEBOOK_EXPORT_NAME   default "Kitebook contributors"
#   KITEBOOK_EXPORT_EMAIL  default "contributors@kitebook.invalid" (.invalid never routes); e.g. 12345+you@users.noreply.github.com
#   KITEBOOK_EXPORT_MESSAGE  commit message, default "Initial public release of Kitebook"
#   KITEBOOK_EXPORT_EXCLUDE  extra paths/globs to leave out, space-separated (added to the list below)
#   KITEBOOK_EXPORT_PRIVATE  a file of extra regexes (one per line) the export must not contain: your name, home address, live
#                            hostname, real emails. Keep that file OUTSIDE the repo, since this script and the export are public.
# Checks run on the export (exit 1 on any finding; --no-check skips them): gitleaks if installed (GITLEAKS=path), a built-in
# secret-shape grep, email addresses, /Users/<name> and /home/<name> paths, the KITEBOOK_EXPORT_PRIVATE patterns, links or
# mentions of left-out files, and the old "Relay" name in user-facing docs outside the rename note.
set -euo pipefail
FORCE=0 CHECK=1 ARGS=()
for a in "$@"; do case "$a" in --force) FORCE=1 ;; --no-check) CHECK=0 ;; -h|--help) sed -n 2,15p "$0"; exit 0 ;; *) ARGS+=("$a") ;; esac; done
[ ${#ARGS[@]} -eq 2 ] || { sed -n 4p "$0" >&2; exit 2; }
REF=${ARGS[0]} OUT=${ARGS[1]}
die() { echo "export-public: $*" >&2; exit 1; }
ROOT=$(git rev-parse --show-toplevel) || die "run it inside a Kitebook checkout"
SHA=$(git -C "$ROOT" rev-parse --verify -q "$REF^{commit}") || die "no such ref: $REF"
case "$(cd "$(dirname "$OUT")" 2>/dev/null && pwd)/" in "$ROOT"/*) die "the out dir must be outside this checkout" ;; esac
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then [ $FORCE = 1 ] || die "$OUT exists and isn't empty (--force replaces it)"; rm -rf "$OUT"; fi
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)

# What stays private: the maintainer's agent notes and boards, launch planning (pitch drafts, program applications, the secret-scan
# report about this history) and the internal backlog/audits. docs/launch/good-first-issues.md and demo.gif are public.
EXCLUDE=".hark .hark/** **/.hark/** docs/hark-history.md **/BRAINSTORM*.md **/USABILITY.md **/UX-REVIEW.md **/ARCHITECTURE-REVIEW.md
  **/PRODUCT-CRITERIA.md **/OSS-GOAL.md docs/backlog.md docs/UX-AUDIT.md docs/launch/LAUNCH.md docs/launch/SECRET-SCAN.md
  docs/launch/oss-applications.md docs/launch/contributor-growth.md docs/launch/npm.md ${KITEBOOK_EXPORT_EXCLUDE:-}"
git -C "$ROOT" archive --format=tar "$SHA" | tar -x -C "$OUT"
python3 - "$OUT" $EXCLUDE <<'PY'
# remove the excluded paths, then unlink what pointed at them: a table row whose link goes to a removed file is dropped (README's
# docs table), any other markdown link keeps its text. Mentions left in code spans are caught by the checks below.
import sys, os, re, fnmatch
out, pats = sys.argv[1], sys.argv[2:]
files = [os.path.relpath(os.path.join(d, f), out) for d, _, fs in os.walk(out) for f in fs]
gone = set(f for f in files if any(fnmatch.fnmatch(f, p) or fnmatch.fnmatch(f, p.lstrip("*/")) or f.startswith(p.rstrip("/") + "/") for p in pats))
for f in sorted(gone): os.remove(os.path.join(out, f)); print("left out:", f)
for d, ds, _ in os.walk(out, topdown=False):
    if d != out and not os.listdir(d): os.rmdir(d)
link = re.compile(r"\[([^\]]*)\]\(([^)#\s]+)(#[^)]*)?\)")
for f in files:
    if f in gone or not f.endswith(".md"): continue
    p = os.path.join(out, f); t = open(p, encoding="utf-8").read()
    dead = lambda m: not re.match(r"^[a-z]+:", m.group(2)) and os.path.normpath(os.path.join(os.path.dirname(f), m.group(2))) in gone
    lines = [l for l in t.split("\n") if not (l.lstrip().startswith("|") and any(dead(m) for m in link.finditer(l)))]
    n = link.sub(lambda m: m.group(1) if dead(m) else m.group(0), "\n".join(lines))
    if n != t: open(p, "w", encoding="utf-8").write(n); print("unlinked left-out files in:", f)
PY

NAME=${KITEBOOK_EXPORT_NAME:-Kitebook contributors} EMAIL=${KITEBOOK_EXPORT_EMAIL:-contributors@kitebook.invalid}
MSG=${KITEBOOK_EXPORT_MESSAGE:-Initial public release of Kitebook}
( cd "$OUT" && git init -q -b main && git add -A \
  && GIT_AUTHOR_NAME="$NAME" GIT_AUTHOR_EMAIL="$EMAIL" GIT_COMMITTER_NAME="$NAME" GIT_COMMITTER_EMAIL="$EMAIL" \
     git -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q -m "$MSG" )
echo "export-public: $OUT is one commit ($(git -C "$OUT" rev-parse --short HEAD), $(git -C "$OUT" ls-files | wc -l | tr -d ' ') files) from ${SHA:0:7}, author $NAME <$EMAIL>"
[ $CHECK = 1 ] || exit 0

# ---- checks ----
FAIL=0; flag() { echo "FINDING ($1):"; sed 's/^/  /' | head -40; FAIL=1; }
cd "$OUT"
GL=${GITLEAKS:-$(command -v gitleaks || true)}
if [ -n "$GL" ]; then "$GL" dir --no-banner --redact ${ROOT:+--config "$OUT/.gitleaks.toml"} . >/tmp/export-gitleaks.$$ 2>&1 || flag "gitleaks" < /tmp/export-gitleaks.$$
  rm -f /tmp/export-gitleaks.$$; else echo "export-public: gitleaks not installed, only the built-in grep runs"; fi
# token shapes outside the tests (smoke.sh and *.test.ts feed the secret guard fake keys on purpose; gitleaks above still scans
# them, with its allowlist). The fake fixtures the secret-guard tests use on purpose are listed in .gitleaks.toml and skipped the same way here
ALLOW=$(grep -o "'''[^']*'''" .gitleaks.toml 2>/dev/null | sed "s/'''//g" || true)
SEC='(ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[abposr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|glpat-[A-Za-z0-9_-]{20}|(sk|rk)_live_[A-Za-z0-9]{20,}'
git grep -nIE "$SEC" -- . ':!smoke.sh' ':!*.test.ts' ':!.gitleaks.toml' | { [ -n "$ALLOW" ] && grep -vE "$(echo "$ALLOW" | sort -u | paste -sd '|' -)" || cat; } > /tmp/export-sec.$$ || true
[ -s /tmp/export-sec.$$ ] && flag "secret-shaped strings" < /tmp/export-sec.$$; rm -f /tmp/export-sec.$$
# email addresses: only placeholders, test fixtures and noreply addresses may appear
git grep -nIoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -- . ':!package-lock.json' \
  | grep -viE '@(users\.noreply\.github\.com|([a-z0-9-]+\.)*example\.(com|org|net)|[a-z0-9.-]*\.(invalid|test|example|local|localhost))$|@(t\.t|x\.y|a\.b|b\.c)$|noreply@|no-reply@|@github\.com$|@anthropic\.com$|@openai\.com$|@v[0-9]|@[0-9]+\.[0-9]' \
  | grep -vE ':(git@github\.com|[a-z-]+@[0-9])' > /tmp/export-mail.$$ || true
[ -s /tmp/export-mail.$$ ] && flag "email addresses (check each is a placeholder)" < /tmp/export-mail.$$; rm -f /tmp/export-mail.$$
# personal paths: only generic home folders in examples
git grep -nIoP '(?<![\w$}/.-])/(Users|home)/[A-Za-z][A-Za-z0-9._-]*' | grep -vE '/(Users|home)/(you|your[a-z_-]*|me|user|username|runner|name|<[^>]*>|x|u|a|b|test|t|alice|sam|dev|ubuntu|linuxbrew|someone|sandbox|USER|\$USER|\$\{USER\})$' > /tmp/export-path.$$ || true
[ -s /tmp/export-path.$$ ] && flag "personal paths" < /tmp/export-path.$$; rm -f /tmp/export-path.$$
if [ -n "${KITEBOOK_EXPORT_PRIVATE:-}" ]; then [ -f "$KITEBOOK_EXPORT_PRIVATE" ] || die "KITEBOOK_EXPORT_PRIVATE: no file $KITEBOOK_EXPORT_PRIVATE"
  grep -v '^\s*\(#\|$\)' "$KITEBOOK_EXPORT_PRIVATE" > /tmp/export-pp.$$ || true
  if [ -s /tmp/export-pp.$$ ]; then git grep -nIiE -f /tmp/export-pp.$$ > /tmp/export-priv.$$ || true; [ -s /tmp/export-priv.$$ ] && flag "private patterns from \$KITEBOOK_EXPORT_PRIVATE" < /tmp/export-priv.$$; fi
  rm -f /tmp/export-pp.$$ /tmp/export-priv.$$; fi
# links or mentions of left-out files (a code-span mention of docs/backlog.md would send readers to a file that isn't there)
git grep -nIE 'docs/backlog\.md|UX-AUDIT\.md|hark-history\.md|BRAINSTORM\.md|OSS-GOAL\.md|USABILITY\.md|launch/(LAUNCH|SECRET-SCAN|oss-applications|contributor-growth|npm)\.md|\]\((backlog|UX-AUDIT|LAUNCH|SECRET-SCAN|oss-applications|contributor-growth|npm)\.md' -- '*.md' '.github/*' > /tmp/export-ref.$$ || true
[ -s /tmp/export-ref.$$ ] && flag "references to left-out files" < /tmp/export-ref.$$; rm -f /tmp/export-ref.$$
# the old name in what users read (docs, README, templates); code keeps it only for migrating old installs, which is fine
git grep -nIw 'Relay' -- '*.md' '.github/ISSUE_TEMPLATE/*' '.github/DISCUSSION_TEMPLATE/*' '.github/*.md' \
  | grep -viE 'was called Relay|renamed|before the rename|Relay -> Kitebook|Relay → Kitebook|formerly Relay' > /tmp/export-brand.$$ || true
[ -s /tmp/export-brand.$$ ] && flag "old Relay name in user-facing docs" < /tmp/export-brand.$$; rm -f /tmp/export-brand.$$
[ $FAIL = 0 ] && echo "export-public: checks passed (secrets, emails, paths, private patterns, left-out references, branding)" || { echo "export-public: fix the findings above before publishing"; exit 1; }
