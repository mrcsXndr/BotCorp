#!/usr/bin/env python3
"""
session_summarize.py — write a structured snapshot of the current session to
memory/sessions/<timestamp>.md, so future ticks can recover context that would
otherwise be lost on Claude Code's automatic context compaction.

Wired as a Claude Code PreCompact hook (and as a Stop hook for redundancy).

This script can NOT see the in-memory conversation — it can only read disk
state. The value is: at compaction time, freeze a snapshot of what's happening
externally (git commits, recent decisions, modified memory files) so the next
tick reads "the previous session was working on X, just landed Y, left Z
mid-flight" without having to re-derive it from git logs.

Usage:
    python tools/infra/session_summarize.py              # write a snapshot
    python tools/infra/session_summarize.py --quiet      # suppress stdout
    python tools/infra/session_summarize.py --tail       # also print the snapshot

Output: memory/sessions/YYYY-MM-DD_HHMMSS.md

Extra repos to summarize alongside the bot's own (e.g. a paired app repo) can
be listed in BOT_TRACKED_REPOS, comma-separated absolute paths.
"""

import argparse
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root  # noqa: E402

ROOT = instance_root()
SESSIONS_DIR = ROOT / "memory" / "sessions"


def _tracked_repos() -> list[Path]:
    repos = [ROOT]
    extra = os.environ.get("BOT_TRACKED_REPOS", "")
    for p in extra.split(","):
        p = p.strip()
        if p:
            repos.append(Path(p))
    return repos


MAX_DECISION_LINES = 60
MAX_COMMITS_PER_REPO = 6


def run(cmd: list[str], cwd: Path = None) -> str:
    try:
        result = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return (result.stdout or "").strip()
    except Exception as e:
        return f"(error: {type(e).__name__}: {e})"


def recent_commits(repo: Path, n: int = MAX_COMMITS_PER_REPO) -> str:
    if not (repo / ".git").exists():
        return "(not a git repo)"
    return run(["git", "log", "--oneline", f"-{n}"], cwd=repo)


def repo_status(repo: Path) -> str:
    if not (repo / ".git").exists():
        return "(not a git repo)"
    out = run(["git", "status", "-s"], cwd=repo)
    if not out:
        return "(clean)"
    lines = out.splitlines()
    if len(lines) > 15:
        return "\n".join(lines[:15]) + f"\n... ({len(lines) - 15} more)"
    return out


def head_of_decisions(repo: Path) -> str:
    """A DECISIONS.md at a tracked repo's root is an optional convention, not
    guaranteed to exist — this just surfaces it when a repo has one."""
    p = repo / "DECISIONS.md"
    if not p.exists():
        return "(no DECISIONS.md in this repo)"
    try:
        lines = p.read_text(encoding="utf-8").splitlines()[:MAX_DECISION_LINES]
        return "\n".join(lines)
    except Exception as e:
        return f"(error reading: {e})"


def recently_modified_memory(window_minutes: int = 60) -> list[str]:
    """List memory files modified in the last N minutes."""
    memory_dir = ROOT / "memory"
    if not memory_dir.exists():
        return []
    cutoff = datetime.now().timestamp() - (window_minutes * 60)
    recent = []
    for p in memory_dir.glob("*.md"):
        try:
            if p.stat().st_mtime > cutoff:
                recent.append(p.name)
        except Exception:
            continue
    return sorted(recent)


def list_session_summaries(n: int = 5) -> list[str]:
    """List the N most recent session summaries (by filename, descending)."""
    if not SESSIONS_DIR.exists():
        return []
    files = sorted(SESSIONS_DIR.glob("*.md"), reverse=True)
    return [f.name for f in files[:n]]


def build_snapshot() -> str:
    now = datetime.now()
    repos = _tracked_repos()
    parts = []
    parts.append(f"# Session snapshot — {now.isoformat(timespec='seconds')}")
    parts.append("")
    parts.append("Auto-written by `tools/infra/session_summarize.py` on PreCompact / Stop.")
    parts.append("Future ticks read these to recover context after Claude Code compaction.")
    parts.append("")

    parts.append("## Recent commits (per tracked repo)")
    parts.append("")
    for repo in repos:
        parts.append(f"### {repo.name}")
        parts.append("```")
        parts.append(recent_commits(repo))
        parts.append("```")
        parts.append("")

    parts.append("## Working tree status (per tracked repo)")
    parts.append("")
    for repo in repos:
        parts.append(f"### {repo.name}")
        parts.append("```")
        parts.append(repo_status(repo))
        parts.append("```")
        parts.append("")

    parts.append("## DECISIONS.md head (newest 60 lines, per tracked repo)")
    parts.append("")
    for repo in repos:
        parts.append(f"### {repo.name}")
        parts.append("```")
        parts.append(head_of_decisions(repo))
        parts.append("```")
        parts.append("")

    parts.append("## Memory files modified in the last hour")
    parts.append("")
    recent_mem = recently_modified_memory(60)
    if recent_mem:
        for name in recent_mem:
            parts.append(f"- `{name}`")
    else:
        parts.append("(none)")
    parts.append("")

    parts.append("## Previous session snapshots")
    parts.append("")
    prev = list_session_summaries(5)
    if prev:
        for name in prev:
            parts.append(f"- `memory/sessions/{name}`")
    else:
        parts.append("(none — this is the first snapshot)")
    parts.append("")

    return "\n".join(parts)


def main():
    p = argparse.ArgumentParser(description="Write a session snapshot to memory/sessions/")
    p.add_argument("--quiet", action="store_true", help="Suppress stdout")
    p.add_argument("--tail", action="store_true", help="Print the written snapshot to stdout")
    args = p.parse_args()

    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    snapshot = build_snapshot()
    ts = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    out_path = SESSIONS_DIR / f"{ts}.md"
    out_path.write_text(snapshot, encoding="utf-8")

    if not args.quiet:
        print(f"Snapshot written: {out_path}")
    if args.tail:
        print(snapshot)
    return 0


if __name__ == "__main__":
    sys.exit(main())
