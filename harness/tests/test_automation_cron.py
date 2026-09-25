"""v0.1.16: a cron-triggered automation keeps its state.

Locked behaviour:
- Expand-CronField returns its HashSet as ONE object. A bare `return $set`
  unrolls it: many values -> a fixed-size object[] (`$dow.Add(0)` for a `*`
  day-of-week then throws "Collection was of a fixed size"), one value -> a bare
  int with no .Contains. Either way every state update of every tick died
  inside Use-AutoState (fail-open, so only the log showed it): run-now queues
  never drained and next_due was never written.
- after a run of a cron job, automations.json carries its next_due and no log
  line says "state update failed".
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]

needs_win = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("node") is None,
                               reason="Windows with pwsh and node on PATH")


@pytest.fixture
def repo_bot(tmp_path):
    name = f"zz-r{secrets.token_hex(3)}"
    home = ASSEMBLY / "bots" / name
    home.mkdir(parents=True)
    rt = tmp_path / "rt"
    (rt / "state").mkdir(parents=True)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CLAUDE", "TELEGRAM_", "BOT_"))}
    env["BOTCORP_HOME"] = str(rt)
    try:
        yield name, home, rt, env
    finally:
        shutil.rmtree(home, ignore_errors=True)


# `* ` day-of-week (0-7, so .Add(0) runs) and a single-value field (unrolls to an int)
@needs_win
@pytest.mark.parametrize("cron", ["0 5 2 * *", "30 4 * * 1"])
def test_a_cron_job_run_records_its_next_due(repo_bot, cron):
    name, home, rt, env = repo_bot
    (home / "bot.yaml").write_text(
        f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n"
        f"automations:\n  - name: monthly\n    trigger: {{cron: \"{cron}\"}}\n    command: \"echo ran\"\n"
        "    timeout_min: 0.2\n    idle_gated: false\n", encoding="utf-8")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "automations.ps1"),
                        "-Bot", name, "-RunNow", "monthly"], capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr + r.stdout
    logs = "\n".join(p.read_text(encoding="utf-8", errors="replace") for p in rt.rglob("*.log"))
    assert "state update failed" not in logs, logs
    state = json.loads((rt / "state" / name / "automations.json").read_text(encoding="utf-8-sig"))
    assert state["monthly"].get("next_due"), state
