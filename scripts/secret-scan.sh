#!/usr/bin/env bash
# secret-scan.sh — the ONE implementation of the forbidden-filename + credential
# pattern scan. `.githooks/pre-commit` calls this on the staged diff; the CI
# job `secret-scan` calls it on the push/PR diff range; either can also be
# pointed at a plain tree (e.g. the assembly, before its first commit). One
# fix here fixes both call sites.
#
#   scripts/secret-scan.sh <dir>                   scan every file under <dir> as a tree
#   scripts/secret-scan.sh --range <base>..<head>   scan a git diff range (CI)
#   scripts/secret-scan.sh --staged                 scan the staged diff (pre-commit)
#
# Exit 0 = clean. Exit 1 = hit(s), printed to stderr.

set -uo pipefail

# Filenames that must never be committed: secrets/config files, key material,
# the DPAPI vault directory, and Claude Code's own plaintext OAuth token file.
FORBIDDEN_RE='(^|/)(\.env|credentials\.json|token\.json|secrets\.json|instances\.json|config\.env|access\.json)$|\.(pem|p12|pfx|key|oauth_token)$|(^|/)id_(rsa|ed25519)|(^|/)\.vault/'
ALLOW_RE='\.(example|sample|template)$'

# Telegram bot token (8-12 digit id — newer bot ids run longer than the old
# {8,10}), Anthropic, AWS, GitHub, Slack, and PEM private key blocks.
TOKEN_RE='[0-9]{8,12}:AA[A-Za-z0-9_-]{33,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

fail=0
say() { printf '%s\n' "$*" >&2; }

scan_filenames() {  # $1 = newline-separated list of paths
  local list="$1" f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if printf '%s' "$f" | grep -qE "$FORBIDDEN_RE" && ! printf '%s' "$f" | grep -qE "$ALLOW_RE"; then
      say "BLOCKED: '$f' looks like a secrets/vault file — it must never be committed."
      fail=1
    fi
  done <<<"$list"
}

scan_added_lines() {  # $1 = unified diff text; only '+' lines are checked
  local diff="$1" hits
  hits=$(printf '%s\n' "$diff" | grep -E '^\+' | grep -cE "$TOKEN_RE" || true)
  if [ "${hits:-0}" -gt 0 ]; then
    say "BLOCKED: $hits added line(s) match a credential pattern (telegram/anthropic/aws/github/slack token or a private key block)."
    printf '%s\n' "$diff" | grep -nE '^\+' | grep -E "$TOKEN_RE" | head -5 | sed 's/^/         /' >&2
    fail=1
  fi
}

scan_tree_content() {  # $1 = dir; treats each whole file as if every line were added
  local dir="$1" f
  while IFS= read -r -d '' f; do
    grep -Iq . "$f" 2>/dev/null || continue   # skip binaries
    scan_added_lines "$(sed 's/^/+/' "$f")"
  done < <(find "$dir" \( -path '*/.git' -o -path '*/node_modules' -o -path '*/__pycache__' -o -path '*/.pytest_cache' -o -path '*/bots' \) -prune -o -type f -print0)
}

mode="${1:-}"
case "$mode" in
  --range)
    range="${2:?usage: secret-scan.sh --range <base>..<head>}"
    base="${range%%..*}"; head_rev="${range##*..}"
    scan_filenames "$(git diff --name-only --diff-filter=ACR "$base" "$head_rev" 2>/dev/null || true)"
    scan_added_lines "$(git diff --diff-filter=ACMR -U0 "$base" "$head_rev" 2>/dev/null || true)"
    ;;
  --staged)
    scan_filenames "$(git diff --cached --name-only --diff-filter=ACR 2>/dev/null || true)"
    scan_added_lines "$(git diff --cached --diff-filter=ACMR -U0 2>/dev/null || true)"
    ;;
  ""|--help|-h)
    say "usage: secret-scan.sh <dir> | --range <base>..<head> | --staged"
    exit 2
    ;;
  *)
    dir="$mode"
    [ -d "$dir" ] || { say "secret-scan: no such directory: $dir"; exit 2; }
    scan_filenames "$(find "$dir" \( -path '*/.git' -o -path '*/node_modules' -o -path '*/__pycache__' -o -path '*/.pytest_cache' -o -path '*/bots' \) -prune -o -type f -print | sed "s#^${dir%/}/##")"
    scan_tree_content "$dir"
    ;;
esac

if [ "$fail" -ne 0 ]; then
  say ""
  say "Move the secret into a gitignored file (.vault/, .env, channels/telegram/.env)"
  say "and reference it via env, or fix the filename. If this is a false positive"
  say "you are CERTAIN about: git commit --no-verify."
  exit 1
fi
exit 0
