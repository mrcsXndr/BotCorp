"""QA pack A item 3: a usage pre-warning, and /usage on Telegram.

Locked behaviour:
- `usage_monitor.py warn` reads the 5h and 7d windows from the statusline's
  <config_home>/botcorp/status.json; at 98% or more of a window it sends ONE
  `tg_send.py --alert` (so it lands in alerts.log for triage, never a direct
  push) per window, keyed on the window's reset instant; below 98%, from a
  stale status.json or a second time in the same window it sends nothing;
- `/usage` is a tg_commands.py handler that replies with both windows, and
  from Telegram the hook intercepts it as a read-only command.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

HARNESS = Path(__file__).resolve().parents[1]
MONITOR = HARNESS / "tools" / "v2" / "usage_monitor.py"


def _status(cfg: Path, five: float, seven: float, reset5: int, reset7: int, age_s: float = 5) -> None:
    (cfg / "botcorp").mkdir(parents=True, exist_ok=True)
    (cfg / "botcorp" / "status.json").write_text(json.dumps({
        "ts": time.time() - age_s,
        "rate_limits": {"five_hour": {"used_percentage": five, "resets_at": reset5},
                        "seven_day": {"used_percentage": seven, "resets_at": reset7}},
    }), encoding="utf-8")


def _warn(tmp_path) -> tuple[subprocess.CompletedProcess, list[str]]:
    r = subprocess.run([sys.executable, str(MONITOR), "warn"], capture_output=True, text=True, timeout=60,
                       env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    log = Path(os.environ["BOT_HOME"]) / "memory" / "metrics" / "alerts.log"
    return r, (log.read_text(encoding="utf-8").splitlines() if log.exists() else [])


def test_warn_alerts_once_per_window_at_98(tmp_path):
    cfg = Path(os.environ["CLAUDE_CONFIG_DIR"])
    now = int(time.time())
    _status(cfg, 97.9, 40, now + 3600, now + 86400)
    r, lines = _warn(tmp_path)
    assert r.returncode == 0 and r.stdout.strip() == "OK", r.stderr
    assert lines == []

    _status(cfg, 98.2, 40, now + 3600, now + 86400)
    r, lines = _warn(tmp_path)
    assert r.stdout.strip() == "WARN 5h 98%", r.stderr
    assert len(lines) == 1 and "98% of the 5h window" in lines[0]
    assert "CRITICAL" not in lines[0].upper()            # triaged, never pushed straight to the phone

    _status(cfg, 99.5, 40, now + 3600 + 20, now + 86400)   # same window (reset jitter): quiet
    r, lines = _warn(tmp_path)
    assert r.stdout.strip().startswith("WARN 5h")
    assert len(lines) == 1

    _status(cfg, 98.0, 98.5, now + 5 * 3600 + 3600, now + 86400)  # the next 5h window, and the 7d one
    r, lines = _warn(tmp_path)
    assert len(lines) == 3 and "7d window" in lines[2], lines


def test_warn_ignores_a_stale_status(tmp_path):
    now = int(time.time())
    _status(Path(os.environ["CLAUDE_CONFIG_DIR"]), 99, 99, now + 3600, now + 86400, age_s=3600)
    r, lines = _warn(tmp_path)
    assert r.stdout.strip() == "OK" and lines == []


def test_usage_command_replies_with_both_windows(tmp_path, monkeypatch):
    now = int(time.time())
    _status(Path(os.environ["CLAUDE_CONFIG_DIR"]), 12, 64.4, now + 3600, now + 86400)
    import importlib
    import usage_monitor
    importlib.reload(usage_monitor)                       # its paths are read at import
    import tg_commands
    sent = []
    monkeypatch.setattr(tg_commands, "_send_tg", lambda text, reply_to=None: (sent.append(text), 0)[1])
    assert "/usage" in tg_commands.HANDLERS
    assert tg_commands.HANDLERS["/usage"]([], None) == 0
    assert "5h: 12%" in sent[0] and "7d: 64%" in sent[0], sent


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash on PATH")
@pytest.mark.parametrize("prompt", ["/usage", '<channel source="plugin:telegram:telegram" chat_id="1" message_id="2" user="op">/usage</channel>'])
def test_the_hook_intercepts_usage_from_telegram(tmp_path, prompt):
    from test_hooks_fake_stdin import base_env
    home = tmp_path / "bot"
    (home / ".claude").mkdir(parents=True)
    (home / "memory").mkdir()
    env = base_env(tmp_path, home)
    r = subprocess.run(["bash", str(HARNESS / "hooks" / "user-prompt-submit.sh")], input=json.dumps({"session_id": "u1", "prompt": prompt}),
                       capture_output=True, text=True, env=env, timeout=60)
    assert r.returncode == 2, (r.stdout, r.stderr)
    assert "[tg_commands] handled /usage" in r.stderr
