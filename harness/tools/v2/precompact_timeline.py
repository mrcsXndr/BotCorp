#!/usr/bin/env python3
"""PreCompact timeline rebuild + promotion (Hermes #5 + OpenClaw top-pick).

Wired as a SECOND PreCompact hook (see .claude/settings.json), alongside
precompact_extract.py (which salvages durable decisions/findings). This script
ensures the Critic's Timeline is never stale at the moment context is discarded.

Why this exists
---------------
The Director's Journal grows every turn, but the distilled Timeline only got
rebuilt when someone ran `timeline.py build` by hand — which, in a 35-day
`--continue` session, basically never happened. Per the Hermes review (#5,
pre-compaction extraction) and the OpenClaw notes (#1, structured summarization
at PreCompact), the principled trigger is the instant BEFORE compaction.

The 15s-hook constraint
-----------------------
The PreCompact hook is time-boxed (15s in settings.json). The LLM distill
(`timeline.py build`, default Opus) can take up to 180s — it CANNOT run
synchronously in the hook or it gets killed mid-write. So this script does a
two-tier rebuild:

  1. SYNCHRONOUS structural build (zero-LLM, <1s) — guarantees a FRESH timeline
     exists at compaction, every time. Captures the current journal state into
     timeline.md as bucketed sections.
  2. DETACHED LLM distill (non-blocking) — spawns a hidden, orphaned process
     that upgrades timeline.md to the goal->match->resolution narrative shortly
     after, without blocking compaction. If it dies, the structural one stands.
  3. DETACHED weekly promotion (non-blocking, gated to once / WEEKLY_GATE_H) —
     `timeline.py distill <ISO-week>` rolls per-session timelines into
     memory/timelines/<week>.md so the narrative survives the session.

No auto-critic: distillation is one cheap summarization call (the existing
timeline path); credibility grading stays the manual/gated /critic.

STRICTLY FAIL-OPEN. Any error -> print a status line and exit 0. Must never
block or fail compaction.

CLI
---
  precompact_timeline.py --stdin                  # hook mode (PreCompact JSON)
  precompact_timeline.py --session <id>           # explicit session
  precompact_timeline.py --session <id> --dry-run # show plan, spawn nothing
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root  # noqa: E402

REPO_ROOT = instance_root()
SESSIONS_DIR = REPO_ROOT / "memory" / "sessions"
TIMELINES_DIR = REPO_ROOT / "memory" / "timelines"
CURRENT_SESSION_FILE = REPO_ROOT / ".claude" / ".current_session_id"
WEEKLY_STAMP = TIMELINES_DIR / ".last_weekly_distill"

PYTHON = sys.executable or "python"
TIMELINE_PY = Path(__file__).resolve().parent / "timeline.py"
WEEKLY_GATE_H = float(os.environ.get("BOT_WEEKLY_GATE_H", "6"))
WEEKLY_BACKFILL_WEEKS = int(os.environ.get("BOT_WEEKLY_BACKFILL_WEEKS", "4"))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_week(dt: datetime) -> str:
    y, w, _ = dt.isocalendar()
    return f"{y}-W{w:02d}"


def _missing_prior_weeks(now: datetime, lookback: int = WEEKLY_BACKFILL_WEEKS) -> list[str]:
    """Prior ISO weeks (oldest first) that never got a memory/timelines/<week>.md.

    The weekly promotion only ever distilled _iso_week(now), so any week in which
    no PreCompact fired with the gate open was skipped PERMANENTLY — that is how
    2026-W33 went missing between W32 and W34. Backfill closes that hole."""
    missing: list[str] = []
    for back in range(lookback, 0, -1):
        wk = _iso_week(now - timedelta(weeks=back))
        if not (TIMELINES_DIR / f"{wk}.md").exists():
            missing.append(wk)
    return missing


def _resolve_session(explicit: str | None, stdin_mode: bool) -> str:
    if explicit:
        return explicit
    if stdin_mode and not sys.stdin.isatty():
        try:
            d = json.loads(sys.stdin.read() or "{}")
            sid = d.get("session_id") or ""
            if sid:
                return sid
        except Exception:
            pass
    if CURRENT_SESSION_FILE.exists():
        try:
            return CURRENT_SESSION_FILE.read_text(encoding="utf-8").strip()
        except Exception:
            pass
    return ""


def _spawn_detached(args: list[str]) -> bool:
    """Fire-and-forget an OS-orphaned process that survives this hook process
    exiting. We launch python.exe DIRECTLY (not `powershell -File`), so the
    Windows DETACHED_PROCESS flag is reliable here — the codebase's
    `powershell -File`-breaks-under-DETACHED caveat does not apply. Compaction
    exits this hook normally (it does NOT terminate the claude tree), so a
    detached child outlives us. Returns True if the launcher spawned (NOT
    whether the async work succeeded). Child gets PYTHONIOENCODING=utf-8 so
    timeline.py's Windows output never chokes; it inherits PATH so its inner
    `claude --print` resolves (falling back to structural if not)."""
    try:
        kwargs: dict = dict(
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            close_fds=True,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        if os.name == "nt":
            DETACHED_PROCESS = 0x00000008
            CREATE_NEW_PROCESS_GROUP = 0x00000200
            kwargs["creationflags"] = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen(args, **kwargs)
        return True
    except Exception:
        return False


def _weekly_gate_open(now: datetime) -> bool:
    """True if no weekly distill ran within WEEKLY_GATE_H hours."""
    if not WEEKLY_STAMP.exists():
        return True
    try:
        last = datetime.fromisoformat(WEEKLY_STAMP.read_text(encoding="utf-8").strip())
        if last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        return (now - last).total_seconds() >= WEEKLY_GATE_H * 3600
    except Exception:
        return True  # unreadable stamp -> don't block


def _stamp_weekly(now: datetime) -> None:
    try:
        TIMELINES_DIR.mkdir(parents=True, exist_ok=True)
        WEEKLY_STAMP.write_text(now.isoformat(), encoding="utf-8")
    except Exception:
        pass


def run(session_id: str, dry_run: bool) -> dict:
    journal = SESSIONS_DIR / session_id / "journal.md"
    if not journal.exists():
        return {"status": "no-journal", "session_id": session_id}

    now = _now()
    week = _iso_week(now)
    weekly_open = _weekly_gate_open(now)
    result: dict = {"session_id": session_id, "week": week}

    if dry_run:
        result.update({
            "status": "dry-run",
            "would_structural_build": True,
            "would_spawn_distill": True,
            "would_spawn_weekly": weekly_open,
            "would_backfill": _missing_prior_weeks(now) if weekly_open else [],
        })
        return result

    # --- tier 1: synchronous structural build (instant, can't time out) ------
    try:
        r = subprocess.run(
            [PYTHON, str(TIMELINE_PY), "build", session_id, "--structural"],
            capture_output=True, text=True, timeout=12,
            encoding="utf-8", errors="replace",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        result["structural"] = "ok" if r.returncode == 0 else f"rc={r.returncode}"
    except Exception as e:
        result["structural"] = f"error:{e!r}"

    # --- tier 2: detached LLM distill (non-blocking narrative upgrade) -------
    result["distill_spawned"] = _spawn_detached(
        [PYTHON, str(TIMELINE_PY), "build", session_id]
    )

    # --- tier 3: detached weekly promotion (gated) ---------------------------
    if weekly_open:
        result["weekly_spawned"] = _spawn_detached(
            [PYTHON, str(TIMELINE_PY), "distill", week]
        )
        # Backfill any earlier week that never got promoted. Without this a week
        # with no gate-open PreCompact is lost forever (the 2026-W33 hole).
        backfilled = [
            wk for wk in _missing_prior_weeks(now)
            if _spawn_detached([PYTHON, str(TIMELINE_PY), "distill", wk])
        ]
        result["weekly_backfilled"] = backfilled
        if result["weekly_spawned"] or backfilled:
            _stamp_weekly(now)
    else:
        result["weekly_spawned"] = "gated"

    result["status"] = "ok"
    return result


USAGE = """\
precompact_timeline — rebuild + promote the Critic's Timeline before compaction

Usage:
  precompact_timeline.py --stdin                  hook mode (PreCompact JSON on stdin)
  precompact_timeline.py --session <id>           run for an explicit session
  precompact_timeline.py --session <id> --dry-run preview plan (spawns nothing)

Env:
  BOT_WEEKLY_GATE_H   min hours between weekly distills (default 6)
"""


def main(argv: list[str]) -> int:
    args = argv[1:]
    if "-h" in args or "--help" in args:
        print(USAGE)
        return 0
    stdin_mode = "--stdin" in args
    dry_run = "--dry-run" in args
    explicit = None
    if "--session" in args:
        i = args.index("--session")
        if i + 1 < len(args):
            explicit = args[i + 1]

    try:
        session_id = _resolve_session(explicit, stdin_mode)
        if not session_id:
            print(json.dumps({"status": "no-session"}))
            return 0
        print(json.dumps(run(session_id, dry_run), indent=2 if dry_run else None))
    except Exception as e:  # absolute fail-open
        print(json.dumps({"status": "error", "error": repr(e)}))
    return 0  # NEVER non-zero — must not block compaction


if __name__ == "__main__":
    sys.exit(main(sys.argv))
