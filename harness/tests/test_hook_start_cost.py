"""QA pack A item 2: what a hook costs to start.

Under Git Bash every fork is an emulated fork() that costs 200 ms or more on
Windows, so session-start (about 35 forks) and user-prompt-submit ran past
their hooks.json timeouts on a loaded box.

Locked behaviour:
- on Windows run.mjs starts Git's own usr/bin/bash.exe with --noprofile
  --norc (not the bin/bash.exe launcher, which sets EXEPATH), with
  MSYSTEM=MINGW64 and mingw64/bin + usr/bin first on PATH, so the scripts still
  find git and the coreutils;
- session-start.sh starts python ONCE (session_start.py does every step);
- user-prompt-submit.sh starts python once for a plain prompt and once for a
  Telegram one (the parse also logs the message and builds the reply nudge),
  and the nudge is what it was: the last tag's message id, --chat-id only for
  a chat other than the default.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from test_hooks_fake_stdin import HOOKS, base_env, bot_home, run_hook  # noqa: F401  (bot_home is a fixture)

RUN = HOOKS / "run.mjs"


@pytest.mark.skipif(sys.platform != "win32" or shutil.which("node") is None, reason="Git Bash selection is Windows-only")
def test_run_mjs_starts_git_bash_directly_with_the_launcher_env(tmp_path, bot_home):
    probe = tmp_path / "probe.sh"
    probe.write_text('echo "exepath=${EXEPATH:-}|msystem=$MSYSTEM"\n'
                     'for c in git date sed cat; do command -v "$c" >/dev/null || echo "missing:$c"; done\n', encoding="utf-8")
    env = base_env(tmp_path, bot_home)
    for k in [k for k in env if k.upper() in ("EXEPATH", "MSYSTEM", "CLAUDE_CODE_GIT_BASH_PATH")]:
        env.pop(k)
    r = subprocess.run(["node", str(RUN), "probe", "-", str(probe)], capture_output=True, text=True, env=env, timeout=60)
    assert r.returncode == 0, r.stderr
    assert r.stdout.splitlines()[0] == "exepath=|msystem=MINGW64", r.stdout   # the launcher would set EXEPATH
    assert "missing:" not in r.stdout, r.stdout


def _counting_python(tmp_path):
    log = tmp_path / "py-calls.log"
    wrapper = tmp_path / "countpy"
    wrapper.write_text(f'#!/usr/bin/env bash\necho x >> "{log.as_posix()}"\nexec "{Path(sys.executable).as_posix()}" "$@"\n', encoding="utf-8")
    wrapper.chmod(0o755)
    return wrapper, log


def _calls(log):
    return len(log.read_text(encoding="utf-8").splitlines()) if log.exists() else 0


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash on PATH")
def test_session_start_starts_python_once(tmp_path, bot_home):
    wrapper, log = _counting_python(tmp_path)
    env = base_env(tmp_path, bot_home, {"BOT_PYTHON": wrapper.as_posix(), "BOT_MODULES": "lessons"})
    proc = run_hook("session-start.sh", env, json.dumps({"session_id": "c1"}))
    assert proc.returncode == 0, proc.stderr
    ctx = json.loads(proc.stdout.strip().splitlines()[-1])["hookSpecificOutput"]["additionalContext"]
    assert "Session ID: c1" in ctx and "### item one" in ctx and "Harness lessons" in ctx
    assert (bot_home / ".claude" / ".current_session_id").read_text(encoding="utf-8").strip() == "c1"
    assert _calls(log) == 1


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash on PATH")
def test_user_prompt_submit_starts_python_once_and_keeps_the_nudge(tmp_path, bot_home):
    wrapper, log = _counting_python(tmp_path)
    env = base_env(tmp_path, bot_home, {"BOT_PYTHON": wrapper.as_posix(), "TELEGRAM_CHAT_ID": "111"})

    proc = run_hook("user-prompt-submit.sh", env, json.dumps({"session_id": "c1", "prompt": "plain text"}))
    assert proc.returncode == 0 and proc.stdout == "", (proc.stdout, proc.stderr)
    assert _calls(log) == 1

    prompt = ('<channel source="plugin:telegram:telegram" chat_id="222" message_id="7" user="op">hi</channel>\n'
              '<channel source="plugin:telegram:telegram" chat_id="222" message_id="8" user="op">again</channel>')
    proc = run_hook("user-prompt-submit.sh", env, json.dumps({"session_id": "c1", "prompt": prompt}))
    assert proc.returncode == 0, proc.stderr
    assert _calls(log) == 2
    ctx = json.loads(proc.stdout.strip())["hookSpecificOutput"]["additionalContext"]
    assert ctx.startswith('Reply path: python tools/tg/tg_send.py --chat-id 222 --reply-to 8 "<CommonMark text>" (formatted'), ctx
    assert (bot_home / "memory" / "tg" / "222.jsonl").is_file()           # logged by the same call

    env["TELEGRAM_CHAT_ID"] = "222"                                          # the default chat: no --chat-id
    proc = run_hook("user-prompt-submit.sh", env, json.dumps({"session_id": "c1", "prompt": prompt}))
    ctx = json.loads(proc.stdout.strip())["hookSpecificOutput"]["additionalContext"]
    assert ctx.startswith("Reply path: python tools/tg/tg_send.py --reply-to 8 "), ctx
