"""QA pack C 7: module context_warn, one context-pressure line in the prompt.

Locked behaviour (harness/hooks/user-prompt-submit.sh, module context_warn,
default off):
- this session's last-turn context in <config>/botcorp/status.json above 90%
  of BOT_ROLL_TOKENS (harness.roll_tokens, 500000 when unset) -> ONE
  additionalContext line "Context 460K of 500K: finish the current step,
  update journal + TDL, then declare a breakpoint.";
- at or below 90%, another session's status.json, or the module off -> none;
- at most once per 30 min per session (.claude/.context_warn), a new session
  is warned at once;
- a Telegram prompt gets the reply-path nudge and the line in ONE blob;
- the module is registered everywhere a module is: DEFAULTS, the contract,
  the template, the cockpit/tools and CLI descriptions, and the launcher
  passes harness.roll_tokens as BOT_ROLL_TOKENS.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
HOOK = ASSEMBLY / "harness" / "hooks" / "user-prompt-submit.sh"
needs_bash = pytest.mark.skipif(shutil.which("bash") is None, reason="bash")
SID = "sess-ctx"
LINE = "Context 460K of 500K: finish the current step, update journal + TDL, then declare a breakpoint."


def _box(tmp_path, ctx=460000, status_sid=SID):
    home, cfg = tmp_path / "bot", tmp_path / "cfg"
    (home / ".claude").mkdir(parents=True, exist_ok=True)
    (home / "memory").mkdir(exist_ok=True)
    (cfg / "botcorp").mkdir(parents=True, exist_ok=True)
    (cfg / "botcorp" / "status.json").write_text(json.dumps({
        "ts": time.time(), "session_id": status_sid, "context_window": {"current_usage": {
            "input_tokens": 10000, "cache_read_input_tokens": ctx - 15000, "cache_creation_input_tokens": 5000}}}), encoding="utf-8")
    return home, cfg


def _run(tmp_path, home, cfg, prompt="hello", modules="context_warn", roll=""):
    env = {k: v for k, v in os.environ.items() if not k.startswith("BOT_")}
    env.update({"CLAUDE_PLUGIN_ROOT": str(ASSEMBLY / "harness"), "BOT_HOME": str(home), "BOT_NAME": home.name,
                "BOTCORP_HOME": str(tmp_path / "rt"), "CLAUDE_CONFIG_DIR": str(cfg), "BOT_TG_MUTE": "1",
                "BOT_MODULES": modules, "PYTHONIOENCODING": "utf-8"})
    if roll:
        env["BOT_ROLL_TOKENS"] = roll
    r = subprocess.run(["bash", str(HOOK)], input=json.dumps({"session_id": SID, "prompt": prompt}),
                       capture_output=True, text=True, env=env, timeout=60)
    assert r.returncode == 0, r.stderr
    blobs = [json.loads(l) for l in r.stdout.splitlines() if l.strip().startswith("{")]
    return [b["hookSpecificOutput"]["additionalContext"] for b in blobs]


@needs_bash
def test_above_90_percent_warns_once(tmp_path):
    home, cfg = _box(tmp_path)
    assert _run(tmp_path, home, cfg) == [LINE]
    assert _run(tmp_path, home, cfg) == []                 # within 30 min: quiet
    mark = home / ".claude" / ".context_warn"
    mark.write_text(f"{SID} {int(time.time()) - 31 * 60}", encoding="utf-8")
    assert _run(tmp_path, home, cfg) == [LINE]             # 30 min later: again
    mark.write_text(f"other-session {int(time.time())}", encoding="utf-8")
    assert _run(tmp_path, home, cfg) == [LINE]             # a new session is warned at once


@needs_bash
@pytest.mark.parametrize("case", ["at-90", "other-session", "module-off"])
def test_no_line(tmp_path, case):
    home, cfg = _box(tmp_path, ctx=450000 if case == "at-90" else 460000, status_sid="x" if case == "other-session" else SID)
    assert _run(tmp_path, home, cfg, modules="lessons" if case == "module-off" else "context_warn") == []


@needs_bash
def test_roll_tokens_moves_the_line(tmp_path):
    home, cfg = _box(tmp_path, ctx=300000)
    assert _run(tmp_path, home, cfg, roll="320000") == ["Context 300K of 320K: finish the current step, update journal + TDL, then declare a breakpoint."]


@needs_bash
def test_a_telegram_prompt_gets_one_blob(tmp_path):
    home, cfg = _box(tmp_path)
    tg = '<channel source="telegram" chat_id="42" message_id="7" user="op">hi</channel>'
    [ctx] = _run(tmp_path, home, cfg, prompt=tg)
    assert ctx.startswith("Reply path:") and ctx.endswith(LINE)


def test_registered_everywhere():
    assert "context_warn: false," in (ASSEMBLY / "daemon" / "botyaml.mjs").read_text(encoding="utf-8")
    assert "| `context_warn` | off |" in (ASSEMBLY / "docs" / "engine-contract.md").read_text(encoding="utf-8")
    assert "    context_warn: false" in (ASSEMBLY / "templates" / "bot" / "bot.yaml").read_text(encoding="utf-8")
    assert "  context_warn: '" in (ASSEMBLY / "cli" / "tools.mjs").read_text(encoding="utf-8")
    assert "  context_warn: '" in (ASSEMBLY / "cli" / "botcorp.mjs").read_text(encoding="utf-8")
    assert "$childEnv['BOT_ROLL_TOKENS']     = \"$($cfg.harness.roll_tokens)\"" in (ASSEMBLY / "daemon" / "launch.ps1").read_text(encoding="utf-8")
