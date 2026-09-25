"""What env did THIS session actually get? (SessionStart, via hooks/session-env.sh)

A `claude --bg` session inherits the env of whoever started the config home's
daemon, not the env of the launch that asked for it (docs/daemon.md), so the
launcher cannot know which OAuth account or Telegram token a session runs on.
The hook runs as a child of the session, so its env IS the session's env (and
the Telegram plugin's). This records the last 4 characters of
CLAUDE_CODE_OAUTH_TOKEN / TELEGRAM_BOT_TOKEN plus the launcher pid in
<CLAUDE_CONFIG_DIR>/botcorp/session-env.json, keyed by session id, newest
KEEP kept. Never a full value. launch.ps1, `botcorp status` and `botcorp
doctor` compare it with the vault.

Reads the SessionStart payload ({"session_id": ...}) on stdin. FAIL-OPEN.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

KEEP = 20


def last4(value):
    return value[-4:] if value else None


def build_record(env, session_id, now):
    return {
        "session_id": session_id,
        "at": now,
        "oauth_last4": last4(env.get("CLAUDE_CODE_OAUTH_TOKEN")),
        "telegram_last4": last4(env.get("TELEGRAM_BOT_TOKEN")),
        "launcher_pid": int(env["BOT_LAUNCHER_PID"]) if str(env.get("BOT_LAUNCHER_PID", "")).isdigit() else None,
        "bot": env.get("BOT_NAME") or None,
    }


def merge(existing, rec, keep=KEEP):
    sessions = dict(existing.get("sessions") or {}) if isinstance(existing, dict) else {}
    sessions[rec["session_id"]] = rec
    newest = sorted(sessions.values(), key=lambda r: r.get("at") or "", reverse=True)[:keep]
    return {"sessions": {r["session_id"]: r for r in newest}}


def main():
    config_dir = os.environ.get("CLAUDE_CONFIG_DIR")
    if not config_dir:
        return 0
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        payload = {}
    session_id = payload.get("session_id") if isinstance(payload, dict) else None
    if not session_id:
        return 0
    path = Path(config_dir) / "botcorp" / "session-env.json"
    try:
        existing = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        existing = {}
    rec = build_record(os.environ, session_id, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(merge(existing, rec), indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
