#!/usr/bin/env python3
"""Shared session-id resolver for the v2 context channels.

Why this exists
---------------
The architecture docs tell the Director to run e.g.
`journal.py append "$SESSION_ID" ...`, but `$SESSION_ID` is not exported
into the Director's per-call shells. When the Director can't resolve it,
it passes the literal string "unknown" — which lands every write in
`memory/sessions/unknown/`, defeating the per-session model.

The session-start hook writes the real Claude Code `session_id` to
`.claude/.current_session_id`. This resolver lets journal/timeline/critic
fall back to that marker whenever the caller's arg is missing, empty, or
"unknown", so writes land in the correct per-session directory even when
the Director doesn't have the id to hand.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from _paths import instance_root

REPO_ROOT = instance_root()
CURRENT_SESSION_FILE = REPO_ROOT / ".claude" / ".current_session_id"

# Treated as "no real id supplied" — trigger the marker-file fallback.
_PLACEHOLDERS = {"", "unknown", "none", "null"}


def _read_marker() -> str:
    try:
        return CURRENT_SESSION_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        return ""


def resolve_session_id(arg: str | None) -> str:
    """Resolve the effective session id.

    Order: explicit real arg → `.claude/.current_session_id` marker →
    literal "unknown" (with a stderr warning so the miss is visible).
    """
    candidate = (arg or "").strip()
    if candidate.lower() not in _PLACEHOLDERS:
        return candidate

    marker = _read_marker()
    if marker:
        if candidate:  # caller passed a placeholder explicitly
            print(
                f"[session] arg '{arg}' is a placeholder; using marker '{marker}'",
                file=sys.stderr,
            )
        return marker

    print(
        "[session] no session id supplied and no .claude/.current_session_id "
        "marker found; falling back to 'unknown'",
        file=sys.stderr,
    )
    return "unknown"
