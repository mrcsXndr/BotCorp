"""R5a step 9: Python for jobs and sessions (gap a).

- daemon/automations.ps1: a job gets BOT_PYTHON and the Python folder first on
  its PATH, and `${PY}` (quoted) / `${HARNESS}` / `${BOTCORP}` expand in its
  command: `${PY} -c "import sys;print(sys.executable)"` logs an absolute
  python path and exits 0, and so does a bare `python` (no Store stub).
- daemon/launch.ps1 -DryRun: the session env's PATH starts with the Python folder.

The fixture bot lives under <assembly>/bots/ (the daemon scripts resolve bots
there) with a temp BOTCORP_HOME, and is removed afterwards.
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

ASSEMBLY = Path(__file__).resolve().parents[2]
needs_win = pytest.mark.skipif(sys.platform != "win32" or shutil.which("pwsh") is None, reason="Windows + pwsh")


@pytest.fixture
def repo_bot(tmp_path):
    name = f"zz-p{secrets.token_hex(3)}"
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


def _run_now(name, env, job):
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "automations.ps1"),
                        "-Bot", name, "-RunNow", job], capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr + r.stdout


def _runs(rt, name):
    f = rt / "state" / name / "runs.jsonl"
    if not f.exists():
        return []
    return [json.loads(l) for l in f.read_text(encoding="utf-8-sig").splitlines() if l.strip()]


def _wait_runs(rt, name, n):
    # the job runs under a detached waiter; its runs.jsonl row lands when it ends
    deadline = time.time() + 90
    while len(_runs(rt, name)) < n and time.time() < deadline:
        time.sleep(0.5)
    return _runs(rt, name)


def _last_log(rt, name, job):
    logs = sorted((rt / "logs" / name / job).glob("*.log"))
    assert logs, (rt / "daemon.log").read_text(encoding="utf-8") if (rt / "daemon.log").exists() else "no log"
    return logs[-1].read_text(encoding="utf-8", errors="replace").strip()


@needs_win
def test_py_and_bare_python_resolve_to_a_real_interpreter(repo_bot):
    name, home, rt, env = repo_bot
    (home / "bot.yaml").write_text(
        f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n"
        "automations:\n"
        "  - name: py\n    trigger: {interval_min: 600}\n    command: '${PY} -c \"import sys;print(sys.executable)\"'\n    timeout_min: 1\n"
        "  - name: bare\n    trigger: {interval_min: 600}\n    command: 'python -c \"import sys;print(sys.executable)\"'\n    timeout_min: 1\n"
        "  - name: dirs\n    trigger: {interval_min: 600}\n    command: 'echo ${HARNESS}^|${BOTCORP}'\n    timeout_min: 1\n",
        encoding="utf-8")
    for i, job in enumerate(("py", "bare", "dirs"), 1):
        _run_now(name, env, job)
        _wait_runs(rt, name, i)
    exe = _last_log(rt, name, "py")
    assert Path(exe).is_absolute() and Path(exe).name.lower().startswith("python") and Path(exe).exists(), exe
    bare = _last_log(rt, name, "bare")
    assert "WindowsApps" not in bare and Path(bare).is_absolute(), bare
    assert Path(bare).parent == Path(exe).parent, (bare, exe)
    harness, botcorp = _last_log(rt, name, "dirs").split("|")
    assert Path(harness.strip()) == ASSEMBLY / "harness" and Path(botcorp.strip()) == ASSEMBLY
    assert {r["automation"]: r["exit"] for r in _runs(rt, name)} == {"py": 0, "bare": 0, "dirs": 0}


@needs_win
def test_launch_dryrun_puts_python_first_on_the_session_path(repo_bot):
    name, home, rt, env = repo_bot
    (home / "bot.yaml").write_text(f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n", encoding="utf-8")
    r = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ASSEMBLY / "daemon" / "launch.ps1"),
                        "-Bot", name, "-Bg", "-DryRun", "-StartedBy", "cli"], capture_output=True, text=True, timeout=300, cwd=str(ASSEMBLY), env=env)
    assert r.returncode == 0, r.stderr + r.stdout
    envs = dict(l.split("env : ", 1)[1].split("=", 1) for l in r.stdout.splitlines() if "env : " in l)
    py = envs["BOT_PYTHON"]
    first = envs["PATH"].split(os.pathsep)
    assert str(Path(py).parent) in first[:2], (py, first[:3])
