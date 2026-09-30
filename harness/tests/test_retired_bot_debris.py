"""QA pack B 2: a retired bot leaves no runtime debris.

Locked behaviour (harness/hooks/_guard.sh, tools/_paths.py bot_retired):
- a hook or the cost meter run with BOT_NAME=<x>, where bots/<x> does not
  exist and the process runs from inside bots/ (a live session of a removed
  bot, or another bot's folder as cwd), creates neither state/<x>.json,
  state/<x>/ nor logs/<x>/;
- positive control: the same hooks with BOT_NAME naming the existing folder
  write their state as before.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HARNESS = Path(__file__).resolve().parents[1]
HOOKS = HARNESS / "hooks"
PAYLOAD = json.dumps({"session_id": "s1", "reason": "other"})


def _env(tmp_path, name):
    bots = tmp_path / "bots"
    home = bots / "other"
    (home / "memory").mkdir(parents=True, exist_ok=True)
    (home / ".claude").mkdir(exist_ok=True)
    (home / "bot.yaml").write_text("name: other\n", encoding="utf-8")
    env = dict(os.environ)
    for k in ("BOT_MODULES", "BOT_DISABLED_HOOKS"):
        env.pop(k, None)
    env.update({
        "CLAUDE_PLUGIN_ROOT": str(HARNESS),
        "BOT_HOME": str(home),
        "BOT_NAME": name,
        "BOTCORP_HOME": str(tmp_path / "rt"),
        "BOTCORP_BOTS_DIR": str(bots),
        "CLAUDE_CONFIG_DIR": str(tmp_path / "cfg"),
        "BOT_TG_MUTE": "1",
        "PYTHONIOENCODING": "utf-8",
    })
    return env, home


def _hooks(env, home):
    for args in (["session-end.sh"], ["subagent.sh", "start"], ["stop-failure.sh"], ["notification.sh"],
                 ["session-start.sh"], ["py.sh", "cost-meter", "-", "v2/cost_meter.py", "--stdin"]):
        r = subprocess.run(["bash", str(HOOKS / args[0]), *args[1:]], input=PAYLOAD, capture_output=True, text=True,
                           encoding="utf-8", env=env, cwd=str(home), timeout=120)
        assert r.returncode == 0, (args, r.stderr)
    r = subprocess.run([sys.executable, str(HARNESS / "tools" / "v2" / "cost_meter.py"), "s1"], capture_output=True,
                       text=True, encoding="utf-8", env=env, cwd=str(home), timeout=120)
    assert r.returncode == 0, r.stderr


def _debris(rt: Path, name: str) -> list[str]:
    return [str(p) for p in (rt / "state" / f"{name}.json", rt / "state" / name, rt / "logs" / name) if p.exists()]


def test_hooks_and_cost_meter_write_nothing_for_a_retired_bot(tmp_path):
    env, home = _env(tmp_path, "gone")
    _hooks(env, home)
    assert _debris(tmp_path / "rt", "gone") == []


def test_positive_control_an_existing_bot_still_writes_its_state(tmp_path):
    env, home = _env(tmp_path, "other")
    _hooks(env, home)
    rt = tmp_path / "rt"
    assert (rt / "state" / "other" / "events.jsonl").exists()
    assert (rt / "state" / "other.json").exists()
