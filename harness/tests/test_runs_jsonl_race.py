"""QA pack B 3: the runs.jsonl append never loses a record.

Locked behaviour (daemon/automations.ps1 Add-RunRecord):
- a waiter that finds runs.jsonl held open by another process (a reader, the
  cockpit, another waiter) retries with a short backoff and lands its record
  once the file is free; the old single Out-File -Append logged
  "runs.jsonl append failed" and dropped it;
- concurrent waiters of one bot all land their record (a per-bot mutex).
"""
from __future__ import annotations

import json
import subprocess
import time

from test_automation_python import ASSEMBLY, _runs, needs_win, repo_bot  # noqa: F401  (repo_bot is a fixture)

PWSH = ["pwsh", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]


def _setup(name, home, rt):
    (home / "bot.yaml").write_text(
        f"name: {name}\nharness:\n  service: manual\n  modules:\n    telegram: false\n"
        "automations:\n  - name: plain\n    trigger: {interval_min: 600}\n    command: 'echo ran'\n    timeout_min: 1\n",
        encoding="utf-8")
    jobs = rt / "state" / name / "jobs"
    jobs.mkdir(parents=True)
    return jobs


def _job(jobs, rt, name, run_id):
    f = jobs / f"{run_id}.json"
    f.write_text(json.dumps({"bot": name, "run_id": run_id, "log": str(rt / "logs" / name / "plain" / f"{run_id}.log"),
                             "automation": {"name": "plain"}}), encoding="utf-8")
    return f


def _waiter(name, env, job_file):
    return subprocess.Popen([*PWSH, "-File", str(ASSEMBLY / "daemon" / "automations.ps1"), "-Bot", name, "-ExecJob", str(job_file)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=str(ASSEMBLY), env=env)


@needs_win
def test_a_record_waits_out_a_held_file(repo_bot):
    name, home, rt, env = repo_bot
    jobs = _setup(name, home, rt)
    runs = rt / "state" / name / "runs.jsonl"
    ready = rt / "held"
    holder = subprocess.Popen([*PWSH, "-Command",
                               f"$f = [IO.File]::Open('{runs}', 'OpenOrCreate', 'ReadWrite', 'None'); "
                               f"Set-Content -LiteralPath '{ready}' -Value 1; Start-Sleep -Milliseconds 2500; $f.Close()"])
    deadline = time.time() + 60
    while not ready.exists() and time.time() < deadline:
        time.sleep(0.1)
    assert ready.exists()
    w = _waiter(name, env, _job(jobs, rt, name, "20260930-000000-aaaa"))
    assert w.wait(timeout=300) == 0
    holder.wait(timeout=60)
    assert [r["run_id"] for r in _runs(rt, name)] == ["20260930-000000-aaaa"]


@needs_win
def test_concurrent_waiters_all_land(repo_bot):
    name, home, rt, env = repo_bot
    jobs = _setup(name, home, rt)
    ids = [f"20260930-000000-{i:04x}" for i in range(6)]
    procs = [_waiter(name, env, _job(jobs, rt, name, i)) for i in ids]
    for p in procs:
        assert p.wait(timeout=300) == 0
    got = _runs(rt, name)
    assert sorted(r["run_id"] for r in got) == ids
    log = (rt / "logs" / name / "daemon.log").read_text(encoding="utf-8-sig")
    assert "runs.jsonl append failed" not in log
