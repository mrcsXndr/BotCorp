#!/usr/bin/env python3
"""
state_track.py — persistent project state JSON for cross-tick continuity.

Each tracked project gets a JSON file at memory/projects/<name>/state.json
(JSON not YAML — stdlib only). Holds the cross-session state that the
in-memory TaskList tool can't persist:
  - last_updated timestamp
  - recent_decisions (last 10)
  - in_flight (active sub-agents and tasks)
  - blocked_tasks
  - recent_activity (timeline)
  - notes (free-form)

Each tick reads this file at startup → has perfect context regardless of
session age. Each tick updates it before exiting via the Stop hook.

Replaces the brittleness of "git log + grep + reasoning" with structured
disk state.

Usage:
    python tools/infra/state_track.py read <project>
    python tools/infra/state_track.py update <project> [--from-git]
    python tools/infra/state_track.py log <project> "activity description"
    python tools/infra/state_track.py block <project> <task-id> "reason"
    python tools/infra/state_track.py unblock <project> <task-id>
    python tools/infra/state_track.py note <project> "free-form note"

<project> is any repo name under the projects root. That root defaults to the
bot's own parent directory (siblings of the bot checkout) and can be
overridden with BOT_PROJECTS_ROOT.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root  # noqa: E402

ROOT = instance_root()
PROJECTS_DIR = ROOT / "memory" / "projects"
CODE_ROOT = Path(os.environ.get("BOT_PROJECTS_ROOT", str(ROOT.parent)))
MAX_RECENT_ACTIVITY = 30
MAX_RECENT_DECISIONS = 10


def project_path(name: str) -> Path:
    return PROJECTS_DIR / name / "state.json"


def project_repo(name: str) -> Path:
    return CODE_ROOT / name


def load(name: str) -> dict:
    p = project_path(name)
    if not p.exists():
        return {
            "project": name,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "last_updated": None,
            "recent_decisions": [],
            "in_flight": [],
            "blocked_tasks": [],
            "recent_activity": [],
            "notes": [],
        }
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception as e:
        sys.stderr.write(f"  warning: state file unreadable, starting fresh: {e}\n")
        return {
            "project": name,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "last_updated": None,
            "recent_decisions": [],
            "in_flight": [],
            "blocked_tasks": [],
            "recent_activity": [],
            "notes": [],
        }


def save(name: str, state: dict):
    p = project_path(name)
    p.parent.mkdir(parents=True, exist_ok=True)
    state["last_updated"] = datetime.now().isoformat(timespec="seconds")
    p.write_text(json.dumps(state, indent=2), encoding="utf-8")


def run_git(repo: Path, args: list[str]) -> str:
    try:
        r = subprocess.run(
            ["git", *args],
            cwd=str(repo),
            capture_output=True,
            text=True,
            timeout=10,
        )
        return (r.stdout or "").strip()
    except Exception:
        return ""


def update_from_git(name: str) -> dict:
    """Pull recent commits + DECISIONS.md head + working tree status into state."""
    state = load(name)
    repo = project_repo(name)
    if not (repo / ".git").exists():
        sys.stderr.write(f"  warning: {repo} is not a git repo, skipping git update\n")
        save(name, state)
        return state

    # Recent commits
    commits = run_git(repo, ["log", "--oneline", "-10"]).splitlines()
    state["recent_commits"] = commits

    # Working tree status
    status = run_git(repo, ["status", "-s"]).splitlines()[:20]
    state["working_tree"] = status

    # Recent decisions from a DECISIONS.md at the repo root, if the project
    # keeps one (## YYYY-MM-DD — title headings).
    decisions_path = repo / "DECISIONS.md"
    if decisions_path.exists():
        try:
            text = decisions_path.read_text(encoding="utf-8")
            pattern = re.compile(r"## (\d{4}-\d{2}-\d{2}) — (.+)$", re.MULTILINE)
            matches = pattern.findall(text)
            state["recent_decisions"] = [
                {"date": date, "title": title.strip()}
                for date, title in matches[:MAX_RECENT_DECISIONS]
            ]
        except Exception as e:
            sys.stderr.write(f"  warning: couldn't parse DECISIONS.md: {e}\n")

    save(name, state)
    return state


def append_activity(name: str, message: str):
    state = load(name)
    entry = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "msg": message,
    }
    state["recent_activity"].insert(0, entry)
    state["recent_activity"] = state["recent_activity"][:MAX_RECENT_ACTIVITY]
    save(name, state)


def block_task(name: str, task_id: str, reason: str):
    state = load(name)
    state["blocked_tasks"] = [t for t in state["blocked_tasks"] if t.get("id") != task_id]
    state["blocked_tasks"].append({
        "id": task_id,
        "reason": reason,
        "blocked_at": datetime.now().isoformat(timespec="seconds"),
    })
    save(name, state)


def unblock_task(name: str, task_id: str):
    state = load(name)
    state["blocked_tasks"] = [t for t in state["blocked_tasks"] if t.get("id") != task_id]
    save(name, state)


def add_note(name: str, note: str):
    state = load(name)
    state["notes"].insert(0, {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "note": note,
    })
    state["notes"] = state["notes"][:50]
    save(name, state)


def read(name: str) -> dict:
    return load(name)


def main():
    p = argparse.ArgumentParser(description="Persistent project state for cross-tick continuity")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_read = sub.add_parser("read")
    p_read.add_argument("project")

    p_update = sub.add_parser("update")
    p_update.add_argument("project")
    p_update.add_argument("--from-git", action="store_true", help="Pull commits + decisions from git")

    p_log = sub.add_parser("log")
    p_log.add_argument("project")
    p_log.add_argument("message")

    p_block = sub.add_parser("block")
    p_block.add_argument("project")
    p_block.add_argument("task_id")
    p_block.add_argument("reason")

    p_unblock = sub.add_parser("unblock")
    p_unblock.add_argument("project")
    p_unblock.add_argument("task_id")

    p_note = sub.add_parser("note")
    p_note.add_argument("project")
    p_note.add_argument("note")

    args = p.parse_args()

    if args.cmd == "read":
        state = read(args.project)
        print(json.dumps(state, indent=2))
    elif args.cmd == "update":
        if args.from_git:
            state = update_from_git(args.project)
        else:
            state = load(args.project)
            save(args.project, state)
        print(f"Updated state for {args.project}")
    elif args.cmd == "log":
        append_activity(args.project, args.message)
        print(f"Logged: {args.message}")
    elif args.cmd == "block":
        block_task(args.project, args.task_id, args.reason)
        print(f"Blocked task {args.task_id}: {args.reason}")
    elif args.cmd == "unblock":
        unblock_task(args.project, args.task_id)
        print(f"Unblocked task {args.task_id}")
    elif args.cmd == "note":
        add_note(args.project, args.note)
        print(f"Note added to {args.project}")


if __name__ == "__main__":
    main()
