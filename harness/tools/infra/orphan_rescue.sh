#!/usr/bin/env bash
# orphan_rescue.sh — rescue unstaged changes left by a crashed sub-agent.
#
# Sub-agents on an API overload (529) often crash mid-work, AFTER making
# substantial file changes but BEFORE committing. Their work sits in the
# working tree as unstaged modifications. Without this script, the next
# autonomous tick would see those changes, get confused, and either ignore or
# duplicate them.
#
# This script:
#   1. Walks each tracked repo (the bot's own home, plus any extra repos named
#      in BOT_RESCUE_REPOS)
#   2. Checks `git status -s` for any unstaged or untracked files
#   3. If found AND the file paths look like real work (not just log churn),
#      commits them with a "rescue:" prefixed message
#   4. Pushes
#   5. Reports what got rescued
#
# Designed to be called at the start of an autonomous-tick prompt. Idempotent.
# Safe to run when there's nothing to rescue.
#
# Usage:
#   bash tools/infra/orphan_rescue.sh                    # rescue the bot's own repo (+ BOT_RESCUE_REPOS)
#   bash tools/infra/orphan_rescue.sh --quiet
#   bash tools/infra/orphan_rescue.sh --dry-run          # report only, don't commit

set -uo pipefail

# BOT_HOME (falls back to CLAUDE_PROJECT_DIR, then cwd) is always rescued.
# Extra repos — e.g. a paired app repo a sub-agent also touches — can be
# listed in BOT_RESCUE_REPOS as a colon-separated list of absolute paths.
BOT_HOME="${BOT_HOME:-${CLAUDE_PROJECT_DIR:-$PWD}}"
REPOS=("$BOT_HOME")
if [ -n "${BOT_RESCUE_REPOS:-}" ]; then
  IFS=':' read -ra _extra <<< "$BOT_RESCUE_REPOS"
  REPOS+=("${_extra[@]}")
fi

# Files modified within this many minutes are SKIPPED (likely an in-progress
# sub-agent still writing). Default 10 min — match the usual tick interval.
# Tune upward for safety.
MTIME_GUARD_MINUTES=10

# Files that don't count as "real work" — log churn, scratch, etc.
# Glob patterns matched against the file paths from git status.
JUNK_PATTERNS=(
  "logs/*.log"
  "*.log"
  "*.pyc"
  "__pycache__"
  ".DS_Store"
)

QUIET=false
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=true ;;
    --dry-run) DRY_RUN=true ;;
  esac
done

log() { [ "$QUIET" = false ] && echo "[orphan_rescue] $*"; }

is_junk() {
  local path="$1"
  for pat in "${JUNK_PATTERNS[@]}"; do
    case "$path" in
      $pat|*$pat) return 0 ;;
    esac
  done
  return 1
}

rescue_repo() {
  local repo="$1"
  if [ ! -d "$repo/.git" ]; then
    return 0
  fi

  cd "$repo" || return 1

  local status_output
  status_output=$(git status -s 2>/dev/null)
  if [ -z "$status_output" ]; then
    return 0
  fi

  # Filter out junk files AND files modified within MTIME_GUARD_MINUTES
  local real_changes=()
  local skipped_recent=0
  local now_epoch
  now_epoch=$(date +%s)
  local cutoff_epoch=$((now_epoch - MTIME_GUARD_MINUTES * 60))

  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local path="${line:3}"  # strip the 2-char status prefix
    if is_junk "$path"; then
      continue
    fi
    # Skip if mtime is newer than cutoff (in-progress agent likely writing)
    if [ -e "$path" ]; then
      local mtime
      mtime=$(stat -c %Y "$path" 2>/dev/null || echo 0)
      if [ "$mtime" -gt "$cutoff_epoch" ]; then
        skipped_recent=$((skipped_recent + 1))
        continue
      fi
    fi
    real_changes+=("$path")
  done <<< "$status_output"

  if [ "$skipped_recent" -gt 0 ]; then
    log "$(basename "$repo"): skipped $skipped_recent file(s) modified within last ${MTIME_GUARD_MINUTES}m (in-progress agent guard)"
  fi

  if [ ${#real_changes[@]} -eq 0 ]; then
    log "$(basename "$repo"): only junk files, skipping"
    return 0
  fi

  log "$(basename "$repo"): found ${#real_changes[@]} orphan file(s)"
  for f in "${real_changes[@]}"; do
    log "  $f"
  done

  if [ "$DRY_RUN" = true ]; then
    log "$(basename "$repo"): DRY RUN — not committing"
    return 0
  fi

  # Add the real changes (but not junk)
  for f in "${real_changes[@]}"; do
    git add "$f" 2>/dev/null
  done

  # Compose a rescue commit message
  local repo_name
  repo_name=$(basename "$repo")
  local short_list
  short_list=$(printf '%s\n' "${real_changes[@]}" | head -5 | sed 's/^/  - /')
  local more_count=$(( ${#real_changes[@]} - 5 ))
  local more_text=""
  if [ "$more_count" -gt 0 ]; then
    more_text=$(printf "\n  ... +%d more" "$more_count")
  fi

  local msg
  msg=$(printf "rescue: orphan files from crashed sub-agent\n\n%d file(s) left unstaged after a sub-agent crash (likely an API overload mid-tool-use). Auto-committed by tools/infra/orphan_rescue.sh on the next tick.\n\nFiles:\n%s%s" "${#real_changes[@]}" "$short_list" "$more_text")

  if git commit -m "$msg" >/dev/null 2>&1; then
    log "$(basename "$repo"): committed rescue"
    if git pull --rebase --autostash >/dev/null 2>&1; then
      if git push >/dev/null 2>&1; then
        log "$(basename "$repo"): pushed"
      else
        log "$(basename "$repo"): push failed (will retry next tick)"
      fi
    fi
  else
    log "$(basename "$repo"): commit failed"
  fi
}

for repo in "${REPOS[@]}"; do
  rescue_repo "$repo"
done

log "done"
